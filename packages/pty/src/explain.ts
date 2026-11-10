// "Explain" for terminal-mode statuses (landscape.md §4.3): which OSC 7501 record, detector or
// timer produced the current `session.status`, with the matched text and when. The short form
// travels on every event as `session.status.source`; the full record is kept on the session.

import type { SessionStatus } from '@bizzi/protocol';
import type { PromptKind } from './detectors.ts';
import type { BlockedKind, ProgramState } from './program-status.ts';

export type StatusPrompt = 'approval' | 'input' | 'login' | 'question';

export interface StatusProvenance {
  status: SessionStatus;
  prompt?: StatusPrompt;
  reason?: string;
  /**
   * Same value as the event's `source`: 'osc7501', 'osc133' (new prompt dropped working/blocked
   * records), 'detector:<id>', 'activity:idle' (quiet timer, nothing matched), 'activity:output'
   * (output resumed) or 'process' (exit).
   */
  source: string;
  /** ISO time the status was set. */
  at: string;
  /** source 'osc7501': the record that decided it. */
  osc?: {
    id: string;
    state: ProgramState;
    kind?: BlockedKind;
    app?: string;
    title?: string;
    msg?: string;
    progress?: number;
    /** Live records at the time (the decision is the most urgent one). */
    records: number;
  };
  /** source 'detector:<id>'. */
  detector?: {
    id: string;
    kind: PromptKind;
    note?: string;
    /** e.g. "builtin@2026.11.10" or an override file path. */
    origin?: string;
    /** ANSI-stripped text that matched (shortened). */
    excerpt?: string;
  };
}

/** Anything that can explain its status (TerminalSession does). */
export interface ExplainableSession {
  statusProvenance(): StatusProvenance | undefined;
}

/**
 * Provenance of an adapter session's current status, if the session can tell (terminal-mode
 * sessions can; structured adapters return undefined). Safe to call with any AdapterSession.
 */
export function explainSessionStatus(session: unknown): StatusProvenance | undefined {
  const s = session as Partial<ExplainableSession> | null | undefined;
  return typeof s?.statusProvenance === 'function' ? s.statusProvenance() : undefined;
}

/** One human-readable line, e.g. for logs or a tooltip. */
export function formatStatusProvenance(p: StatusProvenance): string {
  const head = p.prompt ? `${p.status} (${p.prompt})` : p.status;
  const parts: string[] = [];
  if (p.osc) {
    const what = p.osc.kind ? `${p.osc.state}/${p.osc.kind}` : p.osc.state;
    const rec = p.osc.id === '' ? 'root record' : `record "${p.osc.id}"`;
    const extra = [p.osc.app && `app ${p.osc.app}`, p.osc.progress !== undefined && `${p.osc.progress}%`].filter(Boolean).join(', ');
    parts.push(`OSC 7501 ${rec}: ${what}${extra ? ` (${extra})` : ''}`);
    const text = p.osc.msg ?? p.osc.title;
    if (text) parts.push(JSON.stringify(text));
  } else if (p.detector) {
    const meta = [p.detector.note, p.detector.origin].filter(Boolean).join('; ');
    parts.push(`detector ${p.detector.id}${meta ? ` (${meta})` : ''}`);
    if (p.detector.excerpt) parts.push(`matched ${JSON.stringify(p.detector.excerpt)}`);
  } else {
    parts.push(p.source);
    if (p.reason) parts.push(p.reason);
  }
  return `${head} from ${parts.join(', ')} at ${p.at}`;
}
