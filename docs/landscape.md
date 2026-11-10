# bizzi — landscape: Rex, Herdr, and ideas worth taking (draft 1)

Researched 2026-11-09 from public docs, repos and hands-on write-ups. Both projects move fast; re-check before relying on a detail. Sources at the end.

## 1. Positioning

Rex and Herdr both start from the terminal: a server owns PTYs, clients render them, agents are recognised processes inside panes. bizzi starts from the session: adapters speak each agent's structured interface (Agent SDK, `codex app-server`, OpenCode server), with a PTY as the fallback (`@bizzi/pty`).

What neither does, and what bizzi should lead with if released as a project:

- Structured sessions: tool calls, diffs, plans, usage, subagents as normalized events, not screen text.
- Approvals answered from any client (allow / deny / edit input), not keystrokes into a TUI.
- Durable, sequence-numbered event history with replay after disconnect and an offline outbox. Herdr reviewers call this out as missing ("no durable event history").
- Shared rules and memory across agents ([knowledge.md](knowledge.md)). Herdr explicitly isn't this ("orchestration, not shared memory").
- Remote provisioning: install, update and log in ADEs on any machine.
- One hub every client reaches; nodes dial out.

Don't compete on terminal fidelity, multiplexer ergonomics or plugin count.

## 2. Rex (Superlogical)

- **Who / status:** Mitchell Hashimoto's company (announced 2026-07-29, VC-funded). Public beta via mailing-list invites since 2026-10-05; macOS app plus Linux/FreeBSD server; iOS in TestFlight alpha; Windows server and Linux/Windows clients internal; web client promised.
- **Licence / cost:** "free and will always be free", no account, self-hostable, no telemetry. No licence named on first-party pages; secondary sources say closed source with a hinted OSS release. Built on libghostty (MIT).
- **Architecture:** server owns PTYs and tees raw bytes to every client; each client parses with libghostty (no double parsing, per-client scrollback). Each split is its own PTY, which is what enables native iOS and web clients.
- **Remote:** real system logins; servers can join a tailnet as their own device (built-in Tailscale, QR pairing for iOS); `rex hosts add`.
- **Agents:** program status protocol (OSC 7501, §4.1), emitted natively by Claude Code. `rex skill setup` installs a skill plus SessionStart hook (Claude Code, Codex; skill only for OpenCode, Pi). Agents open tabs and splits, run commands, read other panes, send keys.
- **Automation:** Lua `init.lua` (bindings, actions, modes, events), `rex` CLI with `--json` and stable exit codes, self-describing server API, command palette with in-place rebinding.
- **Gaps:** no notifications built in, no structured agent view, macOS-only client in beta; live sharing is promised but not shown.

## 3. Herdr (Herdr, Inc.)

- **Who / status:** `herdrdev` (YC F26 per one source). v0.1.0 March 2026; `herdrdev/herdr` about 50k stars. Apache-2.0 (moved from AGPL). Rust, single binary. Free; "Herdr Cloud" announced, unpriced.
- **Three products, not sharing agents:** the Herdr TUI (`herdr`); herdr-core (`hc`), a headless terminal runtime with an OpenRPC API (`hc schema`); herdr-app, a native desktop client on herdr-core whose UI is agent-editable files explained by an AGENTS.md. Official iOS/Android apps; community clients (Moshi, Roamgate web GUI with diff review, herdr-web-ui with chat-style approvals and push).
- **Model:** session → workspace (per repo) → tab → pane (PTY); an "agent" is a recognised process in a pane. Server restarts kill processes; layouts return; conversations resume only where an integration saved the native session ID.
- **Status detection:** the TUI uses foreground process plus remotely updated "screen manifests" (rules matched against the bottom of the screen), optional hooks (`herdr integration install claude`), and `herdr agent explain` for debugging. herdr-core uses only OSC 7501. States: working / blocked / done (finished while unseen) / idle / unknown; they roll up to tab and workspace.
- **Agent-to-agent:** `hc run --bg`, `hc send`, `hc wait`, `hc read`; helpers are scoped to their parent and report back. TUI: `agent start / prompt --wait / wait --until blocked / read / send-keys`, `pane wait-output --regex`. `--skill` teaches it all.
- **Other:** `hc machine add` over SSH or Tailscale, `hc run --on <machine>`; `herdr worktree create --branch`; toasts / OS notifications / per-agent sounds; plugins are any executable plus `herdr-plugin.toml` using the public CLI and socket API.
- **Gaps (reviewers):** no task graph, approval policy or event history; no shared memory; no file isolation; probabilistic detection; one server per CLI.

## 4. Ideas for bizzi

Ranked by value for effort. Status: **idea** unless noted.

### 4.1 Parse OSC 7501 in `@bizzi/pty`

Both Rex and Herdr use it; it is becoming the standard way for a TUI to say "I'm blocked on a permission prompt". Today `packages/pty/src/ansi.ts` strips every OSC and `packages/pty/src/activity.ts` guesses from output with regexes. Parsing 7501 gives exact state plus a reason in terminal mode (agy, any TUI) and in Claude Code under a PTY; keep the detectors as the fallback.

Format (Rex docs, "Program Status Protocol"): `ESC ] 7501 ; key=value:key=value ST`. Keys: `state` (required: `idle` | `working` | `done` | `blocked` | `error`, or `clear`), `id` (optional, `/` nests records), `app`, `title` and `msg` (base64 UTF-8), `kind` for blocked (`permission` | `question` | `auth`), progress on working/blocked. A report replaces its record; malformed pairs are skipped; oversized reports or bad base64 discard the whole report. `working`/`blocked` drop on process exit or a new prompt (OSC 133 A). A `?` query asks the terminal what it supports. Mapping: `blocked/permission` → `approval.requested`-like status, `blocked/question` → `question.asked`-like status, `idle` → `waiting_input`, `error` → `failed`.

### 4.2 Agent-to-agent tools over MCP

**Status: built for one machine ([spec.md](spec.md) §12.5, `@bizzi/orchestration`), phase M4.** Agents running in bizzi start a helper session (any agent), send / steer, wait until idle or waiting, read structured results, stop. Herdr does this through a CLI with screen text; bizzi's helpers are full sessions and the parent reads events, not screens. The machine is the boundary for now; cross-machine via the hub is M5 (spec §12.4). Depth, concurrency and budget guardrails, with local inference marked budgetless (spec §12.2–12.3).

### 4.3 Data-driven prompt detectors

`PromptDetector` with its `note` provenance field is already Herdr's screen-manifest idea. Next steps: ship the detector set as data (versioned, updatable without a release, off-switch for offline/air-gapped users), and add an "explain" view: which detector or OSC report produced the current status.

### 4.4 Worktrees as workspaces

**Status: built (spec §12.5).**

`worktree.create { workspaceId, branch }` → `git worktree add` and a new workspace grouped under the parent repo; removal never deletes the branch and refuses on uncommitted changes without force. Listed in spec §5.2, not built. Makes fan-out safe.

### 4.5 Published protocol schema

Herdr's client ecosystem (mobile, web, menu bar, Stream Deck) grew because `hc schema` documents the API. Generate a machine-readable schema (JSON Schema or OpenRPC) from `@bizzi/protocol` so third-party clients and plugins can target it. Pairs with releasing bizzi as a project.

**Done:** [`docs/protocol.schema.json`](protocol.schema.json) (JSON Schema 2020-12), generated by `npm run schema` (`scripts/gen-schema.ts`, TypeScript compiler API). One `$defs` entry per protocol type, `params:<method>` / `result:<method>` per method and `session:<type>` / `global:<type>` per event, indexed by `x-methods` and `x-events`; the root validates one WebSocket frame. `npm run check` and CI fail when it is stale, and `smoke:hub` / `smoke:v12` validate their traffic against it.

### 4.6 `bizzi machine add` over SSH

Bootstrap a new machine from an existing client: SSH in, install the node, pair it with the hub, then it dials out as usual. Keeps the dial-out rule; removes the "go install it there first" step.

### 4.7 Tailscale as an alternative to the reverse proxy

For self-hosters without a domain or Caddy: the hub listens on the tailnet (HTTPS certs from Tailscale), and identity comes from the Tailscale login. Rex's built-in Tailscale plus QR pairing for the phone is the reference UX.

### 4.8 Smaller UX ideas

- Command palette that shows each action's shortcut and rebinds in place (Rex).
- Attention rollup, per-agent marks and `done` as an unseen-result flag: **designed, spec §11.1** (sidebar rows), with a hub-side `seen_through` cursor so devices agree (spec §4).
- Per-agent notification sounds; suppress the toast for the session you're viewing (Herdr).
- Agent-editable UI config with its own AGENTS.md (herdr-app): users customise layout by asking their agent.
- Sidebar as the machine → workspace tree with clickable machine tiles and a resizable, auto-fitting width: **done, spec §11.1**.
- Colour/tags per machine and workspace (a stripe or dot in the sidebar and headers): later, spec §13 M5. Not a per-machine theme: the theme is one user-wide setting (theming.md §5).

## Sources

- Rex: [superlogical.com](https://www.superlogical.com/) · [public testing post](https://www.superlogical.com/updates/public-testing-beginning) · [docs](https://www.superlogical.com/rex/docs) · [agent skill](https://www.superlogical.com/rex/docs/automate/agent-skill) · [program status protocol](https://www.superlogical.com/rex/docs/build/program-status) · [Classmethod hands-on](https://dev.classmethod.jp/en/articles/reona-superlogical-rex-beta-try/) · [bitdoze](https://www.bitdoze.com/superlogical-rex/) · [rex-agents](https://github.com/irfn/rex-agents)
- Herdr: [herdr.dev](https://herdr.dev/) · [herdr-core](https://herdr.dev/core/) · [GitHub](https://github.com/herdrdev/herdr) · [Developers Digest deep dive](https://www.developersdigest.tech/blog/herdr-deep-dive-agent-terminal-multiplexer) · [Flavio Copes](https://flaviocopes.com/herdr/) · [innFactory](https://innfactory.ai/en/ai-harness/herdr/) · [bitdoze clients](https://www.bitdoze.com/best-herdr-clients/)
