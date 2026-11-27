// Labels and color classes for session marks, billing classes and status sources (spec §11.1, §12.3).
import type { MarkState, MeterTone } from '@bizzi/client';
import type { AgentKind, BillingClass, RestartPolicy, UpdatePolicy } from '@bizzi/protocol';

export const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', agy: 'agy', shell: 'Shell', api: 'API chat' };

/** Short glyph in a mark's agent tile (agent-type icon). Codex isn't `X`, which would read as the failed ✗. */
export const AGENT_GLYPH: Record<AgentKind, string> = { claude: 'C', codex: 'Cx', opencode: 'O', agy: 'A', shell: '$', api: '@' };

/** Agent identity color (theme-resolved `--agent-<kind>`) for a mark's glyph tile: text, tint and edge. */
export const AGENT_TILE: Record<AgentKind, string> = {
  claude: 'text-agent-claude bg-agent-claude/20 ring-agent-claude/60',
  codex: 'text-agent-codex bg-agent-codex/20 ring-agent-codex/60',
  opencode: 'text-agent-opencode bg-agent-opencode/20 ring-agent-opencode/60',
  agy: 'text-agent-agy bg-agent-agy/20 ring-agent-agy/60',
  shell: 'text-agent-shell bg-agent-shell/20 ring-agent-shell/60',
  api: 'text-agent-api bg-agent-api/20 ring-agent-api/60',
};

export const MARK_LABEL: Record<MarkState, string> = { waiting: 'waiting', failed: 'failed', working: 'working', background: 'running in the background', done: 'done, not yet seen', idle: 'idle' };

/**
 * Text form of each state's symbol (the drawn ones are StateSymbol in components/marks.tsx): a spinner for
 * working, a dotted ring for background work, a warning for waiting, ✓ done, ✗ failed, a hollow dot for idle.
 * Shapes, not only colors, so states read for colorblind users.
 */
export const MARK_SYMBOL: Record<MarkState, string> = { waiting: '⚠', failed: '✗', working: '◐', background: '∿', done: '✓', idle: '○' };

/**
 * Text color per state (theme state tokens, which themes can't camouflage); the symbol's shape carries the state too.
 * Background work is still activity, so it shares the working color; its dotted ring tells them apart.
 */
export const MARK_TEXT: Record<MarkState, string> = {
  waiting: 'text-state-waiting',
  failed: 'text-state-failed',
  working: 'text-state-working',
  background: 'text-state-working',
  done: 'text-state-done',
  idle: 'text-state-idle',
};
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
