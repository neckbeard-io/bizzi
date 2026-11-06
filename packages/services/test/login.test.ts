import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BizziError, type SessionEventMap } from '@bizzi/protocol';
import { defaultRecipes, loginSpec, parseRecipe, RecipeSet } from '@bizzi/provision';
import { TerminalAdapter, claudeSpec } from '@bizzi/pty';
import { createLoginExtension, loginCommand } from '../src/index.ts';
import { FAKE_LOGIN_URL as URL_, fakeClaude } from './fake-claude.ts';
import { CommandStashAdapter, harness, tempDir, waitFor } from './helpers.ts';

async function setup(loginBody: string) {
  const dir = tempDir('bizzi-services-login-');
  const home = join(dir, 'home');
  const { recipes, state } = fakeClaude(dir, loginBody);
  const env = { PATH: '/usr/bin:/bin', HOME: home };
  const ext = createLoginExtension({ recipes, env, probeOptions: { home, npmPrefix: null }, workspacePath: dir });
  // The terminal adapter for claude can't find a real `claude` here; the login command doesn't need it.
  const pty = new CommandStashAdapter(new TerminalAdapter(claudeSpec(), { supervisor: false, path: '/nonexistent', extraDirs: [], idleMs: 300 }));
  const h = await harness({ extensions: [ext], adapters: [pty], commandAdapters: [pty] });
  after(() => h.close());
  return { dir, ext, h, pty, state };
}

type Prompt = SessionEventMap['login.prompt'];
type Completed = SessionEventMap['login.completed'];

describe('login extension', () => {
  it('runs the recipe login command, emits login.prompt and login.completed', async () => {
    const { dir, ext, h, pty, state } = await setup(
      `echo "Open this URL to sign in:"\necho "${URL_}"\nsleep 0.2\necho "Enter code: WXYZ-1234"\nsleep 0.2\ntouch $STATE\nexit 0`,
    );
    const { session } = await h.call(ext, 'agent.login', { agent: 'claude' });
    assert.deepEqual([session.agent, session.mode, session.title], ['claude', 'terminal', 'Log in to claude']);

    const events = () => h.sessionEvents(session.id);
    await waitFor(() => events().some((e) => e.type === 'login.completed'), 'login.completed');
    await ext.idle();

    // The terminal ran the login argv in the login workspace (registered once, by path).
    assert.equal(pty.starts.length, 1);
    assert.deepEqual(pty.starts[0]!.command, [join(dir, 'login.sh')]);
    assert.equal(pty.starts[0]!.cwd, dir);
    const { workspaces } = await h.node.call('workspaces.list', {});
    assert.deepEqual(
      workspaces.map((w) => [w.path, w.name]),
      [[dir, 'Home']],
    );

    const prompts = events()
      .filter((e) => e.type === 'login.prompt')
      .map((e) => e.data as Prompt);
    assert.ok(prompts.length >= 1 && prompts.length <= 2, JSON.stringify(prompts));
    assert.deepEqual(prompts.at(-1), { urls: [URL_], codes: ['WXYZ-1234'], callbackPort: 54545, awaitingCodeInput: false });
    // Deduped: every prompt event adds something new.
    for (let i = 1; i < prompts.length; i++) assert.notDeepEqual(prompts[i], prompts[i - 1]);

    const completed = events().filter((e) => e.type === 'login.completed');
    assert.equal(completed.length, 1);
    assert.deepEqual(completed[0]!.data as Completed, { ok: true, account: 'me@example.com', message: 'logged in' });
    // login.completed comes after the process exited.
    const types = events().map((e) => e.type);
    assert.ok(types.indexOf('term.exited') < types.indexOf('login.completed'));
    assert.ok(existsSync(state));

    // A second login reuses the workspace.
    await h.call(ext, 'agent.login', { agent: 'claude' });
    assert.equal((await h.node.call('workspaces.list', {})).workspaces.length, 1);
    await waitFor(() => pty.starts.length === 2, 'second login start');
  });

  it('reports a failed device-code login', async () => {
    const { ext, h, pty } = await setup('exit 0');
    const { workspace } = await h.node.call('workspace.create', { path: tempDir() });
    const { session } = await h.call(ext, 'agent.login', { agent: 'claude', mode: 'device-code', workspaceId: workspace.id });
    await waitFor(() => h.sessionEvents(session.id).some((e) => e.type === 'login.completed'), 'login.completed');
    await ext.idle();
    assert.match(pty.starts[0]!.command![0]!, /device\.sh$/);
    const evs = h.sessionEvents(session.id);
    const prompt = evs.find((e) => e.type === 'login.prompt')?.data as Prompt;
    assert.deepEqual(prompt, { urls: ['https://example.com/device'], codes: ['QRST-5678'], awaitingCodeInput: false });
    const done = evs.find((e) => e.type === 'login.completed')!.data as Completed;
    assert.deepEqual(done, { ok: false, message: 'login command failed (exit code 3)' });
  });

  it('rejects unsupported modes and missing binaries before creating a session', async () => {
    const { ext, h } = await setup('exit 0');
    const isCode = (c: string) => (e: unknown) => e instanceof BizziError && e.code === c;
    await assert.rejects(h.call(ext, 'agent.login', { agent: 'claude', mode: 'token' }), isCode('unsupported'));
    await assert.rejects(h.call(ext, 'agent.login', { agent: 'codex' }), isCode('unsupported'));
    await assert.rejects(h.call(ext, 'agent.login', { agent: 'claude', mode: 'magic' }), isCode('bad_request'));

    const missing = parseRecipe(
      defaultRecipeYamlWithLogin('bizzi-definitely-not-installed-binary'),
      'missing.yaml',
    );
    const ext2 = createLoginExtension({ recipes: new RecipeSet([missing]), env: { PATH: '/nonexistent', HOME: tempDir() } });
    await assert.rejects(h.call(ext2, 'agent.login', { agent: 'claude', workspaceId: 'w_x' }), isCode('agent_unavailable'));
    assert.equal((await h.node.call('sessions.list', {})).sessions.length, 0);
  });

  it('maps login modes to the built-in recipe commands (no execution)', () => {
    const recipes = defaultRecipes();
    const claude = loginSpec('claude', recipes)!;
    assert.deepEqual(loginCommand('claude', claude, 'interactive').argv, ['claude', 'auth', 'login']);
    assert.deepEqual(loginCommand('claude', claude, 'token').argv, ['claude', 'setup-token']);
    const codex = loginSpec('codex', recipes)!;
    assert.deepEqual(loginCommand('codex', codex, 'interactive'), {
      argv: ['codex', 'login'],
      description: codex.interactive.description,
      callbackPort: 1455,
    });
    assert.deepEqual(loginCommand('codex', codex, 'device-code').argv, ['codex', 'login', '--device-auth']);
    assert.throws(() => loginCommand('codex', codex, 'token'), (e: BizziError) => e.code === 'unsupported');
  });
});

/** A minimal valid agent recipe named `claude` whose login binary is `bin`. */
function defaultRecipeYamlWithLogin(bin: string): string {
  return `
schema: 1
name: claude
kind: agent
displayName: Missing
homepage: https://example.com
docs: [https://example.com]
verified: true
platforms:
  darwin-arm64: {}
  darwin-x64: {}
  linux-x64: {}
  linux-arm64: {}
detect:
  binaries: [${bin}]
  version:
    args: [--version]
    regex: '(\\d+\\.\\d+\\.\\d+)'
latest:
  - type: npm
    package: "@example/missing"
    verified: true
methods:
  - id: echo
    kind: script
    label: Echo
    targetDir: /nonexistent
    pinnable: false
    verified: true
    install:
      - description: Nothing
        run: "true"
    uninstall:
      - description: Nothing
        run: "true"
login:
  interactive:
    argv: [${bin}, login]
    description: Missing
    verified: true
  headless: []
auth:
  absent: missing
`;
}
