# @bizzi/adapter-opencode

`AgentAdapter` for [OpenCode](https://opencode.ai) in **structured** mode. It drives the OpenCode
**v2** server (`opencode serve`, tested with 2.0.25) over HTTP and SSE.

```ts
import { createAdapters } from '@bizzi/adapter-opencode';
const [opencode] = createAdapters({ defaultAgent: 'build' });
```

## Integration choice

- **A small hand-written client for the v2 HTTP API, not `@opencode-ai/sdk`.** The SDK's `./v2`
  entry (npm `latest`, 1.19.5) was generated from an older v2 snapshot. It still calls routes the
  2.0.25 server no longer has (`/api/health`, `/api/session/{id}/event`, `.../question/...`,
  `.../wait`) and doesn't cover newer ones (forms, instruction entries, runtime MCP). Its root
  entry targets v1. `src/client.ts` follows the server's own OpenAPI document
  (`GET /openapi.json`, "opencode HttpApi"). That document types the SSE payload as an opaque JSON
  string, so the event shapes in `src/types.ts` come from captured traffic
  (`test/fixtures/opencode-2.0.25-events.jsonl`, sanitized).
- **One private server per adapter instance (one per bizzi node).** The v2 server serves many
  directories at once: each session carries `location.directory`, and location-scoped routes take
  `?location[directory]=`. Each location the server loads also starts the user's configured MCP
  servers, so a single process keeps that cost down. The server is spawned lazily as
  `opencode serve --hostname 127.0.0.1 --port 0` with a random `OPENCODE_SERVER_PASSWORD`
  (HTTP basic auth, user `opencode`). Readiness means the `server listening on <url>` line, then
  `GET /api/info`, then the SSE stream is open. The adapter never uses or touches the user's
  background service (`opencode service`).
- **Lifecycle:**
  - A health check polls `/api/info` every 15 s. After 3 failures the server is killed and
    restarted.
  - If the server crashes it restarts with exponential backoff, up to 5 times in 5 minutes. After
    that it waits for the next `send`/`start`.
  - A crash ends any in-flight turn with `turn.completed{stopReason:'error'}` plus
    `error{code:'server_exited'}`. After the restart, instructions, environment and MCP
    registrations are applied again. Sessions live on in OpenCode's database.
  - If only the SSE stream drops (the server is still up), the adapter reconnects and rebuilds the
    turn from `GET /api/session/{id}/message` and `/api/session/active`. The server doesn't replay
    events, and `Last-Event-ID` is ignored.
  - Shutdown: SIGTERM, then SIGKILL after 6 s. The server is also stopped 10 minutes after the last
    session stops (`idleShutdownMs`), and when the process exits.
- **ACP fallback:** `opencode acp` speaks the Agent Client Protocol over stdio. It isn't used here.
  If the HTTP API drifts badly, a generic ACP adapter can drive it, but it lacks forms, runtime MCP
  and instruction entries.

## Mapping

| bizzi | OpenCode v2 |
|---|---|
| `start` | `POST /api/session {location, agent, model, permissions, metadata}`; `resumeRef` → `GET /api/session/{id}` |
| `agentSessionRef` | OpenCode session id (`ses_…`) |
| `send` | `POST /api/session/{id}/prompt {text, files}` (image → `data:` URI, file → `file://` URI) |
| `steer` | the same with `delivery: "steer"` |
| `interrupt` | `POST /api/session/{id}/interrupt` (closes the turn itself if nothing is running, or after 5 s) |
| `respondApproval` | `POST /api/session/{sid}/permission/{id}/reply`: allow→`once`, allow_always→`always`, deny→`reject` (+message) |
| `set` | model/effort → `POST …/model {providerID,id,variant}`; permissionMode → `POST …/agent` (both checked against `/api/model` and `/api/agent`) |
| `session.text.delta/ended` | `message.delta` / `message.completed` (messageId `"<assistantMessageID>:t<ordinal>"`) |
| `session.reasoning.*` | `reasoning.delta` / `reasoning.completed` |
| `session.tool.called` / `progress` / `success` / `failed` | `tool.started` / `tool.updated` / `tool.completed` (ok, error, `permission.rejected`→denied, aborted→cancelled) |
| edit/write success | `file.changed` (diff and created/modified from the permission metadata) |
| `permission.asked` / `permission.replied` | `approval.requested` / `approval.resolved` |
| child `session.created{parentID}` + subagent `tool.progress{metadata.sessionID}` | `subagent.started/completed`; child tools get `parentToolId` |
| `session.step.ended` tokens/cost (own + subagents) | `turn.completed.usage` (+ `contextWindow` from the model's limit) |
| `session.execution.succeeded/failed/interrupted` | `turn.completed` end_turn/error/interrupted (failed also emits `error`) |
| `session.agent.selected` / `model.selected` / `renamed` | `session.info` |
| `form.created` | `question.asked` (display only) |
| todo-style tools (`todowrite`) | `plan.updated` (2.0.25 ships no todo tool) |
| anything else for the session | `agent.raw` |

Tool kinds: `shell`/`bash`→shell, `read`→read, `edit`/`patch`/`multiedit`→edit, `write`→write,
`grep`/`glob`/`list`→search, `webfetch`/`websearch`→web, `subagent`/`task`→task, `execute`
(Code Mode, how v2 calls MCP tools) and `server_tool` names→mcp, everything else→other.

**Injection** (best effort; a failure emits a non-fatal `error{code:'injection_failed'}`):

- `systemPromptAppend`: `PUT /api/experimental/session/{id}/instructions/entries/bizzi`. These are
  API-managed instruction entries attached to that session.
- `mcpServers`: `PUT /api/experimental/mcp/{name}?location[directory]=cwd`. This registers the
  server at runtime for that directory and writes nothing to config files. Sessions in the same
  directory share a registration when the config is identical; when it differs, the name gets a
  suffix. Registrations are removed when their last session stops.
- `env`: `PUT /api/session/{id}/environment`.

## Capabilities

streaming `token` · steer ✓ · interrupt ✓ · resume ✓ (also after node restart) · fork ✗ (the server
has `POST …/fork`, but the adapter contract has no fork entry point) · approvals `per-tool`, not
editable · permissionModes `build`, `plan` (any primary agent is accepted) · models `dynamic`,
switchable mid-session · effort = model variants (`minimal`…`max`, depends on the model) ·
planMode ✓ · todos ✗ · subagents ✓ · images ✓ · mcpInjection `launch` ·
instructionInjection `system-append` · usage `tokens+cost`.

## Options (`OpenCodeAdapterOptions`)

| Option | Purpose |
|---|---|
| `binary` | Path to the `opencode` binary |
| `hostname`, `port` | Address the private server listens on |
| `env` | Environment for the server, e.g. `XDG_DATA_HOME` to isolate its database |
| `serverUrl` + `serverPassword` | Attach to an existing server instead of spawning one |
| `defaultAgent` | Agent for sessions that don't set one |
| `permissions` | Extra rules added to every session, e.g. `{action:'shell',resource:'*',effect:'ask'}` to force approvals when the user's config allows everything |
| `allowQuestions` | Default false: the `question` tool is denied, because bizzi can't answer it yet |
| `idleShutdownMs`, `maxRestarts`, `restartWindowMs`, `restartBackoffMs`, `healthIntervalMs`, timeouts | Server lifecycle tuning |

## probe()

1. Runs `opencode --version`. A missing binary gives `installed:false`; a v1 install gets a note.
2. Reads provider ids from the user's global config (`providers` / `provider` keys only; secrets
   are never read out) and checks for provider API keys in the environment. Either one gives
   `auth:'ok'`.
3. Otherwise runs `opencode auth list --format json --standalone`, which uses a throwaway private
   server, never the background service. MCP OAuth logins (`mcp_…`) don't count. If nothing turns
   up, the result is `auth:'unknown'` with a note saying only the free OpenCode Zen models work.

## Caveats

- The private server shares OpenCode's default database, so bizzi sessions also appear in
  `opencode session list` and the TUI. If you prompt a bizzi session from the background service
  or the TUI, that turn runs in that process and bizzi won't see its events.
- The server starts the user's configured MCP servers for every directory it loads, the same as
  the user's own OpenCode does.
- The instruction-entry, runtime-MCP and session-environment routes are `experimental` in 2.0.25.
- Pass real paths: macOS `/tmp` → `/private/tmp` mismatches make OpenCode reject writes. The
  adapter calls `realpath` on `cwd`.

## Tests

`npm test -w @bizzi/adapter-opencode` runs offline. It uses a fake v2 server (`test/fake-server.ts`)
that reproduces the captured routes and SSE shapes, in-process and as a child process. Coverage:

- turn streaming and the tool lifecycle (every tool kind, subagents, files, todos)
- the permission round-trip for allow, allow_always and deny
- interrupt, set() validation, steer, resume
- reconciliation after a stream gap
- a replay of the real 2.0.25 capture (approvals, interrupt, provider failure, subagent)
- server spawn and auth, crash → fail turn → restart, give-up and recovery, startup failure and
  timeout, idle shutdown
- probe

Live run: `BIZZI_LIVE=1 [BIZZI_OPENCODE_MODEL=provider/model] npm test -w @bizzi/adapter-opencode`.
It starts a private server (with a temporary data dir unless `BIZZI_OPENCODE_SHARED_DATA=1`),
creates and resumes a session, and, only if a provider is configured, runs three tiny turns:
a plain reply, a shell approval, and an interrupt.
