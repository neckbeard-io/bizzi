# bizzi on Linux: docker compose

Layout from [topology.md §2.2](../docs/topology.md) and [tech-choices D8/D11](../docs/tech-choices.md).

| File | What |
|---|---|
| `Dockerfile.node` | Debian slim (trixie) + Node 26 + the core + base toolset: git, curl, ca-certificates, python3, build-essential, ripgrep, Xvfb, tini, gosu |
| `Dockerfile.hub` | `FROM` the node image, runs `bizzi hub serve`, and serves the built web UI at `/` |
| `docker/entrypoint.sh` | PUID/PGID handling, chown of `/data` + `/home/bizzi`, Xvfb on `:99` (node only), then `gosu bizzi …` |
| `Dockerfile.*.dockerignore` | per-Dockerfile ignore files (BuildKit); the build context is the repo root |
| `docker-compose.yml` | `hub`, `node`, and `dind` (profile `containers`) |
| `.env.example` | settings; copy to `.env` |
| `Caddyfile.example`, `swag/bizzi.subdomain.conf.example` | reverse proxy: WebSocket upgrade, long timeouts, machine/device endpoints outside forward-auth |

## Run

```sh
cd deploy
cp .env.example .env            # set BIZZI_PUBLIC_URL, PUID/PGID (id -u / id -g), paths
docker network create proxy     # skip if your proxy's network exists (set BIZZI_PROXY_NETWORK)
mkdir -p /srv/bizzi/workspaces  # create it yourself, otherwise Docker creates it as root
docker compose up -d --build
```

**Prebuilt images.** Releases publish `ghcr.io/neckbeard-io/bizzi-hub` and `ghcr.io/neckbeard-io/bizzi-node`
(amd64 and arm64; tags `latest`, `dev` and each version). To use them instead of building, set
`BIZZI_HUB_IMAGE`, `BIZZI_NODE_IMAGE` and `BIZZI_TAG` in `.env` (see `.env.example`), then
`docker compose pull && docker compose up -d --no-build`. Updating is the same two commands.

Point your reverse proxy at `hub:7777` (see [Reverse proxy](#reverse-proxy)) so that
`BIZZI_PUBLIC_URL` (e.g. `https://bizzi.example.com`) reaches the hub.

## First run: pair your browser, then the node

Nothing is paired after the first `up`. The hub accepts only paired devices, and the node needs a
one-time code before it can link to the hub.

1. **Read the setup code** from the hub's log (it is printed on every start until the first device
   pairs, and also written to `/data/setup-code`):

   ```sh
   docker compose logs hub | grep -i 'setup code'
   # or: docker compose exec hub cat /data/setup-code
   ```

2. **Pair your phone or browser** with it: open `BIZZI_PUBLIC_URL`, choose *Pair this device*, and
   enter the code (format `ABCD-EFGH`; case, dashes and spaces don't matter). This first device
   becomes the **owner**. The setup code works once.

3. **Create a node pairing code**, either in the UI (*Devices → Pair a machine*, which calls
   `pairing.create { kind: 'node' }`) or on the hub host:

   ```sh
   docker compose exec -u bizzi hub node apps/cli/src/main.ts hub code --kind node
   ```

   UI codes are valid for 10 minutes and CLI codes for 60 (`--ttl <minutes>`). Each works once.

4. **Give the code to the node** and recreate it:

   ```sh
   echo 'BIZZI_PAIR_CODE=WXYZ-2345' >> .env     # or edit the existing BIZZI_PAIR_CODE= line
   docker compose up -d node
   docker compose logs -f node                  # look for "paired with hub", then "hub link connected"
   ```

   On start the node pairs with that code, saves its key to `/data/hub-credential.json` (mode 0600,
   on the `node-data` volume), and dials `ws://hub:7777/ws/node`. From then on it reconnects by
   itself and ignores `BIZZI_PAIR_CODE`, so you can delete the line.

5. The machine now shows up as online in the UI. To pair more phones or browsers, create a
   `device` code from a paired device (*Devices → Pair a device*) and enter it on the new device.

To re-pair a node (e.g. after losing `node-data`), create a new node code and repeat step 4. The
hub revokes the node's previous key automatically. To revoke a device, use *Devices* in the UI
(`device.revoke`). Its open connections are closed immediately.

## More machines

- **Agent-only Linux machine:** use the same compose file without the `hub` service. Set
  `BIZZI_HUB_URL=wss://bizzi.example.com/ws/node` and `BIZZI_PAIR_CODE=<node code>` in `.env`, then
  `docker compose up -d node`.
- **A Mac or any non-container install:** `bizzi pair https://bizzi.example.com <node code>` once,
  then `bizzi serve` (it connects with the saved credential), or `bizzi serve --connect <url>`.
- **Container workspaces** ([topology.md](../docs/topology.md) §7): set `BIZZI_DOCKER_HOST=tcp://dind:2376`
  in `.env`, then `docker compose --profile containers up -d`. The `dind` sidecar is the node's own
  Docker daemon (TLS, client certs on the `dind-certs` volume); the node never gets the host's Docker
  socket, and agents never see any daemon. dind mounts the workspaces directory at the same
  `/workspaces` path as the node, so a workspace is bind-mounted into its container by that path.
  `container.create { path, image?, network?, lifecycle?, idleMinutes? }` makes a workspace of kind
  `container`; its first session builds `bizzi/workspace:latest` (`packages/containers/image`, Claude Code
  + Codex) into dind unless the repo has a `devcontainer.json` or you gave an image. Agent logins: put a
  long-lived token in the agent's secrets (`agent.setSecret`, e.g. `CLAUDE_CODE_OAUTH_TOKEN` from
  `claude setup-token`, or `OPENAI_API_KEY`) or in the node's environment; they are passed per `docker
  exec`, never stored in the container. If the node can't read `/certs/client/key.pem`, make it readable
  for `PUID` (dind creates it as root).
- **Upgrades:** `docker compose pull && docker compose up -d` (or `--build`). On SIGTERM the node
  drains for up to `stop_grace_period` (2 min). Events produced while the hub is down or restarting
  stay in the node's log and are uploaded when the link comes back, with no gaps or duplicates.
- **More tools:** write a small Dockerfile `FROM bizzi/node` + `RUN apt-get install …` and point
  `node.build` at it. Per-user installs (ADEs, `mise` toolchains, logins) go on the `node-home` volume
  and survive image upgrades.

## The hub container

- Runs `node apps/cli/src/main.ts hub serve --host 0.0.0.0 --port 7777 --data-dir /data` as user
  `bizzi`, with `BIZZI_PUBLIC_URL` from `.env`. It serves:
  - `POST /api/pair`, `POST /api/auth/challenge`, `POST /api/auth/token`: pairing and tokens
  - `/ws`: the client protocol for paired devices
  - `/ws/node`: node links
  - `GET /healthz`
  - the web UI at `/` (built into the image from `packages/ui`)
- `/data` (`hub-data` volume) holds `hub.db`: devices, hashed pairing codes and tokens, machines, the
  replica of every node's session events (so the phone can read history while a laptop sleeps), and
  the hub's merged global log.
- **Push (optional):** set `BIZZI_NTFY_URL` (e.g. `https://ntfy.sh/<secret-topic>`, or your own ntfy
  server, plus `BIZZI_NTFY_TOKEN`). The hub notifies about approval requests, agent questions, and
  turns that ran longer than 20 s. Bursts are debounced per session, and tapping a notification opens
  `BIZZI_PUBLIC_URL/#/s/<session>`.
- **Web Push (on by default):** browsers turn it on per device under Settings → Devices →
  Notifications. The hub keeps its VAPID key in `/data/vapid.json`; set `BIZZI_VAPID_SUBJECT`
  (`mailto:you@example.com`) for Safari, or `BIZZI_WEBPUSH=0` to turn it off.
- No published ports. It sits on the `proxy` network (for the reverse proxy) and on `internal` (for the
  node). For a quick try without a proxy, uncomment `ports: ["7777:7777"]` and use
  `http://<host>:7777`.
- Healthcheck: `curl http://127.0.0.1:7777/healthz`.

## The node container

- Runs `node apps/cli/src/main.ts serve --host 0.0.0.0 --port 7777 --data-dir /data --name $BIZZI_MACHINE_NAME --connect $BIZZI_HUB_URL`
  as user `bizzi` (uid/gid = `PUID`/`PGID`).
- Volumes: `/data` (node sqlite, whose event log doubles as the outbox, and `hub-credential.json`),
  `/home/bizzi` (ADE installs + logins), and `/workspaces` (bind mount from the host).
- No published ports. It is only on the `internal` network and dials the hub. Its own `/ws` endpoint
  takes `BIZZI_TOKEN` if you set one, and a random token otherwise. Clients normally go through the hub.
- `init: true` plus `tini` reap agent and PTY children (`TINI_SUBREAPER` is set because tini isn't
  PID 1 under `init: true`). `shm_size: 1gb` is for headless browsers.
- `DISPLAY=:99` (Xvfb) is started by the entrypoint. Disable it with `BIZZI_XVFB=0`. Browser
  libraries aren't in the base image yet. Install them per project (e.g. `npx playwright install --with-deps`
  in an extending Dockerfile).
- Healthcheck: `curl http://127.0.0.1:7777/healthz`.

Build only the images:

```sh
docker build -f deploy/Dockerfile.node -t bizzi/node:latest .          # from the repo root
docker build -f deploy/Dockerfile.hub  -t bizzi/hub:latest  .          # uses bizzi/node:latest
```

`npm ci --omit=dev --workspace @bizzi/cli` installs only the CLI's production dependency tree (which
includes `@bizzi/hub`), and native addons compile in the image against Node 26. The node image is about
1.2 GB, almost all of it the base toolset (build-essential, python3, Xvfb). If the UI build stage fails,
the hub image is still built and serves the API only.

## Reverse proxy

The hub must be reachable from the proxy as `hub:7777` (shared `proxy` network). The web UI can sit
behind forward-auth once an IdP is chosen. **Machine and device endpoints must not** (`/api/*`, `/ws`,
`/ws/node`), because the hub authenticates those requests itself with per-device keys and short-lived
tokens (D8), and nodes and phone apps can't follow an SSO redirect.

- **Caddy** (`Caddyfile.example`): WebSockets work out of the box, with no read timeout on upgraded
  connections.
- **SWAG** (`swag/bizzi.subdomain.conf.example`): goes in `/config/nginx/proxy-confs/`. It writes
  out the upgrade headers and sets `proxy_read_timeout 1h` explicitly instead of including
  `proxy.conf`, which already sets a 240 s timeout (nginx rejects duplicate directives). The hub pings
  every WebSocket every 30 s.
