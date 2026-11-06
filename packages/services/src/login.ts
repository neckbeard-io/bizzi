// Login extension (spec §7): `agent.login` runs the recipe's login command in a terminal-mode
// session, turns URLs / one-time codes in its output into `login.prompt` events, and reports
// `login.completed` after re-probing auth when the command exits.

import { homedir } from 'node:os';
import { delimiter, isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { BizziError, sessionChannel, type AgentKind, type AgentProbe, type ChannelEvent, type LoginMode, type SessionInfo } from '@bizzi/protocol';
import {
  augmentedPath,
  findBinary,
  LoginPromptScanner,
  loginSpec,
  probe as provisionProbe,
  type LoginSpec,
  type ProbeOptions,
  type RecipeSet,
} from '@bizzi/provision';
import { asParams, checkMachine, oneOf, optInt, optString, reqAgent } from './params.ts';
import type { ExtensionContext, NodeExtension } from './types.ts';

const MODES = ['interactive', 'device-code', 'token'] as const satisfies readonly LoginMode[];
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;

export interface LoginOptions {
  recipes?: RecipeSet;
  /** Environment used to find the login binary and to probe auth (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Options for the auth re-probe after the command exits. */
  probeOptions?: ProbeOptions;
  /** Replace the auth re-probe (tests). */
  probe?: (agent: AgentKind) => Promise<AgentProbe>;
  /** Workspace used when `agent.login` names none (found or registered by path). Default: home dir. */
  workspacePath?: string;
}

export interface LoginCommand {
  argv: string[];
  /** Known localhost OAuth callback port of this flow (from the recipe). */
  callbackPort?: number;
  description: string;
}

/** The recipe command for a login mode. Throws `unsupported` when the recipe has none. */
export function loginCommand(agent: AgentKind, spec: LoginSpec, mode: LoginMode): LoginCommand {
  if (mode === 'interactive') {
    return {
      argv: [...spec.interactive.argv],
      description: spec.interactive.description,
      ...(spec.interactive.callbackPort !== undefined ? { callbackPort: spec.interactive.callbackPort } : {}),
    };
  }
  const kind = mode === 'device-code' ? 'device-code' : 'token-command';
  const h = spec.headless.find((x) => x.kind === kind && x.argv && x.argv.length > 0);
  if (!h?.argv) {
    const alternatives = spec.headless.map((x) => x.kind).join(', ') || 'none';
    throw new BizziError('unsupported', `${agent} has no ${mode} login (headless options: ${alternatives})`);
  }
  return { argv: [...h.argv], description: h.description };
}

interface Watch {
  unsubscribe(): void;
}

export interface LoginExtension extends NodeExtension {
  /** Resolves once every watched login session has reported login.completed. */
  idle(): Promise<void>;
}

export function createLoginExtension(opts: LoginOptions = {}): LoginExtension {
  const env = opts.env ?? process.env;
  const watches = new Set<Watch>();
  const finishing = new Set<Promise<void>>();

  const probeAuth = (agent: AgentKind): Promise<AgentProbe> =>
    opts.probe
      ? opts.probe(agent)
      : provisionProbe(agent, env, { latest: false, ...(opts.recipes ? { recipes: opts.recipes } : {}), ...opts.probeOptions });

  /** Resolve argv[0] on bizzi's augmented PATH so logins work under launchd/systemd too. */
  function resolveArgv(argv: string[]): string[] {
    const [bin, ...rest] = argv;
    if (!bin || isAbsolute(bin) || bin.includes('/')) return argv;
    const found = findBinary([bin], augmentedPath({ env }).split(delimiter).filter(Boolean));
    if (!found) throw new BizziError('agent_unavailable', `${bin} is not installed (install it first)`);
    return [found, ...rest];
  }

  async function loginWorkspace(ctx: ExtensionContext): Promise<string> {
    const path = opts.workspacePath ?? homedir();
    const { workspaces } = await ctx.node.call('workspaces.list', {});
    const existing = workspaces.find((w) => w.path === path);
    if (existing) return existing.id;
    const { workspace } = await ctx.node.call('workspace.create', { path, name: 'Home' });
    return workspace.id;
  }

  function watch(session: SessionInfo, agent: AgentKind, mode: LoginMode, cmd: LoginCommand, cols: number, ctx: ExtensionContext): void {
    const log = ctx.logger.child({ component: 'login', agent, sessionId: session.id });
    const scanner = new LoginPromptScanner({ cols });
    const decoder = new StringDecoder('utf8');
    const urls: string[] = [];
    const codes: string[] = [];
    let callbackPort: number | undefined;
    let awaitingCodeInput = false;
    let done = false;
    let sub: { unsubscribe(): void } | undefined;
    let unsubscribeWhenReady = false;
    const w: Watch = {
      unsubscribe() {
        if (sub) sub.unsubscribe();
        else unsubscribeWhenReady = true;
        watches.delete(w);
      },
    };
    watches.add(w);

    // Emitting from inside a bus listener would reorder events for other listeners; defer.
    const emit = (body: Parameters<ExtensionContext['emitSession']>[1]) =>
      queueMicrotask(() => {
        try {
          ctx.emitSession(session.id, body);
        } catch (err) {
          log.log('warn', 'could not emit login event', { type: body.type, err: String(err) });
        }
      });

    const onOutput = (dataBase64: string) => {
      const found = scanner.push(decoder.write(Buffer.from(dataBase64, 'base64')));
      let changed = false;
      for (const u of found.urls) {
        if (!urls.includes(u.url)) {
          urls.push(u.url);
          changed = true;
        }
        if (u.callbackPort !== undefined && callbackPort === undefined) callbackPort = u.callbackPort;
      }
      for (const c of found.codes) {
        if (!codes.includes(c.code)) {
          codes.push(c.code);
          changed = true;
        }
      }
      if (found.awaitingCodeInput && !awaitingCodeInput) {
        awaitingCodeInput = true;
        changed = true;
      }
      if (!changed) return;
      // The recipe's known callback port applies once the flow has shown its URL.
      const port = callbackPort ?? (urls.length > 0 && mode === 'interactive' ? cmd.callbackPort : undefined);
      emit({
        type: 'login.prompt',
        data: { urls: [...urls], codes: [...codes], ...(port !== undefined ? { callbackPort: port } : {}), awaitingCodeInput },
      });
    };

    const finish = (exit: { exitCode: number | null; signal?: string } | undefined, reason?: string) => {
      if (done) return;
      done = true;
      w.unsubscribe();
      const p = (async () => {
        let ok = false;
        let account: string | undefined;
        let message: string;
        if (!exit) {
          message = `login session ended before the command ran${reason ? ` (${reason})` : ''}`;
        } else if (exit.exitCode !== 0) {
          message = exit.signal ? `login cancelled (${exit.signal})` : `login command failed (exit code ${exit.exitCode})`;
        } else if (mode === 'token') {
          ok = true;
          message = 'token created; store it with agent.setSecret so sessions can use it';
        } else {
          let probed: AgentProbe | undefined;
          try {
            probed = await probeAuth(agent);
          } catch (err) {
            log.log('warn', 'auth probe after login failed', { err: String(err) });
          }
          const auth = probed?.auth ?? 'unknown';
          account = probed?.account;
          ok = auth !== 'missing' && auth !== 'expired';
          message = auth === 'ok' ? 'logged in' : auth === 'unknown' ? 'login command finished; auth state unknown' : `still not logged in (${auth})`;
        }
        ctx.emitSession(session.id, { type: 'login.completed', data: { ok, ...(account ? { account } : {}), message } });
        log.log(ok ? 'info' : 'warn', 'login finished', { ok, mode, account });
        try {
          await ctx.node.call('agents.list', { refresh: true });
        } catch (err) {
          log.log('debug', 'agents refresh after login failed', { err: String(err) });
        }
      })().catch((err) => log.log('error', 'login completion failed', { err: String(err) }));
      finishing.add(p);
      void p.finally(() => finishing.delete(p));
    };

    const listener = (ev: ChannelEvent) => {
      if (done) return;
      switch (ev.type) {
        case 'term.output':
          onOutput(ev.data.dataBase64);
          break;
        case 'term.exited':
          finish(ev.data);
          break;
        case 'session.status':
          // A session that fails or ends without ever running the command (e.g. spawn error).
          if (ev.data.status === 'failed' || ev.data.status === 'ended') {
            queueMicrotask(() => finish(undefined, ev.data.reason));
          }
          break;
        case 'error':
          if (ev.data.fatal) queueMicrotask(() => finish(undefined, ev.data.message));
          break;
        default:
          break;
      }
    };
    sub = ctx.node.subscribe(sessionChannel(session.id), 0, listener);
    if (unsubscribeWhenReady) sub.unsubscribe();
  }

  return {
    methods: {
      'agent.login': async (raw, ctx) => {
        const p = asParams(raw);
        checkMachine(p, ctx.node.machine.id);
        const agent = reqAgent(p);
        const mode = oneOf(p, 'mode', MODES) ?? 'interactive';
        const spec = loginSpec(agent, opts.recipes);
        if (!spec) throw new BizziError('unsupported', `${agent} has no login recipe`);
        const cmd = loginCommand(agent, spec, mode);
        const argv = resolveArgv(cmd.argv);
        const workspaceId = optString(p, 'workspaceId') || (await loginWorkspace(ctx));
        const cols = optInt(p, 'cols', 20, 1000) ?? DEFAULT_COLS;
        const rows = optInt(p, 'rows', 5, 1000) ?? DEFAULT_ROWS;
        const { session } = await ctx.node.call('session.create', {
          workspaceId,
          agent,
          mode: 'terminal',
          title: `Log in to ${agent}`,
          command: argv,
          cols,
          rows,
        });
        ctx.logger.log('info', 'login started', { agent, mode, sessionId: session.id, command: argv[0] });
        watch(session, agent, mode, cmd, cols, ctx);
        return { session };
      },
    },

    stop() {
      for (const w of [...watches]) w.unsubscribe();
    },

    idle: async () => {
      while (finishing.size > 0) await Promise.all([...finishing]);
    },
  };
}
