# bizzi — technology choices (draft 5)

Companion to [spec.md](spec.md), [topology.md](topology.md), [knowledge.md](knowledge.md). Each entry: decision, alternatives, why, when to revisit.

**Targets:** clients on macOS, Windows, Linux and Android; iOS wanted (no test device yet); a browser client. Nodes on macOS (desktop app, remote GUI-capable Mac, headless Mac) and Linux (docker compose); Windows nodes later.

**Ground rule for this doc:** the stack must not weaken what bizzi is *for*: driving four fast-moving ADEs with as much fidelity as possible, reliable sessions and terminals, and reaching them from anywhere. Familiarity is a tiebreaker, not a driver: nobody on the project knows any of these stacks deeply, and most code will be written with AI coding agents.

## Summary

| Layer | Status | Choice |
|---|---|---|
| **Core language (node + hub + adapters)** | **decided (D0a)** | **TypeScript on Node.js** |
| **UI toolkit (all clients)** | **decided (D0b)** | **React web UI** in Electron (desktop), Capacitor (phones), and the browser, with performance guardrails |
| Protocol | settled | JSON envelopes, per-session `seq`, cursor replay; plain TS types in `@bizzi/protocol` (JSON Schema generated from them later) |
| Transport | settled | WebSocket (client↔hub, node↔hub); local socket between the desktop UI and its node |
| Storage | settled | SQLite (`node:sqlite` / better-sqlite3) + Drizzle on every install; Postgres optional for a team hub |
| Replication | settled | single-writer event logs, HLC last-writer-wins config, append-only knowledge |
| Agents | settled | Claude Agent SDK in-process · `codex app-server` · OpenCode SDK · `node-pty` for agy and terminal mode · official ACP SDK for anything else |
| Knowledge MCP server | settled | official MCP TypeScript SDK |
| Linux deployment | settled | docker compose (`hub`, `node`, optional `dind`) |
| Push | settled-ish | ntfy / UnifiedPush and FCM on Android, APNs on iOS, Web Push in browsers, local notifications on desktop |
| Auth | settled-ish | pairing-first; passkeys/OIDC later through an IdP |

---

## D0. Two decisions, not one

The protocol separates them: the **core** (node, hub, adapters) is where bizzi's actual capability lives; the **UI** only renders protocol events and sends intents. So the question "what do we leave behind?" has a different answer for each.

### D0a. Core language: TypeScript (decided)

**What a non-TS core leaves behind.** These are capability losses, not style preferences:

| # | Left behind with a Dart (or Rust/Go) core | Why it matters to bizzi |
|---|---|---|
| 1 | **Claude Agent SDK in-process.** Its features include: editing a tool's input before approving it (`canUseTool` → `updatedInput`); programmatic hooks (PreToolUse/PostToolUse/…); in-process MCP servers; switching model/permission mode mid-session; programmatic subagent definitions; fork/resume options; cost and usage | Claude is the deepest agent we drive. Without the SDK you only get what the ACP adapter exposes, at its release pace. ACP has no standard slot for some of these (edited approval input, hooks; effort to verify). The alternative, re-implementing Claude's internal stream-json control protocol, isn't a stable public contract |
| 2 | **Official SDKs generally.** MCP (official TypeScript SDK; Dart's `dart_mcp` is marked experimental), ACP (official TS and Rust libraries; none for Dart), OpenCode (TS SDK), Codex app-server (generates TS types and JSON Schema) | every adapter and the knowledge MCP server become hand-written clients that we maintain against four upstreams that ship weekly |
| 3 | **`node-pty`**, the PTY layer under VS Code's terminal, battle-tested on macOS, Linux and Windows (ConPTY) | terminal mode is the universal fallback and agy's *only* mode. Dart has no maintained PTY for non-Flutter binaries; we'd write and maintain a C/FFI shim |
| 4 | **AI coding agents' strongest language.** Claude/Codex write TypeScript server code far more reliably than Dart server code, which is rare in training data (most Dart is Flutter UI) | most of bizzi will be agent-written; fewer subtle bugs and faster iteration in the core |
| 5 | **Reference code to learn from.** Most ADE wrappers, ACP clients and Claude/Codex integrations in the wild are TS (or Rust/Python) | faster answers when an adapter misbehaves |
| 6 | **Ecosystem for hub features:** OIDC and WebAuthn libraries, Web Push, git libraries | less to build yourself |

**What a TS core costs:** a Node runtime instead of a small native binary (~60–90 MB; irrelevant in Docker images and on dev machines), native-addon builds (`node-pty`, SQLite) per platform, and garbage-collector memory overhead (fine at this scale).

**Verdict:** TypeScript for the core. It's the only option that leaves nothing behind on agent integration, which is the heart of bizzi. Rust would be the choice only if a tiny static binary mattered more than Claude depth; it doesn't here.

### D0b. UI toolkit: React web UI on Electron (decided)

**Decision:** one React app, shipped in Electron on desktop, in Capacitor on phones, and served by the hub to browsers. Flutter stays possible later: the UI is only a protocol client, so swapping it never touches the core.

The comparison that led here is kept below. The UI choice affects **presentation fidelity and client reach**, not what bizzi can do with agents.

**What Flutter leaves behind (compared with a web UI):**

| # | Left behind | Impact on bizzi |
|---|---|---|
| 1 | **xterm.js**: the standard terminal (VS Code, most web IDEs), with a GPU renderer, Unicode/emoji widths, ligatures, search, image protocols, very mature TUI compatibility. Flutter has `xterm.dart`: capable, smaller, last release Feb 2024 | **high**: terminal mode carries agy entirely and is the fallback for every agent; TUIs like Claude's stress terminal emulators hard |
| 2 | **CodeMirror / Monaco + Shiki**: code view, side-by-side and inline diffs, merge view, VS Code-grade highlighting (TextMate grammars). Flutter: `re_editor` + `re_highlight`, and a custom diff widget | **high**: diff review is one of the main things you do from a remote client |
| 3 | **Native rich rendering of agent output**: markdown with tables, Mermaid diagrams, KaTeX, HTML artifacts and previews. Flutter needs a package per format, and Mermaid/HTML need an embedded webview (weakest on Linux desktop) | medium |
| 4 | **A first-class browser client.** Flutter web renders to a canvas: larger first load, and browser find-in-page, text selection, copy of long logs and accessibility are weaker than in the DOM | medium: matters if you often use bizzi from a browser at the hub's URL |
| 5 | **Text selection and search over long, virtualized timelines.** Free in the DOM; needs care in Flutter | medium |
| 6 | **AI-agent proficiency and component ecosystem** (chat/timeline components, diff viewers, shadcn/ui) | medium |

**What a web UI leaves behind (compared with Flutter):**

| # | Left behind | Impact |
|---|---|---|
| 1 | **Native feel on phones.** Capacitor runs the UI in a webview: scrolling, keyboard handling and gestures are good but not native, especially on lower-end Android | medium: the phone is the main remote client, but its job is mostly timeline + approvals + composer |
| 2 | **One toolkit for everything.** Web needs two thin shells: Electron (desktop) and Capacitor (phones) | low: both are thin wrappers around the same app |
| 3 | **Desktop footprint.** Electron apps are 150–250 MB and use more RAM; Flutter is tens of MB | low for a dev tool |
| 4 | **Your prior Flutter experience** | low: limited depth either way |

**Why web won:** bizzi's heaviest UI surfaces (terminal, diffs, rich agent output, browser access) are exactly where the web is strongest and Flutter is thinnest, while Flutter's main win (native phone feel) matters less for a timeline-and-approvals app.

**Prior art, and the responsiveness concern.** Electron apps range from fast (VS Code, Cursor, Obsidian, Linear, Figma) to sluggish (Slack, Discord, classic Teams). The difference is engineering, so bizzi adopts VS Code-style rules from day 1:

| Guardrail | Rule |
|---|---|
| Core out of the UI | the core runs in its own process (`ELECTRON_RUN_AS_NODE`), never in Electron's main or renderer process; the renderer only renders |
| Main process stays thin | windows, tray, menus, IPC relay; no work that can block it |
| Streaming at frame rate | token deltas are buffered in the client store and flushed at most once per animation frame; no React re-render per token |
| Virtualized everything | timeline, file lists, logs, diffs: only visible rows are mounted (TanStack Virtual) |
| Fine-grained subscriptions | components subscribe to the slice they show (selector-based store); a new event re-renders one row, not the session |
| Heavy work off the main thread | markdown parsing, syntax highlighting, diff computation in web workers |
| Terminal | xterm.js. **DOM renderer for now**: with xterm 6.0.0 + addon-webgl 0.19.0 in Electron 45 (Chromium 156, 2× display) the WebGL glyph atlas draws glyphs far too small. WebGL is opt-in (`?term=webgl` or localStorage `bizzi.term.renderer=webgl`); re-test on each xterm upgrade |
| Budgets in CI | startup to interactive < 1.5 s; input latency < 50 ms while a session streams; idle RAM budget per window; a perf test streams a large synthetic session and fails the build on regressions |

**Fallback shell:** if Electron's footprint still bothers you, the same React app can move to **Tauri** on desktop (system webview: very light on macOS, good on Windows, weaker on Linux). The core is a separate process either way, so this is a contained change.

### Resulting shape

| Piece | Built with |
|---|---|
| Core | TypeScript on Node.js: one `bizzi` program: `serve [--connect <hub>]` (node), `hub serve` (hub), `hub code` (mint a pairing code on the hub host), `pair <hub> <code>` (pair this node), `status` |
| Desktop app (mac/win/linux) | Electron. The core runs as a **separate process** started by the app using Electron's bundled Node (`ELECTRON_RUN_AS_NODE`), so there's one runtime in the install, and sessions survive UI crashes, updates and closed windows. Attaches to an already-running `bizzi serve` instead of starting a second one |
| Phones (Android, iOS) | Capacitor around the same React app; client only |
| Browser | the same React app served by the hub |
| Remote Mac | `bizzi serve` under launchd (Node + the core, signed) |
| Linux | `bizzi/hub` and `bizzi/node` images (D11) |

UI stack: React 19 + Vite, TanStack Router/Query/Virtual, Tailwind + shadcn/ui, a selector-based normalized event store (Zustand), xterm.js (WebGL), CodeMirror 6 + `@codemirror/merge`, Shiki in a worker, Mermaid/KaTeX rendered lazily.

## D1. Transport: WebSocket with a resumable event log

WebSocket for client↔hub and node↔hub, one envelope for requests, responses and events; the desktop UI reaches its own node over a local socket (Unix socket / named pipe) carrying the same envelopes.

| Alternative | Verdict |
|---|---|
| SSE + HTTP POST | fallback for hostile networks; awkward as primary for keystrokes/approvals/steer |
| gRPC / Connect bidi | poor browser bidi streaming; proxy friction |
| WebTransport | revisit; envelope is transport-agnostic |
| NATS | revisit for large fleets |

Why: resumability is the hard part; seq + cursor replay make disconnects a non-event, like Remote Control's dial-out + streaming relay. Proxy notes: Caddy works out of the box; SWAG/nginx needs the stock upgrade headers and `proxy_read_timeout` ≥ 60 s.

## D2. Protocol package

`@bizzi/protocol`: plain, erasable TypeScript types (run directly by Node, no build step) plus small helpers (ids, envelope guards, `BizziError`). It also holds the internal adapter contract (`adapter.ts`). JSON Schema for non-TS clients will be generated from the types (e.g. `ts-json-schema-generator`); runtime validation at the server boundary can move to schemas then. TypeBox was the original plan; deferred to keep M0 simple.

## D3. Storage

SQLite (WAL) via Drizzle on every install: events, config, knowledge, outbox. Team hub: Postgres via Drizzle. Blobs: content-addressed files. `org_id` on every row from day 1.

## D4. Replication

Single-writer event logs shipped from the outbox by `(session, seq)`; HLC last-writer-wins config; append-only knowledge with tombstones. No generic sync engine needed.

## D5. Agent integration

| Agent | Primary | Fallbacks |
|---|---|---|
| Claude Code | **Agent SDK in-process** | ACP (`claude-agent-acp`); `claude -p` stream-json; PTY |
| Codex | `codex app-server` (JSON-RPC stdio; types from `generate-ts`) | `codex-acp`; PTY |
| OpenCode | `opencode serve` + official SDK | `opencode acp`; PTY |
| agy | PTY (`node-pty`) | revisit when Google ships a protocol |
| any other ACP agent | official ACP TS SDK | PTY |

bizzi's session model is ACP-shaped so the generic ACP path stays cheap. Adapters declare supported version ranges; CI contract-tests pinned agent versions. PTY sessions run under a small detached supervisor so they survive core restarts (except Linux container restarts, which drain first).

## D6. Provisioning

Recipes as data (YAML): detect → install → verify → login, per ADE × OS × arch. Prefer vendor installers/release binaries and per-user installs; a bizzi-managed tool dir (`~/.bizzi/tools`). Logins in a PTY with URL/code detection and temporary callback port forwarding. Secrets in the OS keychain (Keychain, libsecret, an encrypted file on headless Linux).

## D7. Knowledge store

SQLite FTS5 now, sqlite-vec later; served by a `bizzi-memory` MCP server built with the official MCP TypeScript SDK, launched per agent session over stdio.

## D8. Auth (IdP deferred)

- **Pairing-first (M1):** the hub prints a one-time setup code on first start (container logs / `bizzi` CLI); the first device pairs with it; later devices and machines are approved from a paired device. Per-device keypairs; short-lived tokens minted by signing a challenge; revocable per device.
- **Later:** OIDC through an IdP (Pocket ID, Authelia, Authentik, Keycloak), which also handles passkeys.
- **Proxy:** machine/device endpoints bypass interactive forward-auth; the hub authenticates every request itself.

```caddyfile
bizzi.example.com {
	@machine path /api/device/* /ws/device /ws/node
	handle @machine {
		reverse_proxy hub:7777
	}
	handle {
		# optional: forward_auth to your IdP once chosen
		reverse_proxy hub:7777
	}
}
```

## D9. Push

Android: ntfy (self-hostable; UnifiedPush) and/or FCM. iOS: APNs (developer account, your own keys). Browser: Web Push. Desktop: local notifications. Actionable Approve/Deny from phone notifications.

## D10. Containers (later)

On Linux through the compose `dind` sidecar, never the host socket; Docker Desktop / OrbStack / Apple `container` on macOS. `devcontainer.json` when present, else a bizzi base image. See [topology.md](topology.md) §7.

## D11. Linux deployment: docker compose

`hub` + `node` (+ `dind` profile) services; runtime state on volumes (`/data`, `/home/bizzi`, bind-mounted `/workspaces`); `PUID`/`PGID`; graceful drain on SIGTERM; no host Docker socket. The node image: Debian slim + Node + the core + base toolset (git, Python, build tools, Xvfb + browser dependencies, `tini`). Full layout: [topology.md](topology.md) §2.2. A bare-metal systemd install stays possible but unsupported.

## Packaging

- Desktop: electron-builder (signed + notarized macOS; AppImage/deb; Windows installer).
- Remote Mac: `bizzi serve` + launchd, signed with a stable identity (macOS privacy grants depend on the signature).
- Linux: container images + compose file.
- Phones: Capacitor builds (Android from any OS; iOS from the Mac: Simulator now, TestFlight once there's a developer account).
- Monorepo: npm workspaces (no extra tooling; Node 26 runs the TypeScript packages directly).

## Repo layout

Authoritative list: [AGENTS.md](../AGENTS.md).

```
bizzi/
  packages/
    protocol/          # wire types (envelope, methods, events, model, capabilities) + adapter contract
    core/              # node role (hub role later): sessions, event store, client-protocol server
    adapter-claude/    # Claude Agent SDK
    adapter-codex/     # codex app-server
    adapter-opencode/  # opencode serve
    pty/               # node-pty terminal host + terminal-mode adapters (agy, shell, any TUI)
    knowledge/         # rules + memory store, resolver, policy engine, MCP server, projection
    provision/         # ADE detection, install/login recipes (recipes/ inside)
    client/            # protocol client + normalized store (no UI deps)
    ui/                # React app shared by every client
  apps/
    cli/               # `bizzi`: serve, status (pair, attach later)
    desktop/           # Electron shell; supervises the core process
    mobile/            # Capacitor shell (later)
  deploy/              # Dockerfiles, docker-compose.yml, SWAG/Caddy examples
  docs/
```

## First spikes

1. **Claude adapter on the Agent SDK:** streaming input, approval round-trip with edited input, interrupt, model/mode switch, resume after a core restart.
2. **Codex app-server adapter:** thread/turn lifecycle, steer, approvals.
3. **Terminal mode:** `node-pty` + xterm.js running Claude's and agy's TUIs, locally and from the phone through the hub.
4. **UI performance baseline:** the session screen (streaming markdown, tool cards, a diff, a terminal pane) against the budgets above, in Electron on macOS and Linux and in Capacitor on a mid-range Android phone.
5. Outbox + replay drill across a network drop.
