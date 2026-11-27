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

Per-method recipe steps live in `packages/provision/recipes/*.yaml`. The OpenCode `brew` method installs fresh copies through `anomalyco/tap/opencode-v2`, while most installs (this Mac's included) come from Homebrew core's `opencode` formula. Adopted installs are updated and uninstalled through the formula the binary actually came from (its `Cellar/<formula>` path and `INSTALL_RECEIPT.json`); casks and npm prefixes work the same way.

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
- **The desktop app doesn't restart the node unless the node changed.** A packaged app runs its core from a copy outside the bundle (`<dataDir>/core/<core id>/`) and leaves it running when it quits, so replacing the app (self-update, a local build) doesn't touch running sessions. The core id is a content hash of the core and its Node runtime, ignoring the version stamp. A relaunch with the same id re-adopts the running core; a different id restarts it (`apps/desktop/src/core/copy.ts`, `manager.ts`). Dev runs and `BIZZI_CORE_ENTRY` keep the old behavior (quit stops the core).

## 8. As built (core, first pass)

- **Running version.** When an adapter session starts, the core records the last probe's `version` as `SessionInfo.agentVersion`, and the probe's `realPath` (else `path`) when that file exists. The values come from the probe, not from the process. Both are cleared on a node restart, because no agent process survives one, and recorded again on the next start.
- **Stale.** A session is stale only while its agent runs. The UI's version chip compares `agentVersion` with the agents.list `version`. `staleSessions` on agents.list counts stale sessions per agent.
- **Triggers.** Every completed probe (the updates extension re-probes on install-path changes and on its interval) and every `session.updated`.
- **Safe point.** `idle` or `waiting_input`, with no turn in flight or being started, and no pending approval or question. Adapters don't report background work yet, so "no turn in flight" stands in for it.
- **Precheck.** A fresh probe: installed, `--version` reported a version, not `unsupported`, and auth not `missing` or `expired`. On failure the old process keeps running and an `error` event (`code: restart_precheck`) is recorded, with no `session.restarting`.
- **Verify.** The restarted adapter must report the same `agentSessionRef` (or none yet). Deeper checks such as message counts are still to do.
- **Failure.** On a failed spawn or resume, `session.restarted { ok: false }` is followed by `session.status failed`, and the old ref is kept. Automatic restarts skip an install (version, path and auth) that a restart already failed on; `session.restart` always tries.
- **Sends during a restart** wait up to 60 s and then go through. If the restart failed they're refused with `agent_unavailable`. The status doesn't change during a restart, so `session_wait` callers on a helper carry on.
- **Policies.** Restart policy comes from agents.list `restartPolicy`, which the services decorate; without services it's `manual`. For `ask`, see the inbox item below; `session.restart` is the answer.

### Built (2026-11-25): the §8 leftovers

- **Shared OpenCode servers.** An adapter now says whether one process serves all its sessions: `AgentAdapter.sharedProcess` is `owned` (bizzi's private `opencode serve`) or `external` (a `serverUrl` server, such as your background service). An owned server is one restart unit. `Sessions.restartGroup` is that session plus every other running session on the same adapter. Safe points and blockers are checked group-wide ("session "beta" on the same opencode server: a turn is in progress"). Once all of them are at a safe point, the core runs one precheck, emits `session.restarting` on each, and stops them all. Then `recycle()` stops the server, and each session resumes from OpenCode's database on a fresh server spawned from the installed binary, with its own verify and `session.restarted`. Sessions that start on the adapter while the server is being replaced wait, so they don't land on the old server. `session.restart` on any one session restarts the whole server. External servers are never restarted: `session.restart` answers `unsupported` ("restart that server instead"), and the stale count still shows them.
- **Running version of a shared server.** An adapter session can report the version actually serving it (`AdapterSession.agentVersion()`; OpenCode returns the server's `/api/info` version), and the core prefers that over the probe's. The probe's path is then recorded only when both versions agree. Without this, a session started on the old server after a CLI upgrade would have recorded the new version and never looked stale.
- **Fallback to the previous version.** When the installed version fails to start during a restart, the core starts the executable the old process ran (`agentPath`, recorded at spawn), as long as it's still on disk and isn't the path that just failed. It passes that path as `StartSessionOptions.executable`, and only to adapters with `acceptsExecutable` (Claude: `pathToClaudeCodeExecutable`; Codex: the `app-server` command). If that resumes the same conversation, the session keeps running on the old version. `session.restarted { ok: false, error, fallbackVersion }` shows "2.1.322 did not start; resumed on 2.1.311" as a warning divider, plus an `error` event (`code: restart_fallback`) as the alert. The session stays stale, and automatic restarts skip that install (version, path and auth); `session.restart` tries it again. With no usable previous executable, or if the fallback also fails or lands in another conversation, the restart fails as before (`failed`, old ref kept). OpenCode has no fallback: the server is shared, and spawning it from an old Cellar path isn't supported.
- **Drain and resume for bizzi's own updates (§7).** The resume is lazy for sessions that were idle: they start their agent on the next send, not at node start. That's a deliberate existing decision (`restart.test.ts`), and it avoids spawning every agent at once. Two changes:
  - **Stopping doesn't end anything:** adapters report `session.status ended` when their process is stopped (Claude, Codex and PTY all do). The core ignores the status a process reports while bizzi is stopping it, so a shutdown leaves every session open and resumable (spec §4.1). Before this, every Claude and Codex session ended whenever bizzi quit.
  - **Drain:** SIGTERM drains as before, but `drain()` now also waits for agents that are starting and for agent restarts in flight, not only for turns. A turn waiting for an approval or a question is still in flight, so the drain waits for your answer, up to `BIZZI_DRAIN_SECONDS`.
  - **Resume:** At load, a session whose agent process was running when the node went down (it had a recorded `agentVersion`/`agentPath`, is resumable and not ended) gets a persisted `nodeRestarted { fromVersion }` mark. Its next start goes through the restart sequence: `session.restarting { fromVersion, toVersion, reason: 'bizzi restarted' }`, the resume, then a verify that the agent continued the same conversation (it no longer adopts a different ref silently), then `session.restarted`. The divider reads "restarted on 2.1.322" even when the agent was updated while bizzi was down. A mismatch fails the session and keeps the old ref; a failed start also closes the divider with `ok: false`. The mark survives further node restarts until the session's next start. There's no precheck step here, because no old process survives to keep running.
- **Inbox item for `ask`.** This is client-side only; no protocol change. `selectRestartPrompts` (in `@bizzi/client`) lists live sessions whose machine's restart policy for that agent is `ask` and whose `agentVersion` differs from the installed version (the version chip's rule). The Inbox shows a card for each ("Claude 2.1.311 · 2.1.322 installed") with **Restart on 2.1.322**, which calls `session.restart`. The Inbox tab badge doesn't count these (unsupported-agent alerts aren't counted either); the machine's "updates pending" note already does.
- **Left:**
  - per-version retention is unverified (§9.1). The fallback relies on the old version dir surviving until the restart, which Claude native and Codex script appear to do; Homebrew cleans old Cellar dirs, so there's usually no fallback there. For wrapper-shim installs, `realPath` may point at a platform binary inside the package, and starting that directly is untested live;
  - if the private OpenCode server crashes and auto-restarts on a newer binary, sessions keep the version recorded at their start until their next start (the adapter doesn't push version changes);
  - restarting an `external` OpenCode service (`opencode service restart` under `when-idle`) needs a live check that the service keeps its port and password, so it's not built. The `restart-service` remedy kind exists in the model but nothing produces it yet;
  - adapters still don't report background work (§4).

### Built (2026-11-27): continuing turns a restart cut off

When bizzi does have to restart mid-turn (a core change, a crash, the drain running out), the turn no longer waits for someone to send a message:

- **Mark.** `Sessions.close()` records `interruptedTurn` on every structured session with a turn in flight, before stopping its agent. At load, a turn that is still open (the node was killed) gets the same mark. Terminal sessions don't need it: their PTY supervisor keeps the process running.
- **Continue.** One second after start (extensions running, `bizzi serve` wired up), `Sessions.resumeInterrupted` sends `CONTINUE_AFTER_RESTART` to each marked session, one at a time and 500 ms apart. It goes through the normal send path, so the restart sequence (resume, verify, divider) runs as before. The message asks the agent to check what's already done and to say so if it had finished.
- **Loop guard.** `autoResumes` counts automatic resumes since the last real message; any `session.send` resets it. At `MAX_AUTO_RESUMES` (3) the session gets a `resume_skipped` notice instead, and a failed resume leaves a `resume_failed` notice. Both say to send a message to continue.
- **Off switch.** `BIZZI_RESUME_INTERRUPTED=0` (`NodeOptions.resumeInterrupted: false`).
- **Fixed alongside:** `#persist` dropped `titleByUser`, `closed` and `startFresh`, so a renamed session took the agent's title again after a restart, and the close marker had to be inferred from the last status.

## 9. To verify

1. **Claude native:** how many old version dirs are kept, and can the auto-updater ever remove the version a session is running?
2. **Claude npm installs:** do running sessions survive the package being replaced in place?
3. **Resuming across versions:** Claude transcripts and Codex rollouts under `thread/resume`. Pin a contract test per adapter: resume a session created on N-1.
4. **OpenCode database:** an old service (2.0.25) and a new CLI (2.2.6) share `~/.local/share/opencode`. If the new version migrates the schema, the old process may fail or write the old shape, which is a reason to restart stale servers promptly. Check whether v2 guards against this.
5. **OpenCode `/upgrade`:** does any version restart the background service itself?
6. **agy:** does it have a resume flag?
