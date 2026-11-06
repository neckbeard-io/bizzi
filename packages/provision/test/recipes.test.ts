import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { BizziError } from '@bizzi/protocol';
import { BUILTIN_RECIPES_DIR, defaultRecipes, loadRecipes, parseRecipe, RecipeError, validateRecipe } from '../src/index.ts';
import { fakeRecipe, tempDir } from './helpers.ts';

const AGENTS = ['claude', 'codex', 'opencode', 'agy'];

test('all built-in recipes load and validate', () => {
  const set = loadRecipes();
  assert.deepEqual(set.list().map((r) => r.name).sort(), ['agy', 'claude', 'codex', 'node', 'opencode']);
  assert.deepEqual(set.check(), []);
  for (const r of set.list()) {
    const raw = parse(readFileSync(join(BUILTIN_RECIPES_DIR, `${r.name}.yaml`), 'utf8'));
    const res = validateRecipe(raw);
    assert.equal(res.ok, true, `${r.name}: ${res.issues.join('; ')}`);
  }
});

test('agent recipes cover darwin and linux on both arches with login, auth and uninstall', () => {
  for (const name of AGENTS) {
    const r = defaultRecipes().require(name);
    assert.equal(r.kind, 'agent');
    for (const key of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']) {
      assert.ok(r.platforms[key], `${name} supports ${key}`);
    }
    assert.ok(r.login, `${name} login`);
    assert.ok(r.auth, `${name} auth`);
    assert.ok(r.login.interactive.argv.length > 0);
    for (const m of r.methods) assert.ok(m.uninstall, `${name}/${m.id} uninstall`);
  }
});

test('no recipe step requires sudo; brew methods are macOS-only', () => {
  for (const r of defaultRecipes().list()) {
    for (const m of r.methods) {
      for (const s of [...m.install, ...(m.update ?? []), ...(m.uninstall ?? [])]) {
        assert.equal(s.requiresSudo, false, `${r.name}/${m.id}: ${s.description}`);
        assert.doesNotMatch(s.run ?? s.argv?.join(' ') ?? '', /\bsudo\b/);
      }
      if (m.kind === 'brew') assert.deepEqual(m.platforms, ['darwin'], `${r.name}/${m.id}`);
      assert.ok(m.targetDir.startsWith('~/') || m.targetDir.startsWith('{{'), `${r.name}/${m.id} installs per-user`);
    }
  }
});

test('unverified pieces carry notes explaining why', () => {
  for (const r of defaultRecipes().list()) {
    if (!r.verified) assert.ok(r.notes?.length, `${r.name} explains why it is unverified`);
    for (const m of r.methods) if (!m.verified) assert.ok(m.notes?.length, `${r.name}/${m.id}`);
    for (const h of r.login?.headless ?? []) if (!h.verified) assert.ok(h.notes?.length, `${r.name} headless ${h.kind}`);
    if (r.auth?.command && !r.auth.command.verified) assert.ok(r.auth.command.notes?.length, `${r.name} auth command`);
  }
});

test('README lists every recipe', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const r of defaultRecipes().list()) assert.match(readme, new RegExp(`\\|\\s*\`?${r.name}\`?\\s*\\|`));
});

test('the fake fixture is a valid recipe', () => {
  const r = fakeRecipe();
  assert.equal(r.name, 'fake');
  assert.equal(r.methods[0]?.install[0]?.requiresSudo, false, 'requiresSudo defaults to false');
});

function issuesFor(mutate: (r: Record<string, any>) => void): string[] {
  const raw = parse(readFileSync(new URL('./fixtures/fake.yaml', import.meta.url), 'utf8'));
  mutate(raw);
  return validateRecipe(raw).issues;
}

test('schema rejects unknown keys, wrong types and missing fields', () => {
  assert.match(issuesFor((r) => (r.detect.binarys = ['x'])).join('\n'), /detect\.binarys: unknown key/);
  assert.match(issuesFor((r) => (r.verified = 'yes')).join('\n'), /verified: expected boolean/);
  assert.match(issuesFor((r) => delete r.detect).join('\n'), /detect: expected mapping/);
  assert.match(issuesFor((r) => (r.kind = 'plugin')).join('\n'), /kind: expected one of agent, tool/);
  assert.match(issuesFor((r) => (r.platforms['windows-x64'] = {})).join('\n'), /platforms\.windows-x64: key does not match/);
  assert.match(issuesFor((r) => (r.latest = [{ type: 'ftp', verified: true }])).join('\n'), /latest\[0\]\.type: expected one of/);
});

test('schema rejects semantic mistakes', () => {
  assert.match(issuesFor((r) => (r.detect.version.regex = '(')).join('\n'), /invalid regex/);
  assert.match(issuesFor((r) => (r.methods[0].install[0].run = 'echo {{nope}}')).join('\n'), /unknown template variable "nope"/);
  assert.match(issuesFor((r) => (r.methods[1].id = 'echo')).join('\n'), /duplicate method id/);
  assert.match(issuesFor((r) => (r.methods[0].install[0].argv = ['echo'])).join('\n'), /exactly one of run\/argv/);
  assert.match(issuesFor((r) => (r.methods[1].install[0].when = 'pinned')).join('\n'), /not pinnable/);
  assert.match(issuesFor((r) => delete r.methods[0].uninstall).join('\n'), /uninstall: required for agent recipes/);
  assert.match(issuesFor((r) => delete r.auth).join('\n'), /auth: required/);
  assert.match(issuesFor((r) => (r.methods[1].platforms = ['linux-arm64-musl'])).join('\n'), /matches none/);
  // A platform var used by a method must exist on every platform the method supports.
  assert.match(issuesFor((r) => delete r.platforms['linux-x64'].vars).join('\n'), /"fakeTarget" on linux-x64/);
  assert.match(issuesFor((r) => (r.latest[0].url = 'https://x/{{missing}}')).join('\n'), /latest\[0\]\.url: unknown template variable/);
});

test('parseRecipe throws RecipeError (a BizziError) with all issues', () => {
  assert.throws(
    () => parseRecipe('schema: 1\nname: Bad Name\n', 'bad.yaml'),
    (e: unknown) => e instanceof RecipeError && e instanceof BizziError && e.code === 'bad_request' && e.issues.length > 3,
  );
  assert.throws(() => parseRecipe('a: [unclosed', 'broken.yaml'), (e: unknown) => e instanceof RecipeError && /YAML/.test(e.message));
});

test('loadRecipes: overrides win, names must match files, tool references are checked', () => {
  const dir = tempDir();
  const fake = readFileSync(new URL('./fixtures/fake.yaml', import.meta.url), 'utf8');
  writeFileSync(join(dir, 'fake.yaml'), fake);
  const set = loadRecipes([BUILTIN_RECIPES_DIR, dir]);
  assert.ok(set.get('fake'));
  assert.ok(set.get('claude'));

  const override = fake.replace('displayName: Fake Agent', 'displayName: Fake Override');
  const dir2 = tempDir();
  writeFileSync(join(dir2, 'fake.yaml'), override);
  assert.equal(loadRecipes([dir, dir2]).get('fake')?.displayName, 'Fake Override');

  const dir3 = tempDir();
  writeFileSync(join(dir3, 'other.yaml'), fake);
  assert.throws(() => loadRecipes([dir3]), /does not match file name/);

  const dir4 = tempDir();
  writeFileSync(join(dir4, 'fake.yaml'), fake.replace('    targetDir: "{{toolsDir}}/fake/bin"', '    requires: [{ command: npm, tool: nodejs }]\n    targetDir: "{{toolsDir}}/fake/bin"'));
  assert.throws(() => loadRecipes([dir4]), /unknown tool "nodejs"/);

  // Missing override dirs are fine.
  assert.ok(loadRecipes([BUILTIN_RECIPES_DIR, join(dir, 'does-not-exist')]).get('codex'));
});
