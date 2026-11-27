import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, builtinCommand, commandDetail, matchCommands, sessionCommands, slashQuery } from '../src/lib/slash.ts';

test('bizzi commands come first, agent commands are normalized and deduped', () => {
  const cmds = sessionCommands([{ name: '/review', description: 'Review a PR' }, { name: 'compact' }, { name: 'clear' }, { name: 'new' }, { name: 'review' }, { name: 'bad name' }]);
  assert.deepEqual(
    cmds.map((c) => c.name),
    ['clear', 'review', 'compact'],
  );
  assert.equal(cmds[0]!.builtin, true);
  assert.equal(cmds[1]!.description, 'Review a PR');
  assert.deepEqual(sessionCommands(undefined).map((c) => c.name), ['clear']);
});

test('slashQuery only while typing the first word of a draft that starts with /', () => {
  assert.equal(slashQuery('/', 1), '');
  assert.equal(slashQuery('/cle', 4), 'cle');
  assert.equal(slashQuery('/clear now', 10), null);
  assert.equal(slashQuery('/clear ', 7), null);
  assert.equal(slashQuery('fix /clear', 10), null);
  assert.equal(slashQuery('/clear', 0), null);
});

test('matchCommands ranks prefixes first and keeps order otherwise', () => {
  const cmds = sessionCommands([{ name: 'review' }, { name: 'security-review' }, { name: 'compact' }]);
  assert.deepEqual(matchCommands(cmds, '').map((c) => c.name), ['clear', 'review', 'security-review', 'compact']);
  assert.deepEqual(matchCommands(cmds, 're').map((c) => c.name), ['reset', 'review', 'security-review']);
  assert.deepEqual(matchCommands(cmds, 'c').map((c) => c.name), ['clear', 'compact', 'security-review']);
  assert.deepEqual(matchCommands(cmds, 'zzz'), []);
});

test('builtinCommand recognizes /clear and its aliases, alone', () => {
  assert.equal(builtinCommand('/clear'), 'clear');
  assert.equal(builtinCommand('  /reset \n'), 'clear');
  assert.equal(builtinCommand('/NEW'), 'clear');
  assert.equal(builtinCommand('/clear the cache please'), null);
  assert.equal(builtinCommand('/compact'), null);
  assert.equal(builtinCommand('clear'), null);
});

test('applyCommand replaces the first word and puts the caret after one space', () => {
  assert.deepEqual(applyCommand('/re', { name: 'review' }), { text: '/review ', caret: 8 });
  assert.deepEqual(applyCommand('/re 123', { name: 'review' }), { text: '/review 123', caret: 8 });
});

test('aliases show up in the menu under the name you typed', () => {
  const cmds = sessionCommands([{ name: 'review' }, { name: 'compact' }]);
  const n = matchCommands(cmds, 'n');
  assert.deepEqual(n.map((c) => c.name), ['new']);
  assert.equal(n[0]!.aliasOf, 'clear');
  assert.equal(n[0]!.builtin, true);
  assert.deepEqual(matchCommands(cmds, 're').map((c) => c.name), ['reset', 'review']);
  // The canonical name wins when it matches too; the aliases aren't listed twice.
  assert.deepEqual(matchCommands(cmds, '').map((c) => c.name), ['clear', 'review', 'compact']);
  assert.deepEqual(matchCommands(cmds, 'cl').map((c) => c.name), ['clear']);
  assert.match(commandDetail(cmds[0]!)!, /also \/new, \/reset$/);
  assert.match(commandDetail(n[0]!)!, /same as \/clear$/);
  assert.equal(commandDetail({ name: 'compact' }), undefined);
  assert.equal(builtinCommand(`/${n[0]!.name}`), 'clear');
});
