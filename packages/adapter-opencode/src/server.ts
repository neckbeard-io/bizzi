// Lifecycle of the private `opencode serve` instance shared by every OpenCode session on this node.
//
// One server per adapter (i.e. per bizzi node), not per session or workspace: the v2 server is
// multi-location (every request/session carries `location.directory`), and each location the
// server loads starts the user's configured MCP servers, so one process amortizes that cost.
// The instance is private: its own ephemeral port and a random password. It never talks to
// or touches the user's background service (`opencode service`).

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Logger } from '@bizzi/protocol';
import { OpenCodeClient } from './client.ts';
import { locateBinary } from './locate.ts';
import type { OcEvent } from './types.ts';

export interface ServerListener {
  onEvent(ev: OcEvent): void;
  /**
   * The event stream was interrupted and events may have been missed. `crashed` is true when the
   * server process died (in-flight executions are gone) as opposed to a dropped connection.
   */
  onGap(info: { crashed: boolean; reason: string }): void;
  /** The stream is connected again after a gap. */
  onResync(): void;
}

export interface ServerOptions {
  /** `opencode` binary (default: "opencode" on PATH). */
  binary: string;
  hostname: string;
  /** 0 = ephemeral. */
  port: number;
  /** Extra environment for the server process. */
  env?: Record<string, string>;
  /** Working directory of the server process (its default location). */
  cwd?: string;
  /** Replace the launch command entirely (tests). Must print "server listening on <url>". */
  command?: string[];
  /** Attach to an already running server instead of spawning one (no lifecycle management). */
  url?: string;
  password?: string;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  healthIntervalMs: number;
  /** Restarts allowed within `restartWindowMs` before giving up. */
  maxRestarts: number;
  restartWindowMs: number;
  restartBackoffMs: number;
  logger: Logger;
}

type State = 'stopped' | 'starting' | 'ready' | 'restarting' | 'failed';

const LISTEN_RE = /server listening on (https?:\/\/\S+)/;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref?.());
}

export class OpenCodeServer {
  readonly opts: ServerOptions;
  #state: State = 'stopped';
  #client: OpenCodeClient | undefined;
  #child: ChildProcess | undefined;
  #starting: Promise<OpenCodeClient> | undefined;
  #listeners = new Set<ServerListener>();
  #streamAbort: AbortController | undefined;
  #healthTimer: NodeJS.Timeout | undefined;
  #stopping = false;
  #restarts: number[] = [];
  #exitHook: (() => void) | undefined;
  #version: string | undefined;

  constructor(opts: ServerOptions) {
    this.opts = opts;
  }

  get state(): State {
    return this.#state;
  }
  get client(): OpenCodeClient | undefined {
    return this.#client;
  }
  get version(): string | undefined {
    return this.#version;
  }
  get pid(): number | undefined {
    return this.#child?.pid;
  }

  subscribe(l: ServerListener): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }

  /** Start (or reuse) the server; resolves once the HTTP API and event stream are up. */
  ensure(): Promise<OpenCodeClient> {
    if (this.#state === 'ready' && this.#client) return Promise.resolve(this.#client);
    if (this.#starting) return this.#starting;
    if (this.#state === 'failed') this.#restarts = [];
    this.#stopping = false;
    this.#state = 'starting';
    this.#starting = this.#start().then(
      (c) => {
        this.#starting = undefined;
        return c;
      },
      (err: unknown) => {
        this.#starting = undefined;
        this.#state = 'failed';
        throw err;
      },
    );
    return this.#starting;
  }

  async #start(): Promise<OpenCodeClient> {
    const log = this.opts.logger;
    let client: OpenCodeClient;
    if (this.opts.url) {
      client = new OpenCodeClient({
        baseUrl: this.opts.url,
        password: this.opts.password,
        requestTimeoutMs: this.opts.requestTimeoutMs,
      });
      const info = await client.info(this.opts.startupTimeoutMs);
      this.#version = info.version;
    } else {
      client = await this.#spawn();
    }
    this.#client = client;
    await this.#openStream(client, false);
    this.#state = 'ready';
    this.#startHealth(client);
    log.log('info', 'opencode server ready', { url: client.baseUrl, version: this.#version, pid: this.#child?.pid });
    return client;
  }

  async #spawn(): Promise<OpenCodeClient> {
    const o = this.opts;
    const log = o.logger;
    const password = this.opts.password ?? randomBytes(24).toString('base64url');
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...o.env,
      // The server reads OPENCODE_PASSWORD first, then OPENCODE_SERVER_PASSWORD; set both so a
      // value inherited from the user's shell can't take over.
      OPENCODE_PASSWORD: password,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    };
    // The same lookup as the probe, so the server runs the install the probe reported.
    const [cmd, ...args] = o.command ?? [locateBinary(o.binary, env), 'serve', '--hostname', o.hostname, '--port', String(o.port)];
    if (!cmd) throw new Error('empty opencode command');
    log.log('debug', 'spawning opencode server', { cmd, args });
    const child = spawn(cmd, args, { env, cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    this.#child = child;

    const url = await new Promise<string>((resolve, reject) => {
      let out = '';
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`opencode serve did not start within ${o.startupTimeoutMs}ms`)), o.startupTimeoutMs);
      const finish = (err: Error | null, u?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          child.kill('SIGKILL');
          reject(err);
        } else resolve(u!);
      };
      const onData = (stream: 'stdout' | 'stderr') => (buf: Buffer) => {
        const text = buf.toString('utf8');
        if (!settled) {
          out += text;
          const m = LISTEN_RE.exec(out);
          if (m?.[1]) finish(null, m[1]);
          if (out.length > 64_000) out = out.slice(-8_000);
        }
        for (const line of text.split('\n')) if (line.trim()) log.log('debug', 'opencode server output', { stream, line: line.slice(0, 500) });
      };
      child.stdout?.on('data', onData('stdout'));
      child.stderr?.on('data', onData('stderr'));
      child.once('error', (e) => finish(e));
      child.once('exit', (code, signal) => finish(new Error(`opencode serve exited during startup (code ${code}, signal ${signal}): ${out.slice(-500)}`)));
    });

    child.once('exit', (code, signal) => this.#onExit(child, code, signal));
    // Don't keep the node process alive just for the server; the exit hook below kills it.
    child.unref();
    (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
    (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
    if (this.#stopping) {
      child.kill('SIGTERM');
      throw new Error('opencode server stopped during startup');
    }
    if (!this.#exitHook) {
      this.#exitHook = () => this.#child?.kill('SIGTERM');
      process.once('exit', this.#exitHook);
    }

    const client = new OpenCodeClient({ baseUrl: url, password, requestTimeoutMs: o.requestTimeoutMs });
    const info = await client.info(o.startupTimeoutMs);
    this.#version = info.version;
    return client;
  }

  /** Open the event stream; resolves when connected, then pumps events in the background. */
  async #openStream(client: OpenCodeClient, resync: boolean): Promise<void> {
    const ac = new AbortController();
    this.#streamAbort = ac;
    const gen = await client.events(ac.signal);
    if (resync) for (const l of this.#listeners) l.onResync();
    void this.#pump(client, gen, ac);
  }

  async #pump(client: OpenCodeClient, gen: AsyncGenerator<OcEvent>, ac: AbortController): Promise<void> {
    const log = this.opts.logger;
    let reason = 'event stream ended';
    try {
      for await (const ev of gen) {
        for (const l of this.#listeners) {
          try {
            l.onEvent(ev);
          } catch (err) {
            log.log('error', 'opencode event listener failed', { type: ev.type, err: String(err) });
          }
        }
      }
    } catch (err) {
      reason = `event stream error: ${String(err)}`;
    }
    if (ac.signal.aborted || this.#stopping || this.#client !== client) return;
    // Connection dropped while the process (or external server) may still be alive.
    if (this.#child && this.#child.exitCode !== null) return; // exit handler takes over
    log.log('warn', 'opencode event stream interrupted; reconnecting', { reason });
    for (const l of this.#listeners) l.onGap({ crashed: false, reason });
    let delay = 200;
    while (!this.#stopping && this.#client === client && !(this.#child && this.#child.exitCode !== null)) {
      try {
        await this.#openStream(client, true);
        return;
      } catch (err) {
        log.log('debug', 'opencode event stream reconnect failed', { err: String(err) });
        await sleep(delay);
        delay = Math.min(delay * 2, 5_000);
      }
    }
  }

  #startHealth(client: OpenCodeClient): void {
    clearInterval(this.#healthTimer);
    if (this.opts.healthIntervalMs <= 0) return;
    let failures = 0;
    this.#healthTimer = setInterval(() => {
      if (this.#client !== client || this.#state !== 'ready') return;
      client.info(Math.min(this.opts.healthIntervalMs, 10_000)).then(
        () => {
          failures = 0;
        },
        (err: unknown) => {
          failures++;
          this.opts.logger.log('warn', 'opencode health check failed', { failures, err: String(err) });
          if (failures >= 3 && this.#child && this.#child.exitCode === null) {
            this.opts.logger.log('error', 'opencode server unresponsive; killing it', { pid: this.#child.pid });
            this.#child.kill('SIGKILL'); // exit handler restarts
          }
        },
      );
    }, this.opts.healthIntervalMs);
    this.#healthTimer.unref();
  }

  #onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#child !== child) return;
    this.#child = undefined;
    clearInterval(this.#healthTimer);
    this.#streamAbort?.abort();
    this.#client = undefined;
    if (this.#stopping) {
      this.#state = 'stopped';
      return;
    }
    const reason = `opencode server exited (code ${code}, signal ${signal})`;
    this.opts.logger.log('warn', reason, {});
    for (const l of this.#listeners) l.onGap({ crashed: true, reason });
    const now = Date.now();
    this.#restarts = this.#restarts.filter((t) => now - t < this.opts.restartWindowMs);
    if (this.#listeners.size === 0) {
      this.#state = 'stopped';
      return;
    }
    if (this.#restarts.length >= this.opts.maxRestarts) {
      this.#state = 'failed';
      this.opts.logger.log('error', 'opencode server keeps crashing; giving up until next demand', {
        restarts: this.#restarts.length,
      });
      return;
    }
    this.#restarts.push(now);
    this.#state = 'restarting';
    const backoff = this.opts.restartBackoffMs * 2 ** (this.#restarts.length - 1);
    const restart = (async () => {
      await sleep(backoff);
      if (this.#stopping) throw new Error('opencode server stopped');
      const client = await this.#spawn();
      this.#client = client;
      await this.#openStream(client, true);
      this.#state = 'ready';
      this.#startHealth(client);
      this.opts.logger.log('info', 'opencode server restarted', { url: client.baseUrl, pid: this.#child?.pid });
      return client;
    })();
    // ensure() callers during the restart join this attempt instead of spawning a second server.
    this.#starting = restart.then(
      (c) => {
        this.#starting = undefined;
        return c;
      },
      (err: unknown) => {
        this.#starting = undefined;
        if (!this.#stopping) {
          this.#state = 'failed';
          this.opts.logger.log('error', 'opencode server restart failed', { err: String(err) });
        }
        throw err;
      },
    );
    this.#starting.catch(() => {});
  }

  /** Stop the server (SIGTERM, then SIGKILL after a grace period). Idempotent. */
  async stop(graceMs = 6_000): Promise<void> {
    this.#stopping = true;
    clearInterval(this.#healthTimer);
    this.#streamAbort?.abort();
    this.#client = undefined;
    const child = this.#child;
    if (this.#exitHook) {
      process.removeListener('exit', this.#exitHook);
      this.#exitHook = undefined;
    }
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.#child = undefined;
      this.#state = 'stopped';
      return;
    }
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), graceMs);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill('SIGTERM');
    });
    this.#child = undefined;
    this.#state = 'stopped';
  }
}
