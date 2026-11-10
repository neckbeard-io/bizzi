// Activity heuristics for terminal sessions: "the agent went quiet, it probably wants input".
//
// A burst starts with the first output after a quiet period (or with an explicit kick(), e.g. when
// bizzi types a prompt). Once output has been quiet for `idleMs`, onIdle fires once for that burst.
// Prompt detectors run against the ANSI-stripped text of the current burst; when one matches, the
// quiet period shrinks to `settleMs` so recognised prompts surface quickly, and the match is
// reported as the reason. Detectors are plain objects, so callers can add their own; the shipped
// set is data (data/detectors.json, see detectors.ts). OSC 7501 reports, when a program sends
// them, take precedence over all of this (adapter.ts).

import { stripAnsi } from './ansi.ts';
import { detectorsFor, lastLine, regexDetector, shippedDetectors, type PromptDetector, type PromptKind } from './detectors.ts';

export { detectorsFor, lastLine, regexDetector, type PromptDetector, type PromptKind };

/**
 * The shipped detector set (data/detectors.json), compiled. Nodes normally use `loadDetectorSet()`,
 * which also applies the data-dir override and the BIZZI_DETECTORS=off switch.
 */
export const DEFAULT_DETECTORS: readonly PromptDetector[] = shippedDetectors().detectors;

export interface IdleResult {
  /** Which detector matched, if any. */
  detector?: PromptDetector;
  kind: PromptKind | 'idle';
  /** Short machine-friendly reason, e.g. "approval:claude-permission" or "idle". */
  reason: string;
  /** The ANSI-stripped text the detector matched (shortened), for "explain". */
  excerpt?: string;
}

export interface ActivityMonitorOptions {
  /** Quiet period after activity before reporting idle. Default 3000 ms. */
  idleMs?: number;
  /** Quiet period when a prompt detector matches. Default 500 ms (never more than idleMs). */
  settleMs?: number;
  /** Small output this soon after user input is treated as echo and does not start a burst. */
  echoWindowMs?: number;
  echoMaxBytes?: number;
  /** Detectors to run, in priority order. Default: none. */
  detectors?: readonly PromptDetector[];
  /** How much burst text (raw) to keep for detectors. Default 16 KiB. */
  maxTextChars?: number;
  onActive?: () => void;
  onIdle: (result: IdleResult) => void;
}

export const DEFAULT_IDLE_MS = 3000;
export const DEFAULT_SETTLE_MS = 500;

const MAX_EXCERPT = 160;

export class ActivityMonitor {
  readonly idleMs: number;
  readonly settleMs: number;
  #echoWindowMs: number;
  #echoMaxBytes: number;
  #detectors: readonly PromptDetector[];
  #maxText: number;
  #onActive: (() => void) | undefined;
  #onIdle: (r: IdleResult) => void;
  #active = false;
  #text = '';
  #lastInputAt = -Infinity;
  #timer: NodeJS.Timeout | undefined;
  #disposed = false;

  constructor(opts: ActivityMonitorOptions) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.settleMs = Math.min(opts.settleMs ?? DEFAULT_SETTLE_MS, this.idleMs);
    this.#echoWindowMs = opts.echoWindowMs ?? 150;
    this.#echoMaxBytes = opts.echoMaxBytes ?? 64;
    this.#detectors = opts.detectors ?? [];
    this.#maxText = opts.maxTextChars ?? 16 * 1024;
    this.#onActive = opts.onActive;
    this.#onIdle = opts.onIdle;
  }

  /** Whether a burst is in progress (output seen and not yet reported idle). */
  get active(): boolean {
    return this.#active;
  }

  /** Feed decoded terminal output. `bytes` is the raw size (for echo suppression). */
  output(text: string, bytes: number = Buffer.byteLength(text)): void {
    if (this.#disposed) return;
    if (!this.#active) {
      const isEcho = Date.now() - this.#lastInputAt < this.#echoWindowMs && bytes <= this.#echoMaxBytes;
      if (isEcho) return;
      this.#active = true;
      this.#text = '';
      this.#onActive?.();
    }
    this.#text += text;
    if (this.#text.length > this.#maxText) this.#text = this.#text.slice(-this.#maxText);
    this.#schedule();
  }

  /** Note user keystrokes (raw terminal input). */
  input(): void {
    this.#lastInputAt = Date.now();
  }

  /** Start a burst now (bizzi typed a prompt), even if no output follows. */
  kick(): void {
    if (this.#disposed) return;
    this.#active = true;
    this.#text = '';
    this.#lastInputAt = Date.now();
    this.#schedule();
  }

  /** Evaluate detectors against the current burst text. */
  match(): PromptDetector | undefined {
    return this.matchWithExcerpt()?.detector;
  }

  /** Like match(), plus the matched excerpt (the last line when the detector can't say). */
  matchWithExcerpt(): { detector: PromptDetector; excerpt: string } | undefined {
    if (this.#detectors.length === 0) return undefined;
    const text = stripAnsi(this.#text);
    for (const d of this.#detectors) {
      try {
        if (d.match) {
          const m = d.match(text);
          if (m !== undefined) return { detector: d, excerpt: m };
        } else if (d.test(text)) {
          return { detector: d, excerpt: lastLine(text).trim().slice(0, MAX_EXCERPT) };
        }
      } catch {
        // A broken detector never breaks the session.
      }
    }
    return undefined;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    const delay = this.#detectors.length > 0 && this.match() ? this.settleMs : this.idleMs;
    this.#timer = setTimeout(() => this.#fire(), delay);
  }

  #fire(): void {
    this.#timer = undefined;
    if (this.#disposed || !this.#active) return;
    const hit = this.matchWithExcerpt();
    this.#active = false;
    this.#onIdle(
      hit
        ? { detector: hit.detector, kind: hit.detector.kind, reason: `${hit.detector.kind}:${hit.detector.id}`, excerpt: hit.excerpt }
        : { kind: 'idle', reason: 'idle' },
    );
  }
}
