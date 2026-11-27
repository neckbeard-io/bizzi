import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import {
  augmentedEnv,
  augmentedPath,
  evaluateAuthCommand,
  extraPathDirs,
  findBinary,
  parsePlatform,
  parseRecipe,
  probe,
  probeTool,
  RecipeSet,
  type ExecResult,
} from '../src/index.ts';
import { fakeRecipe, isolatedEnv, tempDir, writeScript } from './helpers.ts';

test('augmented PATH: inherited first, then per-user and package-manager dirs', () => {
  const home = realpathSync(tempDir());
  const tools = join(home, '.bizzi', 'tools');
  mkdirSync(join(tools, 'node', 'bin'), { recursive: true });
  mkdirSync(join(tools, 'uv', 'bin'), { recursive: true });
  mkdirSync(join(tools, 'nobin'), { recursive: true });
  const env = { PATH: `/usr/bin:/bin:${home}/.local/bin`, HOME: home };

  const dirs = augmentedPath({ env, npmPrefix: '/opt/npm-global', platform: parsePlatform('darwin-arm64') }).split(delimiter);
  assert.deepEqual(dirs, [
    '/usr/bin',
    '/bin',
    `${home}/.local/bin`, // inherited position kept, not duplicated
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/opt/npm-global/bin',
    `${tools}/node/bin`,
    `${tools}/uv/bin`,
  ]);

  const linux = extraPathDirs({ env, npmPrefix: null, platform: parsePlatform('linux-x64') });
  assert.ok(linux.includes('/home/linuxbrew/.linuxbrew/bin'));
  assert.ok(!linux.includes('/opt/homebrew/bin'));
  assert.ok(!linux.some((d) => d.includes('npm-global')));
});

test('augmented PATH: empty PATH falls back to system dirs; prepend and env prefix', () => {
  const home = realpathSync(tempDir());
  const dirs = augmentedPath({ env: { HOME: home, NPM_CONFIG_PREFIX: '/srv/npm' }, prepend: ['/first'], platform: parsePlatform('linux-x64') }).split(delimiter);
  assert.deepEqual(dirs.slice(0, 5), ['/first', '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  assert.ok(dirs.includes(`${home}/.local/bin`));
  assert.ok(dirs.includes('/srv/npm/bin'), 'npm prefix from env');
  const toolsOverride = augmentedEnv({ env: { HOME: home, BIZZI_TOOLS_DIR: join(home, 'custom') }, npmPrefix: null });
  assert.equal(toolsOverride.HOME, home, 'other env vars are kept');
});

test('findBinary searches dirs in order and requires the exec bit', () => {
  const dir = realpathSync(tempDir());
  writeScript(join(dir, 'b', 'tool'), 'echo b');
  writeScript(join(dir, 'c', 'tool'), 'echo c');
  writeFileSync(join(dir, 'a-tool'), 'not executable');
  assert.equal(findBinary(['tool'], [join(dir, 'missing'), join(dir, 'b'), join(dir, 'c')]), join(dir, 'b', 'tool'));
  assert.equal(findBinary(['nope', 'tool'], [join(dir, 'c')]), join(dir, 'c', 'tool'));
  assert.equal(findBinary(['a-tool'], [dir]), undefined);
});

function fakeSetup() {
  const home = realpathSync(tempDir());
  const tools = join(home, 'tools');
  const bin = join(home, 'bin');
  const recipes = new RecipeSet([fakeRecipe()]);
  const opts = { recipes, home, toolsDir: tools, npmPrefix: null, latest: false as const };
  return { home, tools, bin, recipes, opts };
}

test('probe: finds the binary, parses the version, runs the auth command', async () => {
  const { home, bin, opts } = fakeSetup();
  writeScript(
    join(bin, 'fake-agent'),
    `case "$1" in
  --version) echo "fake-agent 3.4.5 (build 99)";;
  status) echo '{"loggedIn":true,"email":"dev@example.com"}';;
esac`,
  );
  const env = isolatedEnv(home, { PATH: `${bin}:/usr/bin:/bin` });
  const p = await probeTool('fake', env, opts);
  assert.equal(p.installed, true);
  assert.equal(p.path, join(bin, 'fake-agent'));
  assert.equal(p.version, '3.4.5');
  assert.equal(p.auth, 'ok');
  assert.equal(p.account, 'dev@example.com');
  assert.equal(p.onInheritedPath, true);
  assert.deepEqual(p.notes, []);
});

test('probe: skips broken shims and finds binaries outside PATH via search paths', async () => {
  const { home, tools, bin, opts } = fakeSetup();
  writeScript(join(bin, 'fake-agent'), 'echo "fake-agent: command not found" >&2; exit 127');
  writeScript(join(tools, 'fake', 'bin', 'fake-agent'), 'if [ "$1" = status ]; then echo \'{"loggedIn":false}\'; exit 1; fi; echo "fake-agent 1.0.0"');
  const env = isolatedEnv(home, { PATH: `${bin}:/usr/bin:/bin` });
  const p = await probeTool('fake', env, opts);
  assert.equal(p.installed, true);
  assert.equal(p.path, join(tools, 'fake', 'bin', 'fake-agent'));
  assert.equal(p.version, '1.0.0');
  assert.equal(p.onInheritedPath, false);
  assert.equal(p.auth, 'missing');
  assert.ok(p.notes.some((n) => n.includes('skipped binaries that failed to run') && n.includes('exit 127')));
  assert.ok(p.notes.some((n) => n.includes('outside this process') && n.includes(`${tools}/fake/bin`)));
});

test('probe: missing binary → installed false; auth from env rules; never throws', async () => {
  const { home, opts } = fakeSetup();
  const env = isolatedEnv(home);
  const missing = await probeTool('fake', env, opts);
  assert.equal(missing.installed, false);
  assert.equal(missing.auth, 'missing');
  const withKey = await probeTool('fake', { ...env, FAKE_API_KEY: 'k' }, opts);
  assert.deepEqual([withKey.installed, withKey.auth, withKey.account], [false, 'ok', 'api key']);
  const unknown = await probeTool('no-such-recipe', env, opts);
  assert.equal(unknown.installed, false);
  assert.match(unknown.notes[0] ?? '', /no recipe/);
});

test('probe: hanging version command times out', async () => {
  const { home, bin, opts } = fakeSetup();
  writeScript(join(bin, 'fake-agent'), 'sleep 30');
  const started = Date.now();
  const p = await probeTool('fake', isolatedEnv(home, { PATH: `${bin}:/usr/bin:/bin` }), { ...opts, timeoutMs: 300 });
  assert.equal(p.installed, false);
  assert.ok(p.notes.some((n) => n.includes('timed out')));
  assert.ok(Date.now() - started < 10_000);
});

test('probe: side-effecting auth commands are skipped unless allowed', async () => {
  const { home, bin } = fakeSetup();
  const yaml = readFileSync(new URL('./fixtures/fake.yaml', import.meta.url), 'utf8').replace('sideEffectFree: true', 'sideEffectFree: false');
  const recipes = new RecipeSet([parseRecipe(yaml)]);
  writeScript(join(bin, 'fake-agent'), 'if [ "$1" = status ]; then echo \'{"loggedIn":true}\'; else echo "fake-agent 2.0.0"; fi');
  const env = isolatedEnv(home, { PATH: `${bin}:/usr/bin:/bin` });
  const opts = { recipes, home, npmPrefix: null, latest: false as const };
  assert.equal((await probeTool('fake', env, opts)).auth, 'missing');
  assert.equal((await probeTool('fake', env, { ...opts, allowSideEffectAuth: true })).auth, 'ok');
});

test('probe(shell) reports the login shell', async () => {
  const p = await probe('shell', { SHELL: '/bin/sh', PATH: '/usr/bin:/bin' });
  assert.deepEqual(p, { agent: 'shell', installed: true, path: '/bin/sh', auth: 'ok' });
});

test('evaluateAuthCommand: json, text, exit codes, expired', () => {
  const r = (stdout: string, code: number | null = 0, extra: Partial<ExecResult> = {}): ExecResult => ({
    code,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
    aborted: false,
    durationMs: 1,
    ...extra,
  });
  const json = { argv: ['x'], sideEffectFree: true, format: 'json' as const, loggedInField: 'loggedIn', accountField: 'email', methodField: 'authMethod', okExitCodes: [0], missingExitCodes: [1], verified: true };
  assert.deepEqual(evaluateAuthCommand(json, r('{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c"}')), { state: 'ok', account: 'a@b.c' });
  assert.deepEqual(evaluateAuthCommand(json, r('{"loggedIn":true,"authMethod":"oauth_token"}')), { state: 'ok', account: 'oauth_token' });
  assert.deepEqual(evaluateAuthCommand(json, r('{"loggedIn":false,"authMethod":"none"}', 1)), { state: 'missing' });
  assert.deepEqual(evaluateAuthCommand(json, r('garbage', 1)), { state: 'missing' }, 'falls back to exit codes');
  assert.equal(evaluateAuthCommand(json, r('', null, { timedOut: true })), undefined);

  const text = { argv: ['x'], sideEffectFree: true, format: 'text' as const, okExitCodes: [0], missingExitCodes: [1], missingRegex: 'not logged in', accountRegex: 'Logged in using (.+)', expiredRegex: 'expired', verified: true };
  assert.deepEqual(evaluateAuthCommand(text, r('Logged in using ChatGPT\n')), { state: 'ok', account: 'ChatGPT' });
  assert.deepEqual(evaluateAuthCommand(text, r('Not logged in\n', 1)), { state: 'missing' });
  assert.deepEqual(evaluateAuthCommand(text, r('Your login expired\n', 1)), { state: 'expired' });
  assert.equal(evaluateAuthCommand(text, r('???', 2)), undefined, 'unknown exit code is inconclusive');

  const nonEmpty = { argv: ['x'], sideEffectFree: false, format: 'json' as const, nonEmptyMeansOk: true, verified: false };
  assert.deepEqual(evaluateAuthCommand(nonEmpty, r('[{"provider":"anthropic"}]')), { state: 'ok' });
  assert.deepEqual(evaluateAuthCommand(nonEmpty, r('[]')), { state: 'missing' });
});

test("probe: a package's node_modules/.bin on PATH never shadows the install", async () => {
  // `npm run …` (and an app reopened from one) puts <pkg>/node_modules/.bin first on PATH; a repo
  // with the agent CLI as a dev dependency must not flip the detected install and version.
  const { home, bin, opts } = fakeSetup();
  writeScript(join(bin, 'fake-agent'), 'echo "fake-agent 0.172.0"');
  const projectBin = join(home, 'repo', 'worktree', 'node_modules', '.bin');
  writeScript(join(projectBin, 'fake-agent'), 'echo "fake-agent 0.167.0"');
  const env = isolatedEnv(home, { PATH: [projectBin, 'node_modules/.bin', bin, '/usr/bin', '/bin'].join(delimiter) });
  const p = await probeTool('fake', env, opts);
  assert.equal(p.path, join(bin, 'fake-agent'));
  assert.equal(p.version, '0.172.0');
  assert.ok(!augmentedPath({ env, home, npmPrefix: null }).split(delimiter).includes(projectBin));
});
