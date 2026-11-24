// Step 1 of routing (spec §11.2): `@machine`, `#workspace` and `/agent` in the text always win.
// A token is consumed when it names something that exists, online or not; anything else stays in the
// text (an email address, `#123`, a path). Tokens combine: `@mac-mini #acme-shop` is that one workspace.
// When the tokens name real things that can't all hold (a workspace that isn't on the named machine,
// a machine that's offline), routing stops with `problem` instead of guessing elsewhere.

import { AGENT_KINDS, type AgentKind, type MachineInfo } from '@bizzi/protocol';
import type { RouteTarget } from './catalogue.ts';

export interface ExplicitRoute {
  /** Online targets left after the `@` and `#` filters (every online target when neither matched). */
  targets: RouteTarget[];
  /** Whether a `@` or `#` token matched. */
  narrowed: boolean;
  /** The `@` / `#` tokens that matched, as typed. */
  used: string[];
  agent?: AgentKind;
  /** The text without the consumed tokens. */
  text: string;
  /** Set when the tokens can't be satisfied: nothing matches all of them, or what matches is offline. */
  problem?: string;
}

// Names may contain dots (`@laptop.local`) but not end in one, so `on @mac-mini.` still matches.
const TOKEN = /(^|\s)([@#/])([\w-]+(?:\.[\w-]+)*)(?=\s|$|[,.;:!?)\]])/g;
const norm = (s: string) => s.toLowerCase();

/**
 * @param all every target, offline machines included (`buildTargets(input, { includeOffline: true })`)
 * @param machines every known machine, so `@name` is recognised even when it has no workspaces
 */
export function parseExplicit(text: string, all: RouteTarget[], machines: MachineInfo[] = uniqueMachines(all)): ExplicitRoute {
  let set = all;
  const used: string[] = [];
  let agent: AgentKind | undefined;
  let problem: string | undefined;
  const consumed: [number, number][] = [];
  for (const m of text.matchAll(TOKEN)) {
    const [, lead = '', sigil, name = ''] = m;
    const n = norm(name);
    const start = (m.index ?? 0) + lead.length;
    const end = start + 1 + name.length;
    if (sigil === '/') {
      if ((AGENT_KINDS as readonly string[]).includes(n)) {
        agent = n as AgentKind;
        consumed.push([start, end]);
      }
      continue;
    }
    const token = `${sigil}${name}`;
    let next: RouteTarget[];
    if (sigil === '@') {
      const named = machines.filter((x) => norm(x.name) === n || norm(x.hostname) === n);
      if (named.length === 0) continue;
      next = set.filter((t) => named.some((x) => x.id === t.machine.id));
      if (!problem && next.length === 0 && used.length === 0) {
        problem = named.every((x) => !x.online) ? offline(named.map((x) => x.name)) : `${named[0]!.name} has no workspaces`;
      }
    } else {
      if (!all.some((t) => norm(t.workspace.name) === n)) continue;
      next = set.filter((t) => norm(t.workspace.name) === n);
    }
    consumed.push([start, end]);
    if (!problem && next.length === 0) problem = `no workspace matches ${[...used, token].join(' and ')}`;
    used.push(token);
    set = next;
  }

  const online = set.filter((t) => t.machine.online);
  if (!problem && used.length > 0 && online.length === 0) {
    const names = [...new Set(set.map((t) => t.machine.name))];
    problem = used.some((u) => u.startsWith('@')) ? offline(names) : `${used.join(' ')} is only on ${names.join(', ')}, which ${names.length > 1 ? 'are' : 'is'} offline`;
  }

  let rest = text;
  for (const [s, e] of consumed.reverse()) {
    // `on @mac-mini.` becomes `on.`, not `on .`
    const from = /^[,.;:!?)\]]/.test(rest.slice(e)) && /\s$/.test(rest.slice(0, s)) ? s - 1 : s;
    rest = rest.slice(0, from) + rest.slice(e);
  }
  return {
    targets: problem ? [] : online,
    narrowed: used.length > 0,
    used,
    ...(agent ? { agent } : {}),
    text: rest.replace(/\s+/g, ' ').trim(),
    ...(problem ? { problem } : {}),
  };
}

const offline = (names: string[]) => `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} offline`;

function uniqueMachines(targets: RouteTarget[]): MachineInfo[] {
  return [...new Map(targets.map((t) => [t.machine.id, t.machine])).values()];
}
