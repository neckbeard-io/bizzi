import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_TITLE_MAX, clipTitle, titleFromText } from '../src/index.ts';

test('titleFromText: the gist of the first line', () => {
  const cases: [string, string][] = [
    [
      'I’d like shorter titles for auto-named sessions instead of just the entire prompt. For example, this one should be called "short titles for sessions".',
      'shorter titles for auto-named sessions',
    ],
    ['Can you fix the login redirect loop? It happens after a token refresh.', 'fix the login redirect loop'],
    ['please refactor the session manager so that every turn goes through a single queue', 'refactor the session manager'],
    ["Hey, I want you to add dark mode to the settings page", 'add dark mode to the settings page'],
    ["let's speed up the test suite; it takes 4 minutes now", 'speed up the test suite'],
    ['The checkout page crashes on submit, the stack trace is below', 'The checkout page crashes on submit'],
    ['why are checkout 502s up?\nmore detail', 'why are checkout 502s up?'],
    ['How do I configure the hub behind nginx?', 'configure the hub behind nginx'],
    ['upgrade to node 26 (it has type stripping on by default)', 'upgrade to node 26'],
    ['bump the deps, e.g. react and vite', 'bump the deps'],
    ['fix the bug in the checkout page where totals are wrong after a coupon is applied', 'fix the bug in the checkout page…'],
    ['  fix the   login redirect loop  ', 'fix the login redirect loop'],
    ['\n\n## Add dark mode\nmore detail here', 'Add dark mode'],
    ['```ts\nconst x = 1\n```', 'const x = 1'],
    ['---\n> quoted ask', 'quoted ask'],
    ['Please.', 'Please'],
    ['next.js build is broken', 'next.js build is broken'],
  ];
  for (const [input, want] of cases) assert.equal(titleFromText(input), want, input);
  assert.equal(titleFromText('   \n  '), undefined);
  const long = titleFromText('x'.repeat(120))!;
  assert.equal(long.length, AUTO_TITLE_MAX);
  assert.ok(long.endsWith('…'));
});

test('clipTitle cuts at a word and marks the cut', () => {
  assert.equal(clipTitle('short', 10), 'short');
  assert.equal(clipTitle('one two three four five', 12), 'one two…');
});
