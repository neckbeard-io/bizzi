import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentListing } from '@bizzi/protocol';
import { HOTKEYS, hotkeyLabel, isMacPlatform, matchHotkey, readHotkeyPrefs } from '../src/lib/hotkeys.ts';
import type { KeyLike } from '../src/lib/hotkeys.ts';
import { defaultAgent, profileSessionParams, resolveMode } from '../src/lib/newSession.ts';
import { groupWorkspaces, readCollapsed } from '../src/lib/sidebarTree.ts';

const on = readHotkeyPrefs(null);
const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test('hotkeys: ⌘ on macOS, Ctrl elsewhere, exactly that modifier', () => {
  assert.equal(matchHotkey(key('n', { metaKey: true }), { mac: true, prefs: on }), 'newWorkspace');
  assert.equal(matchHotkey(key('t', { metaKey: true }), { mac: true, prefs: on }), 'newSession');
  assert.equal(matchHotkey(key('w', { metaKey: true }), { mac: true, prefs: on }), 'closeSession');
  assert.equal(matchHotkey(key('w', { ctrlKey: true }), { mac: false, prefs: on }), 'closeSession');
  assert.equal(matchHotkey(key('W', { metaKey: true, shiftKey: true }), { mac: true, prefs: on }), null, '⇧⌘W closes the window');
  assert.equal(matchHotkey(key('n', { ctrlKey: true }), { mac: true, prefs: on }), null, 'Ctrl+N on a Mac is the shell’s');
  assert.equal(matchHotkey(key('N', { metaKey: true, shiftKey: true }), { mac: true, prefs: on }), null, '⌘⇧N is New Prompt');
  assert.equal(matchHotkey(key('n', { ctrlKey: true }), { mac: false, prefs: on }), 'newWorkspace');
  assert.equal(matchHotkey(key('t', { ctrlKey: true, altKey: true }), { mac: false, prefs: on }), null);
  assert.equal(matchHotkey(key('t', { metaKey: true }), { mac: false, prefs: on }), null);
  assert.equal(matchHotkey(key('t', { metaKey: true, repeat: true }), { mac: true, prefs: on }), null, 'held keys don’t repeat');
  // Physical key, for non-Latin layouts.
  assert.equal(matchHotkey(key('е', { code: 'KeyT', ctrlKey: true }), { mac: false, prefs: on }), 'newSession');
});

test('hotkeys: switched off per device; Ctrl+letter in a terminal stays with the shell (not ⌘)', () => {
  const prefs = readHotkeyPrefs({ newSession: false, junk: 1 });
  assert.deepEqual(prefs, { newWorkspace: true, newSession: false, closeSession: true });
  assert.equal(matchHotkey(key('t', { metaKey: true }), { mac: true, prefs }), null);
  assert.equal(matchHotkey(key('t', { ctrlKey: true }), { mac: false, prefs: on, inTerminal: true }), null);
  assert.equal(matchHotkey(key('w', { ctrlKey: true }), { mac: false, prefs: on, inTerminal: true }), null, 'Ctrl+W deletes a word in the shell');
  assert.equal(matchHotkey(key('t', { metaKey: true }), { mac: true, prefs: on, inTerminal: true }), 'newSession');
  assert.deepEqual(readHotkeyPrefs('nope'), on);
});

test('hotkeys: labels and platforms', () => {
  const n = HOTKEYS.find((h) => h.id === 'newWorkspace')!;
  assert.equal(hotkeyLabel(n, true), '⌘N');
  assert.equal(hotkeyLabel(n, false), 'Ctrl+N');
  for (const p of ['darwin', 'MacIntel', 'macOS', 'iPad']) assert.ok(isMacPlatform(p), p);
  for (const p of ['win32', 'Win32', 'linux', 'Linux x86_64', undefined]) assert.equal(isMacPlatform(p), false, String(p));
});

function agent(over: Partial<AgentListing>): AgentListing {
  return {
    agent: 'claude',
    installed: true,
    auth: 'ok',
    capabilities: { modes: ['structured', 'terminal'], permissionModes: ['default', 'plan'], effort: ['low', 'high'] },
    ...over,
  } as AgentListing;
}

test('default session: the form’s agent, the profile’s fields where the agent takes them', () => {
  const codex = agent({ agent: 'codex', auth: 'missing' as AgentListing['auth'] });
  const claude = agent({});
  const broken = agent({ agent: 'opencode', support: 'unsupported' as AgentListing['support'] });
  assert.equal(defaultAgent([codex, broken, claude])?.agent, 'claude', 'signed in and supported first');
  assert.equal(defaultAgent([codex])?.agent, 'codex', 'else the first installed');
  assert.equal(defaultAgent([agent({ installed: false })]), undefined);

  assert.deepEqual(profileSessionParams('w1', claude, { id: 'p', agent: 'claude', name: 'Plan', model: ' opus ', permissionMode: 'plan', effort: 'high' }), {
    workspaceId: 'w1',
    agent: 'claude',
    mode: 'structured',
    model: 'opus',
    permissionMode: 'plan',
    effort: 'high',
  });
  assert.deepEqual(profileSessionParams('w1', claude, { id: 'p', agent: 'claude', name: 'X', permissionMode: 'yolo', effort: 'max' }), { workspaceId: 'w1', agent: 'claude', mode: 'structured' });
  assert.deepEqual(profileSessionParams('w1', claude, { id: 'p', agent: 'claude', name: 'T', mode: 'terminal', model: 'opus' }), { workspaceId: 'w1', agent: 'claude', mode: 'terminal', cols: 100, rows: 30 });
  assert.equal(resolveMode('terminal', ['structured']), 'structured');
  assert.equal(resolveMode('', ['terminal']), 'terminal');
});

test('sidebar tree: worktrees under their repo; folded workspaces', () => {
  const ws = (id: string) => ({ id, machineId: 'm', name: id, path: `/${id}`, kind: 'git', createdAt: '' }) as never;
  const groups = groupWorkspaces([
    { workspace: ws('a'), depth: 0 },
    { workspace: ws('a-wt'), depth: 1 },
    { workspace: ws('b'), depth: 0 },
  ]);
  assert.deepEqual(
    groups.map((g) => [(g.workspace as { id: string }).id, g.worktrees.map((w) => w.id)]),
    [
      ['a', ['a-wt']],
      ['b', []],
    ],
  );
  assert.deepEqual(readCollapsed({ a: true, b: false, c: 'x' }), { a: true });
});
