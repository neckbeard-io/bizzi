/**
 * Slash commands in the composer. bizzi's own (`/clear`) work on every structured agent and run
 * as session methods; the agent's advertised ones (`session.info.commands`) are sent as the message
 * text, which the agent runs itself.
 */
export interface SlashCommand {
  /** Without the leading slash. */
  name: string;
  description?: string;
  /** Run by bizzi rather than sent to the agent. */
  builtin?: boolean;
}

export type BuiltinCommand = 'clear';

export const BUILTIN_COMMANDS: readonly SlashCommand[] = [
  { name: 'clear', description: 'Fresh conversation: the agent forgets everything so far', builtin: true },
];

/** Other names people type for a built-in. */
const ALIASES: Readonly<Record<string, BuiltinCommand>> = { clear: 'clear', new: 'clear', reset: 'clear' };

const MAX_SHOWN = 8;

/** bizzi's commands first, then the agent's, each name once (bizzi's win). */
export function sessionCommands(advertised: readonly { name: string; description?: string }[] | undefined): SlashCommand[] {
  const out: SlashCommand[] = [...BUILTIN_COMMANDS];
  const seen = new Set(out.map((c) => c.name));
  for (const c of advertised ?? []) {
    const name = c.name.replace(/^\/+/, '').trim();
    if (!name || /\s/.test(name) || seen.has(name) || ALIASES[name]) continue;
    seen.add(name);
    out.push(c.description ? { name, description: c.description } : { name });
  }
  return out;
}

/** The command name being typed: the draft starts with `/` and the caret is still in that first word. */
export function slashQuery(text: string, caret: number): string | null {
  const m = /^\/(\S*)/.exec(text);
  if (!m || caret < 1 || caret > m[0].length) return null;
  return m[1]!;
}

/** Commands matching `query`: name prefix first, then a later word of the name, then anywhere. */
export function matchCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const rank = (c: SlashCommand): number => {
    const n = c.name.toLowerCase();
    if (n.startsWith(q)) return 0;
    if (n.split(/[:._-]/).some((w) => w.startsWith(q))) return 1;
    return n.includes(q) ? 2 : -1;
  };
  return commands
    .map((c, i) => ({ c, r: rank(c), i }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, MAX_SHOWN)
    .map((x) => x.c);
}

/** A draft that is exactly a built-in command (`/clear`, `/new`, `/reset`), else null. */
export function builtinCommand(text: string): BuiltinCommand | null {
  const m = /^\/(\w+)$/.exec(text.trim());
  return m ? (ALIASES[m[1]!.toLowerCase()] ?? null) : null;
}

/** The draft with its first word replaced by the picked command and one space after it. */
export function applyCommand(text: string, c: SlashCommand): { text: string; caret: number } {
  const rest = text.replace(/^\/\S*/, '');
  const head = `/${c.name}`;
  const next = `${head}${/^\s/.test(rest) ? '' : ' '}${rest}`;
  return { text: next, caret: head.length + 1 };
}
