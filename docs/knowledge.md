# bizzi — knowledge: rules & memory across agents (draft 2)

Goal: a rule or memory saved once reaches every agent (Claude, Codex, OpenCode, agy) that works in the same place (global, machine, project or workspace), on every machine, offline too, and even in agent sessions bizzi didn't start.

## 1. What each agent does today (Nov 2026, verify per version)

| | Claude Code | Codex | OpenCode | agy |
|---|---|---|---|---|
| Project instructions | `CLAUDE.md`; reads `AGENTS.md` when no `CLAUDE.md` exists (≥ 2.1.277, configurable) | `AGENTS.md` (+ nested, `AGENTS.override.md`) | `AGENTS.md` (falls back to `CLAUDE.md`) | `AGENTS.md` + `GEMINI.md`, `.agents/rules/` |
| User instructions | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | `~/.config/opencode/AGENTS.md` | `~/.gemini/GEMINI.md` |
| Skills (`SKILL.md`) | `.claude/skills/`, `~/.claude/skills/` | `.agents/skills/`, `~/.agents/skills/` | `.opencode/skills/`, `.claude/skills/`, `.agents/skills/` | `.agents/skills/`, `~/.gemini/antigravity-cli/skills/` |
| MCP servers | `.mcp.json`, `~/.claude.json`, SDK `mcpServers` | `config.toml` `[mcp_servers.*]` | `opencode.json` | `agy mcp add`, settings |
| Learned memory | auto-memory `~/.claude/projects/<repo>/memory/` (per repo, machine-local) | `~/.codex/memories/` (opt-in, machine-local) | none native | unclear |

Instructions have converged on `AGENTS.md`, and skills mostly on `.agents/skills/`. **Memory and scoped rules haven't converged at all**, and nothing native shares them across agents or machines. That's bizzi's job.

## 2. Two kinds of knowledge, one scope model

| | **Rule** | **Memory** |
|---|---|---|
| What | prescriptive: "always use pnpm", "never touch `migrations/`, but only in this workspace" | descriptive: "the staging DB is on server-a:5433", "test X is flaky because Y" |
| Delivery | **always injected in full** into every matching session | **retrieved by relevance**: a ranked digest at session start + on-demand search via MCP |
| Typical author | you (or an agent you asked to "remember to always…") | agents, while working |

### 2.1 Scopes

```
global                     you, everywhere, every machine
 └─ machine                one machine, every project ("on server-a, scratch space is /data")
 └─ project                one project, every machine and workspace
     └─ workspace          one directory on one machine ("always do this, but only here")
         └─ session        this session only (ephemeral)
(team / org — later)
```

Each item can also be limited to certain agents (`appliesTo: ["codex"]`, e.g. "Codex: run `just fmt` before finishing"). The default is all agents, which is what lets Claude and Codex in the same workspace or project share rules and memories.

### 2.2 Resolution

For a session of agent **A**, in workspace **W**, on machine **M**, in project **P**, the visible items are those whose scope is `global`, `machine=M`, `project=P`, `workspace=W` or `session=S`, and whose `appliesTo` includes A.

- **Rules conflict by specificity:** workspace > project > machine > global. Rules are injected in that order (general first, specific last) with a line stating that more specific scopes override.
- **Memories don't conflict**; they're ranked (scope specificity, recency, relevance to the prompt) and capped for the digest.

### 2.3 Model

```ts
interface KnowledgeItem {
  id: string;                              // ULID
  type: "rule" | "memory";
  scope: { level: "global" | "machine" | "project" | "workspace" | "session" | "team";
           machineId?: string; projectId?: string; workspaceId?: string; sessionId?: string };
  appliesTo?: AgentKind[];                 // default: all agents
  kind?: "fact" | "preference" | "decision" | "gotcha" | "procedure" | "reference" | "todo"; // memory only
  title: string;                           // one line: digests, dedupe, inbox cards
  body: string;
  tags: string[];
  source: { agent?: AgentKind; sessionId?: string; machineId: string;
            via: "ui" | "tool" | "harvest" | "extract"; userRequested?: boolean };
  status: "active" | "suggested" | "superseded" | "deleted";
  supersedes?: string[];
  createdAt: string; updatedAt: string; hlc: string;
}
```

Append-only replication with tombstones ([topology.md](topology.md) §5.1): every node has the items for the projects it hosts plus global and its machine items, so everything works offline.

## 3. Control across agents: one pipeline, whichever agent

The agent never decides what's shared. Every write goes through the same bizzi pipeline, and every read comes from the same resolver; agent differences live only in thin projection adapters.

```
 WRITES                                                       READS
 agent calls memory_add / rule_add (MCP) ─┐                    session context (A, W, M, P)
 agent saves native memory → harvester  ──┼─▶ policy ─▶ active │        │
 transcript extraction (cheap model)    ──┤    engine   or     │   resolver (§2.2)
 you, in the UI / CLI                   ──┘  (your     suggested│        │
                                             settings)   │      │  ┌─────┴──────────────┐
                                                         ▼      │  inject rules + digest │ bizzi-memory MCP
                                              replicate to all nodes  (per-agent adapter) │ search/add/history
```

### 3.1 Acceptance policy (a user setting)

What goes live immediately vs. becomes a suggestion in the inbox is configurable per source and target scope. Proposed defaults: the broader the blast radius, the stricter.

| Source → target scope | session / workspace | project | machine | global |
|---|---|---|---|---|
| You (UI/CLI) | live | live | live | live |
| Agent rule, `userRequested` ("you told me to always…") | live + inbox notice (undo) | live + inbox notice | live + inbox notice | suggested |
| Agent rule, unprompted | suggested | suggested | suggested | suggested |
| Agent memory, explicit save (`memory_add` or native) | live | live | live | suggested |
| Extracted from transcripts | suggested | suggested | suggested | suggested |

Presets for quick switching: **trusting** (everything live, prune later), **balanced** (the table above), **strict** (only you write live). Overridable per project.

### 3.2 Review UX

Batched inbox cards, one per finished session ("3 suggested memories, 1 rule"); accept / edit scope / reject, in bulk; no push notifications for knowledge. "Live + inbox notice" items show up in the same card with an undo.

### 3.3 Default scope for agent writes (a user setting)

- The MCP tools take an explicit `scope` with guidance in the tool description ("workspace = only this directory on this machine; project = this project everywhere; …").
- When the agent omits it: the user setting decides, default **project**.
- Optional: a cheap model reclassifies (e.g. absolute paths → machine/workspace; personal style → global) and flags its change in the inbox card.

### 3.4 Native memory (a user setting, per agent)

Native stores are per agent and per machine, so sharing between Claude and Codex in the same workspace requires bizzi to sit in the middle:

- **Mirror (default):** native memory stays on; the harvester imports what each agent saves natively (one-way, deduped by content hash + provenance) and pushes it through the policy engine. The other agents receive it via injection/MCP.
  - Claude auto-memory is per repo per machine → imported at **project** scope by default (machine/workspace if it references local paths).
  - Codex memories are user-wide → imported as **suggested** at global scope, or at project scope when they clearly reference the project.
- **bizzi-only:** sessions bizzi launches get native memory disabled where possible; the bizzi store is the single source.
- **Ignore:** native memory on, not imported.

bizzi never writes into native memory directories (that would loop).

## 4. Delivery: launch mode and ambient mode

### 4.1 Launch mode (sessions bizzi starts)

The adapter injects at launch; nothing is written to the repo:

| | Claude (SDK) | Codex (app-server) | OpenCode (serve) | agy (PTY) |
|---|---|---|---|---|
| rules + memory digest | `systemPrompt.append` | per-session instructions config override | `instructions` → generated file | `.agents/rules/bizzi.md` (excluded file) |
| bizzi-memory MCP | `mcpServers` | `-c mcp_servers.bizzi…` | config | `agy mcp add` (session-scoped if supported) |
| skills (`.agents/skills`) | symlink into `.claude/skills/` (excluded) | native | native | native |

### 4.2 Ambient mode (opt-in): agent sessions bizzi didn't start

Your plain `claude` in a terminal, the Codex IDE extension, the Antigravity GUI, in any directory. This is how bizzi "straddles" directories and other ADE sessions:

- **Directory → context:** the node maps a cwd to a workspace by longest registered path prefix (worktrees resolve to their main workspace). Unregistered directories get global + machine items only, plus an offer to register them.
- **Reads:**
  - bizzi registers its MCP server once in each agent's **user-level** config (`~/.claude.json`, `~/.codex/config.toml`, `opencode.json`, agy settings) as a managed entry. The server resolves scope from the process cwd / MCP roots on each call.
  - Rules are projected into files those agents read: global rules into managed blocks in user-level instruction files; project/workspace rules into local-only files.
- **Writes:** MCP calls and native-memory harvest go through the same policy engine. (Transcripts of ambient sessions aren't in bizzi's event log; importing them is a later feature.)

**File projection rules (both modes):**

1. Only touch user-level files inside a managed block:
   ```md
   <!-- bizzi:begin (managed; edits inside are overwritten) -->
   …
   <!-- bizzi:end -->
   ```
2. Never dirty a repo: generated files go in paths listed in `.git/info/exclude` (local-only ignore).
3. **Never create a `CLAUDE.md` or `CLAUDE.local.md` where only `AGENTS.md` exists**: Claude would then stop reading `AGENTS.md`. For Claude, project and workspace rules go through launch injection, or (ambient) a file imported from an existing `CLAUDE.md`, or the MCP server's instructions.
4. If a repo has both `CLAUDE.md` and `AGENTS.md`, warn and offer to add `@AGENTS.md` to `CLAUDE.md`.

## 5. bizzi-memory MCP server

Runs on every node (stdio for local agents), backed by the local replica, so it works offline.

| Tool | Purpose |
|---|---|
| `memory_search(query, scope?)` | ranked search (FTS5; embeddings later) across visible scopes |
| `memory_add(title, body, kind, scope?, appliesTo?)` | save a memory, then the policy engine decides |
| `rule_add(title, body, scope, appliesTo?, userRequested)` | propose a rule |
| `knowledge_update(id, …)` / `knowledge_forget(id)` | edit or retire an item (creates `supersedes` / tombstone) |
| `history_search(query)` | past sessions across all agents and machines in this project |
| `handoff_brief(sessionId)` | what an earlier session was doing |

The server's instructions tell agents when to save, and which scope means what.

## 6. Other shared layers

| Layer | Canonical | Notes |
|---|---|---|
| Instructions committed with the repo | `AGENTS.md` | team-shared via git; bizzi reads it but doesn't own it |
| Personal/scoped rules | bizzi store (§2) | never committed unless you "promote to AGENTS.md" |
| Skills | `.agents/skills/` + a bizzi user library | projected per §4 |
| MCP servers | bizzi config at global / machine / project scope, secrets from per-machine env profiles | injected at launch; ambient via managed entries |
| Roles / subagents | bizzi role definitions | generated into `.claude/agents/`, `.codex/agents/`, `.opencode/agent/` (excluded) |

## 7. Consolidation

A periodic job (cheap model) merges duplicates, marks superseded items, flags rules that contradict each other in the same scope, and keeps digests sharp. Every change is an item update with `supersedes`, so it's auditable and reversible.

## 8. Claude-first iteration (2026-11-11)

Scope for now: **Claude first, OpenCode second** (to discuss), Codex and agy off. Decisions:

1. **`AGENTS.md` is native.** A workspace's root `AGENTS.md` reaches every agent without bizzi; nested ones are picked up as agents work in those directories. bizzi never copies `AGENTS.md` into its store.
   - Claude Code (docs, checked 2026-11-11): the fallback is **project-level only**: `AGENTS.md` in the working directory and its parents when there's no `CLAUDE.md`; a subdirectory's `AGENTS.md` loads when Claude reads a file there, unless that directory has a `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`. `@path` imports inside `AGENTS.md` are expanded. Setting: `/config` → Project instructions (`claude-md-or-agents-md` default, `claude-md-and-agents-md`, `claude-md`, `managed-only`).
   - **Unverified for the Agent SDK**, which is what bizzi uses: the SDK docs cover `CLAUDE.md` through `settingSources` but don't mention the `AGENTS.md` fallback. Spike §11.6.
   - Auto-memory is loaded by the SDK regardless of `settingSources`.
2. **Claude memories are observed, not converted.**
   - Claude already reads its own auto-memory natively (the adapter starts sessions with `settingSources: ['user', 'project', 'local']`), so bizzi adds nothing for Claude.
   - The harvester mirrors each Claude memory into the bizzi store **as a memory** (never a rule suggestion), so other agents get it through the digest and `memory_search`. Under the balanced preset these are live at project scope: no inbox items.
   - Harvest runs when a workspace is added, on node start, and on a watch of the memory directory (so memories from a plain `claude` in a terminal aren't missed), not only when a bizzi Claude session ends.
   - Claude sessions don't get Claude-harvested memories from the same machine in their digest (they'd see them twice).
   - **"Add to AGENTS.md…"** (one-time, explicit): pick memories, preview the diff to the workspace's `AGENTS.md` (appended under a heading you choose), write. bizzi never commits; the picked memories get a `promoted` tag so they aren't offered again.

## 9. Machine and global rules

Rules above the project level, which only bizzi can provide because native instruction files are per machine and per agent.

Example: the laptop has production access (kube contexts, VPN, prod credentials), and production investigations always happen there. The mac mini has a GUI (Xcode, simulators, headed browsers) and will never have production access. Some rules hold everywhere ("never push to main without asking").

### 9.1 Scopes

| Scope | Applies to | Example |
|---|---|---|
| `global` | every machine, every project | "Never add AI attribution to commits." |
| `tag` *(new)* | every machine with that tag | `prod-access`: "Prod clusters: read-only kubectl, always pass `--context`." |
| `machine` | one machine, every project | mac-mini: "Use the iPhone 17 simulator for UI checks; take screenshots of what you build." |
| `project`, `workspace`, `session` | as before (§2.1) | |

- **Tags** are user-set labels on a machine (`machine.tags`, already in the model; add a `machine.setTags` method and UI on the machine page). Suggested tags come from facts (`gui` when headful, `always-on`), but a tag like `prod-access` is yours to set: bizzi can't detect it.
- **Machine × project** ("on the mac mini, in acme, use the iPhone 17 simulator") is a `workspace` rule: a workspace is one project on one machine.
- Order of injection, general first: global → tag → machine → project → workspace → session, with the existing line that more specific scopes override.

### 9.2 Machine card (generated, not a rule)

Every session gets a short generated block about where it runs, built from facts the node already has: machine name, OS, GUI or headless, always-on or sleeps, tags, and the user's one-paragraph machine description (a free-text field on the machine page). This answers "where am I?" without the user writing a rule, and keeps it current when facts change.

### 9.3 Capabilities: what a machine is for

"No production access" on the mac mini isn't a restriction to enforce; it's a fact about the machine, like "has a GUI". Facts decide **where work goes**; rules decide **how work is done** once it's there.

- A machine's capabilities are its tags plus its description: `gui`, `always-on`, `gpu` (suggested from facts) and ones only you know (`prod-access`). The mac mini simply doesn't have `prod-access`.
- **Routing preferences** live on the user, not on a session: "production investigations → the machine tagged `prod-access`", "UI work and screenshots → `gui`", "long test runs → `always-on`". They're used by one-pane mode ([spec.md](spec.md) §11.2) and, later, by cross-machine helpers (spec §12.4).
- The machine card (§9.2) tells an agent what its machine is for, so an agent on the mac mini asked for a prod investigation can say "that belongs on the laptop" instead of trying.

### 9.4 Replication (not built yet; needed for any of this to work across machines)

Today every node has its own knowledge store, so a global rule written on the laptop never reaches the mac mini.

- Through the hub, append-only with HLC ordering and tombstones (the fields exist already): `global` and `tag` items go to every node; `machine` items go to their machine; project/workspace items to the nodes hosting that project.
- The hub keeps a copy so any client (phone included) can edit any scope; edits to an offline machine's rules apply when it reconnects.
- A node works offline from its local copy; local edits queue in the outbox.

### 9.5 Delivery

- **Launch mode** (sessions bizzi starts): the resolver already includes global and machine items; add `tag` and the machine card. Injected via `systemPrompt.append`.
- **Native sessions** (plain `claude` in a terminal; opt-in): project global + tag + machine rules into a managed block (§4.2) in the machine's user-level instruction file, so they apply outside bizzi too. The file is **`~/.claude/CLAUDE.md`**: Claude reads it, and OpenCode uses it as its global file when there's no `~/.config/opencode/AGENTS.md`. `~/.claude/AGENTS.md` isn't a documented user-level file for Claude (checked 2026-11-11), so bizzi doesn't rely on it. The user's own text outside the block is never touched.
- **Where you author:** global and tag rules on the Knowledge page; machine rules and the machine description on the machine page.

## 10. Team (later)

`team` scope; project rules and memories shared with members; personal ones stay personal; team-scope writes always go to review by a maintainer. Promote a personal project rule to team or to `AGENTS.md` with one action.

## 11. Spikes

1. Claude via the SDK: `systemPrompt.append` + injected MCP + skills symlink; what auto-memory files look like for the harvester.
2. Codex: per-session instruction + MCP injection without touching `~/.codex` (`-c` overrides vs a `CODEX_HOME` overlay).
3. Ambient MCP: does each agent spawn user-level MCP servers with the project cwd, or send MCP roots, so scope resolution works?
4. agy: `.agents/rules/*.md` pickup; per-project MCP.
5. Adoption: how often each agent calls `memory_search` / `memory_add` unprompted, and which tool-description wording works best.
6. Claude Agent SDK: with `settingSources: ['user', 'project', 'local']`, does a session load the project `AGENTS.md` fallback (no `CLAUDE.md`) and nested `sub/AGENTS.md` on read? Codeword test, `BIZZI_LIVE=1`.
7. OpenCode: does it expand `@path` imports in `~/.claude/CLAUDE.md` (e.g. `@RTK.md`) when it uses that file as its global fallback?
