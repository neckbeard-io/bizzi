# bizzi — product & system spec (draft 3)

Status: ideation. Companion docs: [topology.md](topology.md) (installs, roles, machines, where work runs, offline), [knowledge.md](knowledge.md) (rules & memory across agents), [tech-choices.md](tech-choices.md) (stack; the core language/shell decision is open).

## 0. Decisions so far

| # | Topic | Decision |
|---|---|---|
| 1 | Users | Solo now, team later. Org/member/role in the schema from day 1. |
| 2 | Exposure | The hub sits behind a reverse proxy (Caddy / SWAG) and is authenticated. Auth is pluggable; IdP choice deferred. M1 ships built-in single-user passkey login + device pairing. |
| 3 | Hierarchy | **Machine first**: Machine > Workspace > Session. You choose where to work (this laptop, machine A, machine B) before anything else. Projects are an optional cross-machine link between workspaces. |
| 4 | Install model | **One install, roles by config.** The desktop app embeds the control layer, so local mode needs nothing else. Remote machines run the same core without the desktop UI (`bizzi serve`), either GUI-capable (inside a logged-in GUI session, e.g. a Mac for visual inspection) or headless. **On Linux, headless means a docker-compose stack** (`hub` + `node` services, [topology.md](topology.md) §2.2). The phone is client-only. |
| 5 | Mental model | Like Claude Code Remote Control: the machine running the agent dials out to a relay, clients talk to the relay. In bizzi the relay is your self-hosted hub, and it drives any ADE on any of your machines. |
| 6 | Continuity | **No takeover of running sessions.** A session lives and dies on the machine you started it on. Continuity comes from choosing a remote machine for work that should outlive the laptop lid. Laptop sessions pause while the laptop sleeps and resume when it wakes; clients replay what they missed. (An explicit "fork to another machine" may come later.) |
| 7 | ADE provisioning | bizzi can install, update and log in ADEs (Claude, Codex, OpenCode, agy) on any machine, from any client. |
| 8 | Workspaces | git repos and plain directories (research) both supported. Containers as a workspace kind are a candidate for later ([topology.md](topology.md) §7); VMs out of scope. |
| 9 | Knowledge | Scoped rules + memories (global, machine, project, workspace, session) shared across agents; acceptance policy is a user setting with balanced defaults; suggestions in a batched inbox ([knowledge.md](knowledge.md)). |
| 10 | Stack | **Decided:** TypeScript core on Node.js (Claude Agent SDK in-process, `codex app-server`, OpenCode SDK, `node-pty`, official MCP/ACP SDKs). React UI shipped in Electron (desktop), Capacitor (phones) and the browser, with performance guardrails. See tech-choices D0. |

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
8. Team-ready data model and auth, even while single-user.

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
       version, install method, update available, auth: ok | missing | expired, account label
       defaults: model, effort, permission mode, extra flags
  ─< ApiProvider                   # model API credentials usable from this machine
  ─< Workspace                     # a directory on this machine
       path, kind: git | dir   (container later)
       project?: Project           # optional cross-machine link
       ─< Session
            agent, mode: structured | terminal
            agent_session_ref (claude session id / codex thread id / opencode session id / pty id)
            forked_from?           # forks; later: forks onto another machine
            status: starting|running|waiting_input|waiting_approval|idle|
                    paused (machine asleep/offline)|ended|failed
            ─< Turn ─< Event(seq, ts, type, data)
            ─< Approval   ─< Artifact (blob refs)

Org ─< Project                     # optional: links workspaces across machines
  identity: normalized git remote URL, or manual link for dir workspaces
  used for: project-scope knowledge, "same project on machine B", defaults
```

Navigation follows the model: **machine → workspace → session**. The project link lets the UI show "acme on laptop / acme on server-a" and lets project-scope rules and memory apply in both.

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
| Machines | `machines.list`, `machine.get`, `machine.pair`, `machine.rename`, `machine.tags` |
| Provisioning | `agents.list { machineId }`, `agent.install`, `agent.update`, `agent.uninstall`, `agent.login` (opens a login PTY, §7), `agent.logout`, `agent.probe` |
| Workspaces | `workspaces.list { machineId }`, `workspace.create` (clone / new dir / adopt existing path), `workspace.linkProject`, `fs.list/read/write`, `git.status/diff/commit/push`, `worktree.*` |
| Sessions | `session.create { workspaceId, agent, mode }`, `send`, `steer`, `interrupt`, `stop`, `fork`, `resume`, `set` (model/effort/mode) |
| Approvals | `approval.respond { approvalId, decision: allow\|allow_always\|deny, message?, editedInput? }` |
| Terminal | `term.open`, `input`, `resize`, `close` |
| Knowledge | `knowledge.list/search/add/update/forget`, `knowledge.suggestions` + `accept/reject`, `knowledge.policy.get/set`, `knowledge.sync` |
| Commands | `agent.commands`, `agent.runCommand` |
| Notifications | `push.register`, `push.prefs` |

### 5.3 Normalized events

`session.status` · `turn.started/completed` (usage, cost, stop reason) · `message.delta/completed` · `reasoning.delta/summary` · `tool.started/updated/completed` (`kind`: shell, read, edit, write, search, web, mcp, task, other) · `file.changed` (diff ref) · `plan.updated` · `approval.requested/resolved` · `question.asked` · `usage.updated` · `subagent.started/completed` · `knowledge.written` · `term.output` · `machine.status` · `install.progress` · `agent.raw` (untranslated native event, always kept and rendered generically, so new agent features show up before the adapter learns them)

### 5.4 Node ↔ hub

Same envelope. Node→hub: `hello` (facts, installs, last-acked seq per session), events from the outbox, `heartbeat` (power, load), knowledge replication. Hub→node: relayed client requests, knowledge replication, (later) `tools.bridge`.

The node writes events to its local SQLite first; the outbox drains to the hub when connected. A laptop that worked offline uploads its sessions on reconnect, so the phone can see them afterwards.

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
| **OpenCode** | `opencode serve` (HTTP + SSE, official SDK), or `opencode acp` | also the multi-provider harness for raw APIs (§6.5) |
| **agy** | none yet → **terminal mode** | `--print` reportedly silent without a TTY; interactive Google sign-in; Google's FAQ reportedly treats third-party access tools as a ToS violation, so drive only the official binary in a PTY. Structured mode once Google ships a protocol, or in Gemini API-key mode. |

### 6.5 Plain model APIs
1. **Chat/utility (no tools):** provider abstraction on the node or hub: quick questions, session titles, handoff briefs, memory extraction, review passes. Anthropic, OpenAI, Gemini, OpenRouter, OpenAI-compatible base URLs.
2. **Agentic:** OpenCode on the node, configured for that provider/model.

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
| Claude Code | native installer (`curl -fsSL https://claude.ai/install.sh \| bash`) or Homebrew | native installer | self-updates; bizzi can pin or let it auto-update |
| Codex | Homebrew or `npm i -g @openai/codex` | npm, or a release binary | npm route needs Node; bizzi can install a managed Node if missing |
| OpenCode | install script / Homebrew | install script | |
| agy | Homebrew `antigravity-cli` / install script | install script | |

Exact commands get verified per release in CI; recipes are data, so fixing one doesn't need a bizzi release.

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

## 9. Knowledge & memory (summary; details in [knowledge.md](knowledge.md))

- **Rules** (always injected) and **memories** (ranked digest + search), one scope model: global > machine > project > workspace > session, optionally limited to certain agents.
- **One pipeline for every agent:** MCP tool calls, harvested native memory, transcript extraction and UI edits all go through a configurable acceptance policy; reads come from one resolver keyed on (agent, machine, project, workspace).
- **Launch mode** injects into sessions bizzi starts; opt-in **ambient mode** serves the same knowledge to agent sessions bizzi didn't start.

## 10. Security & auth

- **Hub:** behind Caddy/SWAG, authenticates every request itself (the proxy is defense in depth). Pluggable auth: **pairing-first** for M1 (a one-time setup code from the hub's first start pairs the first device; later devices are approved from a paired one); OIDC / proxy-header providers later, with passkeys handled by the IdP.
- **Pairing:** machines and devices pair by QR / one-time code approved by a logged-in user and get a per-device keypair; access tokens are short-lived and minted by signing a challenge. Revocable per device. Machine/device endpoints bypass interactive forward-auth at the proxy (they can't follow an SSO redirect).
- **Local mode:** the in-process / local-socket path is limited to the OS user who owns the install (socket file permissions).
- **Credentials:** ADE logins and API keys stay on their machine (OS keychain / secret store). The hub never sees them.
- **Approvals** are attributed to the deciding device and audit-logged; remote-stricter policy is available (e.g. no `bypassPermissions` from the phone).
- **Agent ToS:** drive each vendor's official CLI under your own login on your own machine; re-check Anthropic and Google terms before a wider release. Remote Control itself needs a claude.ai subscription; bizzi doesn't use Remote Control, it drives the CLI locally.

## 11. Frontend

One UI codebase for every client: desktop app (macOS, Windows, Linux), phone (Android; iOS best-effort), browser client served by the hub. React, in Electron / Capacitor / the browser (tech-choices D0b).

Screens: **machines** (online, headful/headless, power, ADE status with install/update/login buttons) → **workspaces** (on the selected machine, with project links) → **sessions** (timeline, composer, inline approvals, plan/todos, diff review, terminal tab, raw-events tab) · **inbox** (approvals, questions, finished turns, knowledge suggestions) · **knowledge browser** (by scope, provenance, policy) · settings.

Mobile-first touches: approve/deny from the notification, voice input, file-by-file diff review, share sheet into a session.

## 12. Orchestration (later)

Fan-out (same task to several agents in separate worktrees; compare), pipelines (planner → implementer → reviewer across agents), watchers (a cheap model pings you only for real decisions). Shared knowledge keeps cross-agent work coherent.

## 13. Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **M0 local core** | core with node role; Claude + Codex adapters; event log; local UI | full session control for both agents on the laptop, offline |
| **M1 connected** | hub role behind Caddy; pairing-first login; headless install on a server; outbox + replay; browser/phone client; push (ntfy/Web Push) | start a session on the server from the phone, close the laptop, keep going; kill sockets mid-turn with no loss or duplicates |
| **M2 provisioning + breadth** | install/update/login recipes; OpenCode adapter; terminal mode + agy; desktop + phone shells; headful Mac install | install and log in Codex on a fresh Linux box entirely from the phone; all four agents usable |
| **M3 knowledge** | rules + memory store, MCP server, injection, harvest, acceptance policy, inbox | a rule set in Claude applies to Codex in the same workspace, on another machine too |
| **M4 later** | team (orgs, sharing, Postgres), container workspaces, fork-to-machine, tool bridging, API chat, fan-out/pipelines | |

## 14. Open questions

1. Containers: worth it, and in which form ([topology.md](topology.md) §7)?
2. Ambient knowledge mode: on by default or opt-in?
3. Messages sent to a session on a sleeping laptop: reject, or queue for delivery on wake?
4. IdP (deferred).
