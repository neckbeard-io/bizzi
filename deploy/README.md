# bizzi on Linux: docker compose

Layout from [topology.md §2.2](../docs/topology.md) and [tech-choices D8/D11](../docs/tech-choices.md).

> **The hub is a placeholder.** The hub role (registry, relay, auth, event-log replica, push) is
> not implemented yet. `Dockerfile.hub` builds on the node image and only logs "not implemented",
> then idles, reporting *unhealthy*. The `node` service is real, and so is the compose/proxy
> layout around it.

| File | What |
|---|---|
| `Dockerfile.node` | Debian slim (trixie) + Node 26 + the core + base toolset: git, curl, ca-certificates, python3, build-essential, ripgrep, Xvfb, tini, gosu |
| `Dockerfile.hub` | **placeholder**, `FROM` the node image (the hub will be the same program run as `serve --hub`) |
| `docker/entrypoint.sh` | PUID/PGID handling, chown of `/data` + `/home/bizzi`, Xvfb on `:99`, then `gosu bizzi …` |
| `Dockerfile.*.dockerignore` | per-Dockerfile ignore files (BuildKit); the build context is the repo root |
| `docker-compose.yml` | `hub`, `node`, and `dind` (profile `containers`) |
| `.env.example` | settings; copy to `.env` |
| `Caddyfile.example`, `swag/bizzi.subdomain.conf.example` | reverse proxy: WebSocket upgrade, long timeouts, machine endpoints outside forward-auth |

## Run

```sh
cd deploy
cp .env.example .env            # set BIZZI_TOKEN (openssl rand -hex 32), PUID/PGID (id -u / id -g), paths
docker network create proxy     # skip if your proxy's network exists (set BIZZI_PROXY_NETWORK)
mkdir -p /srv/bizzi/workspaces  # create it yourself, otherwise Docker creates it as root
docker compose up -d --build
docker compose logs -f node
```

- **Agent-only machine:** delete the `hub` service and set `BIZZI_HUB_URL=wss://bizzi.example.com/ws/node`.
- **Container workspaces:** `docker compose --profile containers up -d` starts a `dind` sidecar.
  Uncomment the `DOCKER_*` variables and the `dind-certs` mount in the `node` service. The node
  never gets the host's Docker socket.
- **Upgrades:** `docker compose pull && docker compose up -d` (or `--build`). On SIGTERM the node
  drains for up to `stop_grace_period` (2 min).
- **More tools:** write a small Dockerfile `FROM bizzi/node` + `RUN apt-get install …` and point
  `node.build` at it. Per-user installs (ADEs, `mise` toolchains, logins) go on the `node-home` volume
  and survive image upgrades.

## The node container

- Runs `node apps/cli/src/main.ts serve --host 0.0.0.0 --port 7777 --data-dir /data` as user
  `bizzi` (uid/gid = `PUID`/`PGID`). `BIZZI_TOKEN` is passed through from the environment. The
  entrypoint warns if it is missing, and compose refuses to start without it.
- Volumes: `/data` (node sqlite, outbox, secrets), `/home/bizzi` (ADE installs + logins), and
  `/workspaces` (bind mount from the host).
- No published ports. It is only on the `internal` network and dials the hub.
- `init: true` plus `tini` reap agent and PTY children (`TINI_SUBREAPER` is set because tini isn't
  PID 1 under `init: true`). `shm_size: 1gb` is for headless browsers.
- `DISPLAY=:99` (Xvfb) is started by the entrypoint. Disable it with `BIZZI_XVFB=0`. Browser
  libraries aren't in the base image yet. Install them per project (e.g. `npx playwright install --with-deps`
  in an extending Dockerfile).
- Healthcheck: `curl http://127.0.0.1:7777/healthz`.

Build only the image:

```sh
docker build -f deploy/Dockerfile.node -t bizzi/node:latest .          # from the repo root
docker build -f deploy/Dockerfile.hub  -t bizzi/hub:latest  .          # uses bizzi/node:latest
```

`npm ci --omit=dev --workspace @bizzi/cli` installs only the CLI's production dependency tree, and
native addons compile in the image against Node 26. The image is about 1.2 GB, almost all of it
the base toolset (build-essential, python3, Xvfb). The core itself is small.

## Reverse proxy

The hub must be reachable from the proxy as `hub:7777` (shared `proxy` network). Interactive routes
can sit behind forward-auth once an IdP is chosen. **Machine and device endpoints must not**
(`/api/device/*`, `/ws/device`, `/ws/node`), because the hub authenticates those requests itself (D8).

- **Caddy** (`Caddyfile.example`): WebSockets work out of the box, with no read timeout on upgraded
  connections.
- **SWAG** (`swag/bizzi.subdomain.conf.example`): goes in `/config/nginx/proxy-confs/`. It writes
  out the upgrade headers and sets `proxy_read_timeout 1h` explicitly instead of including
  `proxy.conf`, which already sets a 240 s timeout (nginx rejects duplicate directives).
