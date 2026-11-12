// Mock knowledge store: rules and memories, inbox suggestions, settings (docs/knowledge.md).
import { BizziError, GLOBAL_CHANNEL } from '@bizzi/protocol';
import type { AgentKind, KnowledgeInboxCard, KnowledgeItemInfo, KnowledgeScope, KnowledgeScopeLevel, KnowledgeSettings } from '@bizzi/protocol';
import type { MockHost, MockModule } from './host.ts';

const LAPTOP = 'm_laptop';
const SERVER = 'm_server';

let counter = 0;

function ago(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

type Seed = Omit<KnowledgeItemInfo, 'createdAt' | 'updatedAt' | 'tags' | 'status'> & { tags?: string[]; status?: KnowledgeItemInfo['status']; ageMin: number };

const SEED: Seed[] = [
  {
    id: 'k_pnpm',
    type: 'rule',
    scope: { level: 'global' },
    title: 'Use pnpm, never npm or yarn, in JavaScript projects',
    body: 'Install with `pnpm install`, add packages with `pnpm add`. If a repo has a package-lock.json, ask before converting it.',
    tags: ['tooling', 'js'],
    source: { machineId: LAPTOP, via: 'ui' },
    ageMin: 60 * 24 * 12,
  },
  {
    id: 'k_style',
    type: 'memory',
    kind: 'preference',
    scope: { level: 'global' },
    title: 'Prefers small commits with plain, descriptive messages',
    body: 'No emoji, no conventional-commit prefixes. One logical change per commit; mention the why in the body when it is not obvious.',
    tags: ['git'],
    source: { machineId: LAPTOP, via: 'harvest', agent: 'claude' },
    ageMin: 60 * 24 * 9,
  },
  {
    id: 'k_migrations',
    type: 'rule',
    scope: { level: 'workspace', workspaceId: 'w_acme' },
    title: 'Never edit files in migrations/',
    body: 'Migrations that shipped are immutable. Create a new migration instead, and run `pnpm db:check` before finishing.',
    tags: ['db'],
    source: { machineId: LAPTOP, via: 'tool', agent: 'claude', sessionId: 's_demo', userRequested: true },
    ageMin: 60 * 24 * 4,
  },
  {
    id: 'k_flaky',
    type: 'memory',
    kind: 'gotcha',
    scope: { level: 'workspace', workspaceId: 'w_acme' },
    title: 'checkout.spec.ts races the payment mock',
    body: 'The payment mock settles on the next tick. Await `payments.settled()` before asserting on order status; never add sleeps.',
    tags: ['tests', 'flaky'],
    source: { machineId: LAPTOP, via: 'tool', agent: 'claude', sessionId: 's_demo' },
    ageMin: 25,
  },
  {
    id: 'k_fmt',
    type: 'rule',
    scope: { level: 'project', projectId: 'p_acme' },
    appliesTo: ['codex'],
    title: 'Codex: run `just fmt` before finishing',
    body: 'Codex does not pick up the editor formatter. Run `just fmt` as the last step of every turn that edits code.',
    tags: ['format'],
    source: { machineId: LAPTOP, via: 'ui' },
    ageMin: 60 * 24 * 6,
  },
  {
    id: 'k_retry',
    type: 'memory',
    kind: 'decision',
    scope: { level: 'project', projectId: 'p_acme' },
    title: 'Payment retries: 3 attempts, exponential backoff, idempotency key',
    body: 'Decided after the March incident: `withRetry()` in src/payments/retry.ts; never retry without the idempotency key header.',
    tags: ['payments'],
    source: { machineId: LAPTOP, via: 'tool', agent: 'codex', sessionId: 's_review' },
    ageMin: 80,
  },
  {
    id: 'k_staging_db',
    type: 'memory',
    kind: 'fact',
    scope: { level: 'machine', machineId: SERVER },
    title: 'Staging Postgres runs on server-a:5433',
    body: 'Container `db-staging`, data in /data/pg-staging. Credentials are in the machine keychain entry `staging-db`.',
    tags: ['db', 'infra'],
    source: { machineId: SERVER, via: 'tool', agent: 'claude', sessionId: 's_infra' },
    ageMin: 60 * 3,
  },
  {
    id: 'k_scratch',
    type: 'rule',
    scope: { level: 'machine', machineId: SERVER },
    title: 'On server-a, use /data/scratch for temporary files',
    body: 'The root disk is small. Put build caches, dumps and downloads under /data/scratch, and clean up after yourself.',
    tags: ['infra'],
    source: { machineId: SERVER, via: 'ui' },
    ageMin: 60 * 24 * 20,
  },
  {
    id: 'k_prod_kubectl',
    type: 'rule',
    scope: { level: 'tag', tag: 'prod-access' },
    title: 'Prod clusters: read-only kubectl, always pass --context',
    body: 'get, describe, logs, top and events only. Never apply, edit, delete, exec or read Secrets.',
    tags: ['k8s'],
    source: { machineId: LAPTOP, via: 'ui' },
    ageMin: 60 * 24 * 3,
  },
  {
    id: 'k_gui',
    type: 'memory',
    kind: 'reference',
    scope: { level: 'machine', machineId: LAPTOP },
    title: 'Playwright browsers are installed on this laptop',
    body: 'Headed runs work here (Aqua session). Use `pnpm exec playwright test --headed` for visual debugging.',
    tags: ['tests'],
    source: { machineId: LAPTOP, via: 'extract', agent: 'opencode' },
    ageMin: 60 * 30,
  },
  {
    id: 'k_crdt',
    type: 'memory',
    kind: 'reference',
    scope: { level: 'workspace', workspaceId: 'w_notes' },
    title: 'CRDT papers summary lives in notes/crdt.md',
    body: 'Shapiro 2011, Kleppmann & Beresford 2017, Weidner 2023 (Fugue). Keep the comparison table there up to date.',
    tags: ['research'],
    source: { machineId: LAPTOP, via: 'tool', agent: 'opencode', sessionId: 's_notes' },
    ageMin: 60 * 25,
  },
  {
    id: 'k_pg17',
    type: 'memory',
    kind: 'procedure',
    scope: { level: 'workspace', workspaceId: 'w_infra' },
    title: 'Postgres major upgrade: dump, bump image, pg_upgrade, health check',
    body: '1. `pg_dumpall` to /data/backup\n2. bump the image in docker-compose.yml\n3. run pg_upgrade in a one-off container\n4. `curl :8080/health` must be green before removing the old volume.',
    tags: ['db', 'runbook'],
    source: { machineId: SERVER, via: 'tool', agent: 'claude', sessionId: 's_infra' },
    ageMin: 60 * 2.3,
  },
  {
    id: 'k_review',
    type: 'rule',
    scope: { level: 'global' },
    appliesTo: ['claude', 'opencode'],
    title: 'Explain risky shell commands before asking for approval',
    body: 'For anything that deletes, force-pushes or touches production, say in one sentence what it does and how to undo it.',
    tags: ['safety'],
    source: { machineId: LAPTOP, via: 'ui' },
    ageMin: 60 * 24 * 15,
  },
  {
    id: 'k_todo_lint',
    type: 'memory',
    kind: 'todo',
    scope: { level: 'project', projectId: 'p_acme' },
    title: 'Add a lint rule that flags sleep() in specs',
    body: 'Suggested after the flaky checkout fix; not done yet.',
    tags: ['tests'],
    source: { machineId: LAPTOP, via: 'tool', agent: 'claude', sessionId: 's_demo' },
    ageMin: 20,
  },
  // ---- suggestions (inbox)
  {
    id: 'k_sug_mock',
    type: 'memory',
    kind: 'gotcha',
    status: 'suggested',
    scope: { level: 'global' },
    title: 'Payment mock resolves asynchronously; await settled()',
    body: 'Any spec touching checkout must await `payments.settled()` after `submit()`. Sleeping hides the race instead of fixing it.',
    tags: ['tests'],
    source: { machineId: LAPTOP, via: 'tool', agent: 'claude', sessionId: 's_demo' },
    ageMin: 3,
  },
  {
    id: 'k_sug_vitest',
    type: 'memory',
    kind: 'procedure',
    status: 'suggested',
    scope: { level: 'project', projectId: 'p_acme' },
    title: 'Reproduce flaky specs with a 100× vitest loop',
    body: '`for i in $(seq 100); do npx vitest run <spec> -s || exit 1; done` – stops at the first failure.',
    tags: ['tests', 'flaky'],
    source: { machineId: LAPTOP, via: 'extract', agent: 'claude', sessionId: 's_demo' },
    ageMin: 3,
  },
  {
    id: 'k_sug_nosleep',
    type: 'rule',
    status: 'suggested',
    scope: { level: 'workspace', workspaceId: 'w_acme' },
    title: 'Never use sleep() to wait for async work in tests',
    body: 'Await the promise or an explicit signal (mock.settled(), waitFor()) instead.',
    tags: ['tests'],
    source: { machineId: LAPTOP, via: 'tool', agent: 'claude', sessionId: 's_demo', userRequested: true },
    ageMin: 2,
  },
  {
    id: 'k_sug_sandbox',
    type: 'memory',
    kind: 'fact',
    status: 'suggested',
    scope: { level: 'global' },
    title: 'Integration tests need the payments-sandbox container',
    body: 'Start it with `docker compose up -d payments-sandbox` from the acme-shop root before `pnpm test:integration`.',
    tags: ['tests', 'docker'],
    source: { machineId: LAPTOP, via: 'tool', agent: 'codex', sessionId: 's_review' },
    ageMin: 5,
  },
];

const PRESETS = new Set(['trusting', 'balanced', 'strict']);
const LEVELS = new Set<KnowledgeScopeLevel>(['global', 'tag', 'machine', 'project', 'workspace', 'session', 'team']);

export class MockKnowledge implements MockModule {
  private readonly host: MockHost;
  private readonly items = new Map<string, KnowledgeItemInfo>();
  private settings: KnowledgeSettings = { preset: 'balanced', defaultAgentScope: 'project' };

  constructor(host: MockHost) {
    this.host = host;
    for (const s of SEED) {
      const { ageMin, tags, status, ...rest } = s;
      const ts = ago(ageMin);
      this.items.set(s.id, { ...rest, tags: tags ?? [], status: status ?? 'active', createdAt: ts, updatedAt: ts });
    }
  }

  handles(method: string): boolean {
    return method.startsWith('knowledge.');
  }

  handle(method: string, params: Record<string, unknown>): unknown {
    const machine = this.host.requireOnline(params.machineId);
    switch (method) {
      case 'knowledge.list':
        return { items: this.list(params) };
      case 'knowledge.add': {
        const type = params.type === 'rule' ? 'rule' : params.type === 'memory' ? 'memory' : null;
        const title = typeof params.title === 'string' ? params.title.trim() : '';
        if (!type || !title) throw new BizziError('bad_request', 'type and title are required');
        const now = new Date().toISOString();
        const item: KnowledgeItemInfo = {
          id: `k_mock${(++counter).toString(36)}`,
          type,
          scope: scopeParam(params.scope) ?? { level: 'global' },
          title,
          body: typeof params.body === 'string' ? params.body : '',
          tags: stringList(params.tags),
          source: { machineId: machine.id, via: 'ui' },
          status: 'active',
          createdAt: now,
          updatedAt: now,
        };
        const appliesTo = stringList(params.appliesTo) as AgentKind[];
        if (appliesTo.length) item.appliesTo = appliesTo;
        if (type === 'memory' && typeof params.kind === 'string' && params.kind) item.kind = params.kind;
        this.items.set(item.id, item);
        this.changed([item.id]);
        return { item: { ...item } };
      }
      case 'knowledge.update': {
        const item = this.get(params.id);
        const next: KnowledgeItemInfo = { ...item, updatedAt: new Date().toISOString() };
        if (typeof params.title === 'string') next.title = params.title;
        if (typeof params.body === 'string') next.body = params.body;
        const scope = scopeParam(params.scope);
        if (scope) next.scope = scope;
        if (Array.isArray(params.appliesTo)) {
          const a = stringList(params.appliesTo) as AgentKind[];
          if (a.length) next.appliesTo = a;
          else delete next.appliesTo;
        }
        if (Array.isArray(params.tags)) next.tags = stringList(params.tags);
        this.items.set(next.id, next);
        this.changed([next.id]);
        return { item: { ...next } };
      }
      case 'knowledge.forget': {
        const item = this.get(params.id);
        this.items.set(item.id, { ...item, status: 'deleted', updatedAt: new Date().toISOString() });
        this.changed([item.id]);
        return {};
      }
      case 'knowledge.inbox':
        return { cards: this.inbox() };
      case 'knowledge.accept': {
        const ids = stringList(params.ids);
        const scope = scopeParam(params.scope);
        const now = new Date().toISOString();
        for (const id of ids) {
          const item = this.get(id);
          const next: KnowledgeItemInfo = { ...item, status: 'active', updatedAt: now };
          if (scope) next.scope = scope;
          this.items.set(id, next);
        }
        this.changed(ids);
        return {};
      }
      case 'knowledge.reject': {
        const ids = stringList(params.ids);
        const now = new Date().toISOString();
        for (const id of ids) this.items.set(id, { ...this.get(id), status: 'deleted', updatedAt: now });
        this.changed(ids);
        return {};
      }
      case 'knowledge.settings.get':
        return { settings: { ...this.settings } };
      case 'knowledge.settings.set': {
        const patch = (params.settings ?? {}) as Partial<KnowledgeSettings>;
        if (patch.preset !== undefined && !PRESETS.has(patch.preset)) throw new BizziError('bad_request', `unknown preset ${String(patch.preset)}`);
        if (patch.defaultAgentScope !== undefined && !LEVELS.has(patch.defaultAgentScope)) throw new BizziError('bad_request', 'unknown scope level');
        this.settings = { ...this.settings, ...patch };
        return { settings: { ...this.settings } };
      }
      default:
        throw new BizziError('unsupported', `mock does not implement ${method}`);
    }
  }

  private get(id: unknown): KnowledgeItemInfo {
    const item = this.items.get(String(id));
    if (!item || item.status === 'deleted') throw new BizziError('not_found', `no such knowledge item: ${String(id)}`);
    return item;
  }

  private list(p: Record<string, unknown>): KnowledgeItemInfo[] {
    const status = typeof p.status === 'string' ? p.status : 'active';
    const q = typeof p.query === 'string' ? p.query.trim().toLowerCase() : '';
    const limit = typeof p.limit === 'number' && p.limit > 0 ? p.limit : 500;
    return [...this.items.values()]
      .filter((i) => i.status === status)
      .filter((i) => !p.type || i.type === p.type)
      .filter((i) => !p.scopeLevel || i.scope.level === p.scopeLevel)
      .filter((i) => !p.workspaceId || i.scope.workspaceId === p.workspaceId)
      .filter((i) => !p.projectId || i.scope.projectId === p.projectId)
      .filter((i) => !q || i.title.toLowerCase().includes(q) || i.body.toLowerCase().includes(q) || i.tags.some((t) => t.toLowerCase().includes(q)))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .slice(0, limit)
      .map((i) => ({ ...i }));
  }

  /** One card per source session, newest first. */
  private inbox(): KnowledgeInboxCard[] {
    const cards = new Map<string, KnowledgeInboxCard>();
    for (const i of this.items.values()) {
      if (i.status !== 'suggested') continue;
      const key = i.source.sessionId ?? '';
      let card = cards.get(key);
      if (!card) {
        card = { items: [] };
        if (i.source.sessionId) card.sessionId = i.source.sessionId;
        if (i.source.agent) card.agent = i.source.agent;
        cards.set(key, card);
      }
      card.items.push({ ...i });
    }
    const newest = (c: KnowledgeInboxCard): string => c.items.reduce((m, i) => (i.createdAt > m ? i.createdAt : m), '');
    return [...cards.values()].sort((a, b) => (newest(a) < newest(b) ? 1 : -1));
  }

  private changed(ids: string[]): void {
    this.host.emit(GLOBAL_CHANNEL, { type: 'knowledge.changed', data: { ids } });
  }
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function scopeParam(v: unknown): KnowledgeScope | null {
  if (typeof v !== 'object' || v === null) return null;
  const s = v as Record<string, unknown>;
  if (typeof s.level !== 'string' || !LEVELS.has(s.level as KnowledgeScopeLevel)) throw new BizziError('bad_request', 'invalid scope');
  const out: KnowledgeScope = { level: s.level as KnowledgeScopeLevel };
  for (const k of ['tag', 'machineId', 'projectId', 'workspaceId', 'sessionId'] as const) if (typeof s[k] === 'string' && s[k]) out[k] = s[k] as string;
  return out;
}
