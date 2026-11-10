# bizzi — ADE updates, restarts and seamless resume (draft 1)

Companion to [spec.md](spec.md) §7 (provisioning). Covers what happens between "a new version exists" and "every session runs it", without losing a conversation.

## 1. Principle

bizzi orchestrates updates; each agent owns its binary layout. Every update path ends the same way: verify the new version, find processes still on the old one, restart them at a safe point, resume. **The agent process changes; the bizzi session doesn't**: same session id, same event log, `seq` keeps counting, and the timeline shows a divider ("restarted on 2.1.322").

Updates that bizzi didn't run are normal, not an edge case: Claude's own auto-updater, `/upgrade` inside an OpenCode TUI, `brew upgrade` in your shell. bizzi detects them by watching and handles them exactly like its own.

## 2. Detecting updates and stale processes

- **Installed version:** the probe (spec §7) on an interval, plus filesystem watches on the paths that change during an update:
  - Claude native: the `~/.local/bin/claude` symlink target in `~/.local/share/claude/versions/`;
  - Codex script: `~/.codex/packages/standalone/current`;
  - Homebrew: `Cellar/<name>/` and `Caskroom/<name>/`;
  - OpenCode script: `~/.opencode/bin/opencode`.
- **Running version:** recorded per process at spawn: the probe's version plus the real path of the executable launched (`agent_version`, spec §4). For processes bizzi didn't start, it asks them: OpenCode's `GET /api/info` returns `{ version, pid, urls }` for the shared background service, for example.
- **Stale:** the running version differs from the installed one, or the running executable's path no longer exists.

Observed 2026-11-09: `/upgrade` inside an OpenCode session moved the CLI to 2.2.6 (Homebrew), and the session that ran it carried on fine. The shared background service (`opencode serve --service`) kept running 2.0.25 from a Cellar directory that no longer existed until `opencode service restart` was run, about 1.5 hours later. The restarted service kept its port and reported 2.2.6 via `/api/info`. Rule of thumb: the process that runs an update copes; every other running process on the old version needs a kick.

## 3. Per agent

| Agent | Install method → update command | On disk | Running processes | Restart unit | Resume handle |
|---|---|---|---|---|---|
| **Claude** | native: built-in auto-updater, `claude update`, `claude install <v>` (pin) | new `~/.local/share/claude/versions/<v>`, symlink flips | keep running the old file | **one process per session** (the Agent SDK spawns `claude`) | SDK `resume: <session id>` (transcript in `~/.claude/projects/…`); terminal mode: `claude --resume <id>` |
| | Homebrew cask: `brew upgrade --cask claude-code` | Caskroom version dir replaced | keep running (unlinked file) | | |
| | npm: `npm i -g @anthropic-ai/claude-code` | package files replaced in place | verify; offer migration to native instead | | |
| **Codex** | script: re-run installer or `codex update` | `~/.codex/packages/standalone/releases/<v>`, `current` flips | keep running | **one `codex app-server` per session** | `thread/resume { threadId }` |
| | Homebrew cask, npm | as above | keep running / verify (npm) | | |
| **OpenCode v2** | `opencode upgrade [--method brew\|curl\|npm]`, or `/upgrade` in the TUI (picks the method itself) | Homebrew core `opencode` formula; script: `~/.opencode/bin`; npm `@opencode/cli` | **nothing restarts** the servers | **a server**: bizzi's private `opencode serve` (one per node, shared by all bizzi OpenCode sessions), or your shared background service | OpenCode session id; sessions live in OpenCode's database, and the adapter already re-applies runtime state after a server restart (`reapply`) |
| **agy** | script only: remove the binary and re-run the installer (bizzi's recipe) | `~/.local/bin/agy` replaced | keep running (unlinked) | one PTY per session | unknown (verify); if none, restart loses the conversation |

Per-method recipe steps live in `packages/provision/recipes/*.yaml`. Known recipe bug: the OpenCode `brew` method installs and uninstalls through `anomalyco/tap/opencode-v2`, while most installs (this Mac's included) come from Homebrew core's `opencode` formula. Adopted installs need the formula the binary actually came from.

## 4. Safe points

A process may be restarted only when:

- its session is at a **turn boundary**: `idle` or `waiting_input`;
- it is **not** `waiting_approval` or answering a question: the prompt belongs to the running turn and would be lost;
- it has **no background work** (Claude background shells, Codex background terminals, OpenCode background subagents and shells). Their children die with the process, so the session shows "has background work" and waits or asks.

For a **shared server** (OpenCode), every session on it must be at a safe point. While it restarts (seconds), new sends to those sessions are queued briefly instead of rejected.

**Helpers** (spec §12) restart independently. A parent blocked in `session_wait` survives its helper's restart, because the wait is held by bizzi, not by the agent.

## 5. Restart sequence

1. **Precheck the new binary:** `--version` works and the auth probe still passes. An update that broke login must not take sessions down: keep the old processes running and alert.
2. Emit `session.restarting { fromVersion, toVersion }`. Clients show "restarting on 2.1.322", not "failed".
3. Stop the old process gracefully: SDK close, app-server shutdown, server `SIGTERM`.
4. Spawn the new version and resume from `agent_session_ref`. Re-apply runtime state: model, effort, permission mode, the MCP servers bizzi injects (knowledge, agent-to-agent), instructions.
5. **Verify the resume** (for example, the resumed conversation has the expected number of messages). On mismatch the session is marked `failed`, the old ref is kept and shown, and nothing retries automatically.
6. Emit `session.restarted { fromVersion, toVersion }` and re-read context usage ([usage.md](usage.md) §1); a new version may count differently.

On a failed spawn, fall back to the previous version while it's still on disk (Claude native and Codex script keep version dirs; verify retention) and alert.

## 6. Policies

Per agent and machine, two settings:

| Setting | Values | Default |
|---|---|---|
| **update** | `auto` / `notify` / `pinned` | `auto`. Installs that self-update (Claude native) are left to their own updater, and bizzi only observes. For the rest, bizzi runs the recipe's update steps. |
| **restart** | `when-idle` / `ask` / `manual` | `when-idle` for structured sessions with a reliable resume (Claude, Codex, bizzi's private OpenCode server); `ask` for terminal mode and for anything bizzi doesn't own (your OpenCode background service) |

- Updates that bizzi didn't run follow the same restart policy once detected.
- **UI:**
  - a version chip on the session header ("2.1.311 · 2.1.322 installed"), derived from facts, so it can't go stale;
  - a quiet "updates pending: 2 sessions" note on the machine header in the sidebar;
  - an inbox item for `ask`.
- **Shared background service:** when bizzi sees it stale, it alerts with **Restart service** (`opencode service restart`) and doesn't restart it on its own unless you set `when-idle` for it.

## 7. bizzi's own updates

Updating the node is the same problem one level up:

- PTY sessions run under the detached supervisor and survive a node restart.
- Structured sessions declare `resumeAfterNodeRestart` and resume through the same sequence (§5).
- The node drains at safe points first: no restart mid-turn.

## 8. To verify

1. **Claude native:** how many old version dirs are kept, and can the auto-updater ever remove the version a session is running?
2. **Claude npm installs:** do running sessions survive the package being replaced in place?
3. **Resuming across versions:** Claude transcripts and Codex rollouts under `thread/resume`. Pin a contract test per adapter: resume a session created on N-1.
4. **OpenCode database:** an old service (2.0.25) and a new CLI (2.2.6) share `~/.local/share/opencode`. If the new version migrates the schema, the old process may fail or write the old shape, which is a reason to restart stale servers promptly. Check whether v2 guards against this.
5. **OpenCode `/upgrade`:** does any version restart the background service itself?
6. **agy:** does it have a resume flag?
