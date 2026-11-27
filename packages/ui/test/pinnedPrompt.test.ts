import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TimelineItem } from '@bizzi/client';
import { pinnedPromptIndex, promptText } from '../src/lib/pinnedPrompt.ts';

const base = { id: 'i', seq: 1, ts: 0 } as const;

test('promptText flattens turn input and skips non-prompts', () => {
  const turn = {
    ...base,
    kind: 'turn',
    input: [
      { type: 'text', text: '  fix the build  ' },
      { type: 'file', path: 'src/a.ts' },
      { type: 'image', mediaType: 'image/png', dataBase64: '' },
      { type: 'image', mediaType: 'image/png', dataBase64: '' },
    ],
  } as unknown as TimelineItem;
  assert.equal(promptText(turn), 'fix the build\n@src/a.ts\n[2 images]');
  assert.equal(promptText({ ...base, kind: 'turn', input: [{ type: 'text', text: '  ' }] } as unknown as TimelineItem), null);
  assert.equal(promptText({ ...base, kind: 'message', role: 'user', text: 'hi' } as unknown as TimelineItem), 'hi');
  assert.equal(promptText({ ...base, kind: 'message', role: 'assistant', text: 'hi' } as unknown as TimelineItem), null);
  assert.equal(promptText({ ...base, kind: 'steer', input: [{ type: 'text', text: 'also x' }] } as unknown as TimelineItem), null);
  assert.equal(promptText(undefined), null);
});

test('promptText leaves out what bizzi sent itself and turns the agent started', () => {
  const note = [{ type: 'text', text: '[bizzi] bizzi restarted while you were working, and your last turn was cut off partway.' }];
  const turn = (extra: object) => ({ ...base, kind: 'turn', ...extra }) as unknown as TimelineItem;
  assert.equal(promptText(turn({ input: note, auto: true })), null);
  // History from older nodes: no `auto` flag, only the prefix.
  assert.equal(promptText(turn({ input: note })), null);
  assert.equal(promptText({ ...base, kind: 'message', role: 'user', text: note[0]!.text } as unknown as TimelineItem), null);
  assert.equal(promptText(turn({ input: [], agent: true })), null);
  assert.equal(promptText(turn({ input: [{ type: 'text', text: 'what does [bizzi] mean?' }] })), 'what does [bizzi] mean?');
});

test('pinnedPromptIndex pins the last prompt above the viewport once it is fully out of view', () => {
  // Rows of 100px each; prompts at rows 0, 3 and 7.
  const span = (i: number) => ({ start: i * 100, end: i * 100 + 100 });
  const prompts = [0, 3, 7];
  assert.equal(pinnedPromptIndex(prompts, span, 0), -1, 'first prompt in view');
  assert.equal(pinnedPromptIndex(prompts, span, 50), -1, 'first prompt partly in view');
  assert.equal(pinnedPromptIndex(prompts, span, 100), 0);
  assert.equal(pinnedPromptIndex(prompts, span, 250), 0, 'row 3 not reached yet');
  assert.equal(pinnedPromptIndex(prompts, span, 350), -1, 'prompt 3 still partly visible');
  assert.equal(pinnedPromptIndex(prompts, span, 650), 3);
  assert.equal(pinnedPromptIndex(prompts, span, 5000), 7);
  assert.equal(pinnedPromptIndex([], span, 500), -1);
  assert.equal(pinnedPromptIndex([2], () => undefined, 500), -1, 'unmeasured');
});
