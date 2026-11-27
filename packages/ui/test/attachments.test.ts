import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInput,
  expandInDraft,
  hasContent,
  insertAt,
  lineCount,
  liveAttachments,
  placeholderFor,
  removeFromDraft,
  shouldCollapse,
  shouldCondense,
  stripPlaceholders,
} from '../src/lib/attachments.ts';
import type { Attachment } from '../src/lib/attachments.ts';
import { parseTokens } from '../src/lib/onePane.ts';

const log = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
const img: Attachment = { kind: 'image', id: 1, mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=' };
const paste: Attachment = { kind: 'text', id: 2, text: log };

test('long pastes are condensed, short ones are not', () => {
  assert.equal(lineCount(''), 0);
  assert.equal(lineCount('a'), 1);
  assert.equal(lineCount('a\nb\n'), 2);
  assert.equal(shouldCondense('a short note'), false);
  assert.equal(shouldCondense(log), true);
  assert.equal(shouldCondense('x'.repeat(1200)), true);
  assert.equal(shouldCollapse('two\nlines'), false);
  assert.equal(shouldCollapse(log), true);
});

test('placeholders name the attachment and its size', () => {
  assert.equal(placeholderFor(img), '[Image 1]');
  assert.equal(placeholderFor(paste), '[Pasted text 2 · 40 lines]');
  assert.equal(placeholderFor({ kind: 'text', id: 3, text: 'x'.repeat(1500) }), '[Pasted text 3 · 1500 chars]');
});

test('buildInput keeps order and splits pastes and images into their own blocks', () => {
  const draft = `Why does this fail? ${placeholderFor(paste)} It looks like ${placeholderFor(img)} on screen.`;
  assert.deepEqual(buildInput(draft, [img, paste]), [
    { type: 'text', text: 'Why does this fail?' },
    { type: 'text', text: log },
    { type: 'text', text: 'It looks like' },
    { type: 'image', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=' },
    { type: 'text', text: 'on screen.' },
  ]);
  assert.deepEqual(liveAttachments(draft, [img, paste]), [paste, img]);
  assert.equal(stripPlaceholders(draft, [img, paste]), 'Why does this fail? It looks like on screen.');
});

test('a deleted or unknown placeholder drops out; an image alone is content', () => {
  assert.deepEqual(buildInput('just text [Image 9]', [img]), [{ type: 'text', text: 'just text [Image 9]' }]);
  assert.deepEqual(liveAttachments('no placeholders', [img, paste]), []);
  assert.equal(hasContent('  ', [img]), false);
  assert.equal(hasContent('[Image 1] ', [img]), true);
  assert.deepEqual(buildInput('[Image 1] ', [img]), [{ type: 'image', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=' }]);
  // A placeholder whose size label was edited still resolves by number.
  assert.deepEqual(liveAttachments('[Pasted text 2 · 41 lines]', [paste]), [paste]);
});

test('expand and remove edit the draft in place', () => {
  const draft = `see ${placeholderFor(paste)} and ${placeholderFor(img)} ok`;
  assert.equal(expandInDraft(draft, paste), `see ${log} and [Image 1] ok`);
  assert.equal(removeFromDraft(draft, img), `see ${placeholderFor(paste)} and ok`);
  assert.equal(expandInDraft(draft, img), draft);
});

test('insertAt pads placeholders away from words', () => {
  assert.deepEqual(insertAt('', 0, 0, '[Image 1]'), { text: '[Image 1] ', caret: 10 });
  assert.deepEqual(insertAt('look:', 5, 5, '[Image 1]'), { text: 'look: [Image 1] ', caret: 16 });
  assert.deepEqual(insertAt('a b', 1, 1, '[Image 1]'), { text: 'a [Image 1] b', caret: 11 });
  assert.deepEqual(insertAt('replace me', 0, 7, 'X'), { text: 'X me', caret: 1 });
});

test('placeholders never read as routing tokens', () => {
  const r = parseTokens(`fix it ${placeholderFor(img)} ${placeholderFor(paste)}`, [], []);
  assert.equal(r.any, false);
});
