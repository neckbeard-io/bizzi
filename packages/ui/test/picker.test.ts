import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowseEntry } from '@bizzi/protocol';
import {
  basename,
  breadcrumbs,
  dirInput,
  commonPrefix,
  dropdownKey,
  exactMatch,
  expandTilde,
  isAbsoluteLike,
  pickerRequestFromHash,
  splitInput,
  tabCompletion,
  toTilde,
} from '../src/lib/picker.ts';
import type { DropdownState } from '../src/lib/picker.ts';

const dir = (name: string, extra: Partial<BrowseEntry> = {}): BrowseEntry => ({ name, path: `/Users/dev/${name}`, kind: 'dir', ...extra });

test('splitInput mirrors fs.complete', () => {
  assert.deepEqual(splitInput('~/re'), { base: '~/', partial: 're' });
  assert.deepEqual(splitInput('~'), { base: '~/', partial: '' });
  assert.deepEqual(splitInput(''), { base: '~/', partial: '' });
  assert.deepEqual(splitInput('/Users/dev/src/'), { base: '/Users/dev/src/', partial: '' });
  assert.deepEqual(splitInput('/a/b'), { base: '/a/', partial: 'b' });
  assert.deepEqual(splitInput('C:\\Users\\me\\pro'), { base: 'C:\\Users\\me\\', partial: 'pro' });
});

test('tilde, absolute check, basename', () => {
  assert.equal(expandTilde('~/src/app/', '/Users/dev'), '/Users/dev/src/app');
  assert.equal(expandTilde('~', '/Users/dev'), '/Users/dev');
  assert.equal(expandTilde('/', '/Users/dev'), '/');
  assert.equal(toTilde('/Users/dev/src', '/Users/dev'), '~/src');
  assert.equal(toTilde('/Users/dev', '/Users/dev'), '~');
  assert.equal(toTilde('/Users/devx/src', '/Users/dev'), '/Users/devx/src');
  assert.ok(isAbsoluteLike('~/x') && isAbsoluteLike('/x') && isAbsoluteLike('C:\\x') && !isAbsoluteLike('src/x'));
  assert.equal(basename('/Users/dev/src/app/'), 'app');
  assert.equal(basename('/'), '/');
  assert.equal(dirInput('/Users/dev/src', '/Users/dev'), '~/src/');
  assert.equal(dirInput('/Users/dev', '/Users/dev'), '~/');
  assert.equal(dirInput('/', '/Users/dev'), '/');
  assert.equal(dirInput('/srv', null), '/srv/');
});

test('commonPrefix, optionally case folded', () => {
  assert.equal(commonPrefix(['react', 'redux', 'repo']), 're');
  assert.equal(commonPrefix(['acme-shop', 'acme-shop.worktrees']), 'acme-shop');
  assert.equal(commonPrefix(['Rust', 'rustlings']), '');
  assert.equal(commonPrefix(['Rust', 'rustlings'], true), 'Rust');
  assert.equal(commonPrefix([]), '');
  assert.equal(commonPrefix(['one']), 'one');
});

test('tabCompletion: single match descends, several extend to the common prefix', () => {
  assert.equal(tabCompletion('~/sr', [dir('src')], -1), '~/src/');
  assert.equal(tabCompletion('~/src/ac', [dir('acme-shop'), dir('acme-shop.worktrees')], -1), '~/src/acme-shop');
  assert.equal(tabCompletion('~/src/acme-shop', [dir('acme-shop'), dir('acme-shop.worktrees')], -1), null);
  assert.equal(tabCompletion('~/src/acme-shop', [dir('acme-shop'), dir('acme-shop.worktrees')], 1), '~/src/acme-shop.worktrees/');
  assert.equal(tabCompletion('~/x', [], -1), null);
});

test('dropdownKey: arrows, Tab, Enter, Escape', () => {
  const s: DropdownState = { input: '~/re', completions: [dir('react'), dir('repo'), dir('research')], selected: -1, open: true };
  const down = dropdownKey(s, 'ArrowDown');
  assert.deepEqual(down.kind === 'state' && down.state.selected, 0);
  const wrapUp = dropdownKey({ ...s, selected: 0 }, 'ArrowUp');
  assert.deepEqual(wrapUp.kind === 'state' && wrapUp.state.selected, 2);
  const wrapDown = dropdownKey({ ...s, selected: 2 }, 'ArrowDown');
  assert.deepEqual(wrapDown.kind === 'state' && wrapDown.state.selected, 0);
  // Closed list: an arrow opens it.
  const opened = dropdownKey({ ...s, open: false }, 'ArrowUp');
  assert.ok(opened.kind === 'state' && opened.state.open && opened.state.selected === 2);
  assert.deepEqual(dropdownKey({ ...s, completions: [] }, 'ArrowDown'), { kind: 'default' });

  // Tab: no common extension beyond "re" and nothing highlighted → nothing to add.
  assert.deepEqual(dropdownKey(s, 'Tab'), { kind: 'default' });
  assert.deepEqual(dropdownKey({ ...s, selected: 1 }, 'Tab'), { kind: 'input', input: '~/repo/' });
  assert.deepEqual(dropdownKey({ ...s, input: '~/res', completions: [dir('research')] }, 'Tab'), { kind: 'input', input: '~/research/' });

  // Enter: descend into the highlighted entry, else submit.
  assert.deepEqual(dropdownKey({ ...s, selected: 2 }, 'Enter'), { kind: 'input', input: '~/research/' });
  assert.deepEqual(dropdownKey(s, 'Enter'), { kind: 'submit' });
  assert.deepEqual(dropdownKey({ ...s, open: false, selected: 1 }, 'Enter'), { kind: 'submit' });

  // Escape: closes the list first, then the dialog.
  const esc = dropdownKey({ ...s, selected: 1 }, 'Escape');
  assert.ok(esc.kind === 'state' && !esc.state.open && esc.state.selected === -1);
  assert.deepEqual(dropdownKey({ ...s, open: false }, 'Escape'), { kind: 'close' });
  assert.deepEqual(dropdownKey(s, 'a'), { kind: 'default' });
});

test('breadcrumbs collapse home into ~', () => {
  assert.deepEqual(breadcrumbs('/Users/dev/src/app', '/Users/dev'), [
    { label: '~', path: '/Users/dev' },
    { label: 'src', path: '/Users/dev/src' },
    { label: 'app', path: '/Users/dev/src/app' },
  ]);
  assert.deepEqual(breadcrumbs('/srv/infra', '/Users/dev'), [
    { label: '/', path: '/' },
    { label: 'srv', path: '/srv' },
    { label: 'infra', path: '/srv/infra' },
  ]);
  assert.deepEqual(breadcrumbs('/', '/Users/dev'), [{ label: '/', path: '/' }]);
});

test('pickerRequestFromHash', () => {
  assert.deepEqual(pickerRequestFromHash('#/workspaces?add=1'), {});
  assert.deepEqual(pickerRequestFromHash('#/workspaces?add=1&machine=m_mini&path=~%2Fsrc'), { machineId: 'm_mini', path: '~/src' });
  assert.equal(pickerRequestFromHash('#/workspaces'), null);
  assert.equal(pickerRequestFromHash('#/workspaces?add=0'), null);
});

test('exactMatch respects case sensitivity', () => {
  const list = [dir('Rust'), dir('repo')];
  assert.equal(exactMatch('repo', list)?.name, 'repo');
  assert.equal(exactMatch('rust', list), undefined);
  assert.equal(exactMatch('rust', list, true)?.name, 'Rust');
});
