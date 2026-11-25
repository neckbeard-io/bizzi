// Mock provisioning: agents.list per machine, agent.plan / install (with install.progress), login, secrets.
import { BizziError, GLOBAL_CHANNEL } from '@bizzi/protocol';
import type { AgentKind, AgentListing, InstallAction, InstallPlan, InstallStep, MachineInfo, RestartPolicy, SecretInfo, UpdatePolicy } from '@bizzi/protocol';
import { AGENTS, MACHINE, MINI, MINI_AGENTS, SERVER, SERVER_AGENTS } from './fixtures.ts';
import type { MockHost, MockModule } from './host.ts';

const LATEST: Record<Exclude<AgentKind, 'shell' | 'api'>, string> = { claude: '2.4.3', codex: '0.99.1', opencode: '2.1.0', agy: '0.9.2' };

const BIN_PATH: Record<Exclude<AgentKind, 'shell' | 'api'>, (m: MachineInfo) => string> = {
  claude: (m) => (m.os === 'darwin' ? '/Users/dev/.local/bin/claude' : '/home/dev/.local/bin/claude'),
  codex: (m) => (m.os === 'darwin' ? '/opt/homebrew/bin/codex' : '/home/dev/.bizzi/node/bin/codex'),
  opencode: (m) => (m.os === 'darwin' ? '/Users/dev/.opencode/bin/opencode' : '/home/dev/.opencode/bin/opencode'),
  agy: (m) => (m.os === 'darwin' ? '/opt/homebrew/bin/agy' : '/home/dev/.local/bin/agy'),
};

const ACCOUNT: Record<Exclude<AgentKind, 'shell' | 'api'>, string> = {
  claude: 'dev@example.com (Max)',
  codex: 'dev@example.com (ChatGPT Plus)',
  opencode: 'dev@example.com',
  agy: 'dev@example.com (Google)',
};

const step = (id: string, title: string, command?: string, requiresSudo?: boolean): InstallStep => {
  const s: InstallStep = { id, title };
  if (command) s.command = command;
  if (requiresSudo) s.requiresSudo = true;
  return s;
};

/** Recipes per agent × action × OS (see docs/spec.md §7). */
export function mockPlan(agent: AgentKind, action: InstallAction, m: MachineInfo, method?: string, current?: AgentListing): InstallPlan {
  if (agent === 'shell' || agent === 'api') throw new BizziError('unsupported', `${agent === 'api' ? 'API chat' : 'the shell'} is built in; nothing to install`);
  const mac = m.os === 'darwin';
  const plan = (method: string, steps: InstallStep[], notes?: string[]): InstallPlan => (notes ? { target: agent, action, method, steps, notes } : { target: agent, action, method, steps });
  switch (agent) {
    case 'claude':
      if (action === 'install')
        return plan(
          'installer',
          [
            step('download', 'Download and run the native installer', 'curl -fsSL https://claude.ai/install.sh | bash'),
            step('path', 'Add ~/.local/bin to the PATH of non-interactive shells', `bizzi env path add ~/.local/bin --service ${mac ? 'launchd' : 'systemd'}`),
            step('verify', 'Verify the binary', 'claude --version'),
          ],
          ['Per-user install, no sudo.', 'Claude Code updates itself; bizzi can pin a version instead.'],
        );
      if (action === 'update') return plan('installer', [step('update', 'Run the built-in updater', 'claude update'), step('verify', 'Verify the binary', 'claude --version')]);
      return plan('installer', [step('remove', 'Remove the binary and its versions', 'rm -f ~/.local/bin/claude && rm -rf ~/.local/share/claude'), step('verify', 'Check it is gone', 'command -v claude || true')], [
        'Your login and ~/.claude settings are kept.',
      ]);
    case 'codex': {
      const via = method ?? (mac ? 'brew' : 'npm');
      if (via === 'brew') {
        if (action === 'install') return plan('brew', [step('brew', 'Install with Homebrew', 'brew install codex'), step('verify', 'Verify the binary', 'codex --version')]);
        if (action === 'update') return plan('brew', [step('brew', 'Upgrade with Homebrew', 'brew upgrade codex'), step('verify', 'Verify the binary', 'codex --version')]);
        return plan('brew', [step('brew', 'Uninstall with Homebrew', 'brew uninstall codex')], ['~/.codex (config and login) is kept.']);
      }
      if (action === 'install')
        return plan(
          'npm',
          [
            step('node', 'Install a managed Node.js 24 (per user)', 'bizzi provision node --version 24'),
            step('npm', 'Install the Codex CLI', 'npm i -g @openai/codex'),
            step('path', 'Expose it to non-interactive shells', 'bizzi env path add ~/.bizzi/node/bin'),
            step('verify', 'Verify the binary', 'codex --version'),
          ],
          ['Node.js is not installed on this machine; bizzi installs its own copy under ~/.bizzi/node.'],
        );
      if (action === 'update') return plan('npm', [step('npm', 'Update the Codex CLI', 'npm i -g @openai/codex@latest'), step('verify', 'Verify the binary', 'codex --version')]);
      return plan('npm', [step('npm', 'Remove the Codex CLI', 'npm rm -g @openai/codex')], ['~/.codex (config and login) is kept.']);
    }
    case 'opencode':
      if (action === 'install')
        return plan('script', [step('script', 'Run the install script', 'curl -fsSL https://opencode.ai/install | bash'), step('verify', 'Verify the binary', 'opencode --version')]);
      if (action === 'update' && current?.version?.startsWith('1.'))
        return plan(
          'script',
          [step('upgrade', 'Upgrade to OpenCode v2', 'opencode upgrade --major'), step('service', 'Restart the background service', 'opencode service restart'), step('verify', 'Verify the binary', 'opencode --version')],
          ['v2 keeps your providers and sessions; v1-only plugins need updating.', 'Sessions running on v1 restart on v2 at their next safe point.'],
        );
      if (action === 'update') return plan('script', [step('upgrade', 'Upgrade in place', 'opencode upgrade'), step('verify', 'Verify the binary', 'opencode --version')]);
      return plan('script', [step('remove', 'Remove the install directory', 'rm -rf ~/.opencode')]);
    case 'agy':
      if (!mac) {
        if (action === 'uninstall') return plan('script', [step('remove', 'Remove the binary', 'rm -f ~/.local/bin/agy')]);
        return plan(
          'script',
          [
            step('deps', 'Install system libraries for the TUI', 'apt-get install -y libsecret-1-0', true),
            step('script', 'Run the install script', 'curl -fsSL https://antigravity.google/cli/install.sh | sh'),
            step('verify', 'Verify the binary', 'agy --version'),
          ],
          ['This machine is headless: Google sign-in needs a browser, so set a GEMINI_API_KEY under API keys instead.'],
        );
      }
      if (action === 'install')
        return plan(
          'brew',
          [
            step('tap', 'Add the Antigravity tap', 'brew tap google/antigravity'),
            step('brew', 'Install with Homebrew', 'brew install antigravity-cli'),
            step('verify', 'Verify the binary', 'agy --version'),
          ],
          ['agy runs in terminal mode only (no structured events yet).'],
        );
      if (action === 'update') return plan('brew', [step('brew', 'Upgrade with Homebrew', 'brew upgrade antigravity-cli'), step('verify', 'Verify the binary', 'agy --version')]);
      return plan('brew', [step('brew', 'Uninstall with Homebrew', 'brew uninstall antigravity-cli')]);
  }
}

/** spec §7 "Install method and migration": switch an adopted install to the recipe's preferred method. */
export function mockMigratePlan(agent: AgentKind, m: MachineInfo, current: AgentListing | undefined): InstallPlan {
  if (agent !== 'claude') throw new BizziError('unsupported', `${agent} has no preferred method to migrate to`);
  const from = current?.method ?? 'brew';
  const remove = from === 'npm' ? 'npm rm -g @anthropic-ai/claude-code' : 'brew uninstall --cask claude-code';
  return {
    target: agent,
    action: 'install',
    method: 'installer',
    steps: [
      step('native', 'Install with the native installer', 'curl -fsSL https://claude.ai/install.sh | bash'),
      step('pathorder', 'Put ~/.local/bin first on PATH for login and non-interactive shells', `bizzi env path add ~/.local/bin --first --service ${m.os === 'darwin' ? 'launchd' : 'systemd'}`),
      step('reprobe', 'Re-probe the binary and the login', 'claude --version && claude auth status'),
      step('cleanup', `Remove the ${from} install once no session uses it`, remove),
    ],
    notes: ['Your login lives in ~/.claude and the keychain, not next to the binary, so it carries over.', 'The native install updates itself.'],
  };
}

/** Fake output per step, so the progress log reads like a real run. */
const STEP_MESSAGES: Record<string, string> = {
  download: 'Downloading claude 2.4.3 for this platform (38 MB)…',
  path: 'Updated the service environment',
  verify: 'Version check passed',
  update: 'Downloading the latest release…',
  remove: 'Removed',
  brew: '==> Pouring bottle…',
  tap: '==> Tapping google/antigravity',
  node: 'Downloading node-v24.11.0 (29 MB)…',
  npm: 'added 1 package in 6s',
  script: 'Installing to ~/.local/bin…',
  upgrade: 'Fetching the latest release…',
  deps: 'Reading package lists…',
  native: 'Installing claude 2.4.3 to ~/.local/bin…',
  pathorder: 'PATH order checked for zsh, launchd',
  reprobe: 'claude 2.4.3 · signed in as dev@example.com (Max)',
  cleanup: '==> Uninstalling Cask claude-code',
  service: 'Restarted opencode.service',
};

interface LoginRun {
  machineId: string;
  agent: Exclude<AgentKind, 'shell' | 'api'>;
  line: string;
  done: boolean;
}

export class MockProvision implements MockModule {
  private readonly host: MockHost;
  /** Mutable probe results per machine. */
  readonly agents = new Map<string, AgentListing[]>();
  readonly secrets = new Map<string, SecretInfo[]>();
  private jobCounter = 0;

  constructor(host: MockHost) {
    this.host = host;
    this.agents.set(MACHINE.id, AGENTS.map((a) => ({ ...a })));
    this.agents.set(SERVER.id, SERVER_AGENTS.map((a) => ({ ...a })));
    this.agents.set(MINI.id, MINI_AGENTS.map((a) => ({ ...a })));
    this.secrets.set(MACHINE.id, [{ agent: 'claude', name: 'ANTHROPIC_API_KEY', setAt: new Date(Date.now() - 3 * 86400_000).toISOString() }]);
    if (host.demo.has('install')) {
      setTimeout(() => {
        const m = host.machines().find((x) => x.id === MACHINE.id);
        if (m) void this.runJob('job_demo', m, 'agy', 'install', mockPlan('agy', 'install', m), 2500, 6);
      }, 600);
    }
    if (host.demo.has('login')) this.startLogin(MACHINE.id, 'codex', 's_login', 2000);
  }

  handles(method: string): boolean {
    return method === 'agents.list' || (method.startsWith('agent.') && method !== 'agent.raw');
  }

  async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    const m = this.host.requireOnline(params.machineId);
    switch (method) {
      case 'agents.list': {
        await this.host.sleep(params.refresh ? 600 : 50);
        return { agents: (this.agents.get(m.id) ?? []).map((a) => ({ ...a })) };
      }
      case 'agent.plan': {
        await this.host.sleep(250);
        const agent = this.agentParam(params);
        return { plan: mockPlan(agent, this.actionParam(params), m, typeof params.method === 'string' ? params.method : undefined, this.listing(m.id, agent)) };
      }
      case 'agent.migrate': {
        const agent = this.agentParam(params);
        const listing = this.listing(m.id, agent);
        if (!listing?.installed) throw new BizziError('conflict', `${agent} is not installed`);
        if (!listing.remedies?.some((r) => r.kind === 'migrate')) throw new BizziError('conflict', `${agent} already uses the preferred install method`);
        await this.host.sleep(250);
        const plan = mockMigratePlan(agent, m, listing);
        const jobId = `job_${(++this.jobCounter).toString(36)}${Date.now().toString(36).slice(-4)}`;
        if (params.dryRun !== true) setTimeout(() => void this.runJob(jobId, m, agent, 'migrate', plan, 1000), 0);
        return { jobId, plan };
      }
      case 'agent.policy.set': {
        const agent = this.agentParam(params);
        if (!this.listing(m.id, agent)) throw new BizziError('not_found', `${agent} is unknown on ${m.name}`);
        const update = params.update as UpdatePolicy | undefined;
        const restart = params.restart as RestartPolicy | undefined;
        if (update !== undefined && !['auto', 'notify', 'pinned'].includes(update)) throw new BizziError('bad_request', `unknown update policy: ${String(update)}`);
        if (restart !== undefined && !['when-idle', 'ask', 'manual'].includes(restart)) throw new BizziError('bad_request', `unknown restart policy: ${String(restart)}`);
        this.patchListing(m.id, agent, (l) => ({ ...l, ...(update ? { updatePolicy: update } : {}), ...(restart ? { restartPolicy: restart } : {}) }));
        return { agent: { ...this.listing(m.id, agent) } };
      }
      case 'agent.install': {
        const agent = this.agentParam(params);
        const action = this.actionParam(params);
        const listing = this.listing(m.id, agent);
        if (action === 'install' && listing?.installed) throw new BizziError('conflict', `${agent} is already installed`);
        if (action !== 'install' && !listing?.installed) throw new BizziError('conflict', `${agent} is not installed`);
        const plan = mockPlan(agent, action, m, typeof params.method === 'string' ? params.method : undefined, listing);
        const jobId = `job_${(++this.jobCounter).toString(36)}${Date.now().toString(36).slice(-4)}`;
        if (params.dryRun !== true) setTimeout(() => void this.runJob(jobId, m, agent, action, plan, 1000), 0);
        return { jobId, plan };
      }
      case 'agent.login': {
        const agent = this.agentParam(params);
        if (agent === 'shell' || agent === 'api') throw new BizziError('unsupported', `${agent === 'api' ? 'API chat uses API keys (secrets), not a' : 'the shell has no'} login`);
        if (!this.listing(m.id, agent)?.installed) throw new BizziError('agent_unavailable', `${agent} is not installed on ${m.name}`);
        const session = this.startLogin(m.id, agent, undefined, 800);
        return { session: { ...session } };
      }
      case 'agent.secrets': {
        const list = this.secrets.get(m.id) ?? [];
        return { secrets: (params.agent ? list.filter((s) => s.agent === params.agent) : list).map((s) => ({ ...s })) };
      }
      case 'agent.setSecret': {
        const agent = this.agentParam(params);
        const name = String(params.name ?? '').trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new BizziError('bad_request', 'name must be an environment variable name');
        if (!String(params.value ?? '')) throw new BizziError('bad_request', 'value is empty');
        const list = (this.secrets.get(m.id) ?? []).filter((s) => !(s.agent === agent && s.name === name));
        list.push({ agent, name, setAt: new Date().toISOString() });
        this.secrets.set(m.id, list);
        return {};
      }
      case 'agent.deleteSecret': {
        const agent = this.agentParam(params);
        const name = String(params.name ?? '');
        const list = this.secrets.get(m.id) ?? [];
        if (!list.some((s) => s.agent === agent && s.name === name)) throw new BizziError('not_found', `no secret ${name} for ${agent}`);
        this.secrets.set(
          m.id,
          list.filter((s) => !(s.agent === agent && s.name === name)),
        );
        return {};
      }
      default:
        throw new BizziError('unsupported', `mock does not implement ${method}`);
    }
  }

  private agentParam(params: Record<string, unknown>): AgentKind {
    const a = String(params.agent ?? '');
    if (!['claude', 'codex', 'opencode', 'agy', 'shell'].includes(a)) throw new BizziError('bad_request', `unknown agent: ${a}`);
    return a as AgentKind;
  }

  private actionParam(params: Record<string, unknown>): InstallAction {
    const a = String(params.action ?? '');
    if (a !== 'install' && a !== 'update' && a !== 'uninstall') throw new BizziError('bad_request', `unknown action: ${a}`);
    return a;
  }

  private listing(machineId: string, agent: AgentKind): AgentListing | undefined {
    return this.agents.get(machineId)?.find((a) => a.agent === agent);
  }

  private patchListing(machineId: string, agent: AgentKind, fn: (a: AgentListing) => AgentListing): void {
    const list = this.agents.get(machineId);
    if (!list) return;
    this.agents.set(
      machineId,
      list.map((a) => (a.agent === agent ? fn(a) : a)),
    );
  }

  private progress(jobId: string, agent: AgentKind, data: { stage: string; message?: string; step?: number; total?: number; done?: boolean; ok?: boolean }): void {
    this.host.emit(GLOBAL_CHANNEL, { type: 'install.progress', data: { agent, jobId, ...data } });
  }

  /** Sessions of `agent` on a machine whose process runs another version than `version` (updates.md §2). */
  staleCount(machineId: string, agent: AgentKind, version: string | undefined): number {
    return this.host.sessions().filter((x) => x.machineId === machineId && x.agent === agent && x.status !== 'ended' && x.agentVersion !== undefined && x.agentVersion !== version).length;
  }

  /** Re-derive `staleSessions` for an agent (after an update or a session restart). */
  refreshStale(machineId: string, agent: AgentKind): void {
    this.patchListing(machineId, agent, (l) => ({ ...l, staleSessions: this.staleCount(machineId, agent, l.version) }));
  }

  private async runJob(jobId: string, m: MachineInfo, agent: AgentKind, action: InstallAction | 'migrate', plan: InstallPlan, stepMs: number, minSteps = 0): Promise<void> {
    // The demo job pads the plan with a resolve step so it runs long enough to be seen mid-way.
    const steps = [...plan.steps];
    while (steps.length < minSteps) steps.unshift(step(`resolve${steps.length}`, steps.length % 2 ? 'Check prerequisites' : 'Resolve the latest version'));
    const total = steps.length;
    this.progress(jobId, agent, { stage: 'Starting', message: `${plan.method} · ${total} steps`, step: 0, total });
    for (let i = 0; i < total; i++) {
      await this.host.sleep(stepMs * (i === 0 ? 0.4 : 1));
      const s = steps[i];
      if (!s) continue;
      this.progress(jobId, agent, { stage: s.title, message: s.command ? `$ ${s.command}` : (STEP_MESSAGES[s.id] ?? 'Working…'), step: i + 1, total });
      await this.host.sleep(stepMs * 0.5);
      const detail = STEP_MESSAGES[s.id.replace(/\d+$/, '')];
      if (detail) this.progress(jobId, agent, { stage: s.title, message: detail, step: i + 1, total });
    }
    await this.host.sleep(stepMs * 0.4);
    const a = agent as Exclude<AgentKind, 'shell' | 'api'>;
    if (action === 'uninstall') {
      this.patchListing(m.id, agent, (l) => ({ agent: l.agent, installed: false, auth: 'missing', latestVersion: LATEST[a] }));
    } else if (action === 'migrate') {
      this.patchListing(m.id, agent, (l) => {
        const next: AgentListing = { ...l, method: plan.method, path: BIN_PATH[a](m), realPath: BIN_PATH[a](m), version: LATEST[a], latestVersion: LATEST[a], updateAvailable: false, onPath: true };
        next.remedies = (l.remedies ?? []).filter((r) => r.kind !== 'migrate');
        delete next.notes;
        return next;
      });
      this.refreshStale(m.id, agent);
    } else {
      this.patchListing(m.id, agent, (l) => {
        const next: AgentListing = { ...l, installed: true, version: LATEST[a], latestVersion: LATEST[a], updateAvailable: false, path: l.path ?? BIN_PATH[a](m), onPath: true };
        if (action === 'install') {
          next.auth = 'missing';
          next.notes = ['installed by bizzi; log in to use it'];
          next.method = plan.method;
        }
        if (l.support === 'unsupported') {
          next.support = 'ok';
          delete next.supportReason;
          next.remedies = (l.remedies ?? []).filter((r) => r.kind !== 'upgrade');
        }
        return next;
      });
      this.refreshStale(m.id, agent);
    }
    this.progress(jobId, agent, { stage: 'Done', message: `${agent} ${action === 'uninstall' ? 'removed' : action === 'migrate' ? `${LATEST[a]} via ${plan.method}` : LATEST[a]}`, step: total, total, done: true, ok: true });
  }

  /** A login flow as a terminal session that prints a URL + code and waits for the code to be pasted. */
  private startLogin(machineId: string, agent: Exclude<AgentKind, 'shell' | 'api'>, fixedId: string | undefined, promptDelayMs: number): ReturnType<MockHost['createSession']> {
    const host = this.host;
    const ws = host.workspaces().find((w) => w.machineId === machineId);
    const init: Parameters<MockHost['createSession']>[0] = { machineId, workspaceId: ws?.id ?? 'w_acme', agent, mode: 'terminal', title: `${agent} login`, status: 'running' };
    if (fixedId) init.id = fixedId;
    const session = host.createSession(init);
    const sid = session.id;
    const run: LoginRun = { machineId, agent, line: '', done: false };
    const code = agent === 'claude' ? null : `${randomBlock()}-${randomBlock()}`;
    const url =
      agent === 'claude'
        ? 'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=mock'
        : agent === 'codex'
          ? 'https://auth.openai.com/codex/device'
          : agent === 'opencode'
            ? 'https://opencode.ai/auth/device'
            : 'https://accounts.google.com/o/oauth2/device/usercode';
    host.termWrite(sid, `\x1b[2m$ ${agent} login\x1b[0m\r\n`);
    setTimeout(() => {
      if (agent === 'claude') {
        host.termWrite(sid, 'Opening your browser to sign in to Claude…\r\n\r\nBrowser didn\'t open? Use the URL below to sign in:\r\n\r\n');
      } else {
        host.termWrite(sid, `Sign in to ${agent} with a one-time code.\r\n\r\n1. Open this link in a browser on any device:\r\n`);
      }
      host.termWrite(sid, `\x1b[4;36m${url}\x1b[0m\r\n\r\n`);
      if (code) host.termWrite(sid, `2. Enter this code: \x1b[1;33m${code}\x1b[0m\r\n\r\n3. `);
      host.termWrite(sid, 'Paste the confirmation code shown in the browser: ');
      host.emitSession(sid, { type: 'login.prompt', data: { urls: [url], codes: code ? [code] : [], awaitingCodeInput: true } });
      host.emitSession(sid, { type: 'session.status', data: { status: 'waiting_input', prompt: 'login' } });
      host.setSessionStatus(sid, 'waiting_input');
    }, promptDelayMs * host.speed);
    host.onTermInput(sid, (data) => {
      if (run.done) return;
      let echo = '';
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          if (!run.line.trim()) continue;
          run.done = true;
          host.termWrite(sid, `${echo}\r\n\r\n\x1b[32m✔ Login successful.\x1b[0m Signed in as ${ACCOUNT[agent]}\r\n`);
          echo = '';
          void this.finishLogin(sid, run);
          break;
        }
        if (ch === '\x7f') {
          if (run.line) {
            run.line = run.line.slice(0, -1);
            echo += '\b \b';
          }
          continue;
        }
        if (ch >= ' ') {
          run.line += ch;
          echo += '*';
        }
      }
      if (echo) host.termWrite(sid, echo);
    });
    return session;
  }

  private async finishLogin(sid: string, run: LoginRun): Promise<void> {
    const host = this.host;
    host.setSessionStatus(sid, 'running');
    await host.sleep(500);
    this.patchListing(run.machineId, run.agent, (l) => {
      const next: AgentListing = { ...l, auth: 'ok', account: ACCOUNT[run.agent] };
      delete next.notes;
      return next;
    });
    host.emitSession(sid, { type: 'login.completed', data: { ok: true, account: ACCOUNT[run.agent] } });
    host.emitSession(sid, { type: 'term.exited', data: { exitCode: 0 } });
    host.emitSession(sid, { type: 'session.status', data: { status: 'ended', reason: 'login finished' } });
    host.setSessionStatus(sid, 'ended');
  }
}

function randomBlock(): string {
  const alphabet = 'BCDFGHJKLMNPQRSTVWXZ23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)] ?? 'X';
  return out;
}
