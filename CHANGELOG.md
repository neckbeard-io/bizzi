# Changelog

What changed in each release, written for someone using bizzi rather than reading the diff.
Entries are added with the change, not reconstructed at release time; the rules are in
[AGENTS.md](AGENTS.md#changelog), and how releases are cut is in [docs/releasing.md](docs/releasing.md).

## Unreleased

### Added
- Paste, drop or attach images in the message box; large images are scaled down before sending, and sent images show in the conversation.
- Slash commands in the message box: type `/` for a list with the agent's own commands (Claude's `/compact`, `/review`, …) and bizzi's `/clear`.
- `/clear` (also `/new`, `/reset`) starts a fresh conversation in the same session with any agent, so the agent forgets everything so far while the session's history stays visible.
- Long pasted text collapses into a `[Pasted text 1 · 40 lines]` placeholder you can expand or remove before sending, and shows collapsed in the conversation.
- agy's plan usage in the bottom bar and usage panel: the 5-hour and weekly limits for its Gemini pool and its Claude and GPT pool, checked without spending any quota.
- Sessions you don't name get a title from your first message instead of staying "Untitled session". Choose a title model (`utilityModel` in `api-providers.json`, or `BIZZI_AUTO_TITLE_MODEL`) to have it summarize the task in a few words instead. Your own names, and titles the agent picks, always win.

### Changed
- The bottom bar's usage meters stack the 5-hour limit over the weekly limit as two bars, always in that order, instead of one bar that switched to whichever window was fuller.
- Quitting, updating or reinstalling the desktop app no longer stops running sessions: the core keeps running and the relaunched app reconnects to it. The core restarts only when an update actually changes it. To stop everything, use **Quit and Stop Sessions** in the menu bar.
- Sessions only end when you close them. If an agent exits or crashes, the session stays open and your next message picks the conversation back up. A terminal session restarts its process when you press a key.
- A helper keeps running when its parent's agent crashes; helpers stop only when their parent is closed.
- When bizzi has to restart while an agent is mid-turn, the agent picks its work back up on its own once bizzi is back, instead of waiting for your next message. After three crashes in a row with no message from you it waits for you instead; a run of ordinary restarts (updates, local installs) gets ten.

### Fixed
- The desktop window reopens where you left it, at the same size and position (and maximized or full screen if it was), instead of resetting on every restart or update.
- Quitting, restarting or updating bizzi no longer ends your Claude and Codex sessions. Sessions that an earlier version ended this way reopen the next time bizzi starts.
- Text you've typed but not sent stays in the composer, per session, when bizzi reloads, restarts or updates.
- Rules and memories an agent saved because you asked no longer look like they wait for approval: the inbox lists them under "Recent knowledge changes" as already live, with Dismiss and Undo, and the Knowledge badge counts only real suggestions.
- Editing a rule more than once leaves one entry in the inbox for its newest version instead of one per version.
- A session you renamed keeps its name after bizzi restarts, instead of taking the agent's title again.
- A Claude session you opened but never sent a message to works after bizzi restarts, instead of failing with "No conversation found with session ID".
- Restarting the desktop app onto a new core is quick and lands back on your sessions: the window opens right away and shows "Starting bizzi…" while the old core hands over, instead of showing the connect screen and a second broken window for up to 30 seconds. Turns the old core was running continue on the new one.

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
