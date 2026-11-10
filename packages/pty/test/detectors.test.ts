import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_DETECTORS,
  SHIPPED_DETECTORS_PATH,
  detectorsDisabledByEnv,
  detectorsFor,
  loadDetectorSet,
  overridePath,
  regexDetector,
  resolveDetectorSet,
  shippedDetectors,
  stripAnsi,
  validateDetectorFile,
} from '../src/index.ts';
import { tempDir } from './helpers.ts';

const NO_ENV = {};

function writeJson(dir: string, data: unknown, name = 'detectors.json'): string {
  const p = join(dir, name);
  writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data));
  return p;
}

describe('shipped detectors.json', () => {
  it('validates cleanly and carries provenance', () => {
    const raw = JSON.parse(readFileSync(SHIPPED_DETECTORS_PATH, 'utf8'));
    const { file, errors } = validateDetectorFile(raw);
    assert.deepEqual(errors, []);
    assert.equal(file!.schema, 1);
    assert.match(file!.version, /^\d{4}\.\d{2}\.\d{2}$/);
    for (const d of file!.detectors) assert.ok(d.note, `${d.id} has a note`);
    const ids = shippedDetectors().detectors.map((d) => d.id);
    assert.deepEqual(ids, [
      'claude-permission',
      'claude-trust',
      'codex-approval',
      'agy-approval',
      'yes-no',
      'claude-input',
      'codex-input',
      'press-enter',
      'shell-prompt',
    ]);
    assert.equal(DEFAULT_DETECTORS.length, ids.length);
    assert.match(DEFAULT_DETECTORS[0]!.origin!, /^builtin@/);
  });

  it('phrases tolerate cursor-move whitespace and report the matched excerpt', () => {
    const d = DEFAULT_DETECTORS.find((x) => x.id === 'claude-permission')!;
    const text = stripAnsi('\x1b[1mDo\x1b[4Gyou\x1b[8Gwant\x1b[13Gto\x1b[16Gproceed?\x1b[0m\r\n❯ 1. Yes');
    assert.equal(d.test(text), true);
    assert.equal(d.match!(text), 'Do you want to proceed?');
    assert.equal(d.match!('nothing here'), undefined);
  });

  it('last-line patterns only look at the last non-empty line', () => {
    const d = DEFAULT_DETECTORS.find((x) => x.id === 'yes-no')!;
    assert.equal(d.test('Overwrite? [y/N]\nok, overwritten\n'), false);
    assert.equal(d.match!('Overwrite? [y/N] \n\n'), '[y/N]');
  });
});

describe('validateDetectorFile', () => {
  it('rejects wrong schema and shape outright', () => {
    assert.deepEqual(validateDetectorFile([]).errors, ['file must be a JSON object']);
    assert.match(validateDetectorFile({ schema: 2, version: 'x', detectors: [] }).errors[0]!, /unsupported schema 2/);
    assert.match(validateDetectorFile({ schema: 1, detectors: [] }).errors[0]!, /version/);
    assert.match(validateDetectorFile({ schema: 1, version: 'x', mode: 'zap', detectors: [] }).errors[0]!, /mode/);
  });

  it('drops invalid detectors and reports each problem', () => {
    const { file, errors } = validateDetectorFile({
      schema: 1,
      version: 'test',
      detectors: [
        { id: 'ok', prompt: 'question', patterns: [{ phrases: ['Pick one'] }], note: 'n' },
        { id: 'bad prompt', prompt: 'input', patterns: [{ phrases: ['x'] }] },
        { id: 'p1', prompt: 'nope', patterns: [{ phrases: ['x'] }] },
        { id: 'p2', prompt: 'input', agents: ['emacs'], patterns: [{ phrases: ['x'] }] },
        { id: 'p3', prompt: 'input', patterns: [] },
        { id: 'p4', prompt: 'input', patterns: [{ regex: '(' }] },
        { id: 'p5', prompt: 'input', patterns: [{ regex: 'x', flags: 'g' }] },
        { id: 'p6', prompt: 'input', patterns: [{ regex: 'x', scope: 'screen' }] },
        { id: 'p7', prompt: 'input', patterns: [{ words: ['x'] }] },
        { id: 'ok', prompt: 'input', patterns: [{ phrases: ['dup'] }] },
      ],
    });
    assert.deepEqual(
      file!.detectors.map((d) => d.id),
      ['ok'],
    );
    assert.equal(errors.length, 9);
    assert.ok(errors.some((e) => /invalid regex/.test(e)));
    assert.ok(errors.some((e) => /duplicate id/.test(e)));
  });
});

describe('loadDetectorSet', () => {
  it('uses the shipped set when there is no override file', () => {
    const dir = tempDir();
    const set = loadDetectorSet({ dataDir: dir, env: NO_ENV });
    assert.equal(set.enabled, true);
    assert.equal(set.override, undefined);
    assert.deepEqual(set.warnings, []);
    assert.equal(set.detectors.length, DEFAULT_DETECTORS.length);
  });

  it('merges <dataDir>/detectors.json by id: replace, add, disable', () => {
    const dir = tempDir();
    const path = writeJson(dir, {
      schema: 1,
      version: 'local-1',
      detectors: [
        { id: 'claude-input', prompt: 'input', agents: ['claude'], patterns: [{ phrases: ['new footer text'] }], note: 'fixed for claude 3' },
        { id: 'shell-prompt', disabled: true },
        { id: 'my-question', prompt: 'question', patterns: [{ regex: 'choose \\d+ of \\d+', flags: 'i' }], note: 'local' },
      ],
    });
    const set = loadDetectorSet({ dataDir: dir, env: NO_ENV });
    assert.deepEqual(set.override, { path, version: 'local-1', mode: 'merge' });
    const ids = set.detectors.map((d) => d.id);
    assert.ok(!ids.includes('shell-prompt'));
    assert.equal(ids.at(-1), 'my-question');
    assert.equal(ids.indexOf('claude-input'), DEFAULT_DETECTORS.findIndex((d) => d.id === 'claude-input'), 'replaced in place');
    const footer = set.detectors.find((d) => d.id === 'claude-input')!;
    assert.equal(footer.origin, path);
    assert.equal(footer.test('? for shortcuts'), false);
    assert.equal(footer.test('new   footer text'), true);
    // Ordering per agent: blocking kinds first.
    const forClaude = detectorsFor('claude', set.detectors).map((d) => `${d.kind}:${d.id}`);
    assert.deepEqual(forClaude, [
      'approval:claude-permission',
      'approval:claude-trust',
      'approval:yes-no',
      'question:my-question',
      'input:claude-input',
      'input:press-enter',
    ]);
  });

  it('mode "replace" uses only the override file', () => {
    const dir = tempDir();
    writeJson(dir, { schema: 1, version: 'r', mode: 'replace', detectors: [{ id: 'only', prompt: 'login', patterns: [{ phrases: ['Paste the code'] }] }] });
    const set = loadDetectorSet({ dataDir: dir, env: NO_ENV });
    assert.deepEqual(
      set.detectors.map((d) => d.id),
      ['only'],
    );
  });

  it('ignores an unreadable or invalid override file with a warning', () => {
    const dir = tempDir();
    writeJson(dir, '{ not json');
    let set = loadDetectorSet({ dataDir: dir, env: NO_ENV });
    assert.equal(set.detectors.length, DEFAULT_DETECTORS.length);
    assert.equal(set.override, undefined);
    assert.match(set.warnings[0]!, /using the shipped detectors/);

    writeJson(dir, { schema: 99, version: 'x', detectors: [] });
    set = loadDetectorSet({ dataDir: dir, env: NO_ENV });
    assert.equal(set.detectors.length, DEFAULT_DETECTORS.length);
    assert.equal(set.warnings.length, 2);

    // A partly invalid file keeps its valid entries.
    writeJson(dir, { schema: 1, version: 'x', detectors: [{ id: 'good', prompt: 'input', patterns: [{ phrases: ['y'] }] }, { id: 'bad' }] });
    set = loadDetectorSet({ dataDir: dir, env: NO_ENV });
    assert.ok(set.detectors.some((d) => d.id === 'good'));
    assert.equal(set.warnings.length, 1);
  });

  it('BIZZI_DETECTORS_FILE and the file option pick the override; a missing explicit file warns', () => {
    const dir = tempDir();
    const p = writeJson(dir, { schema: 1, version: 'e', mode: 'replace', detectors: [{ id: 'env', prompt: 'input', patterns: [{ phrases: ['z'] }] }] }, 'custom.json');
    assert.equal(overridePath({ env: { BIZZI_DETECTORS_FILE: p } }), p);
    assert.equal(overridePath({ env: { BIZZI_DATA_DIR: dir } }), join(dir, 'detectors.json'));
    assert.deepEqual(
      loadDetectorSet({ env: { BIZZI_DETECTORS_FILE: p } }).detectors.map((d) => d.id),
      ['env'],
    );
    const missing = loadDetectorSet({ file: join(dir, 'nope.json'), env: NO_ENV });
    assert.equal(missing.detectors.length, DEFAULT_DETECTORS.length);
    assert.match(missing.warnings[0]!, /not found/);
  });

  it('BIZZI_DETECTORS=off (or enabled: false) turns every detector off', () => {
    assert.equal(detectorsDisabledByEnv({ BIZZI_DETECTORS: 'off' }), true);
    assert.equal(detectorsDisabledByEnv({ BIZZI_DETECTORS: 'OFF ' }), true);
    assert.equal(detectorsDisabledByEnv({ BIZZI_DETECTORS: 'on' }), false);
    assert.equal(detectorsDisabledByEnv({}), false);
    const dir = tempDir();
    writeJson(dir, { schema: 1, version: 'x', detectors: [{ id: 'extra', prompt: 'input', patterns: [{ phrases: ['y'] }] }] });
    const off = loadDetectorSet({ dataDir: dir, env: { BIZZI_DETECTORS: 'off' } });
    assert.deepEqual(off.detectors, []);
    assert.equal(off.enabled, false);
    assert.deepEqual(loadDetectorSet({ enabled: false, env: NO_ENV }).detectors, []);
    // Explicit enabled wins over the env.
    assert.ok(loadDetectorSet({ enabled: true, dataDir: dir, env: { BIZZI_DETECTORS: 'off' } }).detectors.length > 0);
  });

  it('resolveDetectorSet: an explicit list skips files, detectorsEnabled false empties it', () => {
    const custom = [regexDetector('c', 'input', /ready>/)];
    assert.deepEqual(
      resolveDetectorSet({ detectors: custom }).detectors.map((d) => d.id),
      ['c'],
    );
    assert.deepEqual(resolveDetectorSet({ detectors: custom, detectorsEnabled: false }).detectors, []);
    assert.deepEqual(resolveDetectorSet({ detectorsEnabled: false }).detectors, []);
  });
});

describe('regexDetector (API kept for callers)', () => {
  it('builds a detector; g/y flags do not make test() stateful', () => {
    const d = regexDetector('mine', 'approval', /continue\?/g, { agents: ['shell'], note: 'test' });
    assert.equal(d.kind, 'approval');
    assert.deepEqual(d.agents, ['shell']);
    assert.equal(d.test('continue?'), true);
    assert.equal(d.test('continue?'), true);
    assert.equal(d.match!('really continue? yes'), 'continue?');
  });
});
