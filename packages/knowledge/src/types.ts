// Knowledge model (docs/knowledge.md §2.3). Rules are prescriptive and always injected;
// memories are descriptive and retrieved by relevance.

import type { AgentKind } from '@bizzi/protocol';

export type KnowledgeType = 'rule' | 'memory';
export const KNOWLEDGE_TYPES: readonly KnowledgeType[] = ['rule', 'memory'];

/** `team` is reserved: accepted by the store, never visible to sessions yet, always reviewed. */
export type ScopeLevel = 'global' | 'machine' | 'project' | 'workspace' | 'session' | 'team';
export const SCOPE_LEVELS: readonly ScopeLevel[] = ['global', 'machine', 'project', 'workspace', 'session', 'team'];
/** Scope levels an agent session can see and write today. */
export type SessionScopeLevel = Exclude<ScopeLevel, 'team'>;
export const SESSION_SCOPE_LEVELS: readonly SessionScopeLevel[] = ['global', 'machine', 'project', 'workspace', 'session'];

/**
 * Specificity used for rule ordering and memory ranking. Higher = more specific.
 * Rules conflict by specificity: session > workspace > project > machine > global.
 */
export const SCOPE_SPECIFICITY: Readonly<Record<ScopeLevel, number>> = {
  global: 0,
  team: 0,
  machine: 1,
  project: 2,
  workspace: 3,
  session: 4,
};

export interface KnowledgeScope {
  level: ScopeLevel;
  machineId?: string;
  projectId?: string;
  workspaceId?: string;
  sessionId?: string;
  /** Reserved for `team` scope. */
  teamId?: string;
}

export type MemoryKind = 'fact' | 'preference' | 'decision' | 'gotcha' | 'procedure' | 'reference' | 'todo';
export const MEMORY_KINDS: readonly MemoryKind[] = ['fact', 'preference', 'decision', 'gotcha', 'procedure', 'reference', 'todo'];

export type SourceVia = 'ui' | 'tool' | 'harvest' | 'extract';

export interface KnowledgeSource {
  agent?: AgentKind;
  sessionId?: string;
  machineId: string;
  via: SourceVia;
  userRequested?: boolean;
  /** Writer's project/workspace at write time (lets the inbox re-scope without guessing). */
  projectId?: string;
  workspaceId?: string;
  /** Harvest provenance, e.g. `claude:/abs/path/to/memory/foo.md`. */
  ref?: string;
}

export type KnowledgeStatus = 'active' | 'suggested' | 'superseded' | 'deleted';
export const KNOWLEDGE_STATUSES: readonly KnowledgeStatus[] = ['active', 'suggested', 'superseded', 'deleted'];

export interface KnowledgeItem {
  /** `k_<ULID>` */
  id: string;
  type: KnowledgeType;
  scope: KnowledgeScope;
  /** Default (undefined): all agents. */
  appliesTo?: AgentKind[];
  /** Memory only. */
  kind?: MemoryKind;
  title: string;
  body: string;
  tags: string[];
  source: KnowledgeSource;
  status: KnowledgeStatus;
  supersedes?: string[];
  /**
   * Went live under a "live + inbox notice" policy and the user hasn't acknowledged it yet.
   * Shown in the inbox with an undo.
   */
  noticePending?: boolean;
  /** sha256 over normalized type/title/body; used for dedupe. */
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  /** Hybrid logical clock timestamp of the last change (replication order). */
  hlc: string;
}

/** Who is asking: the session (or ambient process) knowledge is resolved for. */
export interface KnowledgeContext {
  agent: AgentKind;
  machineId: string;
  projectId?: string;
  workspaceId?: string;
  sessionId?: string;
}

/** Tag that marks a suggested item as a request to forget the items it supersedes. */
export const FORGET_TAG = 'bizzi:forget';
