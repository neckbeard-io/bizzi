# @bizzi/knowledge

Rules and memories that every coding agent (Claude, Codex, OpenCode, agy) on every machine sees. The spec is
[docs/knowledge.md](../../docs/knowledge.md).

- **Store**: `KnowledgeStore` on `node:sqlite`, with FTS5 full-text search (falls back to LIKE when FTS5 is
  missing; Node 26's bundled SQLite 3.54 has it). Items are never physically deleted: forgetting writes a
  tombstone, and every change gets an HLC timestamp (`HybridLogicalClock`) for last-writer-wins replication
  (`changesSince` / `applyRemote`).
- **Resolver**: `resolveRules` orders visible rules from general to specific (global → machine → project →
  workspace → session). `rankMemories` ranks memories by FTS relevance (when there's a query), scope
  specificity and recency.
- **Policy**: `decide` applies the presets `trusting`, `balanced` (the §3.1 table) and `strict`, with
  overrides per source × scope and per project. Settings live in the database (`loadSettings` /
  `saveSettings`), so the MCP server process applies the same policy as the node.
- **Pipeline**: `addKnowledge` / `updateKnowledge` (supersedes) / `forgetKnowledge` (tombstone or forget
  request) is the only write path. It resolves the default scope (§3.3, default `project`), dedupes, and runs
  the policy.
- **Inbox**: `listInbox` returns one card per session; `acceptItem` (optionally re-scoped) and `rejectItem`.
  Rejecting a "live + notice" item undoes it.
- **Digest**: `buildSystemPromptAppend` returns all rules in full plus a memory digest within a token budget
  and a note about the tools. `mcpServerSpec` returns a stdio `McpServerSpec`; `knowledgeForSession` returns both.
- **MCP server** (`src/mcp-server.ts`, official SDK, stdio) has these tools: `memory_search`, `memory_add`,
  `rule_add`, `knowledge_update`, `knowledge_forget`. `history_search` and `handoff_brief` reply "not
  available yet".
- **Harvest**: `harvestClaudeMemory` imports Claude auto-memory one way and is idempotent. It dedupes by
  content hash and provenance, and an edited file supersedes its earlier import. `harvestCodexMemories` is a
  documented stub.

## Session start (core)

```ts
import { KnowledgeStore, knowledgeForSession } from '@bizzi/knowledge';

const store = new KnowledgeStore({ path: join(dataDir, 'knowledge.db'), machineId, logger });
const ctx = { agent, machineId, projectId, workspaceId, sessionId };
const k = knowledgeForSession(ctx, { store, query: firstPrompt });
await adapter.start({ ...opts, systemPromptAppend: k.systemPromptAppend, mcpServers: { ...opts.mcpServers, ...k.mcpServers } }, emit, actx);
```

## Running the MCP server by hand

```sh
node packages/knowledge/src/mcp-server.ts --db ~/.bizzi/knowledge.db --agent claude --machine-id m_… \
  [--project-id p_…] [--workspace-id w_…] [--session-id s_…]
```

The same values can come from `BIZZI_KNOWLEDGE_DB`, `BIZZI_AGENT`, `BIZZI_MACHINE_ID`, `BIZZI_PROJECT_ID`,
`BIZZI_WORKSPACE_ID` and `BIZZI_SESSION_ID`. The server logs to stderr (set `BIZZI_DEBUG=1` for debug output).
