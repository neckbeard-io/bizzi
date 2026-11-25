# bizzi — context, usage, budgets and widgets (draft 1)

Companion to [spec.md](spec.md) §11 (frontend) and §12 (orchestration). Three different things that are easy to blur:

| | Scope | Question it answers | Example |
|---|---|---|---|
| **Context** | one session | How full is this agent's window, and with what? | "Claude is at 71%, compacts at 80%; MCP tools take 18k" |
| **Usage** | one login (account) | How much of my plan or spend is left? | "Claude Max: 5h 62% (resets 1h20), 7d 31%"; "LiteLLM key: $554 / $2,474" |
| **Budget** | a session tree, a provider | What am I willing to spend on this job? | "this fan-out may spend $5 metered; local model unlimited" |

Billing classes (`metered` / `plan` / `budgetless`) are defined in spec §12.3 and decide which of these applies.

## 1. Context per session

### 1.1 What the agents expose (verified 2026-11-09)

| Agent | Current occupancy | Window | Breakdown | Compaction |
|---|---|---|---|---|
| Claude (Agent SDK) | `getContextUsage()` → `totalTokens`, `percentage` | `maxTokens` / `rawMaxTokens`; `modelUsage[].contextWindow` on results | yes: categories with `id` (system_prompt, system_tools, mcp_tools, memory_files, skills, messages, autocompact_buffer, free_space, …) and `kind` (used / free / buffer / deferred) | compact-boundary messages |
| Codex (app-server) | `ThreadTokenUsage.last` (the latest turn's input = what's in the window) | `modelContextWindow` | no | context-compaction events (verify) |
| OpenCode v2 | latest assistant message tokens | model `limit.context` (models.dev) | no | `compaction` config (`keep.tokens`, `buffer`) |
| agy / terminal mode | none | none | none | none |

Today `Usage` (`packages/protocol/src/model.ts`) carries `contextWindow` but not occupancy, and `usage.updated` is the running session total. A running total is not context: summing tokens over turns overcounts, and compaction resets occupancy.

### 1.2 Protocol (additive)

New event `context.updated { used, window, usable?, compactAt?, categories?: { id, label, tokens, kind }[] }`:

- `used` comes from the agent's own figure when it has one (Claude, Codex `last`), never from summing turns.
- `usable` = window minus the agent's compaction buffer, when known. Warnings key off `usable`, not `window`.
- `categories` only where the agent reports them (Claude). bizzi adds its own row, **bizzi overhead**, for what bizzi injects (knowledge rules, the knowledge and agent-to-agent MCP tools), estimated from the tool schemas and instruction text it sends.
- `context.compacted { before, after }` when the agent compacts.
- Agents without data report nothing; the UI shows "context unknown", never a guess.

### 1.3 UI

- **Session header:** a thin bar showing `used / usable`; neutral below 60%, amber from 80%, red near compaction. The label reads "71% · compacts at 80%".
- **Breakdown:** clicking the bar (long-press on the phone) shows a stacked bar by category, like Claude's `/context`, with "bizzi overhead" called out. This is where you notice that six MCP servers cost 30k tokens before you've typed anything.
- **Not in the sidebar.** Context is per session; the sidebar stays as spec §11.1 describes. The sidebar's hover / long-press breakdown can include context % per session.

## 2. Context and cost when farming out

Helpers (spec §12.1) and fan-out create two context costs and, on metered or plan logins, real spend.

**Parent context.** What a helper returns lands in the parent's window.

- `session_read` returns a structured summary by default (final message, changed files with diff refs, tool counts, stop reason), not the transcript, and takes `maxTokens` (default about 4k). The parent asks for more explicitly (`detail: "full"`, a specific file's diff).
- `session_wait` returns only the state and a one-line reason, plus, when the parent may answer its helper's approvals (spec §12.5), the pending items (approval input truncated to about 2k characters).

**Helper context.** Each helper starts fresh: its system prompt, tools and rules, plus the brief.

- bizzi learns a per-agent, per-model **baseline** (starting context in this workspace) from earlier sessions and shows it at start: "Codex starts at about 14k here."
- The brief is the parent's prompt; there's no "copy my context" option. A helper that needs history gets a handoff brief (spec §6.5 chat/utility) instead of a fork.

**Budgets on a session tree.**

- `session_start` accepts `budget { usd?, tokens?, turns? }`; the tree's cap (spec §12.2) bounds the sum.
- Only `metered` spend counts toward `usd`. `plan` logins count toward the plan windows shown in §3 (bizzi warns, it doesn't cap). `budgetless` providers count tokens only.
- When a helper hits its budget it stops at the next turn boundary and goes **waiting** with reason `budget` (inbox, push), so you choose: raise, switch model, or stop.

**Preflight for fan-out.** Before starting N sessions, the fan-out dialog shows:

- per agent and model: billing class, baseline context, estimated cost per turn (metered: model price × baseline; budgetless: free, with the gateway's current load; plan: the login's current window usage);
- a warning when a plan window is above 80% or a metered estimate exceeds the tree budget;
- a one-click swap to a budgetless model for explorers and reviewers.

**Tree view.** A parent's helpers show as a tree: agent, model, billing class, context %, tokens, metered spend, state. Totals at the root count metered spend only.

## 3. Usage per login (central meter)

### 3.1 Logins, not machines

A login is an agent account (`AgentInstall` account label, spec §4). The same Claude Max account logged in on the laptop and the VPS shares one plan, so the hub merges snapshots per account identity across machines (newest observation wins) and shows the account once, listing the machines that use it.

### 3.2 Sources (verified 2026-11-09)

| Login | Source | What it gives |
|---|---|---|
| Claude subscription | `rate_limit_event` messages during sessions | `status` (allowed / allowed_warning / rejected), `rateLimitType` (five_hour, seven_day, seven_day_opus, seven_day_sonnet, overage), `utilization`, `resetsAt`, overage state |
| Claude subscription | `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` on a live query | 5-hour, 7-day and per-model windows; `subscription_type`; `rate_limits_available` (false for API key / Bedrock / Vertex). Experimental: isolate it in the adapter and tolerate removal |
| Claude API key | `total_cost_usd` on results | metered spend |
| Codex (ChatGPT login) | `account/rateLimits/read`, `account/rateLimits/updated` | `primary` and `secondary` windows (`usedPercent`, `windowDurationMins`, `resetsAt`), credits, `planType`, spend-control state |
| OpenCode | per provider: tokens × models.dev price | metered spend; subscription logins through OpenCode (Copilot, ChatGPT) have no window data (verify) |
| agy | unknown | verify; until then "no usage data" |
| Indirect (LiteLLM, Bifrost) | a widget (§4) | whatever the gateway reports, e.g. LiteLLM `/key/info` → `spend`, `max_budget`, `budget_reset_at` |

Collection:

- Event-driven while sessions run: the adapters already see these messages; they forward them as account snapshots instead of dropping them.
- Codex can be polled cheaply through app-server. Claude's window query needs a live query, so idle Claude logins show the last snapshot with its age ("62% · 40m ago") rather than starting a process to poll.

### 3.3 Protocol (additive)

A hub-level `usage` channel, not per session. Snapshot:

```ts
interface AccountUsage {
  agent: AgentKind; accountId: string; label: string;      // e.g. "claude · max · mc@…"
  billing: 'metered' | 'plan' | 'budgetless';
  machines: string[];
  windows?: { id: string; label: string; usedPercent: number; resetsAt?: string; windowMins?: number }[];
  spend?: { usd: number; capUsd?: number; period?: string; resetsAt?: string };
  status: 'ok' | 'warning' | 'limited' | 'unknown';
  observedAt: string;                                    // ISO; the UI shows age
}
```

### 3.4 UI

- **Desktop: bottom bar.** One compact meter per login, most constrained first:

  ```
  [C] max   5h ▓▓▓▓▓▓░░ 62% ↻1h20  7d 31%   [X] pro  5h 18%   [L] billed $554 / $2,474 (22%)   [H] h200 3/8
  ```

  Colour carries state only (neutral, amber from 80%, red when limited). Click opens the usage panel: every window with reset time, which sessions consumed it, a 7-day sparkline, machines using the login. When the bar is narrow it shows the most constrained login plus `+n`.
- **Phone:** no persistent bottom bar (the tab bar is there). A usage chip in the Machines and Inbox headers shows the most constrained login; tapping it opens the same panel as a sheet. Push notifications at 80% and 95% of a plan window and when a login is limited, so you can switch before a helper tree stalls.
- **Where they also appear:** the fan-out preflight (§2) and the session header's model picker ("Opus · plan 5h 62%").

## 4. Widgets (small plugins)

The LiteLLM meter in the bottom bar is the first case: indirect usage that no adapter knows about. Others: GPU gateway load, CI status for the current branch, a deploy's health. bizzi needs a small, safe way to add them without touching the app.

### 4.1 Model

A widget is **data, not UI**: it produces a small value that bizzi renders natively, so the same widget works on desktop, browser and phone, and no third-party HTML runs in the client.

```jsonc
// ~/.config/bizzi/widgets/litellm.json  (on the machine that runs it)
{
  "id": "litellm-billed",
  "label": "billed",
  "kind": "meter",                       // meter | text | status
  "placement": ["bar"],                  // bar | machine | workspace | session-header
  "every": "60s",
  "source": {
    "type": "http",
    "url": "${env:ANTHROPIC_BASE_URL}/key/info",
    "headers": { "Authorization": "Bearer ${secret:LITELLM_KEY}" },
    "value": "$.info.spend", "max": "$.info.max_budget",
    "resetsAt": "$.info.budget_reset_at",
    "format": "usd"
  },
  "thresholds": { "warn": 0.8, "error": 0.95 },
  "billing": { "account": "claude-via-litellm" }   // optional: feed §3 and budgets
}
```

Source types:

1. **`http`:** declarative GET plus JSONPath. Covers LiteLLM, Bifrost, Prometheus `/api/v1/query`, GitHub checks. No code runs.
2. **`command`:** an executable run on the node on the interval, which prints one JSON object `{ text?, value?, max?, tone?, tooltip?, link? }` (or one plain line). This is your status line's model (a script plus a cache TTL), and covers anything `http` can't.

Rendering by kind:

- **`meter`:** `value / max` with thresholds.
- **`text`:** one line.
- **`status`:** a dot plus a label.

Values are cached on the node and relayed through the hub like events; a stale value shows its age.

### 4.2 Rules

- Widgets run on a node, with that machine's environment and bizzi's secret store (`@bizzi/services`). `${secret:NAME}` is a secret stored with `agent.setSecret`, so `NAME` is an environment-variable name (`LITELLM_KEY`, not `litellm-key`); it resolves to the first agent that has one by that name, or use `${secret:claude:NAME}` for a specific agent's. Secrets are allowed in http `url`/`headers` and command `env`, never in command arguments. Secrets never leave the node; only the rendered value does.
- **Trust:** a `command` widget is code on your machine, the same trust as opening a terminal there (`term.open`). Creating one remotely (from the phone) goes through the same confirmation as provisioning, and the node logs it. `http` widgets can't execute anything.
- **Billing hook:** a widget with `billing.account` becomes the usage source for that login (§3) and can back a budget cap (spec §12.2). For example, Claude Code through LiteLLM gets its real cap from the key's `max_budget`.
- **Files are agent-editable.** Widget files are plain JSON with a schema, and the directory has an `AGENTS.md`, so "add a widget for my H200 queue depth" is a request to your agent (an idea from herdr-app, [landscape.md](landscape.md)).

### 4.3 Later

- **Widget actions:** a link, or a bizzi action, on click.
- **Rendered sparklines** from a history the node keeps.
- **Larger extensions:** UI panels, new methods. `NodeExtension` (`@bizzi/core`) already covers server-side methods; client UI plugins are out of scope until there's a clear need, because they'd break "same widget on every client".

## 5. Phasing

- **M2:** `context.updated` and the session header bar; per-login snapshots from the Claude and Codex adapters; the desktop bottom bar and the phone chip; `http` and `command` widgets.
- **M4:** helper `budget`, `session_read` `maxTokens`, baselines, the fan-out preflight and the tree view (with spec §12).

## 6. Open questions

1. Claude's window query is experimental. If it disappears, is `rate_limit_event` alone enough (it only arrives while sessions run)?
2. agy and OpenCode subscription logins: is any usage data exposed?
3. Account identity for merging across machines: Claude and Codex expose an account email or ID through their auth status; confirm both, and decide what to do for API-key logins (key fingerprint).
4. The "bizzi overhead" estimate: count tokens per model tokenizer, or approximate from bytes?
