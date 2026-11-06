// Codex memories importer: documented stub.
//
// Codex keeps opt-in memories user-wide under ~/.codex/memories/ (machine-local). The on-disk
// format isn't pinned down yet (docs/knowledge.md §9 spike 2), so nothing is parsed here.
// The intended behavior, once the format is verified per Codex version:
//
//  - One-way, like the Claude importer: never write into ~/.codex (that would loop).
//  - Codex memories are user-wide, so import them as *suggested* at global scope
//    (`forceSuggested: true`), or at project scope when a memory clearly references the project
//    (repo name, remote URL, or a path under the workspace).
//  - Dedupe by content hash + provenance (`codex:<path>[#entry]`) with the same harvest records
//    the Claude importer uses, so re-runs are idempotent and forgotten items stay forgotten.

import type { KnowledgeStore } from '../store.ts';
import type { HarvestResult } from './claude.ts';

export interface CodexHarvestOptions {
  /** Default: `$CODEX_HOME/memories` or `~/.codex/memories`. */
  dir?: string;
  machineId: string;
  projectId?: string;
  workspacePath?: string;
}

export interface CodexHarvestResult extends HarvestResult {
  supported: false;
  reason: string;
}

export function harvestCodexMemories(_store: KnowledgeStore, _opts: CodexHarvestOptions): CodexHarvestResult {
  return {
    supported: false,
    reason: 'Codex memories import is not implemented yet: the ~/.codex/memories format is unverified.',
    imported: [],
    updated: [],
    skipped: [],
  };
}
