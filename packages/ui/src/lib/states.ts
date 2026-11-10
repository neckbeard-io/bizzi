// Labels and colour classes for session marks, billing classes and status sources (spec §11.1, §12.3).
import type { MarkState, MeterTone } from '@bizzi/client';
import type { AgentKind, BillingClass, RestartPolicy, UpdatePolicy } from '@bizzi/protocol';

export const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', agy: 'agy', shell: 'Shell' };

/** One-letter glyph inside a mark (agent-type icon). */
export const AGENT_GLYPH: Record<AgentKind, string> = { claude: 'C', codex: 'X', opencode: 'O', agy: 'A', shell: '$' };

export const MARK_LABEL: Record<MarkState, string> = { waiting: 'waiting', failed: 'failed', working: 'working', done: 'done, not yet seen', idle: 'idle' };

/** Text glyphs for compact counts (`⚠1 ◐2 ●3`). */
export const MARK_SYMBOL: Record<MarkState, string> = { waiting: '⚠', failed: '✗', working: '◐', done: '✓', idle: '●' };

// TODO(theming): switch to the state tokens (state-waiting/working/done/failed/idle) once index.css has them.
/** Text colour per state; colour carries state only. */
export const MARK_TEXT: Record<MarkState, string> = { waiting: 'text-warn', failed: 'text-err', working: 'text-info', done: 'text-ok', idle: 'text-muted' };
/** Ring/border colour per state. */
export const MARK_RING: Record<MarkState, string> = { waiting: 'border-warn', failed: 'border-err', working: 'border-info', done: 'border-ok', idle: 'border-muted/50' };
/** Filled dot per state (idle is hollow). */
export const MARK_DOT: Record<MarkState, string> = { waiting: 'bg-warn', failed: 'bg-err', working: 'bg-info', done: 'bg-ok', idle: 'border border-muted/70 bg-transparent' };

export const TONE_TEXT: Record<MeterTone, string> = { neutral: 'text-fg', warn: 'text-warn', err: 'text-err' };
export const TONE_FILL: Record<MeterTone, string> = { neutral: 'bg-muted/70', warn: 'bg-warn', err: 'bg-err' };

export const BILLING_LABEL: Record<BillingClass, string> = { metered: 'metered', plan: 'plan', budgetless: 'budgetless' };
export const BILLING_HINT: Record<BillingClass, string> = {
  metered: 'Pay per token; counts toward budgets and spend warnings',
  plan: 'Subscription with usage windows; not money per call',
  budgetless: 'Inference you own (local GPUs, gateway); excluded from budgets',
};

export const UPDATE_POLICY_LABEL: Record<UpdatePolicy, string> = { auto: 'Update automatically', notify: 'Notify me', pinned: 'Pinned' };
export const RESTART_POLICY_LABEL: Record<RestartPolicy, string> = { 'when-idle': 'Restart when idle', ask: 'Ask me', manual: 'Manual' };

/** "via OSC 7501", "detector: claude-permission", "reported by the adapter" (landscape.md §4.3 explain view). */
export function statusSourceLabel(source: string | undefined): string | null {
  if (!source) return null;
  if (source === 'osc7501') return 'via OSC 7501';
  if (source === 'adapter') return 'reported by the adapter';
  const i = source.indexOf(':');
  if (i > 0) {
    const kind = source.slice(0, i);
    const rest = source.slice(i + 1);
    if (kind === 'detector') return `detector: ${rest}`;
    if (kind === 'bizzi') return `bizzi: ${rest}`;
    return `${kind}: ${rest}`;
  }
  return `via ${source}`;
}

/** "↑2 ↓1", '' when in sync. */
export function aheadBehind(ahead: number, behind: number): string {
  const parts: string[] = [];
  if (ahead > 0) parts.push(`↑${ahead}`);
  if (behind > 0) parts.push(`↓${behind}`);
  return parts.join(' ');
}

/** "updates pending: 2 sessions" */
export function pendingUpdatesLabel(n: number): string {
  return `updates pending: ${n} session${n === 1 ? '' : 's'}`;
}

/** Usage share with the max marks shown before `+n` (four on desktop, three on the phone). */
export function visibleMarks<T>(marks: readonly T[], max: number): { shown: readonly T[]; more: number } {
  if (marks.length <= max) return { shown: marks, more: 0 };
  return { shown: marks.slice(0, max), more: marks.length - max };
}
