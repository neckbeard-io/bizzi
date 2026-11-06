// Activity heuristics for terminal sessions: "the agent went quiet, it probably wants input".
//
// A burst starts with the first output after a quiet period (or with an explicit kick(), e.g. when
// bizzi types a prompt). Once output has been quiet for `idleMs`, onIdle fires once for that burst.
// Prompt detectors run against the ANSI-stripped text of the current burst; when one matches, the
// quiet period shrinks to `settleMs` so recognised prompts surface quickly, and the match is
// reported as the reason. Detectors are plain objects, so callers can add their own.

import type { AgentKind } from '@bizzi/protocol';
import { stripAnsi } from './ansi.ts';

export type PromptKind = 'input' | 'approval';

export interface PromptDetector {
  id: string;
  kind: PromptKind;
  /** Agents this detector applies to; omitted = every agent. */
  agents?: AgentKind[];
  /** Tested against the ANSI-stripped output of the current burst (tail-capped). */
  test(text: string): boolean;
  /** Free-form provenance, e.g. "verified against claude 2.1.311" or "unverified". */
  note?: string;
}

export function regexDetector(
  id: string,
  kind: PromptKind,
  re: RegExp,
  opts: { agents?: AgentKind[]; note?: string } = {},
): PromptDetector {
  return { id, kind, agents: opts.agents, note: opts.note, test: (text) => re.test(text) };
}

/** Regex source for a phrase that tolerates missing/extra whitespace between words (cursor moves). */
function phrase(words: string): string {
  return words
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s*');
}

function anyPhrase(...phrases: string[]): RegExp {
  return new RegExp(phrases.map(phrase).join('|'), 'i');
}

/** Last non-empty line of `text`. */
export function lastLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trimEnd();
    if (l.trim() !== '') return l;
  }
  return '';
}

export const DEFAULT_DETECTORS: readonly PromptDetector[] = [
  // Approvals first: when both match, the approval is the more useful reason.
  regexDetector(
    'claude-permission',
    'approval',
    anyPhrase(
      'Do you want to proceed?',
      'Do you want to make this edit',
      'Do you want to create',
      'Do you want to allow',
      'Do you want to overwrite',
    ),
    { agents: ['claude'], note: 'Claude Code permission dialog wording (2.x); not exercised in tests' },
  ),
  regexDetector('claude-trust', 'approval', anyPhrase('Yes, I trust this folder', 'Do you trust the files in this folder'), {
    agents: ['claude'],
    note: 'Claude Code folder-trust dialog; verified against claude 2.1.311',
  }),
  regexDetector(
    'codex-approval',
    'approval',
    anyPhrase(
      'Would you like to run the following command?',
      'Would you like to make the following edits?',
      'Allow command?',
      'Yes, proceed',
    ),
    { agents: ['codex'], note: 'Codex TUI approval wording; unverified (codex not installed)' },
  ),
  regexDetector(
    'agy-approval',
    'approval',
    anyPhrase('Allow execution', 'Allow once', 'Apply this change?', 'Waiting for user confirmation', 'Do you want to proceed?'),
    { agents: ['agy'], note: 'Gemini-CLI-style wording; unverified (agy not installed)' },
  ),
  {
    id: 'yes-no',
    kind: 'approval',
    note: 'generic [y/N] / (yes/no) confirmation on the last line',
    test: (text) => /[[(]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[\])]\s*[:?]?\s*$/i.test(lastLine(text)),
  },
  regexDetector('claude-input', 'input', anyPhrase('? for shortcuts'), {
    agents: ['claude'],
    note: 'Claude Code idle footer; unverified (trust dialog blocked the live check)',
  }),
  regexDetector('codex-input', 'input', anyPhrase('Ask Codex to do anything', '⏎ send'), {
    agents: ['codex'],
    note: 'Codex composer placeholder/footer; unverified',
  }),
  regexDetector('press-enter', 'input', anyPhrase('Press Enter to continue'), {
    note: 'generic "press enter" pause',
  }),
  {
    id: 'shell-prompt',
    kind: 'input',
    agents: ['shell'],
    note: 'last line ends in a typical shell prompt character ($ % # > ❯ ➜)',
    test: (text) => /[$%#>❯➜]\s?$/.test(lastLine(text)),
  },
];

/** The default detectors that apply to `agent`, approvals first. */
export function detectorsFor(agent: AgentKind, detectors: readonly PromptDetector[] = DEFAULT_DETECTORS): PromptDetector[] {
  const applicable = detectors.filter((d) => !d.agents || d.agents.includes(agent));
  return [...applicable.filter((d) => d.kind === 'approval'), ...applicable.filter((d) => d.kind === 'input')];
}

export interface IdleResult {
  /** Which detector matched, if any. */
  detector?: PromptDetector;
  kind: PromptKind | 'idle';
  /** Short machine-friendly reason, e.g. "approval:claude-permission" or "idle". */
  reason: string;
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
    const text = stripAnsi(this.#text);
    return this.#detectors.find((d) => {
      try {
        return d.test(text);
      } catch {
        return false;
      }
    });
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
    const detector = this.match();
    this.#active = false;
    this.#onIdle(
      detector ? { detector, kind: detector.kind, reason: `${detector.kind}:${detector.id}` } : { kind: 'idle', reason: 'idle' },
    );
  }
}
