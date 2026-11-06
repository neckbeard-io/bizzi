# @bizzi/pty

Terminal mode for bizzi: a PTY host plus terminal-mode `AgentAdapter`s for `shell`, `agy`, `claude`, `codex` and `opencode`. Terminal mode is the fallback for every agent and the only mode agy has (spec §6.4, §6.6).

```ts
import { createAdapters, TerminalHost } from '@bizzi/pty';

const adapters = createAdapters();           // [shell, agy, claude, codex, opencode]
const host = TerminalHost.spawn({ command: 'bash', cwd: '/tmp' });
host.onOutput((chunk) => /* Buffer */ {});
```

## PTY library: `@lydell/node-pty@1.1.0`

The target was `node-pty@1.1.0`. It loads on Node 26 / macOS arm64, but it doesn't work out of the box here:

- **npm 11 blocks its install scripts** (`allowScripts`). Approving them would mean editing the root `package.json`.
- **Its prebuilt `spawn-helper` ships without the executable bit**, so every spawn fails with `posix_spawnp failed.` The install scripts don't fix that either.
- **There are no Linux prebuilds**, so it falls back to `node-gyp rebuild`, which needs python3, make and g++ in the Debian image.

`@lydell/node-pty@1.1.0` is the same upstream 1.1.0 code. Each platform's binaries come in their own optional dependency (`@lydell/node-pty-{darwin,linux,win32}-{x64,arm64}`), with correct file modes and **no install scripts**. It installs cleanly under npm 11 and was verified on Node 26.7 / macOS arm64. The API and typings are identical, so switching back is a one-line import change once upstream ships Linux prebuilds and fixed modes (upstream `1.2.0-beta.18` already does). `@homebridge/node-pty-prebuilt-multiarch` was rejected because it also relies on install scripts (prebuild-install).

**Linux:** the `linux-x64` and `linux-arm64` prebuilds are glibc builds, so they work in a Debian image with no toolchain. Alpine/musl isn't covered and would need a `node-gyp` build.

## TerminalHost

`TerminalHost.spawn({ command, args, cwd, env, cols, rows })` starts a process in a PTY with `TERM=xterm-256color` (and `COLORTERM=truecolor`), and reads raw bytes (`encoding: null`).

- **Output coalescing:** output is flushed after 16 ms or 32 KiB (`coalesceMs`, `coalesceBytes`) and delivered to `onOutput`.
- **Scrollback:** a 2 MiB ring buffer (`scrollbackBytes`) with absolute byte offsets. `scrollback(from?)` returns its contents.
- **Control:** `write`, `resize`, `kill(signal = 'SIGHUP')` (escalates to SIGKILL after `killTimeoutMs`), `onExit`/`exitPromise`. Exit reports `{ exitCode }` or `{ exitCode: null, signal: 'SIGINT' }`.

## Adapters

`capabilities()` always reports `modes: ['terminal']` and `terminal: true`, with `interrupt: true` (Ctrl-C). Every structured feature is off: no streaming, steer, approvals, todos or usage. The only extras are launch-time options that are actually passed as flags: claude permission modes, effort, MCP and instruction injection, plus opencode `auto`. `resumeAfterNodeRestart` is true when the supervisor is enabled (the default on POSIX).

| agent | binary | launch mapping | verified |
|---|---|---|---|
| shell | `$SHELL -l`, falling back to `/bin/bash`, then `/bin/sh` | none | yes |
| claude | `claude` | `--session-id <uuid>` (fresh start, so the ref is known), `--resume <id>`, `--model`, `--permission-mode`, `--effort`, `--append-system-prompt`, `--mcp-config <json>`. Unsets `CLAUDECODE` (nested-session guard) | `claude --help` 2.1.311; the TUI was started in a PTY (live test) |
| opencode | `opencode` | `--session <id>`, `--auto` for permissionMode `auto`. The v2 TUI has no model flag, so model is ignored | `opencode --help` 2.0.25; the TUI was started in a PTY |
| codex | `codex` | `resume <id>`, `--model`, `-c model_reasoning_effort="…"`, `--ask-for-approval` or `--sandbox` (picked by value) | **unverified** (not installed) |
| agy | `agy` | `--conversation <id>`, `--effort`, `--mode plan` | **unverified** (not installed; flags from spec §6.7) |

Options that can't be mapped are logged and ignored.

**probe():** looks for the binary on `PATH`, then in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin` (plus `~/.claude/local` for claude), and runs `--version` with a 5 s timeout. Auth is always `'unknown'`. If `--version` exits with 127, the binary is reported as not installed: that is how wrapper shims (e.g. cmux's `codex`/`agy`) behave when the real binary is missing. probe never throws.

**send(turnId, input)** is best effort. It types the text blocks (file blocks become the path, or `@path` for claude), then presses Enter (`\r`) after `submitDelayMs` (80 ms). When the app has enabled bracketed paste (`ESC[?2004h`, which Claude's TUI does), the text is sent as a paste, so newlines don't submit early. The turn completes with `stopReason: 'end_turn'` once output goes idle. If the process exits first, it completes as `error`, or as `end_turn` when the exit code is 0. bizzi can't really know whether the agent has finished; "quiet for N seconds" is the proxy.

**Other calls:**
- **interrupt():** writes Ctrl-C and completes any in-flight turn as `interrupted`. The bytes sent are configurable per agent via `TerminalAgentSpec.interruptSequence`.
- **respondApproval():** throws `BizziError('unsupported')`. Approvals are answered in the terminal.
- **writeTerminal / resizeTerminal:** raw input and resize.
- **stop():** sends SIGHUP, then SIGKILL; it is idempotent.
- **detach():** not part of the contract. It disconnects without killing, so the session can be reattached later.

## Activity heuristics

`ActivityMonitor`:

1. A burst starts with the first output after a quiet period. Small output within 150 ms of user keystrokes counts as echo and doesn't start a burst. `send()` starts a burst explicitly.
2. When output has been quiet for `idleMs` (default 3000 ms), the adapter completes the in-flight turn and then emits `session.status { status: 'waiting_input', reason }`.
3. If output resumes while no turn is in flight, it emits `session.status running` (reason `terminal output`).

Detectors run on the ANSI-stripped text of the current burst. Cursor moves are mapped to whitespace so that words drawn with `CSI n G` (Claude's renderer) still match. When a detector matches, the quiet period shrinks to `settleMs` (500 ms), and the reason becomes `approval:<id>` or `input:<id>`. Pass your own list with the `detectors` option; `regexDetector()` helps build them.

| id | agent | kind | pattern | status |
|---|---|---|---|---|
| claude-permission | claude | approval | "Do you want to proceed? / make this edit / create / allow / overwrite" | from Claude Code 2.x UI, untested |
| claude-trust | claude | approval | "Yes, I trust this folder" | captured from claude 2.1.311 |
| claude-input | claude | input | "? for shortcuts" | unverified |
| codex-approval | codex | approval | "Would you like to run the following command? / make the following edits?", "Allow command?", "Yes, proceed" | unverified |
| codex-input | codex | input | "Ask Codex to do anything", "⏎ send" | unverified |
| agy-approval | agy | approval | "Allow execution / Allow once / Apply this change? / Waiting for user confirmation" | unverified (Gemini-CLI-style guess) |
| yes-no | all | approval | last line ends with `[y/N]` or `(yes/no)` | generic |
| press-enter | all | input | "Press Enter to continue" | generic |
| shell-prompt | shell | input | last line ends with `$ % # > ❯ ➜` | generic |

The approval detectors only affect the `waiting_input` reason. They never emit `approval.requested`, because there is no structured way to answer one.

## PTY supervisor (implemented)

With `supervisor` enabled (the default on POSIX), each session's PTY is owned by a small detached Node process, `src/supervisor.ts`. It is spawned with `detached: true` (so it gets its own session via setsid) and listens on `<runtimeDir>/<id>.sock`.

- **Runtime dir:** `$XDG_RUNTIME_DIR/bizzi-pty`, falling back to `<tmpdir>/bizzi-pty-<uid>`. The dir is mode 0700 and the socket 0600.
- **Startup:** the spec, including the environment, is handed over in a 0600 file that the supervisor deletes on startup. `<id>.json` holds status and exit information, but no environment.
- **Wire format:** newline-delimited JSON. The client sends `attach`, `input`, `resize`, `kill` and `ack`. The supervisor sends `hello`, `replay`…, `replayed`, then live `data`, then `exit`.
- **Session ref:** `agentSessionRef` is `pty:<id>` or `pty:<id>:<nativeRef>` (e.g. claude's session UUID). Passing it back as `resumeRef` reattaches.
- **Replay on reattach:** the client acks each output chunk after emitting it, so a reattaching node emits only the output the previous node never delivered (`replayOnReattach: 'missed'`). If those bytes have already fallen out of the ring, it emits a terminal reset (`ESC c`) plus the whole scrollback instead. `'full'` and `'none'` are also available. `TerminalSession.host.scrollback()` always holds the full ring.
- **Supervisor gone:**
  - If the meta file shows the process exited while no node was attached, start returns a dead session that emits `term.exited` and `ended`/`failed`.
  - If the supervisor is gone without a trace (e.g. after a reboot), start launches a fresh process. When the ref carries a native id, it resumes the agent session natively. It also emits a non-fatal `error` with code `pty_lost`.
- **Lifetime:** after the child exits, the supervisor waits for a client to collect the exit, or for `lingerMs` (10 min) to pass. `orphanTimeoutMs` (default 0, meaning never) kills PTYs that no node has reattached to. `listSupervisors(dir)` supports discovery and garbage collection.
- **Platform notes:**
  - Under launchd, the node's job should set `AbandonProcessGroup` so launchd doesn't reap supervisors when the job stops.
  - Under Electron, the supervisor runs with `ELECTRON_RUN_AS_NODE=1`.
  - The supervisor runs `src/supervisor.ts` through Node's type stripping, which doesn't work inside `node_modules`. If the package is ever bundled, pass `supervisor.script`.
  - PTYs in a Linux container still die with the container (topology §4).

## Tests

`npm test -w @bizzi/pty` runs offline. It covers the ring buffer, the coalescer, ANSI stripping, the detectors and the idle monitor, then spawns `bash` through the adapter: output, input, resize, exit code, `send()` turns, interrupt, stop and probe. The supervisor tests cover detach and reattach, a node killed with SIGKILL followed by missed-output replay, an exit while detached, and a lost supervisor. `BIZZI_LIVE=1` also starts each installed agent's TUI in a PTY.

## Proposed protocol changes

1. **`session.status` from adapters:** allow terminal adapters to emit `running`. Today the comment allows only `failed`, `ended` and `waiting_input`, but raw typing in a terminal has no `turn.started` to flip the status back.
2. **Terminal approval hint:** add an optional `hint` to `session.status` (`'approval' | 'input' | 'login'`), or a dedicated `term.prompt` event, so UIs can surface "the TUI is asking for approval" without a structured `approval.requested`. Today it's encoded in `reason`.
3. **Reattach semantics:** document `agentSessionRef` for terminal sessions as an opaque reattach token (`pty:<id>[:<native>]`), rather than strictly "the agent's own id". Alternatively, add a separate `reattachRef` to `session.info`.
4. **Scrollback snapshots:** add a method or event for scrollback snapshots (e.g. `term.snapshot`, or `term.open { since }` from spec §5.2). A client joining a long session could then fetch the 2 MiB ring instead of replaying every `term.output` event.
