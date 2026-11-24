// Items arriving from other machines (knowledge.md §9.4). The hub stores them as opaque records, so a
// node checks the whole shape here before `KnowledgeStore.applyRemote` merges one.

import { AGENT_KINDS, BizziError, type AgentKind } from '@bizzi/protocol';
import { parseHlc } from './hlc.ts';
import { isScopeLevel, normalizeScope } from './scope.ts';
import type { KnowledgeItem, KnowledgeScope, KnowledgeSource, MemoryKind, SourceVia } from './types.ts';
import { KNOWLEDGE_STATUSES, KNOWLEDGE_TYPES, MEMORY_KINDS } from './types.ts';

const VIAS: readonly SourceVia[] = ['ui', 'tool', 'harvest', 'extract'];
const SCOPE_FIELDS = ['tag', 'machineId', 'projectId', 'workspaceId', 'sessionId', 'teamId'] as const;
const SOURCE_FIELDS = ['sessionId', 'projectId', 'workspaceId', 'ref'] as const;

type Obj = Record<string, unknown>;

const bad = (msg: string): never => {
  throw new BizziError('bad_request', `knowledge record: ${msg}`);
};
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (o: Obj, k: string, max = 1_000_000): string => {
  const v = o[k];
  if (typeof v !== 'string' || v.length > max) bad(`${k} must be a string`);
  return v as string;
};
const strArray = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) bad(`${what} must be an array of strings`);
  return [...(v as string[])];
};

/** Validate a replicated item and return it in store shape. Throws `bad_request`. */
export function parseRemoteItem(raw: unknown): KnowledgeItem {
  if (!isObj(raw)) return bad('must be an object');
  const id = str(raw, 'id', 200);
  if (id === '') bad('id must not be empty');
  const hlc = str(raw, 'hlc', 300);
  try {
    parseHlc(hlc);
  } catch {
    bad(`hlc is not an HLC timestamp: ${hlc}`);
  }
  const type = raw.type;
  if (!(KNOWLEDGE_TYPES as readonly unknown[]).includes(type)) bad(`unknown type ${String(type)}`);
  const status = raw.status;
  if (!(KNOWLEDGE_STATUSES as readonly unknown[]).includes(status)) bad(`unknown status ${String(status)}`);

  if (!isObj(raw.scope) || !isScopeLevel(raw.scope.level)) return bad('scope.level is invalid');
  const scope: KnowledgeScope = { level: raw.scope.level };
  for (const k of SCOPE_FIELDS) {
    const v = raw.scope[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') bad(`scope.${k} must be a string`);
    scope[k] = v as string;
  }

  if (!isObj(raw.source)) return bad('source must be an object');
  const via = raw.source.via;
  if (!(VIAS as readonly unknown[]).includes(via)) bad(`unknown source.via ${String(via)}`);
  const source: KnowledgeSource = { machineId: str(raw.source, 'machineId', 200), via: via as SourceVia };
  const agent = raw.source.agent;
  if (agent !== undefined) {
    if (!(AGENT_KINDS as readonly unknown[]).includes(agent)) bad(`unknown source.agent ${String(agent)}`);
    source.agent = agent as AgentKind;
  }
  for (const k of SOURCE_FIELDS) if (raw.source[k] !== undefined) source[k] = str(raw.source, k);
  if (raw.source.userRequested === true) source.userRequested = true;

  const item: KnowledgeItem = {
    id,
    type: type as KnowledgeItem['type'],
    scope: normalizeScope(scope),
    title: str(raw, 'title'),
    body: str(raw, 'body'),
    tags: strArray(raw.tags, 'tags'),
    source,
    status: status as KnowledgeItem['status'],
    contentHash: str(raw, 'contentHash', 200),
    createdAt: str(raw, 'createdAt', 100),
    updatedAt: str(raw, 'updatedAt', 100),
    hlc,
  };
  if (raw.appliesTo !== undefined) {
    const a = strArray(raw.appliesTo, 'appliesTo');
    for (const x of a) if (!(AGENT_KINDS as readonly string[]).includes(x)) bad(`appliesTo: unknown agent ${x}`);
    if (a.length > 0) item.appliesTo = a as AgentKind[];
  }
  if (raw.kind !== undefined) {
    if (!(MEMORY_KINDS as readonly unknown[]).includes(raw.kind)) bad(`unknown kind ${String(raw.kind)}`);
    if (item.type === 'memory') item.kind = raw.kind as MemoryKind;
  }
  if (raw.supersedes !== undefined) {
    const s = strArray(raw.supersedes, 'supersedes');
    if (s.length > 0) item.supersedes = s;
  }
  if (raw.noticePending === true) item.noticePending = true;
  return item;
}
