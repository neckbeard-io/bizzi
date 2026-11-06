# bizzi — topology: installs, machines, where work runs (draft 3)

Replaces the earlier continuity draft. Sessions no longer move between machines; continuity comes from *where you choose to start work*.

## 1. Mental model

Same shape as Claude Code Remote Control:

- The machine running the agent **dials out** to a relay and waits for work; it never accepts inbound connections.
- Clients (phone, browser, another desktop) talk to the relay, which routes messages to the machine over a streaming connection.
- The session runs on that machine the whole time; if the machine is off, the session is unreachable.

Differences: the relay is **your hub**, it fronts **all your machines**, and the machine side drives **any ADE**, not just Claude. And because the control layer is embedded in the desktop app, bizzi works fully **without** any relay in local mode.

## 2. One install, roles by configuration

| Install | Roles | Typical machine |
|---|---|---|
| Desktop app | client + node (+ hub, optional) | your laptop |
| `bizzi serve` as a launchd LaunchAgent in the GUI session | node, GUI-capable | a remote Mac used for GUI work (visual inspection, simulators, headed browsers) |
| `bizzi serve` as a launchd agent, no GUI session | node | a headless Mac |
| docker compose: `node` service | node (GUI-capable via a virtual display) | a Linux server, a GPU box |
| docker compose: `hub` + `node` services | hub + node | the always-on Linux server behind your reverse proxy |
| docker compose: `hub` only | hub | a small VPS, if the hub should live apart from any agent machine |
| Phone app / browser | client only | phone, tablet, any browser |

A remote machine never needs the desktop app. If you do open the desktop app on a machine that already runs `bizzi serve`, the app attaches to the running node as a client instead of starting a second one.

Exactly one install in your fleet has the hub role. Everything else pairs with it.

### 2.1 GUI-capable vs headless machines

"Headful" means **the node runs where a display exists**, so agents it launches can open and look at windows. It doesn't mean a full desktop install.

| | GUI-capable Mac | Linux (compose) |
|---|---|---|
| Runs as | `bizzi serve` as a launchd **LaunchAgent** with `LimitLoadToSessionType: Aqua`, i.e. inside the logged-in user's GUI session | the `node` container (§2.2) with a virtual display (Xvfb) |
| Display | the real macOS desktop | virtual X display; optional VNC server for watching |
| Agents can drive | Xcode, simulators, headed browsers, `screencapture`, any GUI app, computer-use style MCP tools | headed browsers, Linux GUI apps, screenshots |
| One-time setup | stay logged in (auto-login + screen lock); grant Screen Recording / Accessibility / Automation to the `bizzi` binary once (e.g. over Screen Sharing) | none |
| Gotcha | macOS ties privacy grants to the binary's code signature: `bizzi serve` must be **signed with a stable identity**, or grants are lost on every upgrade | `shm_size` big enough for browsers |

A Mac with nobody logged in has no GUI session, so the node falls back to headless (CLI-only) until someone logs in.

### 2.1.1 GUI work on remote machines: the agent looks, and so can you

- **The agent's eyes:** agents inspect visually through tools that run on the node, e.g. Playwright in headed mode, simulator screenshots, `screencapture`, or computer-use MCP servers. Because these tools run on the node, they work whether you're watching or not.
- **Your eyes, async:** every screenshot or recording a tool produces is attached to the session timeline as an artifact (blob store), so you can review it from the phone later.
- **Your eyes, live (later):** a "view screen" button on GUI-capable machines. M2: a deep link to macOS Screen Sharing / a VNC client. Later: VNC tunneled through the hub and shown in the UI with noVNC, which also covers the Linux virtual display.

### 2.2 Linux: docker compose

```yaml
# docker-compose.yml on server-a (hub + node). Drop the hub service on agent-only machines.
services:
  hub:
    image: bizzi/hub:latest
    restart: unless-stopped
    environment:
      BIZZI_PUBLIC_URL: https://bizzi.example.com
    volumes:
      - hub-data:/data                       # sqlite, event-log replica, blobs
    networks: [proxy, internal]              # SWAG/Caddy reaches it on `proxy`; no published ports

  node:
    image: bizzi/node:latest                 # or `build: ./node` (FROM bizzi/node + your toolchains)
    restart: unless-stopped
    init: true                               # reap agent and PTY child processes
    stop_grace_period: 2m                    # drain: finish running turns before restart
    environment:
      BIZZI_HUB_URL: ws://hub:7777/ws/node   # agent-only machines: wss://bizzi.example.com/ws/node
      BIZZI_MACHINE_NAME: server-a
      PUID: 1000                             # run as your host user, so bind-mounted files stay yours
      PGID: 1000
    volumes:
      - node-data:/data                      # node sqlite, outbox, encrypted secrets
      - node-home:/home/bizzi                # ADE installs + logins (~/.claude, ~/.codex, ...)
      - /srv/bizzi/workspaces:/workspaces    # workspaces, visible and editable on the host
    shm_size: 1gb                            # headless browsers
    networks: [internal]

volumes: { hub-data: {}, node-data: {}, node-home: {} }
networks:
  proxy: { external: true }                  # the reverse proxy's network (e.g. SWAG's)
  internal: {}
```

Design points:

- **Agents run inside the node container**, so the container is the dev environment. What it can build and run is what the image has.
- **Two persistence layers.** The image holds bizzi plus a base toolset (git, curl, ripgrep, Python, Node, build tools, Xvfb + browser dependencies). The `node-home` volume holds everything provisioned at runtime: ADE installs (self-updating ones like Claude update in place), ADE logins, `gh` auth, and toolchains installed per user with `mise`. Upgrading the image never loses logins or installs.
- **Extending the toolset:** anything that needs root (apt packages, system libraries) goes in a small local Dockerfile, `FROM bizzi/node` + `RUN apt-get install …`, referenced with `build:` in the compose file. bizzi can generate this file from a "machine needs: …" list later.
- **`PUID`/`PGID`** (the linuxserver.io convention SWAG users already know): the entrypoint runs everything as that UID, so files in `/srv/bizzi/workspaces` belong to you on the host.
- **Networking:** the node publishes no ports and only dials the hub. On the hub machine it uses the internal network; on other machines it uses the public URL through the proxy.
- **Git credentials:** no host ssh-agent inside the container. Use `gh auth login` (via the login PTY), a deploy key or token stored in `node-home`, or mount a specific key read-only.
- **Upgrades:** `docker compose pull && docker compose up -d` recreates only changed services. A node restart **drains first**: it stops accepting new turns and waits up to `stop_grace_period` for running turns. Then structured sessions reattach via native resume. PTY sessions don't survive a container restart, but their scrollback does.
- **Bare-metal install** (`bizzi serve` + systemd) stays possible but unsupported, for hosts where Docker isn't an option.
- **Container workspaces** (§7) come as a compose profile: a `dind` (Docker-in-Docker) sidecar gives the node its own Docker daemon, so it never needs the host's Docker socket, which would be root-equivalent on the host.

```yaml
  # docker compose --profile containers up -d
  dind:
    image: docker:dind
    profiles: [containers]
    privileged: true                         # dind needs it; scoped to this sidecar, not the node
    environment: { DOCKER_TLS_CERTDIR: /certs }
    volumes: [dind-certs:/certs, dind-data:/var/lib/docker]
    networks: [internal]
  # the node then gets DOCKER_HOST=tcp://dind:2376 + the client certs volume
```

## 3. Choosing where to work

The first choice in the UI is the **machine**:

```
Machines
 ├─ this laptop       online · headful · claude ✓ codex ✓ opencode ✓ agy ✗ [install]
 ├─ server-a          online · headless · always on · claude ✓ codex ⚠ login expired [log in]
 └─ mac-mini          asleep · headful
```

Then a **workspace** on that machine: pick an existing one, clone a repo, create a directory, or adopt an existing path. Then a **session** with one of the ADEs installed there.

- Machine cards show what the machine is good for: always-on (keeps going when your laptop closes), headful (GUI work), tags (gpu, docker), and ADE install/login status (with install/update/login actions, spec §7).
- **Project links** connect workspaces on different machines that hold the same thing (auto-detected from the git remote, or set by hand for directories). They power project-scope knowledge and "open acme on server-a" shortcuts; they don't move work.
- bizzi remembers your last machine per project and can suggest one ("needs a GUI → mac-mini"), but never picks silently.

## 4. Session lifetime

A session belongs to the node that started it, for its whole life.

| Event | What happens |
|---|---|
| Client disconnects (phone locks, browser closes) | nothing; the session keeps running. The client replays from its last `seq` on reconnect |
| Node loses the hub (network drop) | the session keeps running; events queue in the outbox and upload on reconnect. Remote clients see "machine offline, last seen 14:02" |
| Laptop sleeps | agent processes freeze; the session shows "paused, laptop asleep". On wake they continue. If the agent's model stream broke during sleep, the adapter reports it and offers **retry turn** (most agents retry themselves) |
| Node restarts / upgrades | structured sessions reattach via native resume (Claude `--resume`, Codex `thread/resume`, OpenCode session id). PTY sessions survive a desktop/launchd node restart under their detached supervisor, but not a Linux container restart (the node drains running turns first, §2.2) |
| Machine dies | its sessions end; their timelines remain readable from the hub replica |

Because a session never changes hands, each event log has exactly one writer: no leases, epochs or fencing.

**Messages to a sleeping/offline machine:** rejected with `machine_offline` for now. Queuing them for delivery on wake is an open question.

## 5. Disconnects, replay, offline

- **Replay:** every client keeps the last `seq` per session it watched and reconnects with `subscribe { since }`. The hub serves from its replica; events still in an offline machine's outbox show as a gap that fills in later.
- **Push:** while you're disconnected, notifications carry what needs you: approval requested, question asked, turn finished, machine went offline mid-turn.
- **Airplane mode:** the desktop app talks to its own node in-process, so everything on the laptop works: sessions, workspaces, knowledge (local replica). Other machines are greyed out. On reconnect the outbox uploads, and knowledge and config replicate.

### 5.1 What replicates

| Data | Writer | Replication | Conflicts |
|---|---|---|---|
| Session events | the owning node | outbox → hub → subscribers, by `(session, seq)` | none (single writer) |
| Machine/workspace config | that machine's node, or a client through the hub | field-level last-writer-wins with hybrid logical clocks | rare; the losing value is recorded |
| Rules & memories | any agent or client, anywhere | append-only + tombstones | union; consolidation dedupes ([knowledge.md](knowledge.md)) |
| Blobs | anyone | content-addressed, fetched lazily | none |

## 6. Later: deliberate cross-machine moves (not takeover)

Running sessions are never hijacked. If you want to carry work to another machine, it's an explicit action that creates a **new session**:

- **Fork to machine B:** bizzi pushes the workspace state (git branch, or a shadow-git snapshot for directories) to machine B's linked workspace, and starts a new session there seeded with a brief from the original's timeline (goal, plan, decisions, files touched, open questions). The original stays where it was, linked as `forked_from`.
- **Tool bridging:** a session on server-a borrows laptop-local tools while the laptop is online (the laptop's node exposes an MCP server, e.g. Playwright against your browser, tunneled through the hub).

## 7. Containers: what they would be, and whether they're worth it

**What:** a workspace kind, `container`, that lives *inside* a host machine. The host's node starts a container (Docker or Podman on Linux; Docker Desktop / OrbStack / Apple's `container` tool on macOS), puts the workspace in it (a fresh clone or a mounted directory), and runs the ADE inside it. The adapter talks to the agent through `docker exec` stdio, so the session looks exactly like any other.

```
Machine: server-a
 ├─ Workspace: ~/bizzi/acme                (kind: git, on the host)
 └─ Workspace: acme-pr-482                 (kind: container, image from .devcontainer/)
      └─ Session: codex, bypass permissions
```

**Why you'd want it:**

| Benefit | Example |
|---|---|
| Safe "YOLO" runs | let an agent run with approvals off (Claude `bypassPermissions`, Codex full-auto) where it can't touch your host files, SSH keys or other repos, and network egress can be restricted |
| Parallel work without collisions | five sessions on the same repo, each with its own checkout, ports, database and `node_modules` |
| Reproducible toolchains | the project's `devcontainer.json` defines the tools; identical on any machine |
| Disposable | review a PR or try an experiment, push the branch, throw the container away |

**What it costs:**

- **ADE credentials inside the container.** The agent needs its login in there. Options: inject a long-lived token or API key per container (scoped where possible), or mount the auth file read-only. Either way the agent's credential is inside the sandbox. Acceptable for most uses, but it's the main security trade-off.
- **No GUI.** Containers are for headless work; GUI work stays on a headful machine.
- **On macOS, containers run in a Linux VM** under the hood (Docker Desktop, OrbStack, Apple's tool). The tool manages that VM, so it doesn't conflict with "no VMs" as a bizzi feature.
- Image maintenance (a bizzi base image with the ADEs preinstalled, or project devcontainers), startup time, disk usage.
- Native agent memory inside an ephemeral container disappears with it; bizzi harvests it when the session ends.

**Lifecycle options:** *ephemeral* (created per session, destroyed after its branch is pushed) or *persistent* (kept and stopped when idle, like a named dev environment).

**Why not VMs:** stronger isolation and macOS guests (e.g. Tart), but slower to boot, heavier, and more to manage. Out of scope.

**Suggestion:** M4. Start with Docker/Podman on Linux hosts, `devcontainer.json` when the repo has one, a bizzi base image otherwise, and ephemeral lifecycle first.

## 8. Spikes

1. LaunchAgent in the Aqua session: can the node drive GUI apps and take screenshots with the privacy permissions granted once?
2. Laptop sleep mid-turn for each agent: does the agent recover by itself on wake, or does the adapter need to retry?
3. Native resume after a node restart for Claude, Codex and OpenCode.
4. Outbox + replay drill: drop the network mid-turn, reconnect, verify no gaps or duplicates on the phone.
5. Remote login flows: Claude, Codex, OpenCode and agy login from the phone against a headless Linux node (URL/code detection, localhost-callback forwarding).
