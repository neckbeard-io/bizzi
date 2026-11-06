# @bizzi/adapter-codex

The bizzi `AgentAdapter` for OpenAI Codex in **structured** mode. It drives `codex app-server`, the stdio JSON-RPC interface that Codex's own IDE extension uses. Messages are newline-delimited JSON in JSON-RPC 2.0 shape, without the `"jsonrpc"` field. Each bizzi session runs one `codex app-server` process holding one Codex thread.

```ts
import { createAdapters } from '@bizzi/adapter-codex';
const [codex] = createAdapters({ codexPath: '/opt/homebrew/bin/codex' }); // codexPath is optional
```

## Vendored protocol types

`src/generated/` is the output of `codex app-server generate-ts` from **codex-cli 0.167.0** (also recorded in `src/generated/VERSION`). The output covers the stable API only, without `--experimental`. To regenerate after bumping the `@openai/codex` devDependency, run:

```sh
npm run generate-types -w @bizzi/adapter-codex
```

The script rewrites the extensionless relative imports that ts-rs emits into `.ts` imports, which Node type stripping requires. A test checks that the installed devDependency matches `VERSION`.

## Options (`CodexAdapterOptions`)

| option | default | |
|---|---|---|
| `codexPath` | discovered | Path to `codex`. Discovery checks `PATH`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.npm-global/bin`, then `$(npm prefix -g)/bin`. |
| `codexArgsPrefix` | `[]` | Args placed before `app-server` / `--version`, for wrappers such as `node codex.js`. |
| `extraArgs` | `[]` | Args appended after `app-server`, e.g. `['-c', 'model_reasoning_summary="detailed"']`. |
| `env` | – | Extra env for every codex process, e.g. `CODEX_HOME`. `StartSessionOptions.env` is applied over it. |
| `requestTimeoutMs` | 60000 | Timeout for the handshake and for thread/turn requests. |
| `interruptTimeoutMs` | 15000 | If Codex doesn't confirm an interrupt within this time, the adapter completes the turn locally. |
| `probeTimeoutMs` | 15000 | Timeout for the auth check in `probe()`. |
| `logger` | no-op | Logger for `probe()`. Sessions use `AdapterContext.logger`, and codex stderr is logged at `debug`. |

## Permission modes

| bizzi mode | Codex `approvalPolicy` | Codex sandbox | meaning |
|---|---|---|---|
| `read-only` | `on-request` | `read-only` | Codex reads anything and asks before writes, network, or escalation. This is Codex's built-in default. |
| `auto` | `on-request` | `workspace-write` | Codex edits and runs commands inside the workspace and asks before going beyond it. |
| `untrusted` | `untrusted` | `workspace-write` | Codex asks before any command that isn't a known-safe read. |
| `full-access` | `never` | `danger-full-access` | No sandbox and no prompts. |

If `permissionMode` is omitted, the adapter sends no override and the user's `~/.codex/config.toml` applies. The effective policy is then mapped back to a mode name, when it matches one, and reported in `session.info`.

On `set()`, the sandbox is sent as a full `SandboxPolicy`, because `turn/start` doesn't accept a mode name. `workspace-write` is sent with `networkAccess: false` and no extra writable roots.

## Feature coverage

| feature | how |
|---|---|
| handshake | `initialize` (`clientInfo.name = "bizzi"`), then `initialized` |
| new session | `thread/start {cwd, model, approvalPolicy, sandbox, config, developerInstructions}`. The thread id becomes `agentSessionRef` and is reported via `session.info`. |
| resume | `thread/resume {threadId: resumeRef, …same overrides, excludeTurns: true}`. An unknown thread fails with `not_found`. |
| turns | `turn/start` per bizzi turn. Notifications that arrive before the `turn/start` response (and so before the turn id is known) are buffered, then replayed. |
| steer | `turn/steer {expectedTurnId}` |
| interrupt | `turn/interrupt`. If it's called before the turn id is known, it is sent once the id arrives. If Codex never confirms, the adapter falls back locally. |
| `set()` model / effort / permission mode | Queued and sent as overrides on the next `turn/start`, where they persist for later turns. app-server has no request for changing settings between turns. |
| MCP injection | `thread/start config` overrides: `mcp_servers.<name> = {command, args, env}` (stdio) or `{url, http_headers}` (http). Names are sanitized to `[A-Za-z0-9_-]`. |
| `systemPromptAppend` | `developerInstructions` on thread start/resume. It adds to Codex's base instructions and AGENTS.md rather than replacing them. |
| effort at start | `config.model_reasoning_effort` |
| images | `image` blocks are sent as data URLs. `file` blocks with image extensions are sent as `localImage`. Other files become a text reference. |
| probe | Finds the binary, runs `codex --version`, then starts a throwaway app-server and calls `account/read`. `ok` means an account is present, or the provider needs no OpenAI auth. `missing` means not logged in. `unknown` means the check failed. |

### Event mapping

| Codex | bizzi |
|---|---|
| `item/agentMessage/delta`, `item/completed` agentMessage | `message.delta`, `message.completed` |
| `item/reasoning/summaryTextDelta` (`summaryPartAdded` adds a blank line), `item/completed` reasoning | `reasoning.delta`, `reasoning.completed {summary: true}` |
| `item/reasoning/textDelta` (raw reasoning) | `reasoning.delta`, only for items with no summary stream |
| `commandExecution` item | `tool.started` (kind `shell`). `item/commandExecution/outputDelta` becomes `tool.updated {output: chunk}`. Completion becomes `tool.completed` (a non-zero exit is `error`, declined is `denied`). |
| `fileChange` item | `tool.started` (kind `write` if every change adds a file, otherwise `edit`), then `file.changed` with the diff for each change on success, then `tool.completed`. |
| `mcpToolCall` | `tool` kind `mcp`. `item/mcpToolCall/progress` becomes `tool.updated {progress}`. |
| `webSearch`, `imageView`, `dynamicToolCall`, `collabAgentToolCall` | `tool` with kind `web`, `read`, `other`, `task` respectively |
| `turn/plan/updated` | `plan.updated` |
| `thread/tokenUsage/updated` | `usage.updated` (thread total, with `contextWindow`) |
| `turn/completed` | `turn.completed {stopReason, usage, error}`. Status maps completed to `end_turn`, interrupted to `interrupted`, failed to `error`. `usage` is the change in the thread total during the turn. |
| `error` notification | `error {message, code: codexErrorInfo, fatal: false}` |
| `thread/name/updated`, `model/rerouted` | `session.info {title}`, `session.info {model}` |
| anything else (e.g. `mcpServer/startupStatus/updated`, `warning`) | `agent.raw` |

Usage is normalized so that `inputTokens` excludes cached tokens and `cacheReadTokens` holds the cached count. OpenAI's own `input_tokens` includes cached tokens.

### Approvals

| server request | bizzi `kind` | options and replies |
|---|---|---|
| `item/commandExecution/requestApproval` | `shell` | allow → `accept`, allow_always → `acceptForSession`, deny → `decline` |
| `item/fileChange/requestApproval` | `edit` / `write` | same as above. The changes come from the matching `fileChange` item. |
| `item/permissions/requestApproval` | `other` | allow grants the requested profile for the turn, allow_always grants it for the session, deny grants nothing |
| legacy `execCommandApproval` / `applyPatchApproval` | `shell` / `edit` | `approved` / `approved_for_session` / `denied {rejection: message}` |

Approvals are not editable. If Codex withdraws a request (`serverRequest/resolved` before bizzi answers), the adapter emits `approval.resolved {decision: 'deny', by: 'agent'}`. Approvals still pending when a turn ends or the session stops are answered `cancel`. `mcpServer/elicitation/request` is declined automatically. Other server requests (`item/tool/requestUserInput`, `item/tool/call`, auth refresh, attestation) get a JSON-RPC error and are surfaced as `agent.raw`.

### Process lifecycle

If the process exits unexpectedly, the adapter emits these events in order:

1. `error {fatal: true, code: 'process_exited'}`, whose message includes the stderr tail with ANSI codes stripped.
2. `turn.completed {stopReason: 'error'}`, if a turn was running.
3. `session.status {status: 'failed'}`.

`stop()` completes a running turn as `interrupted`, sends SIGTERM (then SIGKILL after 3 s), and emits `session.status 'ended'`. Calling it again does nothing.

## Not supported (yet)

- fork (`thread/fork` exists, but the adapter contract has no fork operation)
- plan mode (`collaborationMode` is experimental)
- slash commands / skills listing
- answering `requestUserInput` questions (the contract has no answer path)
- editable approvals
- subagent threads (their notifications are ignored, and collab tool calls appear as `task` tools)
- a live model list (`model/list` exists, but `models` is `'dynamic'`)

## Tests

`npm test -w @bizzi/adapter-codex` runs offline:

- `test/fake-app-server.ts` is a scripted JSON-RPC server. It covers handshake, streaming, early notifications, approvals, interrupt, steer, `set()`, crash, and resume.
- `test/rpc.test.ts` covers framing.
- `test/real-binary.test.ts` runs a handshake against the real devDependency binary with a temporary `CODEX_HOME`. It needs no login, and it skips if the binary is unavailable.
