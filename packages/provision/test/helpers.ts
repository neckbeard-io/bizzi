import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { defaultRecipes, parseRecipe, RecipeSet, type Recipe } from '../src/index.ts';

export const FIXTURES = new URL('./fixtures/', import.meta.url);

export function fakeRecipe(): Recipe {
  return parseRecipe(readFileSync(new URL('fake.yaml', FIXTURES), 'utf8'), 'fake.yaml');
}

/** Built-in recipes plus the fake one. */
export function recipesWithFake(...extra: Recipe[]): RecipeSet {
  return new RecipeSet([...defaultRecipes().list(), fakeRecipe(), ...extra]);
}

/** A temp dir removed after the test file finishes. */
export function tempDir(prefix = 'bizzi-provision-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write an executable shell script. */
export function writeScript(path: string, body: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Minimal env for child processes: system PATH only, HOME in the temp dir. */
export function isolatedEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin', HOME: home, ...extra };
}
