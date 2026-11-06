# @bizzi/adapter-claude

Structured-mode `AgentAdapter` for Claude Code, built on the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk` 0.3.318). Terminal mode is handled by `@bizzi/pty`.

```ts
import { createAdapters } from '@bizzi/adapter-claude';
const [claude] = createAdapters({ /* ClaudeAdapterOptions */ });
```

Exports: `createAdapters(options?)`, `ClaudeAdapter`, `ClaudeSession`, `ClaudeAdapterOptions`,
`ClaudeStartSessionOptions` (adds `fork`), `probeClaude`, `findClaudeBinary`, `toolKind`,
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
| File changes | Edit / MultiEdit / Write / NotebookEdit results -> `file.changed` with a unified diff |
| Todos | `TodoWrite` input, and `TaskCreate` / `TaskUpdate` / `TaskList` results -> `plan.updated` |
| Subagents | `task_started` (local_agent) -> `subagent.started`; `task_notification` / `task_updated` -> `subagent.completed`; `task_progress` -> `tool.updated` on the Task/Agent tool |
| Approvals | `canUseTool` -> `approval.requested` (`editable: true`, options allow / allow_always / deny, kind from the tool, CLI title/description when given); the SDK callback stays pending until `respondApproval` |
| allow / allow_always / deny | `{behavior:'allow', updatedInput: editedInput ?? input}`; allow_always also returns the SDK's permission suggestions as `updatedPermissions` (fallback: a session rule for the tool, Bash scoped to the command); deny -> `{behavior:'deny', message}` |
| AskUserQuestion | an approval with options allow / deny; answer with `editedInput.answers`, or a plain `message` that answers every question |
| Interrupt | `query.interrupt()`; pending approvals are denied; the turn completes `interrupted` (forced after 10 s if the CLI sends no result) |
| Steer | `steer()` pushes a user message with `priority: 'next'`; the CLI folds it into the running turn at the next tool boundary. If it arrives too late it runs as a follow-up SDK turn and the bizzi turn stays open until that finishes |
| Model / permission mode / effort | `setModel`, `setPermissionMode`, `applyFlagSettings({effortLevel})`; changes reported as `session.info` |
| Resume / fork | `resumeRef` -> `resume`; `fork: true` (see below) -> `forkSession` with a new session id |
| Usage | `turn.completed.usage`: main-loop tokens of the turn plus cost (delta of the cumulative `total_cost_usd`); `usage.updated`: session totals from `modelUsage` (all models, subagents included) and the context window |
| Session info | `init` -> `session.info` (ref, model, permission mode, effort when reported); `initializationResult().commands` -> `commands` with descriptions |
| Process death | `error` (fatal, code `agent_exited`, with stderr tail), every pending turn completed `error`, `session.status` failed; later sends throw `agent_unavailable` |
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

They cover probe, a one-word turn, resume and fork, an approval with edited input, and steer +
interrupt. A full run costs about one cent with Haiku.

## Known gaps vs the SDK

- **Fork** needs `fork: true` on the start options (`ClaudeStartSessionOptions`); the shared
  `StartSessionOptions` has no field for it yet. `resumeSessionAt` (fork at a message) isn't exposed.
- **Questions:** AskUserQuestion goes through the approval flow; there is no `question.asked` /
  answer method in the protocol. `onElicitation` (MCP elicitation) is not wired, so the SDK declines them.
- **Subagent text** isn't forwarded (`forwardSubagentText` off): `message.*` has no parent
  field, so subagent prose would interleave with the main transcript. Their tool calls are shown.
- **Server-side tools** (`server_tool_use` / web search results) get `tool.started` but their
  result blocks come through as `agent.raw`, with no `tool.completed`.
- **Turn cost** is the delta of a cumulative total; the first turn after a resume includes the
  earlier session's cost.
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
