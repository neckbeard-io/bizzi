// @bizzi/knowledge: rules + memories shared across agents (docs/knowledge.md).

export * from './types.ts';
export { HybridLogicalClock, compareHlc, formatHlc, parseHlc } from './hlc.ts';
export type { HlcTimestamp } from './hlc.ts';
export { KnowledgeStore, contentHash, detectFts5, queryTokens } from './store.ts';
export { parseRemoteItem } from './replica.ts';
export type {
  HarvestRecord,
  ItemPatch,
  KnowledgeStoreOptions,
  ListFilter,
  NewKnowledgeItem,
  SearchHit,
  SearchOptions,
} from './store.ts';
export {
  contextHasLevel,
  isScopeLevel,
  isVisible,
  normalizeScope,
  scopeEquals,
  scopeForLevel,
  scopeMatches,
} from './scope.ts';
export {
  DEFAULT_SETTINGS,
  POLICY_PRESETS,
  POLICY_SOURCES,
  PRESETS,
  decide,
  loadSettings,
  policySourceOf,
  policyTable,
  saveSettings,
} from './policy.ts';
export type {
  KnowledgeSettings,
  PolicyConfig,
  PolicyDecision,
  PolicyInput,
  PolicyOverrides,
  PolicyPreset,
  PolicyResult,
  PolicySource,
  PolicyTable,
} from './policy.ts';
export {
  addKnowledge,
  applyActivation,
  defaultScopeLevel,
  forgetKnowledge,
  originFromContext,
  resolveScope,
  updateKnowledge,
} from './pipeline.ts';
export type { AddInput, UpdateInput, WriteOptions, WriteOrigin, WriteResult } from './pipeline.ts';
export { orderRules, rankMemories, resolveKnowledge, resolveRules } from './resolver.ts';
export type { RankOptions, RankedMemory, ResolvedKnowledge } from './resolver.ts';
export {
  MCP_SERVER_ENTRY,
  MCP_SERVER_NAME,
  RULES_PREAMBLE,
  TOOLS_NOTE,
  approxTokens,
  buildKnowledgeDigest,
  buildSystemPromptAppend,
  isNativeToSession,
  knowledgeForSession,
  mcpServerArgs,
  mcpServerSpec,
  renderMachineCard,
  renderRules,
} from './digest.ts';
export type { DigestOptions, KnowledgeDigest, MachineCardFacts, McpSpecOptions, SessionKnowledgeOptions } from './digest.ts';
export { acceptItem, acceptItems, isForgetRequest, listInbox, rejectItem, rejectItems } from './inbox.ts';
export type { AcceptOptions, InboxFilter, InboxGroup } from './inbox.ts';
export { canRead, canSeeSuggestion, getWithHistory, isOwnSuggestion, listForSession, moveToScope, planScopeMove, readable } from './access.ts';
export type { HistoryEntry, ItemWithHistory, ListStatus, ScopeMovePlan, SessionListFilter, SessionListPage } from './access.ts';
export { LIST_BODY_CHARS, registerBrowseTools } from './mcp-browse.ts';
export { HISTORY_TOKEN_ENV, HISTORY_URL_ENV, historySourceFromEnv, httpHistorySource, registerHistoryTools } from './history.ts';
export type { HistorySearchArgs, HistorySource } from './history.ts';
export { MCP_SERVER_VERSION, createKnowledgeMcpServer, parseServerConfig, serverInstructions } from './mcp-tools.ts';
export type { KnowledgeMcpOptions, McpServerConfig } from './mcp-tools.ts';
export {
  CLAUDE_HARVEST_TAG,
  CLAUDE_TYPE_TO_KIND,
  claudeMemoryDir,
  claudeProjectSlug,
  harvestClaudeMemory,
  localPaths,
  parseMemoryIndex,
  readClaudeMemoryDir,
} from './harvest/claude.ts';
export type { ClaudeHarvestOptions, ClaudeMemoryEntry, HarvestResult, HarvestSkip } from './harvest/claude.ts';
export { harvestCodexMemories } from './harvest/codex.ts';
export type { CodexHarvestOptions, CodexHarvestResult } from './harvest/codex.ts';
export { parseFrontmatter } from './harvest/frontmatter.ts';
export { MemoryDirWatcher } from './harvest/watch.ts';
export type { DirWatchFn, DirWatcher, MemoryDirWatcherOptions } from './harvest/watch.ts';
export {
  ABSENT_FILE_HASH,
  AGENTS_FILE,
  DEFAULT_PROMOTE_HEADING,
  PROMOTED_TAG,
  appendDiff,
  appendSection,
  applyPromotion,
  fileHash,
  normalizeHeading,
  planPromotion,
  renderPromotedItem,
} from './promote.ts';
export type { PromoteOptions, PromoteSkipReason, PromotionPlan, PromotionResult } from './promote.ts';
export type { Frontmatter, FrontmatterValue, ParsedMarkdown } from './harvest/frontmatter.ts';
