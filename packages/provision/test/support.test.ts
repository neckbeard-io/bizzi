// Supported versions, shim resolution, method detection and adopted-install facts (spec §7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import {
  assessInstall,
  assessSupport,
  defaultRecipes,
  execTargets,
  installFacts,
  parsePlatform,
  parseRange,
  planInstall,
  probe,
  RecipeSet,
  resolveExecutable,
  satisfies,
  validateRecipe,
} from '../src/index.ts';
import { isolatedEnv, tempDir, writeScript } from './helpers.ts';

const mac = parsePlatform('darwin-arm64');
const recipes = defaultRecipes();

function bashScript(path: string, body: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function binary(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '\x7fELF fake binary');
  chmodSync(path, 0o755);
  return path;
}

test('version ranges: comparators, AND, OR, wildcard', () => {
  assert.equal(satisfies('2.0.0', '>=2.0.0'), true);
  assert.equal(satisfies('1.14.3', '>=2.0.0'), false);
  assert.equal(satisfies('2.1.311', '>=2.1.0 <2.2.0'), true);
  assert.equal(satisfies('2.2.0', '>=2.1.0 <2.2.0'), false);
  assert.equal(satisfies('2.2.6', '>= 2.0.0 < 2.1.0'), false, 'spaces after operators');
  assert.equal(satisfies('1.5.0', '<1.0.0 || >=1.5.0'), true);
  assert.equal(satisfies('1.2.0', '<1.0.0 || >=1.5.0'), false);
  assert.equal(satisfies('0.167.0', '=0.167.0'), true);
  assert.equal(satisfies('0.167.1', '0.167.0'), false);
  assert.equal(satisfies('9.9.9', '*'), true);
  assert.equal(satisfies('v2.0.25', '>=2'), true);
  assert.equal(satisfies('2.0.0-beta.1', '>=2.0.0'), false, 'prerelease sorts before the release');
  assert.throws(() => parseRange('>=x'), /cannot parse/);
  assert.throws(() => parseRange('>=1 ||'), /empty alternative/);
});

test('support: OpenCode v1 is unsupported with upgrade remedies; newer than tested is untested', () => {
  const oc = recipes.require('opencode');
  const v1 = assessSupport(oc, '1.14.3');
  assert.equal(v1?.support, 'unsupported');
  assert.match(v1?.reason ?? '', /v1 is not supported/);
  assert.deepEqual(v1?.remedies?.[0], { kind: 'upgrade', id: 'major', title: 'Upgrade to v2', command: 'opencode upgrade --major' });
  assert.equal(v1?.remedies?.[1]?.method, 'script');
  assert.equal(v1?.remedies?.[1]?.id, 'v2-installer');
  assert.ok(v1?.remedies?.every((r) => !('steps' in r)), 'remedy steps stay in the recipe');
  assert.deepEqual(assessSupport(oc, '2.0.25'), { support: 'ok' });
  const newer = assessSupport(oc, '2.2.6');
  assert.equal(newer?.support, 'untested');
  assert.match(newer?.reason ?? '', /newer than the versions bizzi was tested with/);
  assert.equal(assessSupport(oc, undefined)?.support, 'untested', 'unknown version is never refused');
  assert.equal(assessSupport(recipes.require('agy'), '1.0.0'), undefined, 'no support block: not checked');
  assert.equal(assessSupport(recipes.require('claude'), '1.0.128')?.support, 'unsupported');
  assert.equal(assessSupport(recipes.require('claude'), '2.1.311')?.support, 'ok');
  assert.equal(assessSupport(recipes.require('codex'), '0.167.0')?.support, 'ok');
  assert.equal(assessSupport(recipes.require('codex'), '0.170.2')?.support, 'untested');
});

test('support block validation: ranges must parse and methods must exist', () => {
  const base = {
    schema: 1,
    name: 'x',
    kind: 'agent',
    displayName: 'X',
    homepage: 'https://x.example',
    docs: ['https://x.example/docs'],
    verified: true,
    platforms: { 'linux-x64': {} },
    detect: { binaries: ['x'], version: { args: ['--version'], regex: '(\\d+)' } },
    latest: [{ type: 'npm', package: 'x', verified: true }],
    methods: [{ id: 'a', kind: 'script', label: 'A', targetDir: '~/.local/bin', pinnable: false, verified: true, install: [{ description: 'd', run: 'true' }], uninstall: [{ description: 'd', run: 'true' }] }],
    login: { interactive: { argv: ['x'], description: 'd', verified: true }, headless: [] },
    auth: { absent: 'unknown' },
  };
  assert.equal(validateRecipe({ ...base, support: { versions: '>=1.0.0' } }).ok, true);
  const bad = validateRecipe({ ...base, support: { versions: '>=one', migrate: { from: ['nope'], title: 't' } } });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => i.includes('support.versions')), bad.issues.join('; '));
  const badMethod = validateRecipe({ ...base, support: { versions: '*', migrate: { from: ['nope'], title: 't' } } });
  assert.ok(badMethod.issues.some((i) => i.includes('unknown method "nope"')), badMethod.issues.join('; '));
});

test('execTargets: quoted, bare, env-prefixed', () => {
  const script = [
    'if [ -x "$w" ]; then',
    '    exec "$w" "$@"',
    'fi',
    "exec '/opt/x/bin/tool' --flag",
    'exec env FOO=1 claude "$@"',
    'exec /usr/bin/env -i claude',
    'echo "exec not-this"',
    'exec claude "$@"',
  ].join('\n');
  assert.deepEqual(execTargets(script), ['$w', '/opt/x/bin/tool', 'claude', 'claude', 'claude']);
});

test('resolveExecutable: symlinks, literal-path shims, $HOME paths, re-exec of the next one on PATH', () => {
  const dir = realpathSync(tempDir());
  const home = join(dir, 'home');
  const real = binary(join(home, '.local/share/claude/versions/2.1.322'));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  symlinkSync(real, join(home, '.local/bin/claude'));

  // Symlink only.
  const viaLink = resolveExecutable(join(home, '.local/bin/claude'), { home });
  assert.equal(viaLink.realPath, real);
  assert.equal(viaLink.viaShim, false);

  // A shim that execs a literal path held in a variable, which is itself a symlink.
  const shim1 = bashScript(join(dir, 'shims1/claude'), `target="$HOME/.local/bin/claude"\nexec "$target" "$@"`);
  const r1 = resolveExecutable(shim1, { home });
  assert.equal(r1.realPath, real);
  assert.equal(r1.viaShim, true);
  assert.deepEqual(r1.chain, [shim1, real]);

  // A terminal-app style shim: strips itself from PATH and re-execs `claude`.
  const shim2 = bashScript(join(dir, 'shims2/claude'), 'export PATH="$(echo stripped)"\nexec claude "$@"');
  const r2 = resolveExecutable(shim2, { home, searchDirs: [join(dir, 'shims2'), join(home, '.local/bin')] });
  assert.equal(r2.realPath, real);

  // A shim → an unreadable wrapper (unknown variables only) → falls back to the next `claude` on PATH.
  const wrapper = bashScript(join(dir, 'app/bin/claude-wrapper'), 'exec "$fallback" "$@"\nexec /bin/zsh -fc "x"');
  const shim3 = bashScript(join(dir, 'shims3/claude'), `w="${wrapper}"\nexec "$w" "$@"`);
  const r3 = resolveExecutable(shim3, { home, searchDirs: [join(dir, 'shims3'), join(home, '.local/bin')] });
  assert.equal(r3.realPath, real);
  assert.deepEqual(r3.chain, [shim3, wrapper, real]);

  // Unresolvable without search dirs: report the wrapper and say so.
  const r4 = resolveExecutable(shim3, { home });
  assert.equal(r4.realPath, wrapper);
  assert.equal(r4.unresolved, true);

  // Scripts that never exec are programs, not shims; non-shell scripts are final.
  const prog = writeScript(join(dir, 'prog/claude'), 'echo "2.1.0 (Claude Code)"');
  assert.equal(resolveExecutable(prog, { home }).realPath, prog);
  const nodeScript = join(dir, 'node/cli.js');
  mkdirSync(join(dir, 'node'), { recursive: true });
  writeFileSync(nodeScript, '#!/usr/bin/env node\nexec("x")\n');
  chmodSync(nodeScript, 0o755);
  assert.equal(resolveExecutable(nodeScript, { home }).viaShim, false);

  // Loops terminate.
  const a = bashScript(join(dir, 'loop/a/claude'), `exec "${join(dir, 'loop/b/claude')}"`);
  bashScript(join(dir, 'loop/b/claude'), `exec "${a}"`);
  assert.equal(resolveExecutable(a, { home }).unresolved, true);
});

test('method detection: pathHints through shims; preferred method; migrate remedy for Claude via Homebrew/npm', () => {
  const dir = realpathSync(tempDir());
  const home = join(dir, 'home');
  const claude = recipes.require('claude');
  const cask = binary(join(dir, 'opt/homebrew/Caskroom/claude-code/2.1.311/claude'));
  mkdirSync(join(dir, 'opt/homebrew/bin'), { recursive: true });
  symlinkSync(cask, join(dir, 'opt/homebrew/bin/claude'));
  const shim = bashScript(join(dir, 'term/shims/claude'), 'exec claude "$@"');

  const a = assessInstall(claude, { path: shim, version: '2.1.311' }, { platform: mac, home, searchDirs: [join(dir, 'term/shims'), join(dir, 'opt/homebrew/bin')] });
  assert.equal(a.realPath, cask);
  assert.equal(a.method, 'brew');
  assert.equal(a.preferredMethod, 'native');
  assert.equal(a.support, 'ok');
  assert.deepEqual(a.remedies, [{ kind: 'migrate', title: 'Switch to the native installer', method: 'native' }]);
  assert.deepEqual(a.facts, { brewCask: 'claude-code' });
  assert.deepEqual(a.watch, [join(dir, 'opt/homebrew/Caskroom/claude-code')]);
  assert.ok(a.notes.some((n) => n.includes('is a wrapper')));

  const npm = binary(join(dir, 'npm/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
  const n = assessInstall(claude, { path: npm, version: '2.1.311' }, { platform: mac, home });
  assert.equal(n.method, 'npm');
  assert.equal(n.facts.npmPrefix, join(dir, 'npm'));
  assert.equal(n.remedies?.[0]?.kind, 'migrate');
  assert.ok(n.watch.includes(join(dir, 'npm/lib/node_modules/@anthropic-ai/claude-code')));

  const native = binary(join(home, '.local/share/claude/versions/2.1.322'));
  const nat = assessInstall(claude, { path: native, version: '2.1.322' }, { platform: mac, home });
  assert.equal(nat.method, 'native');
  assert.equal(nat.selfUpdates, true);
  assert.equal(nat.remedies, undefined, 'preferred method: no migrate remedy');
  assert.deepEqual(nat.watch, [join(home, '.local/share/claude/versions'), join(home, '.local/bin/claude')]);

  // Linux has no brew method; the preferred one is still native.
  assert.equal(assessInstall(claude, {}, { platform: parsePlatform('linux-x64'), home }).preferredMethod, 'native');

  // OpenCode v1 under the script dir: unsupported, upgrade remedies, no migrate remedy.
  const oc = binary(join(home, '.opencode/bin/opencode'));
  const ocA = assessInstall(recipes.require('opencode'), { path: oc, version: '1.14.3' }, { platform: mac, home });
  assert.equal(ocA.method, 'script');
  assert.equal(ocA.support, 'unsupported');
  assert.deepEqual(ocA.remedies?.map((r) => r.kind), ['upgrade', 'upgrade']);
});

test('Homebrew formula from the Cellar path and receipt: core opencode vs the anomalyco tap', () => {
  const dir = realpathSync(tempDir());
  const core = binary(join(dir, 'Cellar/opencode/2.2.6/bin/opencode'));
  writeFileSync(join(dir, 'Cellar/opencode/2.2.6/INSTALL_RECEIPT.json'), JSON.stringify({ source: { tap: 'homebrew/core' } }));
  const tap = binary(join(dir, 'Cellar/opencode-v2/2.0.25/bin/opencode'));
  writeFileSync(join(dir, 'Cellar/opencode-v2/2.0.25/INSTALL_RECEIPT.json'), JSON.stringify({ source: { tap: 'anomalyco/tap' } }));
  const noReceipt = binary(join(dir, 'other/Cellar/opencode/2.1.0/bin/opencode'));
  assert.deepEqual(installFacts(core), { brewFormula: 'opencode' });
  assert.deepEqual(installFacts(tap), { brewFormula: 'anomalyco/tap/opencode-v2' });
  assert.deepEqual(installFacts(noReceipt), { brewFormula: 'opencode' });

  const oc = recipes.require('opencode');
  const opts = { home: '/home/t', toolsDir: '/home/t/.bizzi/tools', env: { PATH: '/usr/bin:/bin' }, hasCommand: () => true };
  const argv = (action: 'update' | 'uninstall', installedPath?: string) =>
    planInstall('opencode', mac, { ...opts, recipes: new RecipeSet([oc]), action, method: 'brew', ...(installedPath ? { installedPath } : {}) }).steps[0]?.argv;
  assert.deepEqual(argv('uninstall', core), ['brew', 'uninstall', 'opencode']);
  assert.deepEqual(argv('update', core), ['brew', 'upgrade', 'opencode']);
  assert.deepEqual(argv('uninstall', tap), ['brew', 'uninstall', 'anomalyco/tap/opencode-v2']);
  assert.deepEqual(argv('uninstall'), ['brew', 'uninstall', 'anomalyco/tap/opencode-v2'], 'fresh installs: the tap');
  assert.deepEqual(
    planInstall('opencode', mac, { ...opts, action: 'install', method: 'brew', installedPath: core }).steps[0]?.argv,
    ['brew', 'install', 'anomalyco/tap/opencode-v2'],
    'install never uses adopted facts',
  );

  // npm uninstall uses the prefix the package actually lives under.
  const npmPlan = planInstall('claude', mac, { ...opts, action: 'uninstall', method: 'npm', installedPath: '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js' });
  assert.equal(npmPlan.steps[0]?.env.NPM_CONFIG_PREFIX, '/opt/homebrew');
  const npmDefault = planInstall('claude', mac, { ...opts, action: 'uninstall', method: 'npm' });
  assert.equal(npmDefault.steps[0]?.env.NPM_CONFIG_PREFIX, '/home/t/.local');
  // Casks: claude-code@latest stays claude-code@latest.
  const caskPlan = planInstall('claude', mac, { ...opts, action: 'update', method: 'brew', installedPath: '/opt/homebrew/Caskroom/claude-code@latest/2.1.322/claude' });
  assert.deepEqual(caskPlan.steps[0]?.argv, ['brew', 'upgrade', '--cask', 'claude-code@latest']);
});

test('probe reports realPath, method, preferredMethod, support and remedies', async () => {
  const dir = realpathSync(tempDir());
  const home = join(dir, 'home');
  writeScript(join(home, '.opencode/bin/opencode'), 'echo "opencode v1.14.3"');
  // The fake comes first on the inherited PATH, ahead of any real install on this machine.
  const env = isolatedEnv(home, { PATH: `${join(home, '.opencode/bin')}:/usr/bin:/bin` });
  const p = await probe('opencode', env, { home, npmPrefix: null, latest: false, platform: mac });
  assert.equal(p.installed, true);
  assert.equal(p.version, '1.14.3');
  assert.equal(p.realPath, join(home, '.opencode/bin/opencode'));
  assert.equal(p.method, 'script');
  assert.equal(p.preferredMethod, 'script');
  assert.equal(p.support, 'unsupported');
  assert.match(p.supportReason ?? '', /v1/);
  assert.equal(p.remedies?.[0]?.title, 'Upgrade to v2');

  const missing = await probe('codex', isolatedEnv(home), { home, npmPrefix: null, latest: false, platform: mac, auth: false });
  if (!missing.installed) {
    assert.equal(missing.support, undefined, 'nothing to check when absent');
    assert.equal(missing.preferredMethod, 'script');
  }
});
