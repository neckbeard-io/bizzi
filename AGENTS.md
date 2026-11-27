# bizzi — agent & contributor guide

bizzi is a self-hosted agentic development environment that drives existing coding agents (Claude Code, Codex, OpenCode, agy) on your machines, reachable from any device. Design docs live in `docs/` — read `docs/spec.md` first, then `docs/tech-choices.md`. `docs/usage.md` covers context, per-login usage, budgets and widgets. `docs/updates.md` covers ADE updates, restarts and resume. `docs/pipelines.md` covers pipelines (stages, gates) and the watcher design. `docs/theming.md` covers themes. `docs/releasing.md` covers branches, release channels, the release workflow and the desktop self-updater. `docs/landscape.md` covers comparable projects (Rex, Herdr) and the ideas backlog taken from them; check it before designing terminal status, agent-to-agent tools or multi-machine features.

## Layout

```
packages/
  protocol/          @bizzi/protocol      wire protocol + internal adapter contract (types only + tiny helpers)
  core/              @bizzi/core          node role: sessions, event store, client-protocol server
  adapter-claude/    @bizzi/adapter-claude    Claude Agent SDK adapter
  adapter-codex/     @bizzi/adapter-codex     `codex app-server` JSON-RPC adapter
  adapter-opencode/  @bizzi/adapter-opencode  `opencode serve` adapter
  adapter-api/       @bizzi/adapter-api       plain model APIs (Anthropic, OpenAI-compatible): `api` chat agent + utility completions
  pty/               @bizzi/pty           node-pty terminal host + terminal-mode adapter (agy, shell, any TUI)
  knowledge/         @bizzi/knowledge     rules + memory store, resolver, policy, MCP server
  orchestration/     @bizzi/orchestration bizzi-agents MCP tools for agent-to-agent helpers (loopback HTTP)
  routing/           @bizzi/routing       one-pane routing: explicit tokens + option-logit classifier (route.suggest)
  containers/        @bizzi/containers    container workspaces: docker exec launcher, lifecycle, devcontainer.json (container.*)
  provision/         @bizzi/provision     ADE detection, install/login recipes
  services/          @bizzi/services      node extensions: provisioning, secrets, login, knowledge methods
  hub/               @bizzi/hub           hub role: relay, replica, routing, device pairing/auth; node→hub link
  client/            @bizzi/client        protocol client + normalized store (no UI deps)
  ui/                @bizzi/ui            React app shared by every client
apps/
  cli/               @bizzi/cli           `bizzi serve [--connect]`, `bizzi hub serve`, `bizzi pair`, `bizzi status`
  desktop/           @bizzi/desktop       Electron shell
  mobile/            @bizzi/mobile        Capacitor shell (phones, client only)
deploy/                                   Dockerfiles, docker-compose.yml, proxy examples
scripts/                                  dev-desktop, smoke tests (smoke:hub, smoke:v12, smoke:live), gen-schema, release/ (version, notes, desktop builds)
```

## Conventions (Node packages)

- **Node ≥ 26, ESM only, TypeScript run directly by Node** (type stripping). No build step for Node packages.
  - Only erasable TS syntax: no `enum`, no `namespace`, no constructor parameter properties, no decorators. `tsconfig.base.json` enforces `erasableSyntaxOnly`.
  - Relative imports use the `.ts` extension: `import { x } from './x.ts'`.
  - Type-only imports use `import type`.
- Each package's `package.json` has `"type": "module"`, `"exports"` pointing at `./src/index.ts`, and scripts `typecheck` (`tsc -p .`) and `test` (`node --test`).
- Tests: built-in `node:test` + `node:assert/strict`, files in `test/*.test.ts`. Tests must pass offline without agent logins; live tests against real agents are gated behind `BIZZI_LIVE=1`.
- Storage: `node:sqlite` (`DatabaseSync`).
- Keep dependencies few and mainstream. Never vendor secrets; never write outside the repo or the data dir you're given.
- Errors crossing the protocol use `BizziError` from `@bizzi/protocol` with an `ErrorCode`.
- Logging: the `Logger` interface from `@bizzi/protocol` (structured, level + message + fields); no bare `console.log` in library code.

## Contracts

- **Wire protocol:** `packages/protocol/src/{envelope,methods,events,model,capabilities}.ts`. Changing it affects every package; keep changes additive. After a change run `npm run schema` and commit `docs/protocol.schema.json` (the published JSON Schema; `npm run check` fails when it is stale).
- **Adapter contract:** `packages/protocol/src/adapter.ts`. The core owns `seq`/`ts` and turn bookkeeping; adapters only emit `SessionEventBody` values.
- **Hub contract:** `packages/protocol/src/hub.ts` (HTTP pairing/auth, node link). The node link reuses the client protocol with roles flipped: the node dials out, the hub acts as a client.
- **Node extensions:** `NodeExtension` in `@bizzi/core` lets packages such as `@bizzi/services` own groups of methods (`agent.*`, `knowledge.*`).
- **CLI ↔ desktop contract:** `bizzi serve` prints exactly one JSON line `{"event":"ready",...}` to stdout when listening (see `ServeReady` in `packages/protocol/src/model.ts`).

## Tooling notes

- Don't drive the Playwright MCP tools in this environment (extension mode blocks). For UI screenshots use the desktop smoke mode: `BIZZI_UI_URL=… BIZZI_SMOKE_MS=8000 npm run dev -w @bizzi/desktop` writes `<data dir>/smoke.png`.
- Fresh clone: `npm run setup` (strict install + fetches the Electron binary, which Electron 45 otherwise downloads on first use). `npm run check` = typecheck + schema check + tests + UI build. `npm run smoke:hub` and `npm run smoke:v12` run a real hub and node offline (fake adapters) in a few seconds. Install scripts are allow-listed in the root `package.json` (`allowScripts`); CI fails on unreviewed ones. See CONTRIBUTING.md.

## Branches and releases

- **Branch from `dev` and open the PR against `dev`.** `dev` reaches `main` through a promotion PR; never merge feature branches into `main`.
- **Never push to `dev` or `main` directly.** A push to `dev` publishes a `vX.Y.Z-dev.N` pre-release that every Dev-channel install offers to update to, and CI runs on the PR, not on `dev`.
- **A merge into `main` publishes the stable `vX.Y.Z`** from the closed `## vX.Y.Z — <date>` section of `CHANGELOG.md`; the release fails without it. Docs-only changes publish nothing.
- **Never bump `version` in a `package.json`.** Builds stamp the version in.
- **Release asset names are a contract with installed copies** (`assetSuffix` in `apps/desktop/src/update/github.ts`). Don't rename them casually.

Channels, promotion, manual runs, local builds, the updater and signing: [docs/releasing.md](docs/releasing.md).

## Changelog

Every user-visible change adds a line under `## Unreleased` in `CHANGELOG.md`, under `### Added`, `### Changed`, `### Fixed` or `### Removed`, in the same PR as the change. Dev release notes are exactly those lines, so write them for someone using bizzi: what they can now do or what stopped going wrong, one line each, no internals. Refactors, tests, CI and docs get no line.

## Commits

Conventional Commits for commit messages and PR titles (`feat(ui): …`, `fix(core): …`, `docs: …`, `chore: …`): imperative, lowercase subject. Commit with the identity configured in the clone and never override it. No AI/tool attribution lines or trailers.
