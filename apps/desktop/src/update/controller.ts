// The self-updater's state machine (main process). Checks GitHub Releases on a channel, downloads the
// asset for this install, and hands it to the installer. Every collaborator is injected, so tests
// drive it without Electron or the network.
//
// Rules carried over from flax's updater:
//   - a background check that fails leaves the screen as it was (no error nobody asked about)
//   - a skipped version stays hidden from background checks, not from "Check now"
//   - a check that lands after a download started leaves the download alone
//   - only the newest download may change the state (a cancelled one can still be winding down)

import { readFileSync, writeFileSync } from 'node:fs';
import type { UpdateAction, UpdateChannel, UpdateState } from '../shared/update.ts';
import { downloadAsset } from './download.ts';
import { describeFailure, fetchReleases, latestFor, matchAsset, type Fetch, type GitHubAsset } from './github.ts';
import type { InstallTarget } from './install.ts';
import { compareSemver, isPrerelease } from './semver.ts';

export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const FIRST_CHECK_DELAY_MS = 15_000;

export interface UpdatePrefs {
  channel: UpdateChannel;
  autoCheck: boolean;
  skippedVersion?: string;
}

export interface PrefsStore {
  load(): Partial<UpdatePrefs>;
  save(p: UpdatePrefs): void;
}

/** Prefs in a JSON file (userData/update.json). */
export function filePrefs(file: string): PrefsStore {
  return {
    load: () => {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as Partial<UpdatePrefs>;
      } catch {
        return {};
      }
    },
    save: (p) => writeFileSync(file, JSON.stringify(p, null, 2)),
  };
}

export interface UpdateControllerOptions {
  currentVersion: string;
  arch: string;
  target: InstallTarget;
  fetch: Fetch;
  prefs: PrefsStore;
  downloadDir: string;
  /** Runs the installer for a downloaded file; resolves 'quit' when bizzi exits for it. */
  install: (file: string) => Promise<'quit' | 'manual'>;
  onState: (s: UpdateState) => void;
  log: (level: 'info' | 'warn', msg: string, fields?: Record<string, unknown>) => void;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  download?: typeof downloadAsset;
}

export class UpdateController {
  #o: UpdateControllerOptions;
  #state: UpdateState;
  #asset: GitHubAsset | null = null;
  #file: string | null = null;
  #abort: AbortController | null = null;
  #timer: { cancel(): void } | null = null;
  #checking = false;

  constructor(o: UpdateControllerOptions) {
    this.#o = o;
    const p = o.prefs.load();
    const channel: UpdateChannel = p.channel === 'dev' || p.channel === 'stable' ? p.channel : isPrerelease(o.currentVersion) ? 'dev' : 'stable';
    this.#state = {
      stage: 'idle',
      currentVersion: o.currentVersion,
      channel,
      autoCheck: p.autoCheck ?? true,
      method: o.target.method,
      methodLabel: o.target.label,
      ...(o.target.hint ? { hint: o.target.hint } : {}),
      ...(p.skippedVersion ? { skippedVersion: p.skippedVersion } : {}),
    };
  }

  get state(): UpdateState {
    return this.#state;
  }

  /** Background checks: one shortly after launch, then every few hours, while auto-check is on. */
  start(): void {
    this.#schedule(FIRST_CHECK_DELAY_MS);
  }

  stop(): void {
    this.#timer?.cancel();
    this.#timer = null;
    this.#abort?.abort();
  }

  async act(a: UpdateAction): Promise<void> {
    switch (a.type) {
      case 'check':
        return this.check({ silent: false });
      case 'download':
        return this.download();
      case 'install':
        return this.install();
      case 'cancel':
        return this.cancel();
      case 'skip':
        return this.skip();
      case 'channel':
        this.#set({ channel: a.channel });
        this.#savePrefs();
        return this.check({ silent: false });
      case 'autoCheck':
        this.#set({ autoCheck: a.enabled });
        this.#savePrefs();
        this.#timer?.cancel();
        this.#timer = null;
        if (a.enabled) this.#schedule(CHECK_INTERVAL_MS);
        return;
    }
  }

  async check(opts: { silent: boolean }): Promise<void> {
    const s = this.#state;
    if (this.#checking || this.#downloadStarted()) return;
    this.#checking = true;
    const before = { stage: s.stage, error: s.error };
    // A background check doesn't flash "checking" over an update that is already offered.
    if (!opts.silent || !this.#offered()) this.#set({ stage: 'checking', error: undefined });
    try {
      const releases = await fetchReleases(this.#o.fetch);
      if (this.#downloadStarted()) return;
      const lastCheckedAt = this.#now().toISOString();
      const found = latestFor(releases, this.#state.channel, this.#o.currentVersion);
      if (!found || compareSemver(found.release.tag_name, this.#o.currentVersion) <= 0) {
        this.#asset = null;
        this.#set({ stage: 'up-to-date', lastCheckedAt, error: undefined, asset: undefined, progress: undefined, latest: found ? this.#release(found.release, found.notes) : undefined });
        return;
      }
      const latest = this.#release(found.release, found.notes);
      if (opts.silent && this.#state.skippedVersion === latest.version) {
        this.#set({ stage: 'idle', lastCheckedAt, error: undefined, latest });
        return;
      }
      const asset = matchAsset(found.release, this.#o.target.method, this.#o.arch);
      const changed = this.#state.latest?.version !== latest.version;
      if (changed) this.#file = null;
      this.#asset = asset;
      this.#set({
        stage: 'available',
        lastCheckedAt,
        latest,
        error: undefined,
        asset: asset ? { name: asset.name, size: asset.size } : undefined,
        ...(changed ? { progress: undefined } : {}),
      });
    } catch (err) {
      this.#o.log('warn', 'update check failed', { error: String(err) });
      if (this.#downloadStarted()) return;
      if (opts.silent) this.#set({ stage: before.stage, error: before.error });
      else this.#set({ stage: 'error', error: describeFailure(err) });
    } finally {
      this.#checking = false;
    }
  }

  async download(): Promise<void> {
    if (this.#state.stage === 'downloading' || this.#state.stage === 'installing') return;
    const asset = this.#asset;
    if (!asset) {
      this.#set({ stage: 'error', error: this.#o.target.hint ?? 'This release has no download for this platform.' });
      return;
    }
    const abort = new AbortController();
    this.#abort?.abort();
    this.#abort = abort;
    const current = () => this.#abort === abort;
    this.#o.log('info', 'downloading update', { asset: asset.name });
    this.#set({ stage: 'downloading', error: undefined, progress: { received: 0, total: asset.size } });
    let last = 0;
    try {
      const file = await (this.#o.download ?? downloadAsset)({
        fetch: this.#o.fetch,
        asset,
        dir: this.#o.downloadDir,
        signal: abort.signal,
        onProgress: (received, total) => {
          if (!current()) return;
          const t = Date.now();
          if (t - last < 100 && received < total) return;
          last = t;
          this.#set({ progress: { received, total } });
        },
      });
      if (!current()) return;
      this.#file = file;
      this.#o.log('info', 'update downloaded', { file });
      this.#set({ stage: 'ready', progress: { received: asset.size, total: asset.size } });
    } catch (err) {
      if (!current()) return;
      if (abort.signal.aborted) this.#set({ stage: 'available', progress: undefined });
      else {
        this.#o.log('warn', 'update download failed', { error: String(err) });
        this.#set({ stage: 'error', error: `Download failed: ${describeFailure(err)}` });
      }
    } finally {
      if (current()) this.#abort = null;
    }
  }

  cancel(): void {
    if (this.#state.stage !== 'downloading') return;
    this.#abort?.abort();
    this.#abort = null;
    this.#set({ stage: 'available', progress: undefined });
  }

  async install(): Promise<void> {
    if (!this.#file) return this.download();
    this.#set({ stage: 'installing', error: undefined });
    try {
      const outcome = await this.#o.install(this.#file);
      if (outcome === 'manual') this.#set({ stage: 'ready' });
    } catch (err) {
      this.#o.log('warn', 'update install failed', { error: String(err) });
      this.#set({ stage: 'error', error: `Install failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  skip(): void {
    const v = this.#state.latest?.version;
    if (!v) return;
    this.#set({ skippedVersion: v, stage: 'idle' });
    this.#savePrefs();
  }

  #schedule(ms: number): void {
    if (!this.#state.autoCheck) return;
    const setTimer = this.#o.setTimer ?? defaultTimer;
    this.#timer = setTimer(() => {
      void this.check({ silent: true }).finally(() => this.#schedule(CHECK_INTERVAL_MS));
    }, ms);
  }

  #release(r: { tag_name: string; name?: string | null; html_url: string; published_at?: string | null; prerelease: boolean }, notes: string) {
    return {
      version: r.tag_name.replace(/^v/, ''),
      tag: r.tag_name,
      title: r.name || `bizzi ${r.tag_name}`,
      notes,
      url: r.html_url,
      publishedAt: r.published_at ?? '',
      prerelease: r.prerelease,
    };
  }

  #offered(): boolean {
    return ['available', 'downloading', 'ready', 'installing'].includes(this.#state.stage);
  }

  #downloadStarted(): boolean {
    return ['downloading', 'ready', 'installing'].includes(this.#state.stage);
  }

  #savePrefs(): void {
    const s = this.#state;
    try {
      this.#o.prefs.save({ channel: s.channel, autoCheck: s.autoCheck, ...(s.skippedVersion ? { skippedVersion: s.skippedVersion } : {}) });
    } catch (err) {
      this.#o.log('warn', 'could not save update settings', { error: String(err) });
    }
  }

  #now(): Date {
    return this.#o.now?.() ?? new Date();
  }

  #set(patch: Partial<UpdateState>): void {
    const next: UpdateState = { ...this.#state, ...patch };
    for (const k of Object.keys(patch) as (keyof UpdateState)[]) if (patch[k] === undefined) delete next[k];
    this.#state = next;
    this.#o.onState(next);
  }
}

function defaultTimer(fn: () => void, ms: number): { cancel(): void } {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
}
