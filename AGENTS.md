# bizzi — agent & contributor guide

bizzi is a self-hosted agentic development environment that drives existing coding agents (Claude Code, Codex, OpenCode, agy) on your machines, reachable from any device. Design docs live in `docs/` — read `docs/spec.md` first, then `docs/tech-choices.md`.

## Layout

```
packages/
  protocol/          @bizzi/protocol      wire protocol + internal adapter contract (types only + tiny helpers)
  core/              @bizzi/core          node role: sessions, event store, client-protocol server
  adapter-claude/    @bizzi/adapter-claude    Claude Agent SDK adapter
  adapter-codex/     @bizzi/adapter-codex     `codex app-server` JSON-RPC adapter
  adapter-opencode/  @bizzi/adapter-opencode  `opencode serve` adapter
  pty/               @bizzi/pty           node-pty terminal host + terminal-mode adapter (agy, shell, any TUI)
  knowledge/         @bizzi/knowledge     rules + memory store, resolver, policy, MCP server
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

- **Wire protocol:** `packages/protocol/src/{envelope,methods,events,model,capabilities}.ts`. Changing it affects every package; keep changes additive.
- **Adapter contract:** `packages/protocol/src/adapter.ts`. The core owns `seq`/`ts` and turn bookkeeping; adapters only emit `SessionEventBody` values.
- **Hub contract:** `packages/protocol/src/hub.ts` (HTTP pairing/auth, node link). The node link reuses the client protocol with roles flipped: the node dials out, the hub acts as a client.
- **Node extensions:** `NodeExtension` in `@bizzi/core` lets packages such as `@bizzi/services` own groups of methods (`agent.*`, `knowledge.*`).
- **CLI ↔ desktop contract:** `bizzi serve` prints exactly one JSON line `{"event":"ready",...}` to stdout when listening (see `ServeReady` in `packages/protocol/src/model.ts`).

## Tooling notes

- Don't drive the Playwright MCP tools in this environment (extension mode blocks). For UI screenshots use the desktop smoke mode: `BIZZI_UI_URL=… BIZZI_SMOKE_MS=8000 npm run dev -w @bizzi/desktop` writes `<data dir>/smoke.png`.
- npm 11 blocks install scripts; fetch the Electron binary with `node node_modules/electron/install.js`.

## Commits

Plain, descriptive commit messages. No AI/tool attribution lines or trailers.
