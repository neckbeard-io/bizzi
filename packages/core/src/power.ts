// Keep the machine awake while agents work (spec §8.1).
//
// `KeepAwake` counts what is going on (sessions running a turn, sessions with background work), decides
// from the machine's setting whether that should hold the machine awake, and holds it through a
// platform backend. After the last piece of work ends the hold lingers for a while, since a follow-up
// from the phone often arrives a minute later and a sleeping machine never sees it.
//
// Backends are child processes tied to the core's pid, with no native add-ons, so a crashed or
// killed core never leaves the machine held. Only idle system sleep is held, never the display.
//   macOS:   `caffeinate -i -w <pid>`; power source from `pmset -g ps`.
//   Linux:   not done yet. `systemd-inhibit --what=idle:sleep --who=bizzi --mode=block tail --pid=<pid> -f /dev/null`.
//   Windows: not done yet. A hidden PowerShell calling SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)
//            through P/Invoke, then `Wait-Process -Id <pid>`.

import { execFile, spawn } from 'node:child_process';
import { BizziError, KEEP_AWAKE_MODES } from '@bizzi/protocol';
import type { KeepAwakeMode, KeepAwakeSettings, KeepAwakeState, Logger, PowerSource } from '@bizzi/protocol';

export const DEFAULT_KEEP_AWAKE: KeepAwakeSettings = { mode: 'turns', onBattery: false };

/** A hold on idle system sleep. `release` is idempotent. */
export interface PowerHold {
  release(): void;
}

/** One OS's way of holding idle sleep and reading the power source. */
export interface PowerBackend {
  readonly name: string;
  /** Start holding idle system sleep. `onLost` fires once if the hold ends without `release` (the child died). */
  hold(onLost: (err: Error) => void): PowerHold;
  /** What the machine runs on now; 'unknown' when it can't tell. */
  powerSource(): Promise<PowerSource>;
}

/** The backend for this OS, or undefined where there is none yet (the setting shows as unavailable). */
export function platformPowerBackend(platform: string = process.platform): PowerBackend | undefined {
  if (platform === 'darwin') return macosPowerBackend();
  // linux (systemd-inhibit) and win32 (SetThreadExecutionState) slot in here; see the header comment.
  return undefined;
}

/** Parse `pmset -g ps`: "Now drawing from 'AC Power'" / "'Battery Power'" / "'UPS Power'". */
export function parsePmsetPs(out: string): PowerSource {
  const m = /drawing from '([^']+)'/.exec(out);
  if (!m) return 'unknown';
  const src = m[1]!.toLowerCase();
  if (src.includes('battery')) return 'battery';
  if (src.includes('ac') || src.includes('ups')) return 'ac';
  return 'unknown';
}

export interface MacosBackendOptions {
  /** Process whose exit ends the hold (default: this process). */
  pid?: number;
  /** Executable names (tests point them elsewhere). */
  caffeinate?: string;
  pmset?: string;
}

export function macosPowerBackend(opts: MacosBackendOptions = {}): PowerBackend {
  const pid = opts.pid ?? process.pid;
  const caffeinate = opts.caffeinate ?? 'caffeinate';
  const pmset = opts.pmset ?? 'pmset';
  return {
    name: 'caffeinate',
    hold(onLost) {
      // -i: prevent idle system sleep (not the display). -w: exit when the core does, however it ends.
      const child = spawn(caffeinate, ['-i', '-w', String(pid)], { stdio: 'ignore' });
      child.unref();
      let done = false;
      const lost = (err: Error): void => {
        if (done) return;
        done = true;
        process.off('exit', kill);
        onLost(err);
      };
      // Belt and braces for a normal exit: -w polls, so don't leave caffeinate up for its next tick.
      const kill = (): void => {
        child.kill();
      };
      process.once('exit', kill);
      child.once('error', (err) => lost(err));
      child.once('exit', (code, signal) => lost(new Error(`caffeinate exited (${signal ?? code})`)));
      return {
        release() {
          if (done) return;
          done = true;
          process.off('exit', kill);
          child.kill();
        },
      };
    },
    powerSource() {
      return new Promise((resolve) => {
        execFile(pmset, ['-g', 'ps'], { timeout: 3000 }, (err, stdout) => resolve(err ? 'unknown' : parsePmsetPs(String(stdout))));
      });
    },
  };
}

/** Validate `machine.set` keepAwake: a partial settings object merged over `cur`. */
export function parseKeepAwakeSettings(v: unknown, cur: KeepAwakeSettings): KeepAwakeSettings {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new BizziError('bad_request', 'keepAwake must be an object');
  const raw = v as { mode?: unknown; onBattery?: unknown };
  const next = { ...cur };
  if (raw.mode !== undefined) {
    if (!KEEP_AWAKE_MODES.includes(raw.mode as KeepAwakeMode)) throw new BizziError('bad_request', `keepAwake.mode must be one of ${KEEP_AWAKE_MODES.join(', ')}`);
    next.mode = raw.mode as KeepAwakeMode;
  }
  if (raw.onBattery !== undefined) {
    if (typeof raw.onBattery !== 'boolean') throw new BizziError('bad_request', 'keepAwake.onBattery must be a boolean');
    next.onBattery = raw.onBattery;
  }
  return next;
}

/** Read persisted settings (JSON from the node's meta table); bad or missing data gives the defaults. */
export function readKeepAwakeSettings(json: string | undefined): KeepAwakeSettings {
  if (!json) return { ...DEFAULT_KEEP_AWAKE };
  try {
    return parseKeepAwakeSettings(JSON.parse(json), DEFAULT_KEEP_AWAKE);
  } catch {
    return { ...DEFAULT_KEEP_AWAKE };
  }
}

/** What is going on right now, counted from the sessions. */
export interface KeepAwakeWork {
  /** Sessions running a turn, or terminal sessions that are busy. */
  turns: number;
  /** Sessions not running a turn that have background work. */
  background: number;
}

export interface KeepAwakeOptions {
  /** Undefined: no backend on this OS (`supported: false`). */
  backend?: PowerBackend;
  settings: KeepAwakeSettings;
  logger: Logger;
  /** Called whenever the published state changes. */
  onChange?: (state: KeepAwakeState) => void;
  /** Hold after the last work ends (default 90 s). */
  lingerMs?: number;
  /** Power source poll while it matters (default 60 s). */
  powerPollMs?: number;
  /** A reading at most this old is reused when work changes (default 10 s). */
  powerFreshMs?: number;
  /** Wait before holding again after the backend lost its hold (default 30 s). */
  retryMs?: number;
}

export class KeepAwake {
  readonly #backend: PowerBackend | undefined;
  readonly #logger: Logger;
  readonly #onChange: ((state: KeepAwakeState) => void) | undefined;
  readonly #lingerMs: number;
  readonly #pollMs: number;
  readonly #freshMs: number;
  readonly #retryMs: number;
  #settings: KeepAwakeSettings;
  #work: KeepAwakeWork = { turns: 0, background: 0 };
  #hold: PowerHold | undefined;
  #since: string | undefined;
  #lingerUntil: number | undefined;
  #lingerTimer: NodeJS.Timeout | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #retryTimer: NodeJS.Timeout | undefined;
  #power: { source: PowerSource; at: number } | undefined;
  #checking = false;
  #closed = false;
  #published = '';
  #state: KeepAwakeState;

  constructor(opts: KeepAwakeOptions) {
    this.#backend = opts.backend;
    this.#logger = opts.logger;
    this.#onChange = opts.onChange;
    this.#settings = { ...opts.settings };
    this.#lingerMs = opts.lingerMs ?? 90_000;
    this.#pollMs = opts.powerPollMs ?? 60_000;
    this.#freshMs = opts.powerFreshMs ?? 10_000;
    this.#retryMs = opts.retryMs ?? 30_000;
    this.#state = this.#compute();
    this.#published = JSON.stringify(this.#state);
  }

  get settings(): KeepAwakeSettings {
    return { ...this.#settings };
  }

  /** The current state (a copy). */
  state(): KeepAwakeState {
    return { ...this.#state, settings: { ...this.#state.settings } };
  }

  /** Report what is going on now (called on every session change; cheap when nothing moved). */
  update(work: KeepAwakeWork): void {
    if (this.#closed) return;
    if (work.turns === this.#work.turns && work.background === this.#work.background) return;
    this.#work = { ...work };
    this.#reconcile(false);
  }

  /** New settings take effect at once: turning it off or narrowing it releases without lingering. */
  setSettings(settings: KeepAwakeSettings): void {
    if (this.#closed) return;
    this.#settings = { ...settings };
    this.#reconcile(true);
  }

  /** Release any hold and stop every timer. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#release('closing');
    this.#closed = true;
    clearTimeout(this.#retryTimer);
    this.#stopPolling();
  }

  /** The work that counts under the current setting. */
  #counted(): KeepAwakeWork {
    const mode = this.#settings.mode;
    return {
      turns: mode === 'off' ? 0 : this.#work.turns,
      background: mode === 'turns_and_background' ? this.#work.background : 0,
    };
  }

  #onBatteryBlocked(): boolean {
    return !this.#settings.onBattery && this.#power?.source === 'battery';
  }

  #reconcile(immediate: boolean): void {
    if (this.#closed) return;
    const counted = this.#counted();
    const wanted = this.#backend !== undefined && counted.turns + counted.background > 0;
    const needsPower = this.#backend !== undefined && !this.#settings.onBattery && (wanted || this.#hold !== undefined);
    if (needsPower) {
      this.#startPolling();
      if (!this.#power || Date.now() - this.#power.at > this.#freshMs) this.#checkPower();
    } else {
      this.#stopPolling();
    }

    if (wanted) {
      this.#cancelLinger();
      if (this.#onBatteryBlocked()) this.#release('on battery');
      // Hold once the power source is known (or doesn't matter); the first reading is quick.
      else if (this.#settings.onBattery || this.#power) this.#acquire(counted);
    } else if (this.#hold) {
      if (immediate || this.#onBatteryBlocked()) this.#release(immediate ? 'setting changed' : 'on battery');
      else this.#startLinger();
    }
    this.#publish();
  }

  #acquire(counted: KeepAwakeWork): void {
    if (this.#hold || !this.#backend || this.#retryTimer) return;
    try {
      this.#hold = this.#backend.hold((err) => this.#lost(err));
    } catch (err) {
      this.#lost(err as Error);
      return;
    }
    this.#since = new Date().toISOString();
    this.#logger.log('info', 'keeping the machine awake', { backend: this.#backend.name, ...counted });
  }

  #release(why: string): void {
    this.#cancelLinger();
    if (!this.#hold) return;
    const hold = this.#hold;
    this.#hold = undefined;
    this.#since = undefined;
    hold.release();
    this.#logger.log('info', 'no longer keeping the machine awake', { why });
  }

  /** The backend's hold ended on its own (child killed, missing binary): try again in a while. */
  #lost(err: Error): void {
    if (this.#closed) return;
    this.#logger.log('warn', 'keep-awake hold lost', { err: err.message });
    this.#hold = undefined;
    this.#since = undefined;
    this.#cancelLinger();
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#reconcile(false);
    }, this.#retryMs);
    this.#retryTimer.unref();
    this.#publish();
  }

  #startLinger(): void {
    if (this.#lingerTimer) return;
    this.#lingerUntil = Date.now() + this.#lingerMs;
    this.#lingerTimer = setTimeout(() => {
      this.#lingerTimer = undefined;
      this.#lingerUntil = undefined;
      this.#release('work ended');
      this.#reconcile(false);
    }, this.#lingerMs);
    this.#lingerTimer.unref();
  }

  #cancelLinger(): void {
    clearTimeout(this.#lingerTimer);
    this.#lingerTimer = undefined;
    this.#lingerUntil = undefined;
  }

  #startPolling(): void {
    if (this.#pollTimer) return;
    this.#pollTimer = setInterval(() => this.#checkPower(), this.#pollMs);
    this.#pollTimer.unref();
  }

  #stopPolling(): void {
    clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
  }

  #checkPower(): void {
    if (this.#checking || !this.#backend) return;
    this.#checking = true;
    this.#backend
      .powerSource()
      .catch((): PowerSource => 'unknown')
      .then((source) => {
        this.#checking = false;
        if (this.#closed) return;
        const prev = this.#power?.source;
        this.#power = { source, at: Date.now() };
        if (prev !== undefined && prev !== source) this.#logger.log('info', 'power source changed', { from: prev, to: source });
        this.#reconcile(false);
      });
  }

  #compute(): KeepAwakeState {
    const counted = this.#counted();
    const state: KeepAwakeState = {
      supported: this.#backend !== undefined,
      settings: { ...this.#settings },
      active: this.#hold !== undefined,
      turns: counted.turns,
      background: counted.background,
    };
    if (this.#since) state.since = this.#since;
    if (this.#lingerUntil !== undefined && this.#hold) state.lingerUntil = new Date(this.#lingerUntil).toISOString();
    if (this.#power && this.#backend) state.power = this.#power.source;
    if (counted.turns + counted.background > 0 && this.#onBatteryBlocked()) state.pausedOnBattery = true;
    return state;
  }

  #publish(): void {
    const next = this.#compute();
    const json = JSON.stringify(next);
    this.#state = next;
    if (json === this.#published) return;
    this.#published = json;
    this.#onChange?.(this.state());
  }
}
