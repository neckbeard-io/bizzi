# bizzi

A self-hosted agentic development environment. bizzi drives the coding agents you already use
(Claude Code, Codex, OpenCode, Antigravity `agy`) and plain model APIs on your own machines, and
lets you reach every session from any device: the desktop app, a browser, or your phone.

- **Machine first.** Pick a machine (this laptop, a Mac mini, a Linux box), then a workspace on it,
  then start a session with any agent.
- **Any agent, natively.** Each agent's richest interface (Claude Agent SDK, `codex app-server`,
  `opencode serve`) with a real terminal as the fallback for everything else.
- **Your own relay.** Machines dial out to a hub you host; devices pair with it. No vendor relay.
- **Shared knowledge.** Rules and memories written once and visible to every agent.

Status: early and moving fast. Expect rough edges.

## Install

### macOS and Linux: one-line installer (recommended)

```sh
curl -fsSL https://raw.githubusercontent.com/neckbeard-io/bizzi/main/scripts/install.sh | bash
```

It installs the latest stable release as a standalone app that updates itself, checks the download
against the release's checksums, and on macOS takes care of Gatekeeper, so bizzi opens on the first
double-click.

- **macOS:** `bizzi.app` in `/Applications` (or `~/Applications`), Apple Silicon or Intel.
- **Linux:** the AppImage in `~/.local/share/bizzi`, a `bizzi` command in `~/.local/bin`, and a
  launcher entry. AppImages need FUSE 2 (`libfuse2`); the installer tells you if it's missing.

Options go after `bash -s --`:

```sh
curl -fsSL https://raw.githubusercontent.com/neckbeard-io/bizzi/main/scripts/install.sh | bash -s -- --dev            # newest dev build
curl -fsSL https://raw.githubusercontent.com/neckbeard-io/bizzi/main/scripts/install.sh | bash -s -- --version 0.1.0  # a specific release
curl -fsSL https://raw.githubusercontent.com/neckbeard-io/bizzi/main/scripts/install.sh | bash -s -- --uninstall      # remove it (keeps ~/.bizzi)
```

The app checks GitHub Releases every few hours and restarts into new versions; Settings › Updates
picks the **Stable** or **Dev** channel (a dev build starts on Dev).

### Other downloads

Every build is on the [releases page](https://github.com/neckbeard-io/bizzi/releases). Stable
releases are `vX.Y.Z`; `vX.Y.Z-dev.N` pre-releases come from the `dev` branch.

| Platform | File |
|---|---|
| macOS (Apple Silicon / Intel) | `bizzi-<version>-macos-<arm64\|x64>.dmg` |
| Linux | `bizzi-<version>-linux-<arch>.AppImage` or `.deb` (`x86_64`/`amd64`, `arm64`) |
| Windows | `bizzi-<version>-windows-x64-setup.exe` (experimental) |
| Remote machines (Docker) | `ghcr.io/neckbeard-io/bizzi-node`, `ghcr.io/neckbeard-io/bizzi-hub` |

These builds aren't signed with a paid certificate, so a manual install meets each OS's warning:

- **macOS `.dmg`:** after dragging bizzi to Applications, run
  `xattr -dr com.apple.quarantine /Applications/bizzi.app` once, or macOS reports it as damaged.
- **Windows:** SmartScreen warns; choose *More info* → *Run anyway*.
- **Linux `.deb`:** `sudo apt install ./bizzi-….deb`. It updates by opening the new package in your
  software installer, so the AppImage (what the installer uses) is the smoother route.

### Remote machines and the hub

A headless Linux machine runs bizzi as a docker compose stack (a `hub` and a `node`). See
[deploy/README.md](deploy/README.md).

## Develop

You need Node 26 (`.nvmrc`) and npm 11.

```sh
npm run setup         # npm ci + the Electron binary
npm run check         # typecheck, schema check, tests, UI build
npm run dev:desktop   # the desktop app against a local core
npm run dev:ui        # the UI alone, with a mock server
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers the workflow, and [AGENTS.md](AGENTS.md) the layout and
conventions. The design is in [docs/](docs/): start with [docs/spec.md](docs/spec.md). Releases are
described in [docs/releasing.md](docs/releasing.md), and what changed in each one in
[CHANGELOG.md](CHANGELOG.md).

## License

[Apache License 2.0](LICENSE). Third-party material bizzi includes is listed in [NOTICE](NOTICE).
