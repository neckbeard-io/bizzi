# Changelog

What changed in each release, written for someone using bizzi rather than reading the diff.
Entries are added with the change, not reconstructed at release time; the rules are in
[AGENTS.md](AGENTS.md#changelog), and how releases are cut is in [docs/releasing.md](docs/releasing.md).

## Unreleased

### Added
- One-line installer for macOS and Linux: `curl -fsSL https://raw.githubusercontent.com/neckbeard-io/bizzi/main/scripts/install.sh | bash`, the recommended way to install.

## v0.1.0 — 2026-11-26

### Added
- Desktop builds for macOS (Apple Silicon and Intel), Linux (AppImage and .deb, x86_64 and arm64) and Windows (experimental), published on the releases page.
- The desktop app updates itself: Settings › Updates picks the Stable or Dev channel, checks GitHub every few hours, and restarts into the new version.
- Docker images for remote machines: `ghcr.io/neckbeard-io/bizzi-node` and `ghcr.io/neckbeard-io/bizzi-hub`.
- Right-click menus for machines, workspaces and sessions.
- Rename a session; your name sticks even when the agent retitles it.
- Remove a workspace from bizzi (worktrees are deleted with it).

### Fixed
- Updating no longer leaves the downloaded installer (about 160 MB) behind in the temp folder.
- The sidebar header shows the whole connection status ("connected") instead of cutting it off.
