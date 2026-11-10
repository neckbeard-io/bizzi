# @bizzi/adapter-claude

Structured-mode `AgentAdapter` for Claude Code, built on the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk` 0.3.318). Terminal mode is handled by `@bizzi/pty`.

```ts
import { createAdapters } from '@bizzi/adapter-claude';
const [claude] = createAdapters({ /* ClaudeAdapterOptions */ });
```

Exports: `createAdapters(options?)`, `ClaudeAdapter`, `ClaudeSession`, `ClaudeAdapterOptions`,
`ClaudeStartSessionOptions` (deprecated alias of `StartSessionOptions`), `probeClaude`, `findClaudeBinary`, `toolKind`,
`toolTitle`, `approvalKind`, `QueryFn` / `ClaudeQuery` (for injecting a scripted `query`).

## How it runs

- One bizzi session is one SDK `query()` in **streaming-input mode**: the prompt is an async
  queue of user messages, so a single Claude Code process serves every turn.
- One bizzi turn is one SDK user message. Each message carries a uuid; the CLI echoes consumed
  uuids (`user_message_uuids`) on its frames and results, which is how results are matched to
  turns. A `send()` made while a turn is running is held and sent after that turn completes.
- Executable: the user's installed `claude` (`$BIZZI_CLAUDE_PATH`, then `$PATH`, `~/.local/bin`,
  `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`), so their login applies. Native
  binaries and node scripts win over shell wrappers (terminal integrations such as cmux wrap
  `claude` and inject `--settings`/`--session-id`, which clash with the SDK's flags). Falls back
  to the SDK's bundled binary; `claudePath: null` forces it.
- Settings sources `user`, `project`, `local` are loaded, so CLAUDE.md / AGENTS.md, settings,
  hooks, skills, plugins and the user's MCP servers apply as in the CLI.
- System prompt: the `claude_code` preset, with `append = systemPromptAppend`.
- `mcpServers` from `StartSessionOptions` are passed at launch (stdio and http).
- A fresh session gets its Claude session id up front (`sessionId` option), so
  `agentSessionRef` is known before the first turn.

## Feature coverage

| Feature | How |
|---|---|
| Token streaming | `includePartialMessages`; `text_delta` -> `message.delta`, `thinking_delta` -> `reasoning.delta` |
| Messages | each completed text / thinking block -> `message.completed` / `reasoning.completed`; ids are `<api message id>:t<n>` / `:r<n>`, the same for deltas and completions |
| Tools | `tool_use` -> `tool.started` (kind + human title, `parentToolId` for subagent calls); `tool_result` -> `tool.completed` (`ok` / `error` / `denied` / `cancelled`, output trimmed to 8000 chars) |
| Server-side tools | `server_tool_use` / `mcp_tool_use` -> `tool.started`; the matching `*_tool_result` block in assistant content (`web_search_tool_result`, `web_fetch_tool_result`, code execution, `mcp_tool_result`, …) -> `tool.completed` (search results as `title — url` lines; `*_error` content / non-zero exit / `is_error` -> `error`) |
| File changes | Edit / MultiEdit / Write / NotebookEdit results -> `file.changed` with a unified diff |
| Todos | `TodoWrite` input, and `TaskCreate` / `TaskUpdate` / `TaskList` results -> `plan.updated` |
| Subagents | `task_started` (local_agent) -> `subagent.started`; `task_notification` / `task_updated` -> `subagent.completed`; `task_progress` -> `tool.updated` on the Task/Agent tool |
| Subagent text | launched with `forwardSubagentText`: the subagent's prompt (`message.completed` role `user`), text and thinking carry `parentToolId` = the Task/Agent tool call (verified live). The CLI streams no token deltas for subagents, so they arrive as completed messages |
| Approvals | `canUseTool` -> `approval.requested` (`editable: true`, options allow / allow_always / deny, kind from the tool, CLI title/description when given); the SDK callback stays pending until `respondApproval` |
| allow / allow_always / deny | `{behavior:'allow', updatedInput: editedInput ?? input}`; allow_always also returns the SDK's permission suggestions as `updatedPermissions` (fallback: a session rule for the tool, Bash scoped to the command); deny -> `{behavior:'deny', message}` |
| AskUserQuestion | `canUseTool('AskUserQuestion')` -> `question.asked` with the full `questions[]` (item id = question text, header, options with descriptions, multiSelect, `allowText` for Claude's built-in "Other"); `text`/`options` summarize the first question. `respondQuestion` answers with `{behavior:'allow', updatedInput: {...input, answers}}` (answers keyed by question text; multi-select joined with `, `; answers may also be keyed by header or index) -> `question.resolved {answers}`. Declined -> deny ("The user declined to answer.") -> `question.resolved {cancelled:true}`. No approval is emitted for it (verified live on Haiku) |
| MCP elicitation | `onElicitation` -> `question.asked`. Form mode: one question per schema property (enum / `oneOf` const -> options, array of enum -> multiSelect, boolean -> Yes/No, others free text; non-required fields marked "(optional)"); answers are converted back to typed `content` (numbers, booleans, enum values). URL mode or an empty form: one Accept / Decline confirmation showing the message (and URL). Declined -> `decline`; cancelled -> `cancel` |
| Question status | `question.asked` is followed by `session.status waiting_input` (prompt `input`); when the last question resolves: `running` in a turn, `waiting_approval` if approvals are pending, `idle` between turns |
| Interrupt | `query.interrupt()`; pending approvals end as `approval.resolved {decision:'cancelled', by:'bizzi'}` (the SDK gets a deny with `interrupt`), pending questions as `question.resolved {cancelled:true}`, their tools complete `cancelled`; the turn completes `interrupted` (forced after 10 s if the CLI sends no result). Stop and process death cancel them the same way; an SDK-side abort of a permission request is `cancelled` by `agent` |
| Steer | `steer()` pushes a user message with `priority: 'next'`; the CLI folds it into the running turn at the next tool boundary. If it arrives too late it runs as a follow-up SDK turn and the bizzi turn stays open until that finishes |
| Model / permission mode / effort | `setModel`, `setPermissionMode`, `applyFlagSettings({effortLevel})`; changes reported as `session.info` |
| Resume / fork | `resumeRef` -> `resume`; `StartSessionOptions.fork` (with `resumeRef`) -> `forkSession` with a new session id, known up front (verified live) |
| Usage | `turn.completed.usage` is per turn: the result's main-loop tokens plus cost (delta of the cumulative `total_cost_usd`). `usage.updated` is the running total of the Claude session from `modelUsage` (all models, subagents included; restored by the CLI on resume/fork, so it includes the resumed history) plus `total_cost_usd` and the context window |
| Context (`context.updated`) | `getContextUsage({detail:'summary'})` after start, after each result and after each compact boundary. `used` = the CLI's `totalTokens`, `window` = `rawMaxTokens`, `usable`/`compactAt` = window minus the buffer rows. Categories keep the CLI's `id`/`kind`; a `bizzi` row ("bizzi overhead") is carved out of the system-prompt row (append text, bytes/4 estimate) and the MCP rows (the CLI's own per-server counts for bizzi's servers) so the breakdown still adds up |
| Compaction | `compact_boundary` -> `context.compacted {before: pre_tokens, after: post_tokens}` |
| Per-login usage (`account.usage`) | Identity from `accountInfo()`: claude.ai logins use the email (`billing: plan`); API-key / gateway logins use `key:` + sha256(base URL, key) (`billing: metered`); Bedrock/Vertex/apiKeyHelper logins emit nothing. `rate_limit_event` -> windows (`utilization` is a fraction, `resetsAt` epoch seconds) and status (allowed/allowed_warning/rejected -> ok/warning/limited). Plan logins also read the experimental usage query (start, then at most every 5 min after a result) through a guarded helper that tolerates its removal. Metered logins report `spend {usd: total_cost_usd, period: 'session'}` (the session's total, not the login's) |
| Session info | `init` -> `session.info` (ref, model, permission mode, effort when reported); `initializationResult().commands` -> `commands` with descriptions |
| Process death | `error` (fatal, code `agent_exited`, with stderr tail), every pending turn completed `error`, `session.status` failed; later sends throw `agent_unavailable` |
| dispose() | stops every session the adapter started (each is its own process; nothing else is shared) |
| Anything else | `agent.raw` (hook events, rate limits, compaction, api retries, synthetic user messages, …) |

## Capabilities (`capabilities('structured')`)

| | |
|---|---|
| modes | `['structured']` |
| streaming | `token` |
| steer / interrupt | `true` / `true` (both verified live) |
| fork / resume / resumeAfterNodeRestart | `true` / `true` / `true` (sessions persist under `~/.claude/projects`) |
| approvals / editableApprovals | `per-tool` / `true` |
| permissionModes | `default`, `acceptEdits`, `plan`, `bypassPermissions`, `dontAsk`, `auto` |
| models / setModelMidSession | `dynamic` / `true` |
| effort | `low`, `medium`, `high`, `xhigh`, `max` |
| planMode, todos, subagents, slashCommands, skills, images | `true` |
| mcpInjection / instructionInjection | `launch` / `system-append` |
| usage | `tokens+cost` |
| questions | `true` |

## Options (`ClaudeAdapterOptions`)

`queryFn`, `claudePath`, `searchDirs`, `settingSources`, `includePartialMessages` (true),
`maxToolOutputChars` (8000), `allowBypassPermissions` (true: launches with
`allowDangerouslySkipPermissions` so the mode can be selected; the core should gate it),
`interruptGraceMs` (10000), `sdkOptions` (merged last: hooks, agents, thinking, sandbox, plugins…).

## Tests

`npm test` runs offline tests against scripted SDK streams (`test/fake.ts`). Live tests:

```sh
BIZZI_LIVE=1 npm test -w @bizzi/adapter-claude      # BIZZI_CLAUDE_MODEL (default haiku), BIZZI_LIVE_DUMP=1 to print events
```

They cover probe, a one-word turn, resume and fork, an approval with edited input, steer +
interrupt, and an AskUserQuestion round-trip (Claude asks a multiple-choice question, the answer
goes back and the reply uses it). A full run costs a few cents with Haiku.

## Known gaps vs the SDK

- **Fork at a message** (`resumeSessionAt`) isn't exposed; forks continue from the end of the conversation.
- **Turn cost after resume/fork:** the CLI restores the conversation's cumulative cost, so the
  first turn's cost can't be separated from the history's; that turn's `usage` has tokens but no
  `costUsd`. Later turns get the delta.
- **Subagent token streaming:** subagent text arrives as completed messages only.
- **Question answers** for AskUserQuestion are plain text; per-option `preview` and `annotations`
  (notes, `unanswered`) aren't mapped. URL-mode elicitations don't report completion
  (`elicitationId` notifications).
- `onUserDialog` (`request_user_dialog`) isn't wired; the CLI applies each dialog's no-dialog behavior.
- **Interrupting** while a steer message is still queued leaves it in the CLI queue; it then
  runs as a turn bizzi didn't start (its events still flow, its result is emitted as `agent.raw`).
- Not exposed: `rewindFiles` / file checkpointing, `stopTask` / `backgroundTasks`,
  `setMcpServers` / `toggleMcpServer` / `reconnectMcpServer`, `getContextUsage`,
  `supportedModels` / `supportedAgents`, `accountInfo`, prompt suggestions, structured output,
  `setMaxThinkingTokens`. Reachable through `sdkOptions` at launch: hooks, custom agents,
  thinking config, sandbox, plugins, budgets.
- The system prompt is recorded per conversation by the CLI (`snapshot` default), so a changed
  `systemPromptAppend` on resume only takes effect after compaction or in a new session.
- Plain read-only Bash commands (e.g. `echo bizzi`) are auto-approved by Claude Code itself and
  never reach `canUseTool`, even in `default` mode.
