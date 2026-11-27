import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionKey, defaultUrl, isMockQuery, normalizeUrl, resolveInitialTarget, staleDesktopKeys } from '../src/lib/connection.ts';
import { contextUse, formatCost, formatDuration, formatRelative, formatTokens, joinPath, keepAwakeSummary, parentPath, tail, usageSummary } from '../src/lib/format.ts';
import { escapeHtml, renderMarkdown, safeUrl } from '../src/lib/markdown.ts';
import { parseHash, restorableHash, routeHref } from '../src/lib/router.ts';
import type { Route } from '../src/lib/router.ts';

test('format helpers', () => {
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(1234), '1.2k');
  assert.equal(formatTokens(31_200), '31k');
  assert.equal(formatTokens(2_500_000), '2.5M');
  assert.equal(formatCost(0.004), '<$0.01');
  assert.equal(formatCost(0.27), '$0.27');
  assert.equal(formatDuration(450), '450 ms');
  assert.equal(formatDuration(12_300), '12 s');
  assert.equal(formatDuration(125_000), '2m 5s');
  assert.equal(formatRelative('2026-11-05T10:00:00Z', Date.parse('2026-11-05T10:30:00Z')), '30 min ago');
  assert.equal(usageSummary({ inputTokens: 1000, outputTokens: 20, costUsd: 0.5 }), '1.0k in · 20 out · $0.50');
  assert.equal(contextUse({ inputTokens: 50_000, contextWindow: 200_000 }), 0.25);
  assert.equal(contextUse({ inputTokens: 1 }), null);
  assert.equal(joinPath('', 'a'), 'a');
  assert.equal(joinPath('src/', 'a.ts'), 'src/a.ts');
  assert.equal(parentPath('src/checkout/a.ts'), 'src/checkout');
});

test('tail keeps the end of long output, cutting at a line break', () => {
  const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
  const t = tail(text, 100);
  assert.ok(t.truncated > 0);
  assert.ok(t.text.startsWith('line '));
  assert.ok(t.text.endsWith('line 999'));
  assert.deepEqual(tail('short', 100), { text: 'short', truncated: 0 });
});

test('routes round-trip', () => {
  const routes: Route[] = [
    { name: 'machine' },
    { name: 'workspaces' },
    { name: 'inbox' },
    { name: 'workspace', workspaceId: 'w_1' },
    { name: 'session', sessionId: 's_1', tab: 'chat' },
    { name: 'session', sessionId: 's/odd', tab: 'changes' },
  ];
  for (const r of routes) assert.deepEqual(parseHash(routeHref(r)), r);
  assert.deepEqual(parseHash(''), { name: 'workspaces' });
  assert.deepEqual(parseHash('#/s/s_1/bogus'), { name: 'session', sessionId: 's_1', tab: 'chat' });
});

test('connection target resolution', () => {
  assert.equal(isMockQuery('?mock=1'), true);
  assert.equal(isMockQuery('?mock=0'), false);
  assert.equal(isMockQuery(''), false);
  assert.equal(resolveInitialTarget({ search: '?mock=1' })?.source, 'mock');
  assert.deepEqual(resolveInitialTarget({ search: '', bridge: { connection: { url: 'ws://x/ws', token: 't' } } }), { url: 'ws://x/ws', token: 't', source: 'electron' });
  assert.equal(normalizeUrl('127.0.0.1:7777'), 'ws://127.0.0.1:7777/ws');
  assert.equal(normalizeUrl('https://hub.example.com'), 'wss://hub.example.com/ws');
  assert.equal(normalizeUrl('wss://hub.example.com/custom'), 'wss://hub.example.com/custom');
  assert.equal(defaultUrl({ protocol: 'https:', host: 'hub.example.com' }), 'wss://hub.example.com/ws');
  assert.equal(defaultUrl({ protocol: 'file:', host: '' }), 'ws://127.0.0.1:7777/ws');
});

test('markdown renders GFM and never passes raw HTML or unsafe links through', () => {
  const html = renderMarkdown('# Hi\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1 < 2;\n```\n\n<script>alert(1)</script>\n\n[ok](https://example.com) [bad](javascript:alert(1)) ![img](https://x/y.png)');
  assert.match(html, /<h1[^>]*>Hi<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /<code class="language-ts">const x = 1 &lt; 2;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /<img/);
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('docs/readme.md'), 'docs/readme.md');
  assert.equal(escapeHtml('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
});

test('restorableHash keeps pages worth reopening after a restart', () => {
  assert.equal(restorableHash('#/s/s_1'), '#/s/s_1');
  assert.equal(restorableHash('#/s/s_1/changes'), '#/s/s_1/changes');
  assert.equal(restorableHash('#/w/w_1'), '#/w/w_1');
  assert.equal(restorableHash('#/machine/m_1'), '#/machine/m_1');
  assert.equal(restorableHash('#/settings/hotkeys'), '#/settings/hotkeys');
  for (const h of ['', '#', '#/', '#/pair?code=x', '#/login/s_2', '#/machines', '#/workspaces', '#/workspaces?add=1', '#/ask?q=hi']) assert.equal(restorableHash(h), null, h);
});

test('the desktop core keeps one storage key across restarts, whatever port it gets', () => {
  assert.equal(connectionKey({ url: 'ws://127.0.0.1:56674/ws', token: 't', source: 'electron' }), 'node:desktop');
  assert.equal(connectionKey({ url: 'ws://127.0.0.1:56917/ws', token: 't', source: 'electron' }), 'node:desktop');
  assert.equal(connectionKey({ url: 'ws://box:7777/ws', source: 'saved' }), 'node:ws://box:7777/ws');
  assert.deepEqual(
    staleDesktopKeys([
      'bizzi.cache.node:ws://127.0.0.1:56674/ws',
      'bizzi.route.node:ws://127.0.0.1:56917/ws',
      'bizzi.machine.node:ws://localhost:7777/ws',
      'bizzi.cache.node:desktop',
      'bizzi.cache.node:ws://box:7777/ws',
      'bizzi.theme',
    ]),
    ['bizzi.cache.node:ws://127.0.0.1:56674/ws', 'bizzi.route.node:ws://127.0.0.1:56917/ws', 'bizzi.machine.node:ws://localhost:7777/ws'],
  );
});

test('keepAwakeSummary says why the machine is held awake', () => {
  const base = { supported: true, settings: { mode: 'turns' as const, onBattery: false }, active: false, turns: 0, background: 0 };
  assert.equal(keepAwakeSummary(undefined), undefined);
  assert.equal(keepAwakeSummary(base), undefined);
  assert.equal(keepAwakeSummary({ ...base, supported: false, active: true, turns: 1 }), undefined);
  assert.equal(keepAwakeSummary({ ...base, active: true, turns: 1 }), 'Keeping awake: 1 turn running');
  assert.equal(keepAwakeSummary({ ...base, active: true, turns: 2, background: 1 }), 'Keeping awake: 2 turns running, 1 session with background work');
  assert.equal(keepAwakeSummary({ ...base, active: true, lingerUntil: '2026-11-27T00:00:00Z' }), 'Keeping awake a little longer after the last work ended');
  assert.equal(keepAwakeSummary({ ...base, turns: 1, pausedOnBattery: true }), 'Not keeping awake on battery (1 turn running)');
});
