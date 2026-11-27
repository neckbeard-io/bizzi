# Changelog

What changed in each release, written for someone using bizzi rather than reading the diff.
Entries are added with the change, not reconstructed at release time; the rules are in
[AGENTS.md](AGENTS.md#changelog), and how releases are cut is in [docs/releasing.md](docs/releasing.md).

## Unreleased

### Added
- Sessions whose agent is waiting on work it left running in the background, such as a command it's watching or a subagent, now show as still active in the sidebar: the mark bobs up and down, and the row names what's running.
- Choose the interface font and the code font (code blocks, diffs and terminals) in Settings › Appearance; the choice applies on every device. The code font is now JetBrains Mono by default, included with bizzi so it works everywhere without installing it.
- Paste, drop or attach images in the message box; large images are scaled down before sending, and sent images show in the conversation.
- Slash commands in the message box: type `/` for a list with the agent's own commands (Claude's `/compact`, `/review`, …) and bizzi's `/clear`.
- `/clear` (also `/new`, `/reset`) starts a fresh conversation in the same session with any agent, so the agent forgets everything so far while the session's history stays visible.
- Long pasted text collapses into a `[Pasted text 1 · 40 lines]` placeholder you can expand or remove before sending, and shows collapsed in the conversation.
- Hotkeys: ⌘N (Ctrl+N on Windows and Linux) adds a workspace on the machine you're on, and ⌘T (Ctrl+T) starts a session with the default profile in the open workspace. Switch each one on or off in Settings › Hotkeys.
- ⌘W (Ctrl+W on Windows and Linux) deletes the open session after asking; on other pages of the desktop app it closes the window, and Close Window moved to ⌘⇧W / Ctrl+Shift+W.
- agy's plan usage in the bottom bar and usage panel: the 5-hour and weekly limits for its Gemini pool and its Claude and GPT pool, checked without spending any quota.
- Your prompt stays pinned at the top of the conversation once it scrolls out of view, so you can see what the agent is working on while it runs. Click it to read the whole prompt, or use the arrow to jump back to it.
- Agents can list the rules and memories that apply to them with their ids, read one in full with its history, see the suggestions they made that are still waiting for your review (and amend or withdraw their own), and propose moving a workspace or project item to a wider scope. Approving suggestions stays with you.
- Sessions you don't name get a short title from the gist of your first message ("I'd like shorter titles for sessions instead of…" becomes "shorter titles for sessions") instead of staying "Untitled session". This includes sessions started from the one-pane composer, which used to take the whole first line. Choose a title model (`utilityModel` in `api-providers.json`, or `BIZZI_AUTO_TITLE_MODEL`) to have it summarize the task in a few words instead. Your own names, and titles the agent picks, always win.

### Changed
- Sessions you didn't name keep up with the conversation: after `/clear`, your next message renames the session, and with a title model the title is refreshed now and then from your original request plus your latest messages.
- The sidebar is a file tree: each workspace lists its open sessions (and then its worktrees) with guide lines, and each session shows its state, name and how full its context window is. Fold a workspace to get the old one-line summary back.
- In the desktop app's File menu, ⌘N / Ctrl+N is now New Workspace and New Prompt moved to ⌘⇧N / Ctrl+Shift+N.
- A session's delete button is red, and the separate End button is gone from its header; End session is still in the session's ⋯ menu.
- The bottom bar's usage meters stack the 5-hour limit over the weekly limit as two bars, always in that order, instead of one bar that switched to whichever window was fuller.
- Quitting, updating or reinstalling the desktop app no longer stops running sessions: the core keeps running and the relaunched app reconnects to it. The core restarts only when an update actually changes it. To stop everything, use **Quit and Stop Sessions** in the menu bar.
- Sessions only end when you close them. If an agent exits or crashes, the session stays open and your next message picks the conversation back up. A terminal session restarts its process when you press a key.
- A helper keeps running when its parent's agent crashes; helpers stop only when their parent is closed.
- The desktop app opens on a plain logo while bizzi starts, instead of a status line and a "Connect to something else" link; the link to connect elsewhere only shows if starting takes longer than 10 seconds.
- When bizzi has to restart while an agent is mid-turn, the agent picks its work back up on its own once bizzi is back, instead of waiting for your next message. After three crashes in a row with no message from you it waits for you instead; a run of ordinary restarts (updates, local installs) gets ten.

### Fixed
- bizzi no longer picks up an agent CLI that a project installs as a dev dependency (a `node_modules/.bin/codex`, for example) in place of the one you installed. Starting bizzi from an `npm` script used to trigger this, and it led to spurious "codex 0.167.0 → 0.172.0 installed" notices and needless session restarts. Switching to a different copy of an agent now says which binary it runs instead of calling it an upgrade.
- Finished install and update notices on a machine's agent cards (such as "codex 0.166.0 → 0.172.0 installed") no longer come back every time bizzi restarts or the window reloads. Once dismissed, they stay gone.
- After an update or a restart that replaces the core, the desktop app reopens the page you were on and shows your sessions right away, instead of starting over on the machine page.
- When Claude picks its work back up on its own after a background task finishes, the session shows as working and can be stopped, and the timeline marks it "continued on its own". Before, that work ran unseen, and a restart during it left its last command spinning forever.
- A command still spinning after a restart, from work that ended without being recorded, now shows as cancelled.
- The prompt pinned above the timeline is always one you wrote: bizzi's "[bizzi] bizzi restarted…" note and turns Claude started on its own no longer replace it.
- Sessions are no longer named "[bizzi] bizzi restarted while you were…": bizzi's own continue message never names a session, and sessions it already renamed, or that were left "Untitled session", take their name from your first message again.
- A Claude session's context bar now keeps up during a long turn, updating after each response and tool result instead of only when the turn ends.
- The desktop window reopens where you left it, at the same size and position (and maximized or full screen if it was), instead of resetting on every restart or update.
- Quitting, restarting or updating bizzi no longer ends your Claude and Codex sessions. Sessions that an earlier version ended this way reopen the next time bizzi starts.
- Text you've typed but not sent stays in the composer, per session, when bizzi reloads, restarts or updates.
- After a restart or an update, bizzi opens on the page you were on (the session, workspace or settings page) instead of the machine page.
- The slash-command list shows aliases: typing `/n` offers `/new` (same as `/clear`), and `/clear` lists its other names.
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
