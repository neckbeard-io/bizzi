# Changelog

What changed in each release, written for someone using bizzi rather than reading the diff.
Entries are added with the change, not reconstructed at release time; the rules are in
[AGENTS.md](AGENTS.md#changelog), and how releases are cut is in [docs/releasing.md](docs/releasing.md).

## Unreleased

### Added
- agy's plan usage in the bottom bar and usage panel: the 5-hour and weekly limits for its Gemini pool and its Claude and GPT pool, checked without spending any quota.

### Changed
- The bottom bar's usage meters stack the 5-hour limit over the weekly limit as two bars, always in that order, instead of one bar that switched to whichever window was fuller.

### Fixed
- Rules and memories an agent saved because you asked no longer look like they wait for approval: the inbox lists them under "Recent knowledge changes" as already live, with Dismiss and Undo, and the Knowledge badge counts only real suggestions.
- Editing a rule more than once leaves one entry in the inbox for its newest version instead of one per version.

## v0.1.1 — 2026-11-26

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
