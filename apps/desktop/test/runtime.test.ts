import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildCsp } from '../src/main/csp.ts';
import { coreNodeArgs, nodeMajor, resolveCoreEntry, resolveCoreRuntime, resolveDataDir, type ResolveRuntimeOptions } from '../src/core/runtime.ts';

const base = (over: Partial<ResolveRuntimeOptions> = {}): ResolveRuntimeOptions => ({
  env: { PATH: '/a:/b', HOME: '/home/u' },
  platform: 'linux',
  isPackaged: false,
  execPath: '/Applications/bizzi.app/Contents/MacOS/bizzi',
  electronNodeVersion: '24.22.2',
  isExecutable: () => true,
  probe: async () => '26.1.0',
  ...over,
});

test('nodeMajor', () => {
  assert.equal(nodeMajor('26.7.0'), 26);
  assert.equal(nodeMajor('v24.22.2'), 24);
  assert.equal(nodeMajor(null), 0);
});

test('BIZZI_NODE wins, and must be >= 26', async () => {
  const rt = await resolveCoreRuntime(base({ env: { BIZZI_NODE: '/opt/node26/bin/node' } }));
  assert.deepEqual(rt, { kind: 'env', command: '/opt/node26/bin/node', env: {}, nodeVersion: '26.1.0' });
  await assert.rejects(
    resolveCoreRuntime(base({ env: { BIZZI_NODE: '/old/node' }, probe: async () => '24.0.0' })),
    /needs Node >= 26/,
  );
});

test('Electron-as-Node is opt-in', async () => {
  const rt = await resolveCoreRuntime(base({ env: { BIZZI_CORE_RUNTIME: 'electron' } }));
  assert.equal(rt.kind, 'electron');
  assert.equal(rt.command, '/Applications/bizzi.app/Contents/MacOS/bizzi');
  assert.deepEqual(rt.env, { ELECTRON_RUN_AS_NODE: '1' });
});

test('packaged builds prefer the bundled runtime', async () => {
  const rt = await resolveCoreRuntime(base({ isPackaged: true, resourcesPath: '/r' }));
  assert.deepEqual(rt, { kind: 'bundled', command: '/r/node/bin/node', env: {}, nodeVersion: '26.1.0' });
  const win = await resolveCoreRuntime(base({ isPackaged: true, resourcesPath: 'C:\\r', platform: 'win32' }));
  assert.equal(win.command, join('C:\\r', 'node', 'node.exe'));
});

test('system Node: first candidate >= 26 on PATH or well-known dirs', async () => {
  const versions: Record<string, string> = { '/a/node': '22.0.0', '/b/node': '26.7.0' };
  const rt = await resolveCoreRuntime(base({ probe: async (c) => versions[c] ?? null }));
  assert.deepEqual(rt, { kind: 'system', command: '/b/node', env: {}, nodeVersion: '26.7.0' });

  const fromBrew = await resolveCoreRuntime(base({ probe: async (c) => (c === '/opt/homebrew/bin/node' ? '26.0.0' : '20.0.0') }));
  assert.equal(fromBrew.command, '/opt/homebrew/bin/node');
});

test('no suitable Node -> a clear error', async () => {
  await assert.rejects(resolveCoreRuntime(base({ probe: async () => '24.1.0' })), /no Node >= 26 found.*BIZZI_NODE/s);
});

test('core entry and data dir resolution', () => {
  assert.equal(resolveCoreEntry({ env: {}, isPackaged: false, appDir: '/repo/apps/desktop' }), join('/repo/apps/cli/src/main.ts'));
  assert.equal(resolveCoreEntry({ env: {}, isPackaged: true, resourcesPath: '/r', appDir: '/r/app.asar' }), join('/r/core/apps/cli/src/main.ts'));
  assert.equal(resolveCoreEntry({ env: { BIZZI_CORE_ENTRY: '/x.ts' }, isPackaged: true, appDir: '/' }), '/x.ts');
  assert.equal(resolveDataDir({ HOME: '/home/u' }), join('/home/u/.bizzi'));
  assert.equal(resolveDataDir({ HOME: '/home/u', BIZZI_DATA_DIR: '/d' }), '/d');
});

test('CSP: strict in production, dev server allowed in dev', () => {
  const prod = buildCsp();
  assert.match(prod, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.match(prod, /connect-src 'self' ws:\/\/127\.0\.0\.1:\* http:\/\/127\.0\.0\.1:\*;/);
  assert.match(prod, /object-src 'none'/);
  assert.doesNotMatch(prod.split(';').find((d) => d.trim().startsWith('script-src')) ?? '', /unsafe-inline/);
  const dev = buildCsp({ devOrigin: 'http://localhost:5173' });
  assert.match(dev, /connect-src [^;]*ws:\/\/localhost:5173/);
  assert.match(dev, /script-src [^;]*http:\/\/localhost:5173/);
});

test('coreNodeArgs loads the workspaces hook only in a staged core (no node_modules/@bizzi)', () => {
  const entry = join('/r', 'core', 'apps', 'cli', 'src', 'main.ts');
  const hook = join('/r', 'core', 'apps', 'cli', 'src', 'workspaces-hook.ts');
  const links = join('/r', 'core', 'node_modules', '@bizzi');
  const staged = coreNodeArgs(entry, (f) => f === hook);
  assert.equal(staged[0], '--import');
  assert.match(staged[1] ?? '', /^file:\/\/.*workspaces-hook\.ts$/);
  assert.deepEqual(coreNodeArgs(entry, (f) => f === hook || f === links), [], 'dev checkout: the links resolve');
  assert.deepEqual(coreNodeArgs(entry, () => false), [], 'no hook file (an older core)');
});
