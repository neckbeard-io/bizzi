import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BizziClient } from '@bizzi/client';
import type { ChannelEvent } from '@bizzi/protocol';
import { isEmptyPrefs, mergePrefs, prefsDiff, reconcilePrefs } from '../src/lib/prefs.ts';
import { desktopRedirect, parseHash, routeHref } from '../src/lib/router.ts';
import { IDLE_FOLD_AT, readGroupBy, readSectionFolds, sectionFolded } from '../src/lib/sidebarTree.ts';
import {
  AUTO_MAX,
  AUTO_MIN,
  DEFAULT_SIDEBAR,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  autoWidth,
  clampManual,
  keyWidth,
  manualMax,
  readSidebarPref,
  rowNaturalWidth,
  sidebarWidth,
} from '../src/lib/sidebarWidth.ts';
import { MockCore, createMockSocketFactory } from '../src/mock/mockServer.ts';

test('auto width fits content into [220, 360] and keeps 640px for the main pane', () => {
  assert.equal(autoWidth(150, 1600), AUTO_MIN, 'a short tree still gets the auto minimum');
  assert.equal(autoWidth(287.2, 1600), 288, 'rounded up to whole pixels');
  assert.equal(autoWidth(900, 1600), AUTO_MAX, 'a long branch name does not take over');
  assert.equal(autoWidth(300, 900), 260, 'narrow window: 900 - 640');
  assert.equal(autoWidth(300, 800), SIDEBAR_MIN, 'never below the hard minimum');
  assert.equal(sidebarWidth({ mode: 'auto', width: 400 }, null, 1600), DEFAULT_SIDEBAR.width, 'before the first measurement');
});

test('manual width clamps to [200, min(480, 40% of the window)]', () => {
  assert.equal(manualMax(1600), SIDEBAR_MAX);
  assert.equal(manualMax(1000), 400);
  assert.equal(manualMax(400), SIDEBAR_MIN);
  assert.equal(clampManual(120, 1600), SIDEBAR_MIN);
  assert.equal(clampManual(333.4, 1600), 333);
  assert.equal(clampManual(700, 1000), 400);
  assert.equal(sidebarWidth({ mode: 'manual', width: 470 }, 250, 1000), 400, 'manual ignores the content width');
});

test('resize handle keys', () => {
  assert.equal(keyWidth('ArrowRight', false, 300, 1600), 316);
  assert.equal(keyWidth('ArrowLeft', true, 300, 1600), 252);
  assert.equal(keyWidth('ArrowLeft', false, 205, 1600), SIDEBAR_MIN);
  assert.equal(keyWidth('Home', false, 300, 1600), SIDEBAR_MIN);
  assert.equal(keyWidth('End', false, 300, 1000), 400);
  assert.equal(keyWidth('a', false, 300, 1600), null);
});

test('stored sidebar preference: unreadable values fall back to auto', () => {
  assert.deepEqual(readSidebarPref(null), DEFAULT_SIDEBAR);
  assert.deepEqual(readSidebarPref('x'), DEFAULT_SIDEBAR);
  assert.deepEqual(readSidebarPref({ mode: 'manual', width: 9999 }), { mode: 'manual', width: SIDEBAR_MAX });
  assert.deepEqual(readSidebarPref({ mode: 'weird', width: Number.NaN }), { mode: 'auto', width: DEFAULT_SIDEBAR.width });
});

test('row natural width ignores how wide spacers currently are', () => {
  const row = (spacer: number) => ({
    offset: 14,
    padding: 16,
    gap: 8,
    children: [
      { width: 16, grows: false },
      { width: 80, grows: false },
      { width: spacer, grows: true },
      { width: 40, grows: false },
    ],
  });
  assert.equal(rowNaturalWidth(row(0)), 14 + 16 + 3 * 8 + 16 + 80 + 40);
  assert.equal(rowNaturalWidth(row(300)), rowNaturalWidth(row(0)));
});

test('prefs merge and reconcile: server wins, pending local changes and unseeded keys go up', () => {
  assert.deepEqual(mergePrefs({ themeId: 'a', density: 'compact' }, { themeId: 'b', density: undefined }), { themeId: 'b', density: 'compact' });
  assert.deepEqual(prefsDiff({ themeId: 'a' }, { themeId: 'a', density: 'spacious' }), { density: 'spacious' });
  assert.ok(isEmptyPrefs({}));

  // Another device chose nord: it wins over this device's cached harbour.
  assert.deepEqual(reconcilePrefs({ themeId: 'harbour' }, { themeId: 'nord' }), { apply: { themeId: 'nord' }, push: null });
  // A fresh server (or one upgraded from per-device themes) is seeded with this device's choice.
  assert.deepEqual(reconcilePrefs({ themeId: 'harbour', density: 'compact' }, {}), {
    apply: { themeId: 'harbour', density: 'compact' },
    push: { themeId: 'harbour', density: 'compact' },
  });
  // A change made offline beats the server's older value.
  assert.deepEqual(reconcilePrefs({ themeId: 'dracula' }, { themeId: 'nord', density: 'spacious' }, { themeId: 'dracula' }), {
    apply: { themeId: 'dracula', density: 'spacious' },
    push: { themeId: 'dracula' },
  });
  assert.deepEqual(reconcilePrefs({}, {}), { apply: {}, push: null });
});

test('routes: #/machine/<id> and the old #/m/<id>; desktop redirects list pages to the machine page', () => {
  assert.deepEqual(parseHash('#/machine/m_mini'), { name: 'machine', machineId: 'm_mini' });
  assert.deepEqual(parseHash('#/m/m_mini'), { name: 'machine', machineId: 'm_mini' });
  assert.equal(routeHref({ name: 'machine', machineId: 'm mini' }), '#/machine/m%20mini');
  assert.deepEqual(parseHash('#/settings/connection'), { name: 'settings', section: 'connection' });
  assert.deepEqual(parseHash('#/settings/appearance'), { name: 'settings', section: 'general' });

  assert.deepEqual(desktopRedirect({ name: 'machines' }, true, 'm_laptop'), { name: 'machine', machineId: 'm_laptop' });
  assert.deepEqual(desktopRedirect({ name: 'workspaces' }, true, 'm_mini'), { name: 'machine', machineId: 'm_mini' });
  assert.equal(desktopRedirect({ name: 'machines' }, false, 'm_laptop'), null, 'kept on the phone');
  assert.equal(desktopRedirect({ name: 'machines' }, true, null), null, 'nothing to open yet');
  assert.equal(desktopRedirect({ name: 'inbox' }, true, 'm_laptop'), null);
  assert.equal(desktopRedirect({ name: 'machine', machineId: 'm_mini' }, true, 'm_laptop'), null);
});

test('mock prefs.*: merged, validated, prefs.updated on the global channel', async (t) => {
  const core = new MockCore({ speed: 0, autoplay: false });
  const client = new BizziClient({ createSocket: createMockSocketFactory(core) });
  t.after(() => {
    client.close();
    core.dispose();
  });
  const events: ChannelEvent[] = [];
  client.onEvent((ev) => events.push(ev));
  await client.connect('mock://local', 'demo');
  await client.subscribe('global');
  assert.deepEqual((await client.request('prefs.get', {})).prefs, {});
  assert.deepEqual((await client.request('prefs.set', { prefs: { themeId: 'nord' } })).prefs, { themeId: 'nord' });
  assert.deepEqual((await client.request('prefs.set', { prefs: { density: 'compact' } })).prefs, { themeId: 'nord', density: 'compact' });
  await assert.rejects(client.request('prefs.set', { prefs: { density: 'huge' as never } }), { code: 'bad_request' });
  const deadline = Date.now() + 2000;
  while (!events.some((e) => e.type === 'prefs.updated' && e.data.prefs.density === 'compact') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  const last = events.filter((e) => e.type === 'prefs.updated').at(-1);
  assert.deepEqual(last?.type === 'prefs.updated' ? last.data.prefs : null, { themeId: 'nord', density: 'compact' });
});

test('session tree layout: helpers fold under their parent, the open one unfolds it, open nests end with "n ended"', async () => {
  const { layoutSessionTree, MAX_NEST_INDENT } = await import('../src/lib/sidebarTree.ts');
  const line = (sessionId: string, depth: number, extra: Record<string, unknown> = {}) =>
    ({ sessionId, depth, agent: 'claude', mode: 'structured', title: sessionId, state: 'idle', updatedAt: '' , ...extra }) as Parameters<typeof layoutSessionTree>[0][number];
  const lines = [
    line('lead', 0, { helpers: 3, endedHelpers: 2 }),
    line('h1', 1, { parentId: 'lead', helpers: 1 }),
    line('h1a', 2, { parentId: 'h1', helpers: 1 }),
    line('h1a1', 3, { parentId: 'h1a', helpers: 1 }),
    line('h1a1x', 4, { parentId: 'h1a1' }),
    line('other', 0),
  ];
  const shape = (items: ReturnType<typeof layoutSessionTree>) => items.map((i) => (i.kind === 'session' ? `${i.line.sessionId}@${i.indent}${i.expandable ? (i.folded ? '+' : '-') : ''}` : `ended:${i.parentId}:${i.n}@${i.indent}`));
  assert.equal(MAX_NEST_INDENT, 3);
  assert.deepEqual(shape(layoutSessionTree(lines, {}, null)), ['lead@0-', 'h1@1-', 'h1a@2-', 'h1a1@3-', 'h1a1x@3', 'ended:lead:2@1', 'other@0']);
  assert.deepEqual(shape(layoutSessionTree(lines, { lead: true }, null)), ['lead@0+', 'other@0'], 'folded: no helpers and no ended line');
  assert.deepEqual(shape(layoutSessionTree(lines, { lead: true, h1: true }, 'h1a')), ['lead@0-', 'h1@1-', 'h1a@2-', 'h1a1@3-', 'h1a1x@3', 'ended:lead:2@1', 'other@0'], 'the open session unfolds its parents');
  assert.deepEqual(shape(layoutSessionTree(lines, { h1a: true }, null)), ['lead@0-', 'h1@1-', 'h1a@2+', 'ended:lead:2@1', 'other@0']);
});

test('by state: the grouping pref reads back safely; a long Idle starts folded, your choice wins, the open session unfolds', () => {
  assert.equal(readGroupBy('state'), 'state');
  for (const raw of ['workspace', null, 42, 'nope']) assert.equal(readGroupBy(raw), 'workspace');
  assert.deepEqual(readSectionFolds({ idle: false, waiting: true, junk: 1 }), { idle: false, waiting: true });
  assert.deepEqual(readSectionFolds('x'), {});
  assert.equal(sectionFolded('idle', IDLE_FOLD_AT, {}, false), false);
  assert.equal(sectionFolded('idle', IDLE_FOLD_AT + 1, {}, false), true);
  assert.equal(sectionFolded('working', 40, {}, false), false);
  assert.equal(sectionFolded('idle', 40, { idle: false }, false), false, 'opened by hand');
  assert.equal(sectionFolded('waiting', 1, { waiting: true }, false), true, 'folded by hand');
  assert.equal(sectionFolded('waiting', 1, { waiting: true }, true), false, 'holds the open session');
});
