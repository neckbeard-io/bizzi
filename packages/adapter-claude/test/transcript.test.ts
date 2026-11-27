import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasTranscript } from '../src/transcript.ts';

test('hasTranscript looks for <id>.jsonl in any project under CLAUDE_CONFIG_DIR', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bizzi-claude-cfg-'));
  try {
    const env = { CLAUDE_CONFIG_DIR: dir };
    assert.equal(await hasTranscript('abc', env), false, 'no projects dir yet');
    await mkdir(join(dir, 'projects', '-tmp-a'), { recursive: true });
    await mkdir(join(dir, 'projects', '-tmp-b'), { recursive: true });
    assert.equal(await hasTranscript('abc', env), false);
    await writeFile(join(dir, 'projects', '-tmp-b', 'abc.jsonl'), '{}\n');
    assert.equal(await hasTranscript('abc', env), true);
    assert.equal(await hasTranscript('abd', env), false);
    assert.equal(await hasTranscript('../x', env), undefined, 'not an id');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
