// Identity color and icon (spec §11.1 "Identity color"): the per-theme palette, the UI helpers, and the
// mock server's machine.set { color } / workspace.set through the store.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BizziError, LABEL_COLORS } from '@bizzi/protocol';
import type { WorkspaceInfo } from '@bizzi/protocol';
import { BizziClient, BizziStore, createManualScheduler } from '@bizzi/client';
import { BUILTIN_THEMES, DEFAULT_LABELS, LABEL_MIN_CONTRAST, STATE_KEYS, bizziDefault, contrast, deltaE, resolveTheme, themeCssVars } from '../src/lib/theme/index.ts';
import type { Theme } from '../src/lib/theme/index.ts';
import { iconInputError, machineTagsLabel, workspaceColor, workspaceMonogram } from '../src/lib/labels.ts';
import { MockCore, createMockSocketFactory } from '../src/mock/mockServer.ts';

/** Identity colors must read as clearly different colors, not shades of one. */
const LABEL_MIN_DISTANCE = 15;

test('identity colors read on sidebar, cards and page in every built-in theme, light and dark, and stay distinct', () => {
  for (const t of BUILTIN_THEMES) {
    for (const mode of ['light', 'dark'] as const) {
      const r = resolveTheme(t, mode);
      const where = `${t.id} ${mode}`;
      assert.deepEqual(Object.keys(r.labels), [...LABEL_COLORS], where);
      for (const c of LABEL_COLORS) {
        for (const surface of ['sidebar', 'card', 'background'] as const) {
          const ratio = contrast(r.labels[c], r.colors[surface]);
          assert.ok(ratio >= LABEL_MIN_CONTRAST, `${where}: ${c} is ${ratio.toFixed(2)}:1 on ${surface}`);
        }
      }
      for (let i = 0; i < LABEL_COLORS.length; i++) {
        for (let j = i + 1; j < LABEL_COLORS.length; j++) {
          const a = LABEL_COLORS[i]!;
          const b = LABEL_COLORS[j]!;
          assert.ok(deltaE(r.labels[a], r.labels[b]) >= LABEL_MIN_DISTANCE, `${where}: ${a} and ${b} are too similar`);
        }
      }
      // Identity colors are written as their own variables, never over the state tokens.
      const vars = themeCssVars(r);
      for (const c of LABEL_COLORS) assert.equal(vars[`--label-${c}`], r.labels[c], where);
      for (const k of STATE_KEYS) assert.equal(vars[`--state-${k.slice(5).toLowerCase()}`], r.colors[k], where);
    }
  }
});

test('a hostile surface still gets readable identity colors (nudged toward the foreground)', () => {
  const theme: Theme = { id: 'odd-labels', name: 'Odd', variants: { light: { colors: { background: '#ffffff', foreground: '#000000', sidebar: '#9a9a9a', card: '#a0a0a0' } } } };
  const r = resolveTheme(theme, 'light');
  for (const c of LABEL_COLORS) {
    for (const s of [r.colors.sidebar, r.colors.card, r.colors.background]) assert.ok(contrast(r.labels[c], s) >= LABEL_MIN_CONTRAST, c);
  }
});

test('index.css paints the default identity colors (defaults.ts, the resolver and the stylesheet agree)', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    return css.slice(start, css.indexOf('}', start));
  };
  for (const [mode, sel] of [
    ['light', ':root'],
    ['dark', "[data-theme='dark']"],
  ] as const) {
    assert.deepEqual(resolveTheme(bizziDefault, mode).labels, DEFAULT_LABELS[mode], `bizzi Default ${mode} needs no nudging`);
    const b = block(sel);
    for (const c of LABEL_COLORS) assert.ok(b.includes(`--label-${c}: ${DEFAULT_LABELS[mode][c]};`), `${mode} ${c}`);
  }
});

test('labels helpers: worktrees borrow their repo color, monograms, icon input, tag line', () => {
  const repo: WorkspaceInfo = { id: 'w_r', machineId: 'm', name: 'acme', path: '/a', kind: 'git', color: 'teal', createdAt: '' };
  const tree: WorkspaceInfo = { id: 'w_t', machineId: 'm', name: 'acme (x)', path: '/b', kind: 'worktree', parentWorkspaceId: 'w_r', createdAt: '' };
  const all = { w_r: repo, w_t: tree };
  assert.equal(workspaceColor(tree, all), 'teal');
  assert.equal(workspaceColor({ ...tree, color: 'pink' }, all), 'pink');
  assert.equal(workspaceColor({ ...repo, color: undefined as never, kind: 'dir' }, all), undefined);
  assert.equal(workspaceColor(tree, null), undefined);
  assert.equal(workspaceMonogram({ name: 'website' }), 'W');
  assert.equal(workspaceMonogram({ name: '  émile' }), 'É');
  assert.equal(workspaceMonogram({ name: '👩‍💻 dev' }), '👩‍💻');
  assert.equal(workspaceMonogram({ name: 'x', icon: '🚀' }), '🚀');
  assert.equal(workspaceMonogram({ name: '' }), '?');
  assert.equal(iconInputError(''), null);
  assert.equal(iconInputError(' AB '), null);
  assert.ok(iconInputError('abc'));
  assert.ok(iconInputError('a b'));
  assert.equal(machineTagsLabel({ tags: ['gui', 'prod-access'] }), 'gui · prod-access');
  assert.equal(machineTagsLabel({ tags: [] }), '');
});

async function connect(t: TestContext) {
  const core = new MockCore({ speed: 0, autoplay: false });
  const client = new BizziClient({ createSocket: createMockSocketFactory(core) });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, { scheduler });
  t.after(() => {
    store.dispose();
    client.close();
    core.dispose();
  });
  await client.connect('mock://local', 'demo');
  const until = async (cond: () => boolean): Promise<void> => {
    const start = Date.now();
    for (;;) {
      scheduler.flush();
      if (cond()) return;
      if (Date.now() - start > 3000) throw new Error('until timed out');
      await new Promise((r) => setTimeout(r, 2));
    }
  };
  await until(() => store.getState().sessionsLoaded && store.getState().workspaces !== null);
  return { store, until };
}

test('mock: machine color and workspace name, color and icon through the store', async (t) => {
  const { store, until } = await connect(t);
  const bad = (code: string) => (e: unknown) => e instanceof BizziError && e.code === code;

  const m = await store.setMachine({ machineId: 'm_mini', color: 'pink' });
  assert.equal(m.color, 'pink');
  assert.deepEqual(m.tags, ['gui', 'xcode'], 'tags kept');
  await until(() => store.getState().machines.m_mini?.color === 'pink');
  await store.setMachine({ machineId: 'm_mini', color: '' });
  await until(() => store.getState().machines.m_mini?.color === undefined);
  await assert.rejects(store.setMachine({ machineId: 'm_mini', color: 'beige' as never }), bad('bad_request'));

  const w = await store.setWorkspace({ workspaceId: 'w_ext', name: 'Extensions', color: 'yellow', icon: 'Ex' });
  assert.equal(w.name, 'Extensions');
  await until(() => store.getState().workspaces?.w_ext?.icon === 'Ex');
  assert.equal(store.getState().workspaces?.w_ext?.color, 'yellow');
  await store.setWorkspace({ workspaceId: 'w_ext', icon: '' });
  await until(() => store.getState().workspaces?.w_ext?.icon === undefined);
  await assert.rejects(store.setWorkspace({ workspaceId: 'w_ext', icon: 'three' }), bad('bad_request'));
  await assert.rejects(store.setWorkspace({ workspaceId: 'w_ext', name: ' ' }), bad('bad_request'));
  // server-a is offline in the demo: its workspace can't change.
  await assert.rejects(store.setWorkspace({ workspaceId: 'w_infra', color: 'red' }), bad('machine_offline'));
});
