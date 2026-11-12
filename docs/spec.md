# bizzi — product & system spec (draft 3)

Status: ideation. Companion docs: [topology.md](topology.md) (installs, roles, machines, where work runs, offline), [knowledge.md](knowledge.md) (rules & memory across agents), [tech-choices.md](tech-choices.md) (stack; the core language/shell decision is open).

## 0. Decisions so far

| # | Topic | Decision |
|---|---|---|
| 1 | Users | **Single user.** "Team" meant releasing bizzi as an open project others self-host for themselves, not one org sharing an install. Multi-user (orgs, sharing, roles) is deprioritized: keep what's already built (`org_id`, Org/Member in the schema) and leave room for it, but don't spend effort on it now. |
| 2 | Exposure | The hub sits behind a reverse proxy (Caddy / SWAG) and is authenticated. Auth is pluggable; IdP choice deferred. M1 ships built-in single-user passkey login + device pairing. |
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
            forked_from?           # forks; later: forks onto another machine
            agent_version          # version the agent process started on (§7 updates)
            spawned_by?            # parent session when an agent started it (§12.1); same machine for now
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
| **OpenCode** | v2 `opencode serve` (HTTP + SSE); v1 only through terminal mode (tech-choices D12). Later: attach to OpenCode's shared background service. Or `opencode acp` | also the multi-provider harness for raw APIs (§6.5) |
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
| Claude Code | **native installer** (`curl -fsSL https://claude.ai/install.sh \| bash`); Homebrew detected, migration offered | native installer | the native install self-updates; the Homebrew cask doesn't (Claude only tells you to `brew upgrade`) |
| Codex | Homebrew or `npm i -g @openai/codex` | npm, or a release binary | npm route needs Node; bizzi can install a managed Node if missing |
| OpenCode | v2 install script / Homebrew `anomalyco/tap/opencode-v2` | v2 install script | **v2 only**; v1 is detected and flagged unsupported (tech-choices D12) |
| agy | Homebrew `antigravity-cli` / install script | install script | |

Exact commands get verified per release in CI; recipes are data, so fixing one doesn't need a bizzi release.

**Ownership.** bizzi installs an ADE where none exists, using the recipe's preferred method (per-user, no sudo). An install that's already there is adopted as-is and never silently replaced.

**Supported versions.** Each recipe declares the versions bizzi supports (OpenCode `>=2.0.0`; the others, the adapter's tested range). The probe reports `support: ok | untested | unsupported`, with a reason and a remedy.

- `unsupported` raises an alert: a banner on the machine, an inbox item, and a warning on the machine header in the sidebar (§11.1).
- Structured sessions refuse to start on an unsupported install (`BizziError`); terminal mode is offered instead.
- Remedies are actions you confirm, never automatic, because they change your own install. OpenCode v1 → **Upgrade to v2** (`opencode upgrade --major`, or the v2 installer).
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

## 9. Knowledge & memory (summary; details in [knowledge.md](knowledge.md))

- **Rules** (always injected) and **memories** (ranked digest + search), one scope model: global > machine > project > workspace > session, optionally limited to certain agents.
- **One pipeline for every agent:** MCP tool calls, harvested native memory, transcript extraction and UI edits all go through a configurable acceptance policy; reads come from one resolver keyed on (agent, machine, project, workspace).
- **Launch mode** injects into sessions bizzi starts; opt-in **ambient mode** serves the same knowledge to agent sessions bizzi didn't start.

## 10. Security & auth

- **Hub:** behind Caddy/SWAG, authenticates every request itself (the proxy is defense in depth). Pluggable auth: **pairing-first** for M1 (a one-time setup code from the hub's first start pairs the first device; later devices are approved from a paired one); OIDC / proxy-header providers later, with passkeys handled by the IdP.
- **Pairing:** machines and devices pair by QR / one-time code approved by a logged-in user and get a per-device keypair; access tokens are short-lived and minted by signing a challenge. Revocable per device. Machine/device endpoints bypass interactive forward-auth at the proxy (they can't follow an SSO redirect).
- **Local mode:** the in-process / local-socket path is limited to the OS user who owns the install (socket file permissions).
- **Workspace picker:** `fs.browse` / `fs.complete` / `fs.suggest` are not confined to a workspace: they run as the node's OS user and can list any directory that user can, which is the same trust a paired device already has through a terminal session. They return directory names, symlink-to-directory entries and a `.git` presence bit only; they never read file contents or write, and each call is bounded (entry caps, a time budget for suggestions). `fs.list` / `fs.read` stay confined to their workspace.
- **Credentials:** ADE logins and API keys stay on their machine (OS keychain / secret store). The hub never sees them.
- **Approvals** are attributed to the deciding device and audit-logged; remote-stricter policy is available (e.g. no `bypassPermissions` from the phone).
- **Agent ToS:** drive each vendor's official CLI under your own login on your own machine; re-check Anthropic and Google terms before a wider release. Remote Control itself needs a claude.ai subscription; bizzi doesn't use Remote Control, it drives the CLI locally.

## 11. Frontend

One UI codebase for every client: desktop app (macOS, Windows, Linux), phone (Android; iOS best-effort), browser client served by the hub. React, in Electron / Capacitor / the browser (tech-choices D0b).

Screens: the **machine → workspace tree** (the desktop sidebar; the Machines tab on the phone) → **machine page** (opened from its tile: online, headful/headless, power, its workspaces with "Add workspace", ADE status with install/update/login buttons and update/restart policies, API keys, widgets, machine settings such as agent-to-agent limits) → **workspace** (sessions, project links) → **sessions** (timeline, composer, inline approvals, plan/todos, diff review, terminal tab, raw-events tab) · **inbox** (approvals, questions, finished turns, knowledge suggestions) · **knowledge browser** (by scope, provenance, policy) · **settings** (app-level only: appearance, knowledge, devices, connection).

Mobile-first touches: approve/deny from the notification, voice input, file-by-file diff review, share sheet into a session.

Theming: themes are semantic UI tokens, a terminal palette and layout tokens, per light/dark variant. The model comes from Chorus/Terax (Apache-2.0), with a base16 importer and contrast validation; state colours and approval/permission badges can't be camouflaged by a theme. See [theming.md](theming.md).

### 11.1 Sidebar: machines, workspaces, agent indicators

Machines first, workspaces (usually a repo) under each, as in Herdr. Two references to steer between: Herdr rolls every agent in a space into one dot, which can't tell one agent from six; a cmux workspace card shows the last message, every status line, every directory and branch, and a PR link, which is too busy to scan. Target: a quiet workspace is one line; a row grows only when it has something worth reading.

```
▾ This computer              6 · 1 waiting
  W website    main*                ⚠ ◐ ◐ ●
    ⚠ Claude: approve `bun run build`?
  C core       master                     ◐
  P plugins    main            ● ● ● ● +3
    PR #27 open · CI ✓ · ↑2
▾ mac-mini                   1
  E extensions main                       ✓
    ✓ Codex: removed five unused selectors
▸ vps (offline)              2 (cached)
```

**Row 1 (always):** workspace icon, name, branch (`*` when dirty), then the agent marks, right-aligned.

- One mark per live session, at most four, then `+n`. Order: waiting, failed, working, done-unseen, idle.
- Mark = the agent-type icon with a ring in the state colour; plain dots when the sidebar is narrow.
- States: **⚠ waiting** (approval, question, login; amber, pulses) · **✗ failed** · **◐ working** (spins) · **✓ done, not yet seen** (clears when the session is opened) · **● idle** (grey, hollow).
- Helper sessions (§12.1) count inside their parent's mark as a small number, not as marks of their own.

**Row 2 (only when something needs you):** the single most urgent item in the workspace, one line, ellipsised: waiting (with the reason) > failed > done-unseen (first line of the final message). Clicking it opens that session directly.

**Row 3 (only when not default):** repo state: PR and CI status, ahead/behind. Hidden when there's no PR and the branch is in sync. PR/CI needs a forge integration on the node (`gh` first); without one the row shows ahead/behind only.

**Machine header (tile):** name, online state, totals ("6 · 1 waiting"), so a collapsed machine still shows what needs you. Offline machines are dimmed and show cached counts; an unsupported agent shows a warning mark; "updates pending" sits under the header. Clicking the tile opens the machine's page and highlights the tile while it's open; the chevron is a separate target that collapses/expands. On hover (desktop) a **+** (add a workspace on that machine) and a gear (the machine page) overlay the totals.

**Desktop sidebar = the tree** (Herdr-style; no separate Machines/Workspaces pages, `#/machines` and `#/workspaces` open the selected machine's page). Header: logo and connection status, then icon buttons for Inbox (waiting badge), Knowledge (suggestion badge) and Settings. Footer: light/dark toggle and disconnect.

**Width:** a drag handle on the right edge (keyboard: focus it, arrows resize, Home/End jump, Enter fits) sets a manual width in [200, min(480, 40% of the window)]. **Auto** (the default) fits the widest row 1 or machine header (rows 2 and 3 don't count), clamped to [220, 360], and shrinks on narrow windows so the main pane keeps 640 px. Double-click the handle, its context menu, or Settings → Appearance returns to auto. Stored per device; rows ellipsise at any width. Measured once per frame at most, from a hidden max-content copy, only when the tree changes.

**Settings split:** the gear opens app-level settings only (appearance, knowledge, devices, connection). Anything about one machine (agents, policies, API keys, widgets, agent-to-agent limits) lives on that machine's page, never in both places.

**Bottom bar (desktop):** usage meters per login (Claude and Codex plan windows, metered spend) plus widgets such as a LiteLLM spend meter. On the phone this becomes a usage chip in the Machines and Inbox headers. The session header carries a context bar. Details: [usage.md](usage.md).

Rules: colour only carries state; everything else is muted text. No chat previews unless waiting or done-unseen. No directory lists. Never more than three lines per workspace. Hover (desktop) or long-press (phone) opens a breakdown: one line per session with agent, title, state, reason and age.

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
4. **Quick classifier:** a cheap or budgetless model (§6.5 chat/utility) gets the prompt plus a compact catalogue (machines with tags, descriptions and online state; workspaces with project, path, branch and recent activity) and returns a ranked target with a one-line reason. Budgetless local models are preferred, since this runs on every prompt.

**Confirm, don't guess:**

- The chosen target and its reason are shown before sending. Above a confidence threshold, Enter sends; below it, bizzi shows the top two or three targets to pick from.
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

**Boundary: the machine.** `workspace` must be on the parent's node, so the node serves these tools without the hub and they work offline. Cross-machine helpers come later (§12.4).

The helper records `spawned_by`. A `child` helper stops when its parent stops or ends; a `detached` one outlives it. Helpers appear nested under their parent in the session list and count inside the parent's mark in the sidebar (§11.1).

### 12.2 Guardrails

- **Depth limit:** default 2 (parent → helper → helper's helper), configurable per workspace. `session_start` beyond the limit fails with a `BizziError`.
- **Concurrency:** max live helpers per parent and per machine; extra starts queue or fail, by setting.
- **Permissions:** a helper's permission mode is never looser than its parent's.
- **Approvals:** a helper's approvals go to you (inbox, push) by default. Letting the parent answer them is an explicit per-workspace opt-in.
- **Budget:** an optional spend cap per session tree, counted on `metered` providers only (§12.3).

### 12.3 Billing classes and budgetless providers

Each `ApiProvider` (and each logged-in agent account) has a billing class:

- **metered:** pay per token (API keys). Counts toward budget caps and spend warnings.
- **plan:** a subscription with usage limits (Claude Max, Codex Pro). Not money per call; show plan-limit usage instead of spend.
- **budgetless:** inference you already own, e.g. local H200/B200 boxes behind vLLM or a Bifrost gateway. Excluded from budget caps and spend warnings.

Context and spend per helper, `session_read` size limits, the fan-out preflight and the tree view are in [usage.md](usage.md) §2.

Budgetless doesn't mean unlimited: GPU capacity is the limit, so a provider can set `maxConcurrent` and helpers queue when it's full. Tokens are still recorded, and an optional notional rate lets reports show what the same work would have cost elsewhere. Helper defaults can prefer budgetless models (explorers and reviewers on the local model, OpenCode pointed at the gateway, §6.5). The UI tags sessions running on a budgetless provider, and session trees show metered spend only.

### 12.4 Later

- **Cross-machine agent-to-agent via the hub:** a parent on the laptop starts a helper on the Mac mini (Xcode build, screenshots) or the VPS (long test run). Needs nodes to send requests to the hub, an additive change to the hub contract (today the hub only acts as a client of nodes). A helper on an offline machine fails fast with `machine_offline`.
- **Pipelines** (planner → implementer → reviewer across agents) and **watchers** (a cheap or budgetless model pings you only for real decisions). Shared knowledge keeps cross-agent work coherent.

### 12.5 Implementation notes (M4, one machine)

- **Worktrees.** `worktree.create` adds a git worktree at `<repo>.worktrees/<branch>` next to the repository (slashes and unsafe characters in the branch become `-`; a numeric suffix avoids clashes) unless `path` is given, and registers a workspace of kind `worktree` under the repo workspace. A worktree of a worktree groups under the same repo workspace. If a registered worktree already has the branch, that workspace is returned. `worktree.remove` never deletes the branch. It refuses uncommitted or untracked changes unless `force`, refuses while any session that isn't ended or failed uses the worktree, and prunes a worktree whose directory is already gone. `workspace.remove` on a repo workspace that still has worktree workspaces is refused, so they are never orphaned.
- **Transport and caller identity.** `@bizzi/orchestration` serves the tools as the `bizzi-agents` MCP server over stateless Streamable HTTP, on a loopback port of its own. It never uses the client listener, which may be bound to `0.0.0.0`. Each structured session bizzi starts gets an `http` server spec with a bearer token minted when its agent process starts. The token identifies the caller, is replaced on every agent start, and is revoked when the session ends, fails or is removed. Terminal sessions and sessions at the depth limit get no tools. The injection composes with the knowledge hook: `NodeExtension.prepareStart` runs after `NodeOptions.prepareStart` and the results are merged.
- **Ownership.** A session can only send to, wait on, read or stop helpers it started itself.
- **Cascade.** A `child` helper stops when its parent stops, ends, fails or is deleted, recursively. `detached` helpers keep running. On node start, children of sessions that have ended are stopped.
- **Limits.** Live helpers (not ended, failed or queued) count toward `maxHelpersPerParent` (from the parent workspace's settings) and `maxHelpersPerMachine` (machine settings). With `onLimit: 'queue'` the helper is registered as `starting` with reason `queued: …` and starts when a slot frees up. Queued helpers end on a node restart.
- **Permissions.** Modes are compared on one scale:
  - 0 read-only: Claude `plan`, Codex `read-only`, OpenCode `plan`
  - 1 asks: Claude `default` and `dontAsk`, Codex `untrusted`
  - 2 edits the workspace: Claude `acceptEdits`, Codex `auto`, OpenCode `build`
  - 3 unrestricted: Claude `bypassPermissions`, Codex `full-access`

  A helper gets its requested mode (or its agent's default), capped at the parent's level. An unknown parent mode counts as 1, and an unknown requested mode inherits the parent's. agy and shell run at their own defaults, which ask, and are refused under a read-only parent. `session.set` keeps the cap: a helper's mode can be tightened later but not loosened beyond its parent's (`conflict`).
- **Approvals.** A helper's approvals and questions always go to you. The parent only sees them as the reason `session_wait` returns. `parentAnswersApprovals` is stored, but the path for the parent to answer isn't built.
- **Settings.** `orchestration.settings.set` merges into the machine or workspace overrides (`null` clears a field). A worktree inherits its repo workspace's overrides, then applies its own.
- **Budgets.** Turns and tokens (input + output of each completed turn) always count; usd counts only when the session's `billing` is `metered`. Billing comes from the session environment: for Claude, `ANTHROPIC_API_KEY` means metered and `CLAUDE_CODE_OAUTH_TOKEN` means plan; for Codex, `CODEX_API_KEY` means metered. Otherwise it comes from the agent probe's `billing`, then from `account.usage` events; if none of these says, it stays unset. A session's `budget` bounds it and every helper below it, and `treeBudgetUsd` bounds the root's whole tree. After the turn that reaches a cap, the session goes `waiting_input` with `prompt: 'budget'`, and `send` and new helpers are refused. It resumes once back within budget. Raise `treeBudgetUsd`, or a session's own cap with `session.set { budget }` (`{}` clears it).

## 13. Phases

| Phase | Scope | Exit criteria | Status (Nov 2026) |
|---|---|---|---|
| **M0 local core** | core with node role; Claude + Codex adapters; event log; local UI | full session control for both agents on the laptop, offline | Built: node role, Claude (Agent SDK) and Codex (`app-server`) adapters, SQLite event log, the shared UI. |
| **M1 connected** | hub role behind Caddy; pairing-first login; headless install on a server; outbox + replay; browser/phone client; push (ntfy/Web Push) | start a session on the server from the phone, close the laptop, keep going; kill sockets mid-turn with no loss or duplicates | Built: hub relay and replica, Ed25519 pairing, node→hub link with outbox replay, Docker images and a Caddy example, ntfy push (Web Push not yet). `npm run smoke:hub` covers the path offline. |
| **M2 provisioning + breadth** | install/update/login recipes; supported-version alerts, method migration, update policy, restart-on-new-version (§7); OpenCode adapter; terminal mode + agy; desktop + phone shells; headful Mac install; context bar, per-login usage meters, `http`/`command` widgets ([usage.md](usage.md) §5) | install and log in Codex on a fresh Linux box entirely from the phone; all four agents usable | Built: recipes with supported versions, adopted-install detection, `agent.migrate`, update/restart policies and install watching; OpenCode adapter; terminal mode (`@bizzi/pty`: agy, shell, OSC 7501); Electron and Capacitor shells; context bar, `usage.list`, `http`/`command` widgets; themes. In progress: restart-and-resume on a new agent version (updates.md §5). |
| **M3 knowledge** | rules + memory store, MCP server, injection, harvest, acceptance policy, inbox | a rule set in Claude applies to Codex in the same workspace, on another machine too | Built on each node: `@bizzi/knowledge` store, bizzi-memory MCP server, session-start injection, Claude/Codex harvest, acceptance policy and inbox (`knowledge.*`). Open: the store has replication primitives (HLC, `changesSince`/`applyRemote`) but nothing syncs it through the hub yet, so the "another machine" half of the exit criterion isn't met. |
| **M4 orchestration (one machine)** | worktrees as workspaces; agent-to-agent MCP tools (§12.1); guardrails (§12.2); billing classes and budgetless providers (§12.3); fan-out + compare view; helper budgets, preflight and tree view ([usage.md](usage.md) §2) | Claude asks Codex to review its change in a worktree on the same machine, waits, reads the findings and fixes them, while you watch both from the phone; local-model helpers don't count toward the budget | Built: `worktree.*`, `seen_through`, the bizzi-agents MCP tools (`@bizzi/orchestration`), guardrails and `orchestration.settings.*`, billing classes, session and tree budgets, helpers nested in the sidebar. In progress: fan-out + compare view, baselines and the preflight. `npm run smoke:v12` covers the one-machine flow offline. |
| **M5 later** | cross-machine agent-to-agent via the hub (§12.4), one-pane mode with routing (§11.2), pipelines/watchers, container workspaces, fork-to-machine, tool bridging, API chat, colour/tags per machine and workspace (sidebar and headers), team (orgs, sharing, Postgres; deprioritized, decision 1) | | Not started. |

## 14. Open questions

1. Containers: worth it, and in which form ([topology.md](topology.md) §7)?
2. Ambient knowledge mode: on by default or opt-in?
3. Messages sent to a session on a sleeping laptop: reject, or queue for delivery on wake?
4. IdP (deferred).
