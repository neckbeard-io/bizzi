import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BizziError } from '@bizzi/protocol';
import { parse as parseYaml } from 'yaml';
import { validateRecipe } from './schema.ts';
import type { Recipe } from './types.ts';

/** Directory holding the recipes shipped with this package. */
export const BUILTIN_RECIPES_DIR = fileURLToPath(new URL('../recipes/', import.meta.url));

export class RecipeError extends BizziError {
  readonly issues: string[];
  readonly source: string;
  constructor(source: string, issues: string[]) {
    super('bad_request', `invalid recipe ${source}:\n  ${issues.join('\n  ')}`, { source, issues });
    this.name = 'RecipeError';
    this.issues = issues;
    this.source = source;
  }
}

/** Parse + validate one recipe from YAML text. Throws RecipeError. */
export function parseRecipe(yamlText: string, source = '<inline>'): Recipe {
  let data: unknown;
  try {
    data = parseYaml(yamlText, { prettyErrors: true });
  } catch (e) {
    throw new RecipeError(source, [`YAML: ${(e as Error).message}`]);
  }
  const res = validateRecipe(data);
  if (!res.ok || !res.recipe) throw new RecipeError(source, res.issues);
  return res.recipe;
}

export class RecipeSet {
  readonly #byName = new Map<string, Recipe>();

  constructor(recipes: Iterable<Recipe> = []) {
    for (const r of recipes) this.add(r);
  }

  /** Later additions replace earlier ones with the same name (local overrides win). */
  add(recipe: Recipe): this {
    this.#byName.set(recipe.name, recipe);
    return this;
  }

  get(name: string): Recipe | undefined {
    return this.#byName.get(name);
  }

  /** Like get(), but throws `not_found`. */
  require(name: string): Recipe {
    const r = this.#byName.get(name);
    if (!r) throw new BizziError('not_found', `no recipe for "${name}"`);
    return r;
  }

  list(): Recipe[] {
    return [...this.#byName.values()];
  }

  /** Cross-recipe checks: every `requires[].tool` must name a tool recipe. */
  check(): string[] {
    const issues: string[] = [];
    for (const r of this.#byName.values()) {
      for (const m of r.methods) {
        for (const req of m.requires ?? []) {
          if (!req.tool) continue;
          const t = this.#byName.get(req.tool);
          if (!t) issues.push(`${r.name}: method ${m.id} requires unknown tool "${req.tool}"`);
          else if (t.kind !== 'tool') issues.push(`${r.name}: method ${m.id} requires "${req.tool}", which is not a tool recipe`);
        }
      }
    }
    return issues;
  }
}

/**
 * Load every `*.yaml` / `*.yml` recipe from the given directories. Later directories override
 * earlier ones, so pass `[BUILTIN_RECIPES_DIR, localOverridesDir]` to fix a recipe without a release.
 * The file name must match the recipe name. Throws RecipeError on the first invalid file.
 */
export function loadRecipes(dirs: string[] = [BUILTIN_RECIPES_DIR]): RecipeSet {
  const set = new RecipeSet();
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && dir !== BUILTIN_RECIPES_DIR) continue;
      throw e;
    }
    for (const f of files) {
      const path = join(dir, f);
      const recipe = parseRecipe(readFileSync(path, 'utf8'), path);
      const stem = basename(f).replace(/\.ya?ml$/, '');
      if (stem !== recipe.name) throw new RecipeError(path, [`name "${recipe.name}" does not match file name "${stem}"`]);
      set.add(recipe);
    }
  }
  const issues = set.check();
  if (issues.length) throw new RecipeError(dirs.join(', '), issues);
  return set;
}

let builtin: RecipeSet | undefined;

/** The built-in recipes, loaded once. */
export function defaultRecipes(): RecipeSet {
  builtin ??= loadRecipes();
  return builtin;
}
