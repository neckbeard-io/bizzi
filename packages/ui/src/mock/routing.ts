// Mock one-pane routing (spec §11.2): `route.suggest` with explicit tokens, routing rules and a keyword
// "classifier" (word overlap with workspace names, paths and session titles), plus `route.record`,
// `route.decisions` and `route.rules.*` in memory. `?mock=1&demo=norouting` answers `unsupported`, like a
// server without routing.
import { BizziError, ulid } from '@bizzi/protocol';
import type { MachineInfo, RouteCandidate, RouteDecision, RouteSuggestion, RoutingRule, WorkspaceInfo } from '@bizzi/protocol';
import { parseTokens } from '../lib/onePane.ts';
import type { MockHost, MockModule } from './host.ts';

const METHODS = new Set(['route.suggest', 'route.record', 'route.decisions', 'route.rules.get', 'route.rules.set']);
const THRESHOLD = 0.8;
const MODEL = 'mock/keywords';
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'why', 'what', 'how', 'it', 'this', 'that', 'up', 'since', 'with', 'fix']);

interface Target {
  m: MachineInfo;
  w: WorkspaceInfo;
  label: string;
  words: Set<string>;
}

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));

export class MockRouting implements MockModule {
  private readonly host: MockHost;
  private rules: RoutingRule[] = [{ id: 'rr_demo', match: ['production', 'prod*'], tag: 'prod-access' }];
  private readonly decisions: RouteDecision[] = [];

  constructor(host: MockHost) {
    this.host = host;
  }

  handles(method: string): boolean {
    return METHODS.has(method);
  }

  async handle(method: string, p: Record<string, unknown>): Promise<unknown> {
    if (this.host.demo.has('norouting')) throw new BizziError('unsupported', `unknown method ${method}`);
    switch (method) {
      case 'route.suggest':
        if (typeof p.text !== 'string' || !p.text.trim()) throw new BizziError('bad_request', 'text is required');
        await this.host.sleep(180);
        return { suggestion: this.suggest(p.text) };
      case 'route.record': {
        const d = p.decision as Omit<RouteDecision, 'id' | 'at'> | undefined;
        if (!d || typeof d.text !== 'string' || !d.chosen) throw new BizziError('bad_request', 'decision must be an object');
        const decision: RouteDecision = { ...d, id: `rd_${ulid()}`, at: new Date().toISOString() };
        this.decisions.unshift(decision);
        return { decision };
      }
      case 'route.decisions': {
        const list = typeof p.overridden === 'boolean' ? this.decisions.filter((d) => d.overridden === p.overridden) : this.decisions;
        const limit = typeof p.limit === 'number' ? p.limit : 100;
        const from = typeof p.before === 'string' ? list.findIndex((d) => d.id === p.before) + 1 : 0;
        return { decisions: list.slice(from, from + limit), total: list.length };
      }
      case 'route.rules.get':
        return { rules: this.rules };
      case 'route.rules.set': {
        if (!Array.isArray(p.rules)) throw new BizziError('bad_request', 'rules must be an array');
        this.rules = (p.rules as RoutingRule[]).map((r) => ({ ...r, id: r.id || `rr_${ulid()}` }));
        for (const r of this.rules) {
          if (!Array.isArray(r.match) || r.match.length === 0) throw new BizziError('bad_request', 'match needs at least one word or phrase');
          if ([r.tag, r.machineId, r.workspaceId].filter(Boolean).length !== 1) throw new BizziError('bad_request', 'exactly one of tag, machineId, workspaceId is required');
        }
        return { rules: this.rules };
      }
    }
    return undefined;
  }

  private targets(): Target[] {
    const machines = new Map(this.host.machines().map((m) => [m.id, m]));
    const titles = new Map<string, string[]>();
    for (const s of this.host.sessions()) if (s.title && !s.spawnedBy) titles.set(s.workspaceId, [...(titles.get(s.workspaceId) ?? []), s.title]);
    return this.host
      .workspaces()
      .filter((w) => w.kind !== 'worktree' && machines.has(w.machineId))
      .map((w) => {
        const m = machines.get(w.machineId)!;
        return { m, w, label: `${m.name} · ${w.name}`, words: new Set(words([w.name, w.path, ...(titles.get(w.id) ?? []), ...m.tags].join(' '))) };
      });
  }

  private suggest(raw: string): RouteSuggestion {
    const machines = this.host.machines();
    const all = this.targets();
    const tokens = parseTokens(raw, machines, this.host.workspaces());
    const text = raw
      .replace(/(^|\s)[@#/][\w.-]+/g, (tok, lead: string) => {
        const name = tok.trim().slice(1).replace(/\.$/, '').toLowerCase();
        const real = tokens.machines.some((m) => m.name.toLowerCase() === name || m.hostname.toLowerCase() === name) || tokens.workspaces.includes(name) || tokens.agent === name;
        return real ? lead : tok;
      })
      .replace(/\s+/g, ' ')
      .trim();
    const base = { text, ...(tokens.agent ? { agent: tokens.agent } : {}) };
    const cand = (t: Target, probability: number): RouteCandidate => ({ machineId: t.m.id, workspaceId: t.w.id, label: t.label, probability: Math.round(probability * 1000) / 1000 });
    const none = (note: string, offered = 0): RouteSuggestion => ({ ...base, source: 'none', candidates: [], confidence: 0, confident: false, offered, note });

    let set = all;
    let rule: { id: string; label: string } | undefined;
    let agent = tokens.agent;
    if (tokens.machines.length) set = set.filter((t) => tokens.machines.includes(t.m));
    if (tokens.workspaces.length) set = set.filter((t) => tokens.workspaces.includes(t.w.name.toLowerCase()));
    const narrowed = tokens.machines.length > 0 || tokens.workspaces.length > 0;
    if (narrowed) {
      if (set.length === 0) return none('no workspace matches those tokens');
      if (!set.some((t) => t.m.online)) return none(`${[...new Set(set.map((t) => t.m.name))].join(', ')} is offline`);
    } else {
      const lower = text.toLowerCase();
      const r = this.rules.find((x) => x.match.some((w) => (w.endsWith('*') ? new RegExp(`(?<![\\w-])${w.slice(0, -1)}`) : new RegExp(`(?<![\\w-])${w}(?![\\w-])`)).test(lower)));
      if (r) {
        const to = r.tag ?? machines.find((m) => m.id === r.machineId)?.name ?? all.find((t) => t.w.id === r.workspaceId)?.label ?? '?';
        rule = { id: r.id, label: `${r.match.join(', ')} → ${to}` };
        agent ??= r.agent;
        set = set.filter((t) => (r.tag ? t.m.tags.includes(r.tag) : r.machineId ? t.m.id === r.machineId : t.w.id === r.workspaceId));
        if (!set.some((t) => t.m.online)) return { ...none(`rule "${rule.label}": ${set.length ? 'its machines are offline' : 'no workspace matches'}`), rule };
      }
    }
    const extra = { ...(agent ? { agent } : {}), ...(rule ? { rule } : {}) };
    const online = set.filter((t) => t.m.online);
    if (online.length === 1) return { ...base, ...extra, source: rule ? 'rule' : narrowed ? 'explicit' : 'single', candidates: [cand(online[0]!, 1)], confidence: 1, confident: true, offered: 1 };
    if (online.length === 0) return none('no workspace on an online machine');

    // "Classifier": word overlap, softmaxed.
    const q = words(text);
    const scores = online.map((t) => q.filter((w) => t.words.has(w) || [...t.words].some((x) => x.startsWith(w) && w.length >= 4)).length);
    const exp = scores.map((s) => Math.exp(s * 2.2));
    const sum = exp.reduce((a, b) => a + b, 0);
    const probs = exp.map((e) => e / sum);
    const entropy = -probs.reduce((a, p) => a + (p > 0 ? p * Math.log(p) : 0), 0);
    const confidence = Math.round((1 - entropy / Math.log(online.length)) * 1000) / 1000;
    const ranked = online.map((t, i) => cand(t, probs[i]!)).sort((a, b) => b.probability - a.probability);
    return {
      ...base,
      ...extra,
      source: 'classifier',
      candidates: ranked.slice(0, 3),
      confidence,
      confident: confidence >= THRESHOLD,
      offered: online.length,
      classifier: { model: MODEL, ms: 180, letterMass: 0.998 },
    };
  }
}
