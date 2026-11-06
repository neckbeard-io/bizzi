import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { clearLatestVersionCache, compareVersions, latestVersion, parsePlatform, type FetchFn } from '../src/index.ts';
import { recipesWithFake } from './helpers.ts';

function fakeFetch(routes: Record<string, string | number>): FetchFn & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const body = routes[url];
    if (body === undefined) return { ok: false, status: 404, text: async () => 'not found' };
    if (typeof body === 'number') return { ok: false, status: body, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  }) as FetchFn & { calls: string[] };
  f.calls = calls;
  return f;
}

beforeEach(() => clearLatestVersionCache());

const mac = parsePlatform('darwin-arm64');
const linux = parsePlatform('linux-x64');

test('claude: vendor "latest" file', async () => {
  const fetch = fakeFetch({ 'https://downloads.claude.ai/claude-code-releases/latest': '2.1.318\n' });
  assert.equal(await latestVersion('claude', { fetch, platform: mac }), '2.1.318');
});

test('codex: releases.openai.com tag_name, falling back to GitHub, then npm', async () => {
  const fetch = fakeFetch({ 'https://releases.openai.com/codex/channels/latest': JSON.stringify({ tag_name: 'rust-v0.167.0', assets: [] }) });
  assert.equal(await latestVersion('codex', { fetch, platform: linux }), '0.167.0');

  clearLatestVersionCache();
  const fb = fakeFetch({
    'https://releases.openai.com/codex/channels/latest': 503,
    'https://api.github.com/repos/openai/codex/releases/latest': JSON.stringify({ tag_name: 'rust-v0.166.1' }),
  });
  assert.equal(await latestVersion('codex', { fetch: fb, platform: linux }), '0.166.1');

  clearLatestVersionCache();
  const npm = fakeFetch({ 'https://registry.npmjs.org/@openai%2fcodex/latest': JSON.stringify({ version: '0.165.0' }) });
  assert.equal(await latestVersion('codex', { fetch: npm, platform: linux }), '0.165.0');
  assert.equal(npm.calls.length, 3);
});

test('agy: per-platform manifest URL', async () => {
  const fetch = fakeFetch({
    'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64_musl.json': JSON.stringify({ version: '1.5.2', url: 'x', sha512: 'y' }),
  });
  assert.equal(await latestVersion('agy', { fetch, platform: parsePlatform('linux-x64-musl') }), '1.5.2');
});

test('opencode and node', async () => {
  const fetch = fakeFetch({
    'https://opencode.ai/update/api/latest/cli/npm': JSON.stringify({ channel: 'latest', version: '2.2.5', metadata: { package: '@opencode/cli' } }),
    'https://nodejs.org/dist/index.json': JSON.stringify([
      { version: 'v27.0.0-alpha.0', lts: false },
      { version: 'v27.1.0', lts: false },
      { version: 'v26.13.0', lts: 'Lithium' },
      { version: 'v24.22.2', lts: 'Krypton' },
    ]),
  });
  assert.equal(await latestVersion('opencode', { fetch, platform: mac }), '2.2.5');
  assert.equal(await latestVersion('node', { fetch, platform: mac }), '26.13.0');
});

test('fake recipe: nested jsonPath + templated URL; cache, force and cacheOnly', async () => {
  const recipes = recipesWithFake();
  const fetch = fakeFetch({ 'https://example.com/fake/linux-amd64/latest.json': JSON.stringify({ release: { version: 'v4.5.6' } }) });
  assert.equal(await latestVersion('fake', { recipes, fetch, platform: linux }), '4.5.6');
  assert.equal(await latestVersion('fake', { recipes, fetch, platform: linux }), '4.5.6');
  assert.equal(fetch.calls.length, 1, 'second call served from cache');
  await latestVersion('fake', { recipes, fetch, platform: linux, force: true });
  assert.equal(fetch.calls.length, 2);
  assert.equal(await latestVersion('fake', { recipes, fetch, platform: mac, cacheOnly: true }), undefined, 'per-platform cache');
  assert.equal(fetch.calls.length, 2, 'cacheOnly never fetches');
});

test('all sources failing → undefined (never throws); unknown recipe → undefined', async () => {
  const recipes = recipesWithFake();
  const fetch = fakeFetch({ 'https://example.com/fake/linux-amd64/latest.json': 'not json' });
  assert.equal(await latestVersion('fake', { recipes, fetch, platform: linux }), undefined);
  const throwing: FetchFn = async () => {
    throw new Error('offline');
  };
  assert.equal(await latestVersion('claude', { fetch: throwing, platform: linux }), undefined);
  assert.equal(await latestVersion('nope', { fetch: throwing }), undefined);
});

test('concurrent calls share one request', async () => {
  const fetch = fakeFetch({ 'https://downloads.claude.ai/claude-code-releases/latest': '2.1.318' });
  const [a, b] = await Promise.all([latestVersion('claude', { fetch, platform: mac }), latestVersion('claude', { fetch, platform: mac })]);
  assert.deepEqual([a, b], ['2.1.318', '2.1.318']);
  assert.equal(fetch.calls.length, 1);
});

test('compareVersions', () => {
  assert.equal(compareVersions('2.1.311', '2.1.318'), -1);
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
});
