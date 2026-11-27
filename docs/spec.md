# bizzi — product & system spec (draft 3)

Status: ideation. Companion docs: [topology.md](topology.md) (installs, roles, machines, where work runs, offline), [knowledge.md](knowledge.md) (rules & memory across agents), [tech-choices.md](tech-choices.md) (stack; the core language/shell decision is open).

## 0. Decisions so far

| # | Topic | Decision |
|---|---|---|
| 1 | Users | **Single user.** "Team" meant releasing bizzi as an open project others self-host for themselves, not one org sharing an install. Multi-user (orgs, sharing, roles) is deprioritized: keep what's already built (`org_id`, Org/Member in the schema) and leave room for it, but don't spend effort on it now. |
| 2 | Exposure | The hub sits behind a reverse proxy (Caddy / SWAG) and is authenticated. Auth is pluggable; IdP choice deferred. M1 ships pairing-first device auth (a setup code, then Ed25519 device keys and short-lived tokens); passkeys come later through the IdP. |
| 3 | Hierarchy | **Machine first**: Machine > Workspace > Session. You choose where to work (this laptop, machine A, machine B) before anything else. Projects are an optional cross-machine link between workspaces. |
| 4 | Install model | **One install, roles by config.** The desktop app embeds the control layer, so local mode needs nothing else. Remote machines run the same core without the desktop UI (`bizzi serve`), either GUI-capable (inside a logged-in GUI session, e.g. a Mac for visual inspection) or headless. **On Linux, headless means a docker-compose stack** (`hub` + `node` services, [topology.md](topology.md) §2.2). The phone is client-only. |
| 5 | Mental model | Like Claude Code Remote Control: the machine running the agent dials out to a relay, clients talk to the relay. In bizzi the relay is your self-hosted hub, and it drives any ADE on any of your machines. |
| 6 | Continuity | **No takeover of running sessions.** A session lives and dies on the machine you started it on. Continuity comes from choosing a remote machine for work that should outlive the laptop lid. Laptop sessions pause while the laptop sleeps and resume when it wakes; clients replay what they missed. (An explicit "fork to another machine" may come later.) |
| 7 | ADE provisioning | bizzi can install, update and log in ADEs (Claude, Codex, OpenCode, agy) on any machine, from any client. |
| 8 | Workspaces | git repos and plain directories (research) both supported. Containers as a workspace kind are a candidate for later ([topology.md](topology.md) §7); VMs out of scope. |
| 9 | Knowledge | Scoped rules + memories (global, machine, project, workspace, session) shared across agents; acceptance policy is a user setting with balanced defaults; suggestions in a batched inbox ([knowledge.md](knowledge.md)). |
| 10 | Stack | **Decided:** TypeScript core on Node.js (Claude Agent SDK in-process, `codex app-server`, OpenCode SDK, `node-pty`, official MCP/ACP SDKs). React UI shipped in Electron (desktop), Capacitor (phones) and the browser, with performance guardrails. See tech-choices D0. |
| 11 | Agent-to-agent | Agents can start and drive other bizzi sessions through MCP tools. **The machine is the boundary for now**; cross-machine via the hub is a later phase. Depth, concurrency and budget limits; local inference can be marked **budgetless**. See §12. |

## 1. What bizzi is

A self-hosted agentic development environment (ADE) that **orchestrates existing coding agents** (Claude Code, Codex, OpenCode, Antigravity CLI `agy`) and can also talk to **plain model APIs** (Anthropic, OpenAI, Gemini, OpenRouter, any OpenAI-compatible endpoint such as a local vLLM/Bifrost gateway).

Pick a machine, pick a workspace on it, start a session with any agent, and drive it from wherever you are: the desktop app on that machine, the desktop app on another machine, a browser, or your phone.

Compared with Vicoa and Claude Remote Control:

- **Self-hosted relay** (the hub), not a vendor's.
- **Any ADE**, not just Claude, with each agent's richest native interface and a raw terminal as the universal fallback.
- **Machines are first-class:** a registry of your machines, what's installed and logged in on each, and their workspaces. bizzi can provision ADEs onto them.
- **One install** that is a full local ADE on its own and becomes a remotely reachable machine when connected to a hub.
- **Shared knowledge across agents:** rules and memory written once, visible to Claude, Codex, OpenCode and agy.
- **Hard frontend/backend split:** UIs are clients of a versioned protocol.

## 2. Goals / non-goals

Goals

1. Drive Claude Code, Codex, OpenCode and agy with as many native options as possible (model, effort, permission/plan mode, approvals, steer/interrupt, fork/resume, MCP, subagents, slash commands/skills, images).
2. One normalized session view across agents; capability-gated controls.
3. One install for desktop and servers (headful or headless); a client-only phone app; a browser client.
4. Fully usable locally with no hub and no network.
5. Reach any of your machines from any client through a self-hosted hub; never lose events across disconnects.
6. Provision ADEs (install, update, log in) on any machine remotely.
7. Shared rules and memory across agents and machines.
8. Releasable as a project: easy for someone else to self-host for their own use. (Team-ready data model kept from earlier work, but multi-user is deprioritized.)

Non-goals (for now)

- Our own coding-agent harness ("agentic with a raw API" = OpenCode pointed at that provider, §6.5).
- Live migration of running sessions between machines.
- VMs. Multi-tenant SaaS. A full code editor (browse, diff review and quick edits only; deep-link to a real editor).

## 3. Architecture

### 3.1 The Remote Control analogy

| Claude Code Remote Control | bizzi |
|---|---|
| Claude app / claude.ai (client) | bizzi client: phone app, browser, or the UI part of any bizzi install |
| Anthropic API: session registry + relay; the local CLI "registers with the Anthropic API and polls for work", messages are routed over a streaming connection; outbound HTTPS only | **hub**: machine/session registry + relay + event-log replica + push; machines dial out over WSS; no inbound ports on machines |
| `claude` process running on your machine | **node**: the agent-driving part of a bizzi install, running any ADE |
| session unreachable while the machine is off | same: sessions run where you started them |

### 3.2 One install, three roles

Every bizzi install contains the same core; roles are switched on by configuration.

| Role | What it does | Where it's on |
|---|---|---|
| **client** | UI: renders sessions, sends your intent | desktop app, browser, phone app |
| **node** | drives ADEs, owns workspaces, PTYs, provisioning, the local replica, the memory MCP server | every desktop or server install |
| **hub** | registry, relay, auth, event-log replica, blobs, push, git mirrors (later) | exactly one install that's always reachable (typically the server, behind the proxy) |

Deployment shapes:

```
 laptop: desktop app                      server: headless or headful install
 ┌──────────────────────────────┐         ┌───────────────────────────────┐
 │ client UI                    │         │ hub ◀── reverse proxy ◀── phone│
 │   │ in-process / local socket│  WSS    │  ▲                            │
 │ node (local control layer)───┼────────▶│  │ local                       │
 │   claude codex opencode agy  │ dial-out│ node                          │
 └──────────────────────────────┘         │   claude codex opencode agy   │
                                          └───────────────────────────────┘
 machine B (Mac for GUI work): `bizzi serve` in the GUI session, dials the hub
 phone: client only, talks to the hub
```

- **Local mode:** the desktop app's UI talks to its own node in-process (or over a local socket). No hub, no network needed. This is the airplane case.
- **Connected mode:** the node also dials the hub. The hub relays clients to it, keeps an event-log replica so clients can catch up, and sends push notifications. The desktop app's UI also reaches other machines through the hub.
- **GUI-capable remote** (e.g. a Mac mini for Xcode, simulators, headed browsers, visual inspection): `bizzi serve` as a LaunchAgent in the logged-in GUI session; no desktop app needed. Agents can open and screenshot windows; screenshots land in the session timeline. Details: [topology.md](topology.md) §2.1.
- **Headless remote on Linux:** a docker-compose stack. A `node` service (agents run inside it, ADE installs and logins on a persistent volume, workspaces bind-mounted from the host) and, on the server that hosts it, a `hub` service on the reverse proxy's network. Headed browsers via Xvfb inside the node image. See [topology.md](topology.md) §2.2.
- **Headless Mac** (e.g. a Mac mini without GUI work): `bizzi serve` as a launchd agent (Docker on macOS is a Linux VM, so it can't run macOS tooling).

Rules:

- **Nodes dial out.** No inbound ports on any machine except the hub's, behind the proxy.
- **Clients never talk to ADEs directly.** Client → (in-process | hub) → node → ADE.
- **Same protocol everywhere.** The in-process, local-socket and hub paths carry the same client protocol.
- **Sessions are owned by their node** and never move, so a session's event log has exactly one writer: no leases or fencing needed.
- **Event-sourced sessions:** sequence-numbered events; clients replay from a cursor after any disconnect.

## 4. Domain model

```
Org ─< Member(User, role: owner|admin|member|viewer)    # day 1: one org, one user
User ─< Device                     # client-only installs: phone, browser

Org ─< Machine                     # an install with the node role (pairs with the hub)
  facts: os, arch, headful, tags[gpu,docker,…], always_on, online, power
  roles: node (+ hub on one machine)
  ─< AgentInstall                  # what's on this machine (see §7)
       agent: claude | codex | opencode | agy
       version, install method (preferred?), update available, update policy: auto | notify | pinned
       support: ok | untested | unsupported (+ reason, remedy)
       auth: ok | missing | expired, account label
       defaults: model, effort, permission mode, extra flags
  ─< ApiProvider                   # model API credentials usable from this machine
       billing: metered | plan | budgetless   (§12.3)
       maxConcurrent?              # capacity limit, e.g. GPU slots on a local gateway
  ─< Workspace                     # a directory on this machine
       path, kind: git | dir   (container later)
       project?: Project           # optional cross-machine link
       ─< Session
            agent, mode: structured | terminal
            agent_session_ref (claude session id / codex thread id / opencode session id / pty id)
            forked_from?           # forks; also forks onto another machine (+ forked_from_machine, topology.md §6)
            agent_version          # version the agent process started on (§7 updates)
            spawned_by?            # parent session when an agent started it (§12.1); + spawned_by_machine when it runs elsewhere (§12.4)
            scope: child | detached  # child: stops with its parent
            status: starting|running|waiting_input|waiting_approval|idle|
                    paused (machine asleep/offline)|ended|failed
            ─< Turn ─< Event(seq, ts, type, data)
            ─< Approval   ─< Artifact (blob refs)

Org ─< Project                     # optional: links workspaces across machines
  identity: normalized git remote URL, or manual link for dir workspaces
  used for: project-scope knowledge, "same project on machine B", defaults
```

Per user and session, the hub keeps a `seen_through` cursor (last seq viewed on any device), so "done, not yet seen" agrees between phone and desktop.

Navigation follows the model: **machine → workspace → session**. The project link lets the UI show "acme on laptop / acme on server-a" and lets project-scope rules and memory apply in both.

### 4.1 Session lifecycle

**A session ends only when someone closes it.** Someone starts a session, and someone closes it: you (End session, removing its workspace), or the parent that started a helper (`session_stop`, or the parent being closed). Everything else resumes:

- **bizzi stops or restarts the agent process** (bizzi quits, updates or restarts; an agent update, [updates.md](updates.md)): the session stays open and resumes on its next message.
- **The agent process exits or crashes on its own:** the open turn closes with an error, the timeline says so, and the next message starts the agent again, resuming the conversation (`resumeRef`). A clean exit leaves the session `idle`; a crash leaves it `failed` until then, so it stands out. A terminal session starts its process again on the next keystroke.
- **The agent can't resume** (no conversation yet, or an adapter without `resumeAfterNodeRestart` after a node restart): the session stays open, and the next message starts a new conversation in it.
- **The agent fails to start:** the session is `failed`, and the next message tries again.

`ended` is therefore final and always means closed, and only `ended` cascades to `child` helpers. A helper whose parent crashed keeps running, because the parent resumes. Adapters still report `session.status ended/failed` when their process goes away; the core turns that into the above and never ends the session for it. Sessions that older versions ended without anyone closing them reopen on the next node start.

Closing is not deleting: an ended session keeps its history, and `session.reopen` makes it `idle` again, so its next message starts the agent and resumes the conversation when the agent can (a terminal session starts again on its next keystroke). Helpers that ended with it stay ended. `session.delete` removes a session and its events for good.

## 5. Protocols

Two protocols (client↔hub/node, node↔hub), one shared schema package, JSON envelopes over WebSocket (or in-process), versioned `bizzi/1`. Transport rationale: tech-choices D1.

### 5.1 Envelope

```jsonc
{ "id": "r_81", "method": "session.send", "params": { "sessionId": "s_01J…", "input": [{ "type": "text", "text": "fix the flaky test" }] } }
{ "id": "r_81", "result": { "turnId": "t_01J…" } }
{ "ch": "session:s_01J…", "seq": 1042, "ts": "2026-11-04T17:02:11.123Z",
  "type": "tool.started", "data": { "toolId": "tc_7", "kind": "shell", "title": "pnpm test" } }
```

- ULIDs generated where things are created (offline-safe).
- `seq` assigned by the owning node. `subscribe { ch, since }` → replay, then live.
- Large payloads go to blobs; per-subscriber delta coalescing on slow links.
- Requests to a session on an offline machine fail fast with `machine_offline` (the UI shows the cached timeline). Optional later: queue the message for delivery on reconnect.

### 5.2 Client operations (initial set)

| Area | Methods |
|---|---|
| Machines | `machines.list`, `machine.get`, `machine.pair`, `machine.rename`, `machine.set` (tags, description) |
| Provisioning | `agents.list { machineId }`, `agent.install`, `agent.update`, `agent.uninstall`, `agent.login` (opens a login PTY, §7), `agent.logout`, `agent.probe` |
| Workspaces | `workspaces.list { machineId }`, `workspace.create` (clone / new dir / adopt existing path), `workspace.linkProject`, `fs.list/read/write`, `git.status/diff/commit/push`, `worktree.*`; workspace picker: `fs.browse { machineId, path?, showHidden? }` (directories only), `fs.complete { machineId, prefix }` (shell-like directory completion, `~` expanded), `fs.suggest { machineId }` (home, source roots, recent parents, repos not yet added) |
| Sessions | `session.create { workspaceId, agent, mode }`, `send`, `steer`, `interrupt`, `stop`, `fork`, `resume`, `set` (model/effort/mode) |
| Approvals | `approval.respond { approvalId, decision: allow\|allow_always\|deny, message?, editedInput? }` |
| Terminal | `term.open`, `input`, `resize`, `close` |
| Knowledge | `knowledge.list/search/add/update/forget`, `knowledge.suggestions` + `accept/reject`, `knowledge.policy.get/set`, `knowledge.sync` |
| Commands | `agent.commands`, `agent.runCommand` |
| Notifications | `push.register`, `push.prefs` |

### 5.3 Normalized events

`session.status` · `turn.started/completed` (usage, cost, stop reason) · `message.delta/completed` · `reasoning.delta/summary` · `tool.started/updated/completed` (`kind`: shell, read, edit, write, search, web, mcp, task, other) · `file.changed` (diff ref) · `plan.updated` · `approval.requested/resolved` · `question.asked` · `usage.updated` · `subagent.started/completed` · `knowledge.written` · `term.output` · `machine.status` · `install.progress` · `agent.raw` (untranslated native event, always kept and rendered generically, so new agent features show up before the adapter learns them)

### 5.4 Node ↔ hub

Same envelope. Node→hub: `hello` (facts, installs, last-acked seq per session), events from the outbox, `heartbeat` (power, load), knowledge replication, and the node's own requests (below). Hub→node: relayed client requests, knowledge replication, node-to-node requests from other machines, (later) `tools.bridge`.

The node writes events to its local SQLite first; the outbox drains to the hub when connected. A laptop that worked offline uploads its sessions on reconnect, so the phone can see them afterwards.

**Node → hub requests** are the primitive behind cross-machine helpers, forks and, later, tool bridging. The node link stays one socket. Besides answering the hub's `h:` requests, a node sends ordinary requests with `n:` ids and gets `{ id, result }` / `{ id, error }` back. The contract is in `packages/protocol/src/hub.ts`:

- **Negotiated, additive.** The hub lists `node.requests` in `node.welcome` `features`. A node linked to an older hub gets `unsupported` locally. A node without a link gets `machine_offline` ("not connected to a hub"). Neither case waits on a timeout.
- **Authenticated as the node.** The identity comes from the link (the `node.hello` token and machine id), never from the params.
- **Allowlisted.** The hub answers hub-index reads (`machines.list`, `workspaces.list`, `sessions.list`) as it would for a paired device. Node-to-node methods (`helper.*`, `fork.prepare`, `fork.receive`) need `machineId`. The hub forwards them to that machine and stamps `caller: { machineId }` on them, so the target can check ownership. Every other method is `unauthorized`, and devices can't call the node-to-node methods at all.
- **Fails fast.** A request to an offline target gets `machine_offline` with `{ machineId, lastSeenAt }` straight away. A request in flight fails with `machine_offline` when either link drops. Long calls carry their own timeouts: a `helper.wait` gets its wait plus a margin, and a fork gets up to 5 minutes.
- **In core.** Node code calls `node.hub` (`HubPort`). The hub link attaches its transport when the hub welcomes the node and detaches it on close, so core never sees WebSockets.

Built (2026-11-25): all of the above, used by §12.4 and by fork-to-machine ([topology.md](topology.md) §6). It is tested end to end with a real hub and two nodes (`apps/cli/test/cross-machine.test.ts`).

## 6. Agent adapters

Each adapter maps an agent's native interface to the session model and publishes a **capability manifest**. The UI reads capabilities, never agent names.

```ts
interface AgentCapabilities {
  modes: ("structured" | "terminal")[];
  streaming: "token" | "message" | "none";
  steer: boolean; interrupt: boolean;
  fork: boolean; resume: boolean; resumeAfterNodeRestart: boolean;
  approvals: "per-tool" | "per-command" | "mode-only" | "none";
  editableApprovals: boolean;
  permissionModes: string[];
  models: "dynamic" | string[]; setModelMidSession: boolean;
  effort: string[] | null;
  planMode: boolean; todos: boolean; subagents: boolean;
  slashCommands: boolean; skills: boolean; images: boolean;
  mcpInjection: "launch" | "config-file" | "none";
  instructionInjection: "system-append" | "config" | "file" | "none";
  usage: "tokens" | "tokens+cost" | "none";
}
```

| Agent | Structured interface | Notes |
|---|---|---|
| **Claude Code** | Claude Agent SDK (spawns the installed `claude`) or `claude -p --input-format stream-json --output-format stream-json` directly | streaming input, per-tool approvals with editable input, hooks, interrupt, set model/permission mode, resume/fork, MCP injection, subagents, todos, cost. Reads `AGENTS.md` when there's no `CLAUDE.md` (≥ 2.1.277). |
| **Codex** | `codex app-server` (stdio JSON-RPC; what the Codex IDE client uses) | thread/turn/item model, `turn/steer`, `turn/interrupt`, fork/resume, server→client approvals, token usage. Generate types per pinned version; buffer notifications that arrive before the `turn/start` response. |
| **OpenCode** | v2 `opencode serve` (HTTP + SSE); v1 only through terminal mode (tech-choices D12). Later: attach to OpenCode's shared background service. Or `opencode acp` | also the multi-provider harness for raw APIs (§6.5) |
| **agy** | none yet → **terminal mode** | `--print` reportedly silent without a TTY; interactive Google sign-in; Google's FAQ reportedly treats third-party access tools as a ToS violation, so drive only the official binary in a PTY. Structured mode once Google ships a protocol, or in Gemini API-key mode. |

### 6.5 Plain model APIs
1. **Chat/utility (no tools):** provider abstraction on the node or hub: quick questions, session titles, handoff briefs, memory extraction, review passes. Anthropic, OpenAI, Gemini, OpenRouter, OpenAI-compatible base URLs.
2. **Agentic:** OpenCode on the node, configured for that provider/model.

**Built (2026-11-25): item 1, `@bizzi/adapter-api`.**

- **Agent kind `api`** ("API chat"), loaded by `bizzi serve` like the other adapters. A structured session with no tools: token streaming (`message.delta`, and `reasoning.delta` for thinking / `reasoning_content`), interrupt (aborts the request; partial text is kept in the conversation), `turn.completed` usage per turn, `usage.updated` totals, `context.updated` (last request's prompt + output against the window; no breakdown beyond a "bizzi overhead" row for the injected rules), model and effort switchable mid-session (also across providers), images, and text files attached as text (≤ 256 KiB). Rules and memory arrive as the system prompt (`systemPromptAppend`); MCP servers are ignored (`mcpInjection: 'none'`). Capabilities match the §6.7 column, plus fork and resume: the conversation is kept in `<dataDir>/api-chat/<ref>.json` (0600), so sessions resume after a node restart and fork natively.
- **Providers:** two wire formats, Anthropic Messages (`/messages`, `x-api-key`, `anthropic-version`, `output_config.effort`, thinking blocks replayed unchanged to Anthropic-format providers) and OpenAI-compatible chat completions (`/chat/completions`, bearer, `stream_options.include_usage`, `reasoning_effort`). Presets: `anthropic`, `openai`, `gemini` and `openrouter` (the last two through their OpenAI-compatible endpoints). Others go in `<dataDir>/api-providers.json`, re-read when it changes:

  ```jsonc
  {
    "defaultModel": "h200/qwen3.8-27b",
    "utilityModel": "h200/qwen3.8-27b",
    "providers": {
      "h200": { "api": "openai", "baseUrl": "https://gpu-gateway.example/v1", "apiKeyEnv": "BIFROST_KEY",
                "billing": "budgetless", "maxConcurrent": 8,
                "body": { "chat_template_kwargs": { "enable_thinking": false } }, "models": ["qwen3.8-27b"] },
      "gemini": null                      // removes a preset
    }
  }
  ```

  Models are `provider/model` (the provider is everything before the first slash, so `openrouter/anthropic/claude-sonnet-5-5` works). Other fields: `auth` (`bearer` | `x-api-key`), `headers`, `contextWindow`, `maxOutputTokens`, `maxTokensParam`, `streamUsage`, `discover`, and per model `{ id, contextWindow, maxOutputTokens, price: { inputPerMTok, outputPerMTok, cacheReadPerMTok?, cacheWritePerMTok? }, body }`.
- **Keys:** a provider names an environment variable (`apiKeyEnv`), never the key. It's looked up in the secrets stored for agent `api` (`agent.setSecret`, which the core passes as the session env), then the node's environment. A missing key fails the session start with `agent_unavailable` naming the secret. Keys are sent in headers only and scrubbed from error text; logs carry provider, model and base URL.
- **Billing (§12.3):** each session emits `account.usage` for its provider (`billing` from the config, presets `metered`; account id = provider plus a 12-hex SHA-256 fingerprint of the key), which sets the session's billing class. `maxConcurrent` is a per-provider queue shared by all sessions and utility calls on the node. Cost (`tokens+cost`) only where the config gives a price; there is no built-in price table.
- **Context windows:** from the config, else discovered once per model from the provider (`GET /models/{id}` → `max_input_tokens` on Anthropic; `GET /models` → `max_model_len` (vLLM), `context_length` (OpenRouter) or `context_window`). Unknown windows report no context, per [usage.md](usage.md) §1.2. The Anthropic output cap defaults to the discovered `max_tokens` (capped at 32k), else 16k; OpenAI-compatible requests send no cap unless configured.
- **Reliability:** retries (2) on 408/409/425/429/5xx/529 and network errors before any output, honoring `retry-after`; 120 s to response headers; a stream with no data for 300 s fails the turn.
- **Utility completions:** `createUtilityCompleter({ dataDir, key })` → `complete({ system, prompt | messages, model?, maxTokens?, signal?, timeoutMs? })` → `{ text, model, billing, stopReason, usage }`, using `utilityModel` (then `defaultModel`). For titles, handoff briefs, memory extraction and review passes; session titles use it (below), the others aren't wired yet. `key` is typically the node's secrets for agent `api` (`@bizzi/services` `secretLookup`, `api:NAME`) with the environment as fallback.
- **Decisions:** fetch + a small SSE parser rather than vendor SDKs (two wire formats, one code path, no dependencies; the OpenCode adapter already parses SSE the same way). The adapter doesn't set `temperature` or thinking parameters (newer Claude models reject some of them); extra fields go in `body`. API chat helpers (`session_start agent: "api"`) are allowed under a read-only parent: no tools means nothing to escalate. `stop_reason` `max_tokens` ends the turn as `other` with an `error` event (`code: max_tokens`); `refusal` maps to `refusal`.
- **Relation to item 2:** OpenCode stays the agentic path for the same providers (it has tools and its own provider config). API chat is the cheap, toolless path; the same `api-providers.json` isn't read by OpenCode.
- **Session titles (2026-11-26):** a session nobody named takes a title from its first message when the turn starts: the gist of the first line with words in it (`titleFromText` in `packages/protocol/src/titles.ts`): markdown markers stripped, whitespace collapsed, request preambles dropped ("I'd like", "can you", "please", "let's", …), only the first sentence kept, cut before an aside ("instead of", "because", "so that", "; ", " — ", "(", a comma after three words), at most 8 words and 50 characters, cut at a word boundary ("Attached spec.md" for a file-only message; image-only messages wait for the next one). When a title model is chosen, `BIZZI_AUTO_TITLE_MODEL` (`provider/model`, `off` disables) or else `utilityModel` in `api-providers.json`, the first message (up to 4000 characters) is also sent to it, and its 3–7 word answer replaces the first-line title. It's never used through the `defaultModel` fallback, so nothing is billed unless you pick a model. The one-pane composer leaves naming to this too; helper sessions started without a `title` get the same short title from their prompt when they're created (not refined by the title model). Precedence: a title given at `session.create` or set with `session.set` (including clearing it) always wins; a title the agent reports (Codex thread names, OpenCode's generated titles) replaces an automatic one, and a model answer that arrives after either is dropped. OpenCode's placeholder ("New session - <date>") doesn't count as a title. Terminal sessions typed into directly stay untitled. Messages bizzi sends itself never title a session: the continue-after-restart turn carries `turn.started.auto` (and anything starting with `[bizzi]` is skipped, for history from older nodes). After `/clear` (`context.cleared`) the next message titles the session again, as if it were the first. **Drift:** with a title model, an automatic title is revisited after the 3rd, 8th, 20th and 50th message since it was made: the model gets the first message (kept as the session's intent, 2000 characters) and the latest three, and names what the conversation is about now. Without a model the first-message title stays. **Repair at load:** sessions titled from bizzi's own message by older nodes, and sessions never titled, take the title from the first user message in their history (no `updatedAt` bump). (`packages/core/src/titles.ts`, `apps/cli/src/titles.ts`).
- **Left:** a provider/model picker that lists providers by name in the new-session dialog (the UI shows `models: dynamic` as free text unless every provider lists its models); wiring utility completions into briefs and harvest; deleting transcripts when a session is deleted (the adapter isn't told); a notional rate for budgetless providers; Anthropic prompt caching (`cache_control`) for long chats.

### 6.6 Terminal mode
Any agent or shell in a PTY under a small detached per-session supervisor (survives node restarts/upgrades); xterm.js in the UI; scrollback chunked to blobs. Also the vehicle for interactive logins (§7).

### 6.7 Expected capability matrix (verify in spikes)

| | Claude | Codex | OpenCode | agy (pty) | API chat |
|---|---|---|---|---|---|
| token streaming | ✓ | ✓ | ✓ | terminal | ✓ |
| steer mid-turn | ✓ | ✓ | ? | type into TUI | – |
| interrupt | ✓ | ✓ | ✓ | Ctrl-C | ✓ |
| per-tool approvals | ✓ editable | ✓ cmd + file | ✓ | TUI | – |
| fork / resume | ✓ / ✓ | ✓ / ✓ | ? / ✓ | ? / `--conversation` | n/a |
| model / effort | ✓ / ✓ | ✓ / ✓ | ✓ / ? | TUI / `--effort` | ✓ |
| plan mode | ✓ | ? | ✓ | `--mode plan` | – |
| MCP injection | launch | config override | config | `agy mcp add` | – |
| AGENTS.md / `.agents/skills` | ✓ / via `.claude/skills` | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ | injected |

## 7. ADE provisioning

From any client: pick a machine → see each ADE's status → install / update / log in.

**Status probe** (on node start, then periodically): binary found? version? latest available? logged in (and as which account)? on PATH for non-interactive shells (launchd/systemd environments differ from your login shell)?

**Install recipes:** declarative, versioned in bizzi, per ADE × OS, preferring per-user installs with no sudo:

| ADE | macOS | Linux | Notes |
|---|---|---|---|
| Claude Code | **native installer** (`curl -fsSL https://claude.ai/install.sh \| bash`); Homebrew detected, migration offered | native installer | the native install self-updates; the Homebrew cask doesn't (Claude only tells you to `brew upgrade`) |
| Codex | Homebrew or `npm i -g @openai/codex` | npm, or a release binary | npm route needs Node; bizzi can install a managed Node if missing |
| OpenCode | v2 install script / Homebrew `anomalyco/tap/opencode-v2` | v2 install script | **v2 only**; v1 is detected and flagged unsupported (tech-choices D12) |
| agy | Homebrew `antigravity-cli` / install script | install script | |

Exact commands get verified per release in CI; recipes are data, so fixing one doesn't need a bizzi release.

**Ownership.** bizzi installs an ADE where none exists, using the recipe's preferred method (per-user, no sudo). An install that's already there is adopted as-is and never silently replaced.

**Supported versions.** Each recipe declares the versions bizzi supports (OpenCode `>=2.0.0`; the others, the adapter's tested range). The probe reports `support: ok | untested | unsupported`, with a reason and a remedy.

- `unsupported` raises an alert: a banner on the machine, an inbox item, and a warning on the machine header in the sidebar (§11.1).
- Structured sessions refuse to start on an unsupported install (`BizziError`); terminal mode is offered instead.
- Remedies are actions you confirm, never automatic, because they change your own install. OpenCode v1 → **Upgrade to v2** (`opencode upgrade --major`, or the v2 installer). An upgrade remedy runs its own steps (`agent.plan` / `agent.install` with the remedy's `id`), not the method's plain update, which keeps v1 on the latest 1.x. The job fails unless the installed version ends up supported.
- `untested` (newer than the adapter's tested range) is a quiet note, not an alert.

**Install method and migration.** A recipe's method order is its preference (Claude: native first). The probe identifies the method from the binary's real path (`pathHints`), seeing through wrapper shims (e.g. a terminal app's `claude` shim on PATH) to the binary they launch. When an install uses a non-preferred method that updates worse (Claude via Homebrew or npm), bizzi offers **Switch to the native installer**:
1. install with the preferred method;
2. check that its bin dir comes first on PATH for login and non-interactive shells;
3. re-probe, including login state (credentials live in the agent's config and keychain, not next to the binary; verify per agent);
4. remove the old install only once no session is using it.

**Updates, restarts and resume.** Update policy per agent and machine (`auto` / `notify` / `pinned`) and restart policy (`when-idle` / `ask` / `manual`). Updates bizzi didn't run (Claude's auto-updater, `/upgrade` inside OpenCode, your own `brew upgrade`) are detected and handled the same way. Stale processes, including long-lived servers such as OpenCode's background service, restart at a turn boundary and resume from `agent_session_ref`. The bizzi session, its event log and `seq` carry on unchanged, and the timeline shows "restarted on <version>". Per-agent paths, safe points, the restart sequence and what's still unverified: [updates.md](updates.md).

**Login flows** run in a PTY on the target machine, streamed to whatever client you're using:

- bizzi detects URLs and one-time codes in the output and shows them as **Open link** / **Copy code** buttons, so you can complete the OAuth on your phone or laptop browser even though the CLI runs on a headless box.
- Flows that need a `localhost` redirect on the remote machine need a forwarded port: the node exposes the callback port through the hub tunnel for the duration of the login.
- Headless-friendly alternatives where they exist: long-lived tokens (e.g. Claude's `setup-token`), device-code login, API keys (stored in the node's keychain/secret store, never in the hub).
- agy: Google sign-in is interactive in its TUI; on headless boxes it needs a Gemini API key.

**Dependency packs (later):** git, gh, Node, Python, Playwright browsers, Xcode CLT, per machine, using the same recipe mechanism.

## 8. Where work runs (summary; details in [topology.md](topology.md))

- You choose the machine. Work that should keep going with the lid closed goes on an always-on machine; work that needs this laptop (local browser, local data, offline) goes on the laptop.
- Laptop sessions pause while it sleeps and resume on wake; nothing else picks them up. The phone shows them as "laptop asleep".
- Offline: the desktop app keeps working against its own node. On reconnect the outbox uploads events, and knowledge replicates.
- Missed events replay from the last `seq`; push notifications cover the gap (approvals, questions, turn done).

### 8.1 Keeping the machine awake

The node holds its own machine awake while its agents work, so a laptop doesn't fall asleep mid-turn and drop off the hub. It runs in the core (`packages/core/src/power.ts`), not the desktop shell, so headless `bizzi serve` does it too.

- **Setting, per machine, stored on the node** (`machine.set { keepAwake }`, shown on the machine page): *when*: `off`, `turns` (a session is running a turn or a terminal session is busy; the default), or `turns_and_background` (also while a session has background work the agent watches, `background.updated`); and *power*: only on a power adapter (the default) or also on battery.
- **Linger:** after the last work ends the hold stays for 90 s, since a follow-up from the phone often comes a minute later. Turning the setting off or narrowing it releases at once; so does switching to battery when it's adapter-only.
- **Power source:** read when the work changes (a reading up to 10 s old is reused) and polled every 60 s while it matters, so unplugging releases the hold and plugging back in takes it again.
- **Status:** `MachineInfo.keepAwake` (`active`, `since`, counts of the turns and background sessions that count, `lingerUntil`, `power`, `pausedOnBattery`), republished with `machine.updated`. The machine page and its sidebar header show it, and `bizzi status` prints it.
- **Only idle system sleep is held, never the display.** On macOS a closed lid on battery still sleeps the Mac (unless an external display is attached); overriding that needs root (`pmset disablesleep`), which bizzi doesn't do.
- **Backends are child processes tied to the core's pid,** with no native add-ons, so a crashed core never leaves the machine held. macOS: `caffeinate -i -w <pid>` (visible in `pmset -g assertions` as "caffeinate command-line tool") and `pmset -g ps`. **Linux and Windows are not done yet** ([landscape.md](landscape.md) §4.8); there `supported` is false and the setting shows as unavailable.

## 9. Knowledge & memory (summary; details in [knowledge.md](knowledge.md))

- **Rules** (always injected) and **memories** (ranked digest + search), one scope model: global > machine > project > workspace > session, optionally limited to certain agents.
- **One pipeline for every agent:** MCP tool calls, harvested native memory, transcript extraction and UI edits all go through a configurable acceptance policy; reads come from one resolver keyed on (agent, machine, project, workspace).
- **bizzi-memory MCP tools** (every agent session): `memory_search`, `memory_add`, `rule_add`, `knowledge_update`, `knowledge_forget` to search and write; `knowledge_list`, `rules_in_effect` and `knowledge_get` to see what applies to the session (with ids, history and its own pending suggestions); `knowledge_promote` to propose moving an item to a wider scope; `history_search` (full-text search over the project's past prompts and replies on this node, SQLite FTS5 in the event store) and `handoff_brief` (what a session was asked, did and left open) for earlier sessions, through the node's `history.*` methods. Writes go through the acceptance policy; approving suggestions stays with the user. Details in [knowledge.md](knowledge.md) §5.
- **Launch mode** injects into sessions bizzi starts; opt-in **ambient mode** serves the same knowledge to agent sessions bizzi didn't start.

## 10. Security & auth

- **Hub:** behind Caddy/SWAG, authenticates every request itself (the proxy is defense in depth). Pluggable auth: **pairing-first** for M1 (a one-time setup code from the hub's first start pairs the first device; later devices are approved from a paired one); OIDC / proxy-header providers later, with passkeys handled by the IdP.
- **Pairing:** machines and devices pair by QR / one-time code approved by a logged-in user and get a per-device keypair; access tokens are short-lived and minted by signing a challenge. Revocable per device. Machine/device endpoints bypass interactive forward-auth at the proxy (they can't follow an SSO redirect).
- **Local mode:** the in-process / local-socket path is limited to the OS user who owns the install (socket file permissions).
- **Workspace picker:** `fs.browse` / `fs.complete` / `fs.suggest` are not confined to a workspace: they run as the node's OS user and can list any directory that user can, which is the same trust a paired device already has through a terminal session. They return directory names, symlink-to-directory entries and a `.git` presence bit only; they never read file contents or write, and each call is bounded (entry caps, a time budget for suggestions). `fs.list` / `fs.read` stay confined to their workspace.
- **Private CAs:** `bizzi` adds the OS certificate store (macOS keychain, Windows store, `/etc/ssl/certs`) to Node's bundled roots at startup, so hubs and model gateways behind a company CA work like they do in browsers and curl. `BIZZI_SYSTEM_CA=0` turns it off. In the Linux compose stack, mount the CA and run `update-ca-certificates` in the image.
- **Credentials:** ADE logins and API keys stay on their machine (OS keychain / secret store). The hub never sees them.
- **Approvals** are attributed to the deciding device and audit-logged; remote-stricter policy is available (e.g. no `bypassPermissions` from the phone).
- **Agent ToS:** drive each vendor's official CLI under your own login on your own machine; re-check Anthropic and Google terms before a wider release. Remote Control itself needs a claude.ai subscription; bizzi doesn't use Remote Control, it drives the CLI locally.

## 11. Frontend

One UI codebase for every client: desktop app (macOS, Windows, Linux), phone (Android; iOS best-effort), browser client served by the hub. React, in Electron / Capacitor / the browser (tech-choices D0b).

Screens: the **machine → workspace tree** (the desktop sidebar; the Machines tab on the phone) → **machine page** (opened from its tile: online, headful/headless, power, its workspaces with "Add workspace", ADE status with install/update/login buttons and update/restart policies, API keys, widgets, machine settings such as agent-to-agent limits) → **workspace** (sessions, project links) → **sessions** (timeline, composer, inline approvals, plan/todos, diff review, terminal tab, raw-events tab) · **inbox** (approvals, questions, finished turns, knowledge suggestions) · **knowledge browser** (by scope, provenance, policy) · **settings** (app-level only: appearance, hotkeys, knowledge, devices, connection).

Mobile-first touches: approve/deny from the notification, voice input, file-by-file diff review, share sheet into a session.

Theming: themes are semantic UI tokens, a terminal palette and layout tokens, per light/dark variant. The model comes from Chorus/Terax (Apache-2.0), with a base16 importer and contrast validation; state colors and approval/permission badges can't be camouflaged by a theme. See [theming.md](theming.md).

### 11.1 Sidebar: machines, workspaces, agent indicators

A file tree: machines first, workspaces (usually a repo) under each, and under each workspace its open sessions, then a folded **Ended (n)** line listing its closed sessions (newest first; open one to read it, its ↻ button or right-click › Reopen session lets it take messages again), then, under a small **Worktrees** heading, the worktrees that have sessions you started there, with guide lines and a chevron to fold each level. A worktree only helpers work in gets no node (its branch shows on the helpers' rows), and unused worktrees fold into one muted "n unused worktrees" line whose menu removes them. Two references to steer between: Herdr rolls every agent in a space into one dot, which can't tell one agent from six; a cmux workspace card shows the last message, every status line, every directory and branch, and a PR link, which is too busy to scan. Target: a quiet workspace is one line; a row grows only when it has something worth reading.

```
▾ This computer              6 · 1 waiting
│ ▾ W website    main*
│ │   ⚠ Fix the build script   ▬▬── 41%
│ │     approve `bun run build`?
│ │   ◐ Review the header PR   ▬─── 18%
│ │   ▾ ⎇ feat/nav
│ │       ● Nav spacing         ▬▬▬─ 77%
│ ▸ P plugins    main            ● ● ● ● +3
│     PR #27 open · CI ✓ · ↑2
▸ vps (offline)              2 (cached)
```

**Session rows (open workspace):** one per open session. Helpers sit directly under the session that started them, one indent per level (capped at three), wherever they run: a helper in another worktree carries a muted `⑂ branch` chip (with `*` when it has uncommitted changes) instead of being listed under that worktree. A helper only nests under a parent that is live and on the same machine; otherwise it is a top-level row of its own workspace. A parent with live helpers has a caret that folds them away (remembered per device; the open session unfolds its parents) and their count; an open nest ends with a muted "n helpers ended" line linking to the parent, since ended helpers aren't rows. Each row has the agent mark in its state, the name (a terminal icon for terminal sessions), and a context bar read like the session header's (fill = share of the usable window, amber from 80%, red near compaction; the number is the share of the whole window), from `SessionInfo.context`, which the node keeps from the latest `context.updated` so sessions nobody has open show it too. A waiting or failed session has its reason on a second line. The row opens the session and is highlighted while it's open; right-click gives the session menu. Session rows don't count toward the auto width.

**Row 1 (always):** chevron, workspace icon, name, branch (`*` when dirty); when folded, the agent marks right-aligned. On hover (desktop) a **+** starts a session there with the default profile, like ⌘T. Folded state is stored per device; everything starts open.

- One mark per live session, at most four, then `+n`. Order: waiting, failed, working, background, done-unseen, idle.
- Mark = the agent-type glyph on a tile in the agent's identity color (Claude orange, Codex violet, OpenCode green, agy blue, shell silver, API chat pink; theme-resolved `--agent-<kind>`), then the state symbol in the state color. Rows of several marks put the state symbol as a badge on the tile's corner; a narrow sidebar shows only the state symbols. State is told by shape as well as color, for colorblind users: working is a spinning arc, background a slowly turning dotted ring, waiting a pulsing warning triangle, done a check, failed a cross, idle a hollow dot. A waiting session's row also says **Needs you** in a solid waiting-colored pill.
- States: **⚠ waiting** (approval, question, login; amber, pulses) · **✗ failed** · **◐ working** (spins) · **∿ background** (the turn is over but the agent left work running, such as a shell command it waits on or a subagent; working color, a dotted ring that turns slowly; the session row's second line names the work; when that work finishes and the agent picks things up on its own, that's a turn again (`turn.started.agent`, shown as "continued on its own") and the session is working) · **✓ done, not yet seen** (clears when the session is opened) · **○ idle** (gray, hollow).
- Helper sessions (§12.1) count inside their parent's mark as a small number, not as marks of their own.

**Row 2 (folded workspaces, only when something needs you):** the single most urgent item in the workspace, one line, ellipsised: waiting (with the reason) > failed > done-unseen (first line of the final message). Clicking it opens that session directly.

**Row 3 (only when not default):** repo state: PR and CI status, ahead/behind. Hidden when there's no PR and the branch is in sync. PR/CI needs a forge integration on the node (`gh` first); without one the row shows ahead/behind only.

**Machine header (tile):** name, online state, totals ("6 · 1 waiting"), so a collapsed machine still shows what needs you. Offline machines are dimmed and show cached counts; an unsupported agent shows a warning mark; "updates pending" sits under the header. Clicking the tile opens the machine's page and highlights the tile while it's open; the chevron is a separate target that collapses/expands. On hover (desktop) a **+** (add a workspace on that machine) and a gear (the machine page) overlay the totals.

**Desktop sidebar = the tree** (Herdr-style; no separate Machines/Workspaces pages, `#/machines` and `#/workspaces` open the selected machine's page). Header: logo and connection status, then icon buttons for Inbox (waiting badge), Knowledge (suggestion badge) and Settings. Footer: light/dark toggle and disconnect.

**Hotkeys** (Settings › Hotkeys, each switchable per device): **⌘N / Ctrl+N** opens Add workspace for the machine you're on (the open page's machine, else the selected one); **⌘T / Ctrl+T** starts a session in the open workspace (the workspace page, or a session's) with the default agent's ★ profile and opens it; **⌘W / Ctrl+W** ends the open session (`session.stop`; it asks only while a turn is running) and opens the next live session in its workspace, else the workspace page; a toast offers Undo (`session.reopen`). On other pages of the desktop app it closes the window, which otherwise closes with ⇧⌘W / Ctrl+Shift+W. Deleting a session for good is the session page's red trash button or Delete… in its menu. The desktop File menu lists all three without registering them, so the keys reach the UI; clicking the item sends the same command (`bizzi:command`). In a terminal session on Windows and Linux, Ctrl+N, Ctrl+T and Ctrl+W go to the shell. Browsers may keep these keys for new window, new tab and close tab.

**Width:** a drag handle on the right edge (keyboard: focus it, arrows resize, Home/End jump, Enter fits) sets a manual width in [200, min(480, 40% of the window)]. **Auto** (the default) fits the widest row 1 or machine header (rows 2 and 3 don't count), clamped to [220, 360], and shrinks on narrow windows so the main pane keeps 640 px. Double-click the handle, its context menu, or Settings → Appearance returns to auto. Stored per device; rows ellipsise at any width. Measured once per frame at most, from a hidden max-content copy, only when the tree changes.

**Settings split:** the gear opens app-level settings only (appearance, knowledge, devices, connection). Anything about one machine (agents, policies, API keys, widgets, agent-to-agent limits) lives on that machine's page, never in both places.

**Bottom bar (desktop):** usage meters per login (Claude and Codex plan windows, metered spend) plus widgets such as a LiteLLM spend meter. On the phone this becomes a usage chip in the Machines and Inbox headers. The session header carries a context bar. Details: [usage.md](usage.md).

Rules: color only carries state (identity colors below are the one exception, and use other shapes); everything else is muted text. No chat previews unless waiting or done-unseen. No directory lists. Never more than three lines per workspace. Hover (desktop) or long-press (phone) opens a breakdown: one line per session with agent, title, state, reason and age.

**Identity color (M5).** You can give each machine and each workspace a color, and each workspace an icon, so you can tell at a glance which machine a session runs on. Identity never looks like state: state marks are round and right-aligned, identity is a square or a stripe on the left.

- **Palette:** eight names (`red orange yellow green teal blue purple pink`, `LabelColor`). The protocol stores the name, not a CSS color. Each theme resolves it as `--label-<name>`: bizzi's base ink for the theme's polarity, nudged toward the foreground until it reaches 3:1 on the sidebar, the cards and the page ([theming.md](theming.md) §3). A test checks every built-in theme, light and dark, for that contrast and for ΔE ≥ 15 between any two colors. Imported themes get the same derivation and can't override it.
- **Machine:** `machine.set { color }` (`''` clears). It's stored with tags and description in the node's machine user fields and replicates as part of `MachineInfo` (`machine.updated`). It shows as a stripe down the left edge of the machine's sidebar group, as a stripe on the session, workspace and machine page headers, and as a square before the machine's name in headers.
- **Workspace:** `workspace.set { workspaceId, name?, color?, icon? }`, stored in the node's workspace record. It emits a new global `workspace.updated` event, which the hub folds into its replica and relays. The color fills the workspace's letter tile in the sidebar, in workspace cards and in headers. The icon (one or two characters or an emoji, `isLabelIcon`) replaces the letter. A worktree without its own color shows its repo workspace's, so a fan-out reads as one family.
- **Headers:** a session's subtitle names its machine (square, name, tags) whenever there's more than one machine or the machine has a color or tags. The workspace page header does the same. Desktop sidebar machine headers carry a muted tag line (`gui · prod-access`) under the name.
- **Built (2026-11-25):** all of the above, edited on the machine page (with tags and description) and with the pencil button on the workspace page (name, color, icon). Decisions where this spec was silent: icons on workspaces only, since only workspaces have an icon slot in the tree. Renaming went into `workspace.set` because it's the same dialog. Colors are names, so themes stay in charge of contrast. Changes need the owning machine online, like `machine.set`; offline machines keep their cached colors. Inbox rows show the workspace tile and the machine (in its color) too. Not done: a per-device override.

**Phone:** same structure; bottom nav Machines · Inbox · Knowledge · Settings, where Machines is the tree and tapping a machine tile opens its page. Rows 1 and 2 only (row 3 folds into a PR icon on row 1). More than three marks collapse to counts (`⚠1 ◐2 ●3`). 44 px hit targets; tapping row 2 jumps straight to the waiting session; the Inbox tab badge is the total waiting count across machines; machine sections collapse and remember their state.

### 11.2 One-pane mode (later)

One composer, no navigation: you type what you want, and bizzi decides where it runs. The tree and session views stay available; one-pane mode is a front door, not a replacement.

```
┌───────────────────────────────────────────────────────────┐
│ why are checkout 502s up since 14:00?                     │
│                                                           │
│ → laptop · acme-shop · Claude      prod-access, prod logs │
│   [Send]  change: mac-mini · vps · workspace… · agent…    │
└───────────────────────────────────────────────────────────┘
```

**Routing, cheapest first:**

1. **Explicit:** `@mac-mini`, `#acme-shop`, `/codex` in the text, or a target picked by hand, always win.
2. **Continuation:** a follow-up while a routed session is live goes to that session unless you change the target.
3. **Rules:** your routing preferences (knowledge.md §9.3): "production investigations → `prod-access`", "UI and screenshots → `gui`", "long runs → `always-on`".
4. **Quick classifier:** a decision model picks from a numbered catalog: machines with tags, descriptions and online state; workspaces with project, path, branch and recent activity; agents. It returns probabilities per option, never free text, so its output can only ever be one of the listed targets.

**Classifier backends** (pluggable, on the hub, which is the only place that knows every machine):

- **Jev** (TypeSafe, `POST /v1/systemone`, model `typesafe/jev`; a single proprietary, hosted model trained for calibrated decisions, not a wrapper around other LLMs; also on OpenRouter): built for this. A `Choice` question picks one of up to 255 options and returns a probability per option plus a confidence; several typed questions about the same input go in one request. Reported latency is about 140–280 ms server-side and under a second end to end; input costs $0.042 per million tokens. One request per prompt:
  - `Choice` workspace (each option is "machine · workspace", with a short description), at most 255 options; above that, filter by online machines and recent activity first;
  - `Choice` agent;
  - `Noul` "is this a follow-up to the open session?".
- **Local** (budgetless, §12.3), checked 2026-11-11; no open model has been shown to match Jev zero-shot on routing:
  - **Option-logit readout from the model already on the H200s** (Qwen3.8-27B behind vLLM): score each numbered option from the next-token logits in one forward pass. No new GPU memory; Qwen3.8-27B scored highest on JevBench accuracy and calibration. First thing to try. **Verified 2026-11-11** through Bifrost (`vllm/qwen3.8-27b`, chat completions, `logprobs` + `top_logprobs: 20`, `max_tokens: 1`, thinking off): 6 options, about 300 ms warm (0.8–1.3 s cold), letter mass ≥ 0.997, 6/6 obvious prompts routed correctly at ≥ 0.97 confidence, and the one ambiguous prompt ("fix the flaky checkout unit test": laptop vs mac-mini copy of the repo) split 0.83 / 0.16 at confidence 0.73, which is the case where bizzi should ask. vLLM's default `--max-logprobs` (20) caps one pass at 20 options.
  - **Laya** (Convai Innovations, Apache 2.0, ModernBERT-large, 421M): speaks the `/v1/systemone` API (choice / score / noul, at most 100 options), tens of ms per question, CPU or GPU. Weak zero-shot (Banking77 42.5%), close to Jev only after fine-tuning and temperature fitting (79.4% vs Jev 80.0%), and it degrades above about 20 options. Needs our own labeled routes.
  - **razorback16/openjev** (Apache 2.0): a Jev-wire-compatible server on vLLM that can front Laya or other models, so the hub's client stays the same whichever model answers.
  - **A plain local LLM with constrained JSON output:** its probabilities are prompted estimates, not calibrated, so the confirm threshold must be stricter.
- **Choosing:** build a labeled set of about 300 real routing decisions (prompt → machine · workspace · agent) and compare hosted Jev, Qwen3.8-27B logit readout, fine-tuned Laya, and a 4B openjev variant on accuracy and calibration before picking a default.
- **Off:** steps 1–3 only, and you pick when they don't decide.

**Built (2026-11-23): the option-logit backend** (`@bizzi/routing`, `route.suggest { text }`):

- **Where:** the hub answers across every online machine; a node answers for its own workspaces (local mode). Configured with `BIZZI_ROUTER_URL`, `BIZZI_ROUTER_MODEL`, `BIZZI_ROUTER_API_KEY`, `BIZZI_ROUTER_BODY` (JSON merged into each request) and `BIZZI_ROUTER_THRESHOLD` (default 0.8), on `bizzi hub serve` and `bizzi serve`. Without a URL only steps 1 and the single-target case run.
- **Borrowed classifier:** the model often isn't reachable from the hub, only from one machine (a lab GPU behind that machine's VPN, a server on its LAN, or the machine itself). A node with `BIZZI_ROUTER_URL` advertises `MachineInfo.routing { model, maxOptions }` and answers `route.score { text, options }`; a hub without a URL of its own builds the catalog and confidence itself and sends only the readout to such a node over the node link. It tries the machine named by `BIZZI_ROUTER_VIA` first, then always-on machines, then the rest by name, at most two per suggestion (a machine that just went to sleep falls through to the next). `classifier.via` says which machine answered, and `ms` is the whole round trip. With none online, routing degrades to tokens and asking.
- **Order:** `@machine` / `#workspace` / `/agent` tokens (step 1), a single remaining target, then the classifier. Routing rules (step 3) run after the tokens since 2026-11-25; continuation (step 2) is the client's (below).
- **Tokens:** consumed only when they name something that exists, online or not (`#123`, `me@x.io` and paths stay in the text); trailing punctuation is fine (`on @mac-mini.`). `@` and `#` combine (`@mac-mini #acme-shop`). When real tokens can't all hold, routing stops with the reason rather than guessing elsewhere: "no workspace matches @mac-mini and #bizzi", "vps is offline". A token that leaves several targets (`#acme-shop` on two machines) goes to the classifier among just those; with no classifier, or when it fails or isn't confident, the client asks with them as the choices.
- **Catalog:** one target per workspace on an online machine, worktrees left out, most recently active first, at most 20 per pass (vLLM's default `--max-logprobs` and OpenAI's `top_logprobs` cap). Each line has the machine's tags, GUI / always-on, its description, the folder and the titles of the last three sessions there.
- **Request:** chat completions with `max_tokens: 1`, `logprobs: true`, `top_logprobs: 20`, options lettered A–T; letter probabilities are renormalized. Confidence is 1 − entropy/ln(N); `letterMass` reports how much probability fell on letters at all.
- **Result:** source (`explicit` / `single` / `classifier` / `none`), the top three candidates with probabilities, confidence, `confident` against the threshold, the agent from `/agent`, the text without routing tokens, the classifier's model, machine (when borrowed) and time, and a note when it didn't run or failed.
- **Measured (H200 Qwen3.8-27B through Bifrost, thinking off, 2026-11-23):** 94–408 ms per prompt, letter mass ≥ 0.99, five clear prompts all correct. Session titles matter: with machine facts and folders only, two clear prompts scored 0.69–0.76 and the ambiguous one 0.70; with titles the clear ones scored 0.89–0.98 and the ambiguous one 0.55 (`packages/routing/test/live.test.ts`, `BIZZI_LIVE=1`).
- **Cloud backends:** the same request works on any endpoint that returns logprobs. Through the company LiteLLM (checked 2026-11-23) only gpt-4.1, gpt-4.1-mini, gpt-4o and gpt-4o-mini do, and they put ~1.00 on their pick even for the ambiguous prompt, so their confidence can't decide when to ask. GPT-5.x on Azure and Claude on Bedrock reject `logprobs`; GPT-6 models on Bedrock accept it with `reasoning_effort: "none"` but return none.
- **UI:** built 2026-11-25, below.

**Built (2026-11-25): the one-pane composer, rules and recorded routes** (`#/ask`, the ✦ Ask button in the desktop sidebar header and the phone's bottom nav; `packages/ui/src/views/onepane/`, pure logic in `packages/ui/src/lib/onePane.ts`):

- **Composer:** typing pauses for 500 ms → `route.suggest`; the line under the composer shows the target, the agent and why ("mock/keywords 94%", "rule: prod → prod-access", "as named"). Enter sends only when the suggestion is `confident` and its machine is online; it starts a structured session there (`session.create` + `session.send`, title from the prompt's first line) with the routing tokens removed from the text, and the view moves to `#/ask/<session>`. Not confident (or "change"): the candidates as buttons, the `note` (or "not sure: 55% laptop · acme-shop, 41% mac-mini · acme-shop"), and "other…" (a filterable list of every workspace on an online machine, plus "New workspace…", which opens the folder picker). A server without `route.suggest` still works: you pick from "other…".
- **Agent:** `/agent` (or a rule's agent) if installed on the target machine, else the agent of the workspace's most recent session (the closest thing to a workspace default; there's no stored one), else a logged-in structured agent, else the first installed. A small select on the target line changes it; the shell is never offered.
- **Autocomplete** (client-side from the store): `@` lists machines, online first, offline disabled ("offline"); names with spaces insert the hostname. `#` lists workspaces (no worktrees), only the named machine's when the prompt has a `@machine`; a name on several machines shows the machine and inserts `@machine #workspace`. `/` lists agents and disables the ones not installed on the target (the `@` machine, else the `#` workspace's machine, else any online machine). Arrows, Enter/Tab, Escape.
- **Step 2, continuation (client):** in `#/ask/<session>` a follow-up goes to that session (send, or steer while it works) while it's live: not closed (`ended`), structured, machine online. A `failed` session resumes on the follow-up. Any real `@`/`#`/`/` token routes afresh, as does "New task". The `Noul` follow-up classifier isn't used.
- **Step 3, routing rules:** `RoutingRule { match, tag | machineId | workspaceId, agent? }`, stored where routing happens (hub: `hub.db`; node in local mode: `<data dir>/routing.db`), edited under "Routing rules and recorded routes" on the Ask page (`route.rules.get` / `route.rules.set`). A rule matches whole words or phrases, case-insensitive, `prod*` for a prefix, and is deterministic, so it runs before any classifier. The first matching rule narrows the targets: one left → `source: 'rule'`, confident; several → the classifier chooses among only those (with no classifier, the user picks); its machines offline → `none` with "rule "…": laptop is offline", never a silent reroute. `@`/`#` tokens skip rules. Decision: a rule leaving several targets does let the classifier see the prompt; point the rule at a machine or workspace when it must not reach a hosted one.
- **Recorded routes** (`route.record`, `route.decisions`): every routed send is recorded where routing happens, with the prompt as typed, the candidates offered, source, confidence, classifier model and machine, rule, the chosen machine · workspace · agent, `via` (suggested / picked / other) and `overridden` (chosen ≠ top candidate). All sends, not just overrides: accepted ones are labels too, `overridden: true` filters the strong ones. At most 10,000 kept. The rules panel shows the count and downloads them as JSON. After an override a hint offers "Make a rule…" with the chosen workspace filled in.
- **Mock:** `?mock=1` routes with a keyword "classifier" and a seeded `production, prod* → prod-access` rule; `#/ask?text=…` prefills the composer (also for launchers and share targets).
- **Left:** suggesting a rule from repeated overrides (only the per-send "Make a rule…" hint exists); a scratch workspace when nothing fits; "asleep" vs offline (§8); the Jev backend and its `Noul` follow-up question; an eval harness that replays the recorded routes against each backend.

**Privacy:** a hosted classifier sees the prompt and the catalog, including machine descriptions and paths. It is opt-in, per hub. Rules (step 3) run first, so a prompt your routing preferences already place (production investigations, say) never reaches a hosted classifier.

Reference: Browser Use's ultrafast mode uses Jev the same way: structured state with numbered options in, a typed choice out, one round trip per decision ([jev-ultrafast](https://github.com/browser-use/jev-ultrafast)).

**Confirm, don't guess:**

- The chosen target and its reason are shown before sending. Above a confidence threshold (the classifier's own confidence, or the gap between the top two probabilities), Enter sends; below it, bizzi shows the top two or three targets to pick from.
- Only online machines are offered; a sleeping laptop shows as "asleep" (§8), never as the silent choice.
- Overrides are recorded, and repeated overrides suggest a routing preference ("you always move prod questions to the laptop: make it a rule?").
- Where no workspace fits, offer "new workspace" (folder picker) or a scratch workspace on the chosen machine.

## 12. Orchestration

Three things that look alike:

| | Started by | What runs | Visible to you |
|---|---|---|---|
| **Subagents** | the agent, inside its own process (Claude's Task tool, Codex subagents) | same agent, same machine | as `subagent.*` events in the parent (§5.3) |
| **Fan-out** | you | N sessions, each in its own worktree, same task | N normal sessions plus a compare view |
| **Agent-to-agent** | an agent, through bizzi's MCP tools | a full bizzi session with any agent | a normal session: watch, steer, take over, stop |

Agent-to-agent is more than subagents: the helper can be a different agent (Claude asks Codex for a review), it is a first-class session (sidebar, inbox approvals, shared knowledge, you can type into it), and the parent waits on real states and reads structured results (final message, changed files with diffs, tool summary, stop reason) rather than screen text, which is the gap in terminal-based tools like Herdr ([landscape.md](landscape.md)). Fan-out and pipelines are built from the same primitives.

### 12.1 Agent-to-agent tools (same machine)

Node-local MCP tools, injected next to the knowledge MCP server:

- `session_start { agent, workspace?, worktree?, prompt, model?, scope: "child" | "detached" }` → `sessionId`
- `session_send { sessionId, input }`, `session_interrupt { sessionId }`
- `session_wait { sessionId, until: "idle" | "waiting" | "done" | "ended", timeout }`
- `session_read { sessionId, since? }`: structured summary of events since a cursor
- `session_stop { sessionId }`, `sessions_list` (this session's helpers)
- `sessions_overview { workspace?, status?, agent?, updatedSince?, waitingOnly?, machine?, offset?, limit? }` and `session_peek { sessionId, since?, detail? }`: read-only views over **every** session on the node, not only helpers (below)

**Boundary: the machine.** Without `machine`, `workspace` must be on the parent's node, so the node serves these tools without the hub and they work offline. Helpers on other machines go through the hub (§12.4).

The helper records `spawned_by`. A `child` helper stops when its parent stops or ends; a `detached` one outlives it. Helpers appear nested under their parent in the session list and the sidebar, even when they work in another worktree, and count inside the parent's mark (§11.1).

### 12.2 Guardrails

- **Depth limit:** default 2 (parent → helper → helper's helper), configurable per workspace. `session_start` beyond the limit fails with a `BizziError`.
- **Concurrency:** max live helpers per parent and per machine; extra starts queue or fail, by setting.
- **Permissions:** a helper's permission mode is never looser than its parent's. When `session_start` names no mode, a helper of the parent's own agent starts in the parent's mode; another agent starts at its default, capped at the parent's level.
- **Approvals:** a helper's approvals go to you (inbox, push) by default. Letting the parent answer them is an explicit per-workspace opt-in.
- **Budget:** an optional spend cap per session tree, counted on `metered` providers only (§12.3).

### 12.3 Billing classes and budgetless providers

Each `ApiProvider` (and each logged-in agent account) has a billing class:

- **metered:** pay per token (API keys). Counts toward budget caps and spend warnings.
- **plan:** a subscription with usage limits (Claude Max, Codex Pro). Not money per call; show plan-limit usage instead of spend.
- **budgetless:** inference you already own, e.g. local H200/B200 boxes behind vLLM or a Bifrost gateway. Excluded from budget caps and spend warnings.

Context and spend per helper, `session_read` size limits, the fan-out preflight and the tree view are in [usage.md](usage.md) §2.

Budgetless doesn't mean unlimited: GPU capacity is the limit, so a provider can set `maxConcurrent` and helpers queue when it's full. Tokens are still recorded, and an optional notional rate lets reports show what the same work would have cost elsewhere. Helper defaults can prefer budgetless models (explorers and reviewers on the local model, OpenCode pointed at the gateway, §6.5). The UI tags sessions running on a budgetless provider, and session trees show metered spend only.

### 12.4 Cross-machine agent-to-agent, and later

- **Cross-machine agent-to-agent via the hub:** a parent on the laptop starts a helper on the Mac mini (Xcode build, screenshots) or the VPS (long test run). Needs nodes to send requests to the hub, an additive change to the hub contract (today the hub only acts as a client of nodes). A helper on an offline machine fails fast with `machine_offline`.

  Built (2026-11-25) on node → hub requests (§5.4):
  - **Tools.** `session_start` takes `machine`, a name or id (case-insensitive). This machine's own name or id means "here". A new `machines_list` tool shows each machine with its online state, OS, GUI, tags, description and workspaces. `session_send`, `session_interrupt`, `session_wait`, `session_read`, `session_stop` and `sessions_list` work the same on a remote helper. The parent's node keeps a record of each remote helper in node meta and routes these calls through the hub as `helper.*` on the target. `sessions_list` refreshes remote helpers from the hub index.
  - **A first-class session on B.** The helper is an ordinary session on the target machine, with `spawnedBy` (the parent's id) and `spawnedByMachineId`. It shows in the sidebar under its own workspace, and its header links to the parent. As with every helper, its approvals go to you.
  - **Default workspace.** Without `workspace`, the helper goes to the target's workspace linked to the parent's: the same `projectId`, else the same normalized `origin` URL (`git@github.com:Acme/App.git` matches `https://github.com/acme/app`). Failing that, it goes to the target's only workspace; with several, the start is `bad_request` and lists them. The helper sees the target's copy of the files. Carrying uncommitted work over is what fork-to-machine is for.
  - **Guardrails on both sides.** The parent's machine checks its depth limit, the budgets and the per-parent limit (local plus remote live helpers). The target checks its own depth limit and per-machine limit (with its `onLimit`). It clamps the permission mode against the parent's agent and mode, and stores that cap with the helper so `session.set` keeps it. Decision: a remote start over the per-parent limit always fails rather than queues, because the parent's machine can't hold a slot in another machine's queue.
  - **Budgets.** The helper's budget is capped, field by field, at what the parent's caps have left: its own, its ancestors' and `treeBudgetUsd` (`Sessions.remainingBudget`). Every `session_wait` and `session_read` brings the helper's spend back, and from then on it counts in the parent's tree, so the parent's caps see it at the next turn boundary. Decision: the spend counted is as of the last wait or read; it isn't streamed.
  - **Ownership.** The target serves `helper.*` only when `caller` (stamped by the hub) is the parent's machine and `parentId` is the helper's `spawnedBy`. Sessions on the target can't drive a remote parent's helper, and the reverse holds too.
  - **Cascade.** When the parent stops, ends, fails or is deleted, its `child` helpers on other machines are stopped through the hub. If the hub is unreachable at that moment, they're marked and stopped on the next link, including after a node restart. `detached` helpers carry on.
  - **Offline.** A start on an offline target fails with `machine_offline` before anything is sent; an unknown machine is `not_found`. If the target drops during a wait, the wait fails with `machine_offline`.
  - Left: queuing remote starts behind the per-parent limit; streaming remote spend instead of reporting it on wait and read; a machine picker for helper defaults in the UI.
- **Pipelines** (planner → implementer → reviewer across agents) and **watchers** (a cheap or budgetless model pings you only for real decisions). Shared knowledge keeps cross-agent work coherent. Designed in [pipelines.md](pipelines.md); pipelines built on one machine (2026-11-25: stages, templates, a shared worktree, gates in the inbox, run budgets), watchers designed only.

### 12.5 Implementation notes (M4, one machine)

- **Worktrees.** `worktree.create` adds a git worktree at `<repo>.worktrees/<branch>` next to the repository (slashes and unsafe characters in the branch become `-`; a numeric suffix avoids clashes) unless `path` is given, and registers a workspace of kind `worktree` under the repo workspace. A worktree of a worktree groups under the same repo workspace. If a registered worktree already has the branch, that workspace is returned. `worktree.remove` never deletes the branch. It refuses uncommitted or untracked changes unless `force`, refuses while any session that isn't ended or failed uses the worktree, and prunes a worktree whose directory is already gone. `workspace.remove` on a repo workspace that still has worktree workspaces is refused, so they are never orphaned.
- **Transport and caller identity.** `@bizzi/orchestration` serves the tools as the `bizzi-agents` MCP server over stateless Streamable HTTP, on a loopback port of its own. It never uses the client listener, which may be bound to `0.0.0.0`. Each structured session bizzi starts gets an `http` server spec with a bearer token minted when its agent process starts. The token identifies the caller, is replaced on every agent start, and is revoked when the session ends, fails or is removed. Terminal sessions and sessions at the depth limit get no tools. The injection composes with the knowledge hook: `NodeExtension.prepareStart` runs after `NodeOptions.prepareStart` and the results are merged.
- **Ownership.** A session can only send to, wait on, read or stop helpers it started itself.
- **Seeing other sessions** (built 2026-11-27). `sessions_overview` and `session_peek` are read-only and see every session on the node, with the same trust the agent already has as the node's OS user (a paired device sees the same). Neither lets a session drive one it didn't start: `session_send`, `session_answer`, `session_interrupt` and `session_stop` keep the ownership rule. Core: `History` in `packages/core/src/history.ts` (`node.history`). The same listener serves bizzi-memory's session history on `POST /history`, with a separate per-session token ([knowledge.md](knowledge.md) §5).
  - **Overview entry.** id, title, agent, status, `updatedAt`, workspace (id, path, name, kind, branch: a worktree's own, a repo's from `git status`), `self` for the caller, `parentId` / `scope` / `helpers` for the helper relation, `turnOpen` (a turn in flight or about to start), `background` (work left running), the last user prompt (300 chars) and the last top-level assistant reply (500 chars). The last prompt skips turns bizzi sent itself (`auto`, `agent`, and text starting with `[bizzi]`, such as the continuation after a restart). Both come from a newest-first walk of the channel's key (`Store.latestOfTypes`), at most 400 events of those types back.
  - **Waiting on the user.** `waiting` lists pending approvals, questions and a budget stop, or the status `waiting_input` / `waiting_approval` when nothing is pending here (a login). As a labelled heuristic, `waiting.asks { heuristic: true, question }` marks an idle session whose last reply came after the last prompt and ends by asking something: one of the last two sentences of its last paragraph ends with `?`, outside code blocks.
  - **Filters.** `workspace` (id or path; a repo workspace includes its worktree workspaces), `status` (default: everything but `ended`), `agent`, `updatedSince` (ISO time or `90m` / `6h` / `2d` / `1w`), `waitingOnly`. Newest first, `limit` 20 by default and at most 50, `offset` / `nextOffset` for paging, and a page stops early past about 40 000 characters of JSON.
  - **Other machines.** With `machine` (name or id) and a hub link, the overview comes from the hub's index (`sessions.list`, `workspaces.list` through node → hub requests): titles, states, workspaces and helper relations, but no prompts, replies or pending details, and `waiting` is the status only (`source: 'hub-index'`). `session_peek` is this node only.
  - **`session_peek`** is `session_read`'s summary (`Orchestrator.summarize`) for any session on the node, plus its title, workspace, parent and last prompt. `waitingOn` lists what it waits on, never with answerable `items`.
- **Cascade.** A `child` helper stops when its parent is closed or deleted, recursively (§4.1). A parent whose agent crashed resumes, so its helpers keep running. `detached` helpers keep running. On node start, children of sessions that were closed are stopped.
- **Limits.** Live helpers (not ended, failed or queued) count toward `maxHelpersPerParent` (from the parent workspace's settings) and `maxHelpersPerMachine` (machine settings). With `onLimit: 'queue'` the helper is registered as `starting` with reason `queued: …` and starts when a slot frees up. Queued helpers end on a node restart.
- **Permissions.** Modes are compared on one scale:
  - 0 read-only: Claude `plan`, Codex `read-only`, OpenCode `plan`
  - 1 asks: Claude `default` and `dontAsk`, Codex `untrusted`
  - 2 edits the workspace: Claude `acceptEdits`, Codex `auto`, OpenCode `build`
  - 3 unrestricted: Claude `bypassPermissions`, Codex `full-access`

  A helper gets its requested mode (or its agent's default), capped at the parent's level. An unknown parent mode counts as 1, and an unknown requested mode inherits the parent's. agy and shell run at their own defaults, which ask, and are refused under a read-only parent. `session.set` keeps the cap: a helper's mode can be tightened later but not loosened beyond its parent's (`conflict`).
- **Approvals.** A helper's approvals and questions always go to you (inbox, push). By default the parent only sees them as the reason `session_wait` returns.
- **Parent answers approvals** (built 2026-11-25). With `parentAnswersApprovals` on for the parent's workspace, `session_start` records `parentAnswersApprovals: true` on the helper's `SessionInfo`. The parent may answer only while that flag is set *and* the setting is still on, so turning the setting off takes effect at once.
  - **Seeing them.** `session_wait` and `session_read` (`waitingOn.items`) list the helper's pending approvals and questions with their ids, the approval input (truncated), and `parentMay`: what the parent may do (`allow`/`deny` for approvals, `answer`/`cancel` for questions), with a `note` saying why when it may only deny. `until: "done"` also returns for a new item the parent may allow or answer, once per item, so a parent can unblock its helper without polling. Deny-only items don't wake `done`, and they stay with you.
  - **Answering.** `session_answer { sessionId, id, decision | answers | cancel, message? }`. You still see every approval and can answer first. Whoever answers first wins: a late `session_answer` returns `answered: false` with `alreadyAnswered: { outcome, by, bySessionId? }`. A late `approval.respond` / `question.respond` from you fails with `not_found`, saying who answered and how, with `data.alreadyAnswered`; it fails with `conflict` while the first answer is still being delivered.
  - **Who answered.** On these helpers, the core stamps `approval.resolved` / `question.resolved` with `by: 'user'` or `by: 'parent'` plus `bySessionId`. The UI shows "by parent" on the resolved card. Events of other sessions are unchanged: only you can answer them.
  - **What the parent may never decide for you** (enforced in core `Orchestrator.answer`; refusals are `conflict` with `data.goesToUser`):
    - `allow_always`, which saves a rule that outlives the helper.
    - Edited tool input.
    - An `allow` of anything its own permission mode would have to ask for. The levels are those of the permission scale: read needs level 0; edit, write and plan need 2 (`acceptEdits`, Codex `auto`, OpenCode `build`); shell, mcp, web and other need 3. So a usual `acceptEdits` parent may allow its helper's edits but not its shell commands.
    - An `allow` that touches any path outside the helper's workspace or worktree. Paths are collected from the tool input (`file_path`, `path`, `cwd`, `grantRoot`, Codex `changes`/`fileChanges`, OpenCode `resources`, …), resolved against the workspace with symlinks followed, and `~` counts as outside. A read, edit or write whose paths can't be found stays with you.
    - An `allow` while the helper is over its budget. Budget stops are never the parent's: raising a cap stays `session.set` / `treeBudgetUsd`.
    - `deny` and question answers are always the parent's to give once it may answer at all.
  - **Left open.** Shell commands aren't parsed, so an unrestricted parent may allow a command that writes outside the worktree. Only `cwd` is checked, and the parent could run the same command itself. Resolutions remembered for "already answered" are in memory: after a node restart a late answer gets a plain `not_found`. Cross-machine helpers (§12.4) will need the same path through the hub.
- **Settings.** `orchestration.settings.set` merges into the machine or workspace overrides (`null` clears a field). A worktree inherits its repo workspace's overrides, then applies its own.
- **Budgets.** Turns and tokens (input + output of each completed turn) always count; usd counts only when the session's `billing` is `metered`. Billing comes from the session environment: for Claude, `ANTHROPIC_API_KEY` means metered and `CLAUDE_CODE_OAUTH_TOKEN` means plan; for Codex, `CODEX_API_KEY` means metered. Otherwise it comes from the agent probe's `billing`, then from `account.usage` events; if none of these says, it stays unset. A session's `budget` bounds it and every helper below it, and `treeBudgetUsd` bounds the root's whole tree. After the turn that reaches a cap, the session goes `waiting_input` with `prompt: 'budget'`, and `send` and new helpers are refused. It resumes once back within budget. Raise `treeBudgetUsd`, or a session's own cap with `session.set { budget }` (`{}` clears it).

## 13. Phases

| Phase | Scope | Exit criteria | Status (Nov 2026) |
|---|---|---|---|
| **M0 local core** | core with node role; Claude + Codex adapters; event log; local UI | full session control for both agents on the laptop, offline | Built: node role, Claude (Agent SDK) and Codex (`app-server`) adapters, SQLite event log, the shared UI. |
| **M1 connected** | hub role behind Caddy; pairing-first login; headless install on a server; outbox + replay; browser/phone client; push (ntfy/Web Push) | start a session on the server from the phone, close the laptop, keep going; kill sockets mid-turn with no loss or duplicates | Built: hub relay and replica, Ed25519 pairing, node→hub link with outbox replay, Docker images and a Caddy example, ntfy and Web Push (Approve/Deny from the notification in Chrome and Edge). `npm run smoke:hub` covers the path offline. Open: a web app manifest (installable PWA; iOS needs it for push), native push for the desktop and phone shells. |
| **M2 provisioning + breadth** | install/update/login recipes; supported-version alerts, method migration, update policy, restart-on-new-version (§7); OpenCode adapter; terminal mode + agy; desktop + phone shells; headful Mac install; context bar, per-login usage meters, `http`/`command` widgets ([usage.md](usage.md) §5) | install and log in Codex on a fresh Linux box entirely from the phone; all four agents usable | Built: recipes with supported versions, adopted-install detection, `agent.migrate`, update/restart policies and install watching; OpenCode adapter; terminal mode (`@bizzi/pty`: agy, shell, OSC 7501); Electron and Capacitor shells; context bar, `usage.list`, `http`/`command` widgets; themes; restart-and-resume on a new agent version (updates.md §5, §8), including shared OpenCode servers, fallback to the previous version, resume after node restarts and an inbox item for `ask`. Open: restarting an external OpenCode service (updates.md §8). |
| **M3 knowledge** | rules + memory store, MCP server, injection, harvest, acceptance policy, inbox | a rule set in Claude applies to Codex in the same workspace, on another machine too | Built on each node: `@bizzi/knowledge` store, bizzi-memory MCP server, session-start injection, Claude/Codex harvest, acceptance policy and inbox (`knowledge.*`). Replication through the hub (`knowledge.sync.pull`/`push`, a hub copy, offline catch-up; [knowledge.md](knowledge.md) §9.4), the `tag` scope, `machine.set` and the machine card ([knowledge.md](knowledge.md) §9.1, §9.2), and the Claude-first iteration ([knowledge.md](knowledge.md) §8: harvest triggers, no double delivery, Add to AGENTS.md). |
| **M4 orchestration (one machine)** | worktrees as workspaces; agent-to-agent MCP tools (§12.1); guardrails (§12.2); billing classes and budgetless providers (§12.3); fan-out + compare view; helper budgets, preflight and tree view ([usage.md](usage.md) §2) | Claude asks Codex to review its change in a worktree on the same machine, waits, reads the findings and fixes them, while you watch both from the phone; local-model helpers don't count toward the budget | Built: `worktree.*`, `seen_through`, the bizzi-agents MCP tools (`@bizzi/orchestration`), guardrails and `orchestration.settings.*`, billing classes, session and tree budgets, helpers nested in the sidebar, the helper tree view, fan-out with session groups, context baselines, the preflight, the compare view, and a parent answering its helpers' approvals and questions (`parentAnswersApprovals`). `npm run smoke:v12` covers the one-machine flow offline. |
| **M5 later** | cross-machine agent-to-agent via the hub (§12.4), one-pane mode with routing (§11.2), pipelines/watchers, container workspaces, fork-to-machine, tool bridging, API chat, color/tags per machine and workspace (sidebar and headers), team (orgs, sharing, Postgres; deprioritized, decision 1) | | Built: cross-machine helpers through the hub and node → hub requests (§5.4, §12.4); fork to machine; one-pane mode (§11.2: the Ask composer with `@` `#` `/` autocomplete, explicit tokens, routing rules, recorded routes, the option-logit classifier, borrowed classifiers); pipelines ([pipelines.md](pipelines.md)); container workspaces (`container.*`, docker exec, the dind compose profile); API chat (`@bizzi/adapter-api`); identity color, icon and tags per machine and workspace (§11.1). Open: watchers ([pipelines.md](pipelines.md) §5) and tool bridging ([topology.md](topology.md) §6.2), both designed, not built; a UI to create a container workspace; team (deprioritized). |

## 14. Open questions

1. Containers: worth it, and in which form ([topology.md](topology.md) §7)?
2. Ambient knowledge mode: on by default or opt-in?
3. Messages sent to a session on a sleeping laptop: reject, or queue for delivery on wake?
4. IdP (deferred).
