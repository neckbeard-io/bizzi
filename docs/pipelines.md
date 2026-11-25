# bizzi — pipelines and watchers (draft 1)

Spec §12.4 lists two orchestration features beyond helpers and fan-out:

- **Pipelines**: planner → implementer → reviewer across agents, one stage after another, each stage fed the previous one's result.
- **Watchers**: a cheap or budgetless model watches a session and pings you only for real decisions.

Both build on the M4 primitives (spec §12.5): structured sessions, worktrees as workspaces, the `session_read` summary, `session_wait` states, budgets and billing classes, session groups. This doc designs both, records what is built (§6), and what is left (§7). Everything here runs on **one machine**; cross-machine stages wait for node→hub requests (spec §12.4).

## 1. How the three compare

| | Started by | Shape | Results flow |
|---|---|---|---|
| Fan-out | you | N sessions, same prompt, parallel worktrees | side by side in the compare view; you pick |
| Helpers | an agent (bizzi-agents MCP) | a tree under the parent session | the parent reads them with `session_read` |
| **Pipeline** | you | a fixed sequence of stages, each its own session | bizzi fills each stage's prompt from earlier stages; you approve at gates |

A pipeline is driven by the node, not by an agent: no session holds the plan in its context, so a long implement stage doesn't crowd out the planner's reasoning, and each stage can be a different agent, model and billing class (a budgetless reviewer after a metered implementer). Herdr has no task graph at all ([landscape.md](landscape.md) §3); a linear pipeline with gates covers planner → implementer → reviewer without a general DAG.

## 2. The definition

```jsonc
{
  "stages": [
    { "name": "plan", "agent": "claude", "permissionMode": "plan",
      "prompt": "Plan this task; do not change any files.\n\nTask:\n{{task}}" },
    { "name": "implement", "agent": "codex", "where": "worktree", "gate": true,
      "prompt": "Implement this task by following the plan.\n\nTask:\n{{task}}\n\nPlan:\n{{previous.result}}" },
    { "name": "review", "agent": "opencode", "model": "local/qwen3.8-27b", "permissionMode": "plan", "where": "worktree",
      "prompt": "Review this change.\n\nPlan:\n{{stages.plan.result}}\n\nDiff:\n{{previous.diff}}" }
  ],
  "branch": "pipeline/cookie-sessions",   // optional: the worktree's branch
  "budgetUsd": 5                          // optional: metered cap for the run
}
```

Started with `pipeline.start { workspaceId, spec, task, title? }`. Per stage (`PipelineStageSpec`, `packages/protocol/src/model.ts`):

- **`name`**: unique, `[a-z0-9][a-z0-9_-]{0,31}`; used in titles (`<title> · <name>`) and placeholders.
- **`agent`**, **`model`**, **`permissionMode`**, **`effort`**: as in `session.create`. Stages are sessions you started, so there is no helper clamping (spec §12.2); a read-only planner or reviewer says so with its permission mode.
- **`prompt`**: a template.
  - `{{task}}`: the run's task text.
  - `{{gate.message}}`: the note you gave when approving this stage's gate (empty otherwise). A note given at the gate is appended as "Note from the user: …" when the template doesn't place it, so it is never lost.
  - `{{previous.name}}`, `{{previous.result}}`, `{{previous.diff}}`, `{{previous.files}}`: the stage before.
  - `{{stages.<name>.result|diff|files}}`: any earlier stage.
  - `result` is the stage session's last assistant message, `files` its changed files (`modified src/x.ts`, one per line), `diff` the stage workspace's `git diff` plus new files the agent reported (git doesn't show untracked files).
  - Each value is cut at 16,000 characters (about 4k tokens, `session_read`'s default), so one huge diff can't flood the next stage.
  - Unknown placeholders, `previous.*` in the first stage, and names of later stages are refused when the run starts.
- **`where`**: `workspace` (default) runs in the workspace the run was started from; `worktree` runs in the run's own worktree (created on first use with `worktree.create`, branch `spec.branch` or `pipeline/<title>-<id suffix>`). Every `worktree` stage shares that one worktree, so the reviewer reads what the implementer wrote. A plain-directory workspace can't have `worktree` stages.
- **`gate`**: stop for your approval before this stage starts.
- **`budget`**: the stage session's own cap (usage.md §2).

The client ships the planner → implementer → reviewer definition as `reviewPipeline({ planner, implementer, reviewer, … })` (`packages/client/src/pipelines.ts`): read-only planner and reviewer, implementer in the worktree, a gate before implementing (on by default) and optionally before the review.

## 3. How it runs

The runner (`packages/core/src/pipelines.ts`) is a built-in node extension, like baselines. It uses only existing machinery:

1. **Start a stage:** resolve its workspace (creating the worktree if needed), fill the template, `Sessions.create` a structured session with `group: <pipeline id>`, then `Sessions.send` the prompt and remember the turn id.
2. **Watch it:** a bus tap re-evaluates the run whenever the current stage's session changes (`turn.completed`, `session.status`, `session.updated`, `session.removed`).
3. **Stage done** when that turn has completed with `end_turn` and the session isn't busy; the stage's summary (first 300 characters of the final message) and changed-file count come from the `session_read` summary (`Orchestrator.summarize`). Approvals and questions on the way go to you as usual (inbox, push); the stage simply isn't done until its turn is.
4. **Stage failed** when the turn ends otherwise (error, interrupted, refused), or the session ends, fails or is deleted first. The run fails and the remaining stages are marked cancelled. A stage's own `budget` is checked at turn boundaries like any session's, so its first turn always finishes and counts; the cap only holds further turns in that session.
5. **Next stage**, or a gate first.

**Gates.** Before a stage with `gate: true`, the run goes `waiting` with `gate { stage, reason: 'gate', message }`. The inbox and the pipeline view show it; `pipeline.gate { decision: 'approve' | 'reject', message? }` answers it. Placeholders are read when the next stage starts, not when the previous one finished, so while the run waits you can open the previous stage's session, push back ("also cover logout"), and the next stage gets the revised result.

**Budget.** `budgetUsd` caps the run's metered spend: the sum of each stage session's tree spend (`Sessions.spent(...).tree.usd`, which is metered only, spec §12.3). It's checked before each stage; once reached, the next stage waits at a gate with `reason: 'budget'`. Approving starts it anyway (its own gate, if any, is asked next). Plan and budgetless stages never count.

**Restarts.** Runs are stored in a `pipelines` table in node.db. A run waiting at a gate keeps waiting across a node restart. A stage whose agent process was cut off by the restart fails the run ("the turn was interrupted"), because its turn can't continue.

**Cancel and delete.** `pipeline.cancel` stops the running stage's session. `pipeline.delete` forgets a finished run; its sessions and worktree stay (remove the worktree from the workspace view as usual).

**Hub.** Every `pipeline.*` call names the machine (`machineId`, or `workspaceId` for start), so the hub relays them like any machine-targeted method; `pipeline.updated` / `pipeline.removed` pass through the hub's global log unchanged. No hub code is involved.

## 4. UI

- **Workspace view:** a **Pipeline** button opens the start dialog (task, an agent and optional model per role, the two gate switches, a metered cap, or the whole definition as editable JSON). Runs started there show as chips with their current stage or final status, next to the fan-out chips.
- **Pipeline view** (`#/pipeline/<id>`): status, the task, the open gate (approve with an optional note, or reject), then the stages top to bottom with the agent mark of each live stage session, its summary, changed files and a link to the session. Cancel while running, delete after.
- **Inbox:** open gates are listed first, with the same approve/reject card. They count toward the Inbox badge (`selectWaitingCount`).
- Stage sessions are ordinary sessions in their workspaces (the worktree groups under its repo), so their marks show in the sidebar as usual. Fan-out views skip groups starting with `pl_` (`PIPELINE_ID_PREFIX`).

## 5. Watchers (designed, not built)

**What a watcher is.** A watcher observes one target (a session, or a pipeline's current stage) and decides, at the target's decision points, whether this is something you need to hear about. It is the opposite of a notification for every turn: it stays quiet when an agent is making progress and raises one inbox item when it isn't.

**Decision points** (the only times a watcher runs):

- the target's turn completed (any stop reason);
- the target failed or ended;
- the target has been `running` longer than `stuckAfterMs` (default 20 min) with no new tool call;
- approvals and questions are **not** watcher triggers: they already reach you through the inbox, and a watcher must never answer them (spec §12.2).

**How a check runs.**

1. Build a digest of the target since the last check: `session_read` summary (final message, changed files, tool counts, failed and denied tools, stop reason), capped at `digestTokens` (default 1,500), plus the task (for a pipeline stage, the stage prompt's first 1,000 characters).
2. Send it to the watcher's own session with a fixed instruction: answer with exactly one line, `QUIET` or `NOTIFY: <one sentence for the user>`. An optional user-written policy is appended ("notify me if it touches migrations or deletes tests").
3. Parse the final message. `NOTIFY:` raises an inbox item (a `watcher.alert` with the sentence, the target and the seq it refers to, and push); anything that isn't one of the two forms counts as `NOTIFY` with the raw text, so a confused watcher fails loud, not silent.

**Where it runs, for now.** An existing agent session as the classifier: by default OpenCode pointed at a budgetless provider (the local gateway, spec §6.5), in a scratch directory, read-only (`plan`), with no bizzi-agents tools. Once the "API chat" provider exists, a watcher should move to a plain chat call: an agent session pays its starting context on every check (baselines, usage.md §2), and a watcher needs no tools.

**Guardrails and cost rules.**

- **Read-only.** A watcher never sends to, steers, interrupts or approves for its target. The only thing it can produce is an alert. (Acting on alerts, e.g. "interrupt when it loops", is a later opt-in.)
- **Budgetless or capped.** Starting a watcher on a `metered` or `plan` agent requires an explicit budget (`tokens` or `usd`); budgetless watchers count tokens only.
- **Rate.** At most one check per decision point, debounced (turn completions within 30 s coalesce), and at most `maxChecksPerHour` (default 20). Over the limit, the watcher skips and says so in its own status.
- **Context.** The watcher session is replaced after `rotateAfterTurns` (default 20) so its context doesn't grow without bound; each check carries what it needs in the digest.
- **Dedupe.** An alert for a target stays until dismissed; further `NOTIFY` verdicts for the same target update it instead of stacking.
- **Stops with its target.** A watcher on a session ends when the session ends; on a pipeline, when the run ends.

**Protocol sketch (additive).** `WatcherInfo { id, machineId, target: { sessionId } | { pipelineId }, agent, model?, policy?, status, checks, lastVerdict?, alert? }`; `watchers.list`, `watcher.start`, `watcher.stop`, `watcher.dismiss`; global `watcher.updated` / `watcher.removed`. A pipeline definition can name a watcher (`spec.watcher { agent, model, policy }`) that watches every stage.

**Open questions.** Whether alerts should arrive as a session event on the target (so they show in its timeline) as well as in the inbox; how to measure "real decision" quality (record verdicts with your dismiss / open reaction, as routing records overrides, spec §11.2).

## 6. Built (2026-11-25)

Pipelines, first slice, one machine:

- **Protocol (additive):** `PipelineSpec`, `PipelineStageSpec`, `PipelineInfo`, `PipelineStageRun`, `PIPELINE_ID_PREFIX` (model.ts); `pipelines.list`, `pipeline.start`, `pipeline.get`, `pipeline.gate`, `pipeline.cancel`, `pipeline.delete` (methods.ts); global `pipeline.updated`, `pipeline.removed` (events.ts); id prefix `pl`.
- **Core:** `Pipelines` runner and `pipelinesExtension` (`packages/core/src/pipelines.ts`), registered with the built-ins in `createNode`; `Orchestrator.summarize` (the `session_read` summary without the ownership check) is what `read` now calls.
- **Client:** `state.pipelines`, `loadPipelines` (per machine, never a machine error on older nodes), `startPipeline`, `gatePipeline`, `cancelPipeline`, `deletePipeline`, selectors (`selectPipelines`, `selectPipelineGates`, `selectPipeline`), `reviewPipeline`; gates count in `selectWaitingCount`; fan-out groups skip `pl_` ids.
- **UI:** start dialog, pipeline view, workspace chips, inbox gate cards, a seeded mock run (`?mock=1`, acme-shop).
- **Tests:** `packages/core/test/pipelines.test.ts` (definitions, templates, the full plan → gate → worktree implement → review flow with results, files and diffs checked in prompts, failure, reject, cancel, deleted stage session, restart while gated and while running, budget gate), `packages/client/test/pipelines.test.ts`, `packages/ui/test/pipelines.test.ts`, and a `smoke:v12` section that runs `reviewPipeline` through a real hub with the gate approved from the second device.

Decisions where the spec was silent:

- **Linear only**, with optional gates. No branches, loops or parallel stages; fan-out covers parallel runs.
- **Stages are not helpers.** They are depth-0 sessions you started (tagged with the pipeline as `group`), so the depth limit, helper concurrency limits and permission clamping don't apply; each stage's permission mode is in the definition.
- **One shared worktree** per run rather than one per stage, so later stages see earlier changes; nothing is committed between stages.
- **`diff` is the working tree against HEAD** of the stage's workspace when the next stage starts. In `where: 'workspace'` that includes your own uncommitted changes there; use `worktree` stages for a clean diff.
- **A stage is its first turn.** Later turns you add (at a gate) change what the next stage reads, but the runner doesn't wait for them.
- **No retry.** A failed run stays failed; start a new one. Approving a budget gate starts the stage even though the run is over its cap.

## 7. Left

- Watchers (§5), ideally on the API chat provider.
- Retry a failed stage (same or new session) and "resume from stage N".
- Commit between stages (a checkpoint per stage in the worktree), and a "send the diff as a PR" final step.
- Sidebar: a pipeline row or mark (today only its stage sessions show), and a group view for a run's sessions in the helper tree.
- Preflight for a run (per-stage billing and baseline, like fan-out's), and per-stage budgets in the start dialog.
- Saved definitions (per workspace or project) instead of only the built-in template or pasted JSON.
- Cross-machine stages (implement on the laptop, run the long test stage on the VPS), after node→hub requests exist.
