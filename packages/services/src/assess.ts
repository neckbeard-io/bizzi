// Adds what @bizzi/provision knows about an install to the adapters' probes: real path behind
// shims, install method, preferred method, supported-version verdict and remedies (spec §7).

import { delimiter } from 'node:path';
import type { AgentListing } from '@bizzi/protocol';
import {
  assessInstall,
  augmentedPath,
  currentPlatform,
  defaultRecipes,
  type InstallAssessment,
  type Platform,
  type RecipeSet,
} from '@bizzi/provision';

export interface AssessorOptions {
  recipes?: RecipeSet;
  platform?: Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export class InstallAssessor {
  readonly #opts: AssessorOptions;
  readonly #memo = new Map<string, InstallAssessment | undefined>();

  constructor(opts: AssessorOptions = {}) {
    this.#opts = opts;
  }

  get recipes(): RecipeSet {
    return this.#opts.recipes ?? defaultRecipes();
  }

  get platform(): Platform {
    return this.#opts.platform ?? currentPlatform();
  }

  get env(): NodeJS.ProcessEnv {
    return this.#opts.env ?? process.env;
  }

  get home(): string | undefined {
    return this.#opts.home;
  }

  /** Forget memoized results (an install changed on disk). */
  clear(): void {
    this.#memo.clear();
  }

  /** Assessment of the install a probe found (memoized per agent, path and version). */
  assess(listing: Pick<AgentListing, 'agent' | 'installed' | 'path' | 'version'>): InstallAssessment | undefined {
    const recipe = this.recipes.get(listing.agent);
    if (!recipe || recipe.kind !== 'agent') return undefined;
    const key = `${listing.agent}\0${listing.installed ? (listing.path ?? '') : ''}\0${listing.version ?? ''}`;
    if (this.#memo.has(key)) return this.#memo.get(key);
    const env = this.env;
    const searchDirs = augmentedPath({ env, platform: this.platform, ...(this.home ? { home: this.home } : {}) })
      .split(delimiter)
      .filter(Boolean);
    let a: InstallAssessment | undefined;
    try {
      a = assessInstall(
        recipe,
        { ...(listing.installed && listing.path ? { path: listing.path } : {}), ...(listing.version ? { version: listing.version } : {}) },
        { platform: this.platform, env, searchDirs, ...(this.home ? { home: this.home } : {}) },
      );
    } catch {
      a = undefined;
    }
    this.#memo.set(key, a);
    return a;
  }

  /** The listing plus realPath, method, preferredMethod, support, supportReason and remedies. */
  decorate(listing: AgentListing): AgentListing {
    const a = this.assess(listing);
    if (!a) return listing;
    const out: AgentListing = { ...listing };
    if (a.preferredMethod) out.preferredMethod = a.preferredMethod;
    if (!listing.installed) return out;
    if (a.realPath) out.realPath = a.realPath;
    if (a.method) out.method = a.method;
    if (a.support) out.support = a.support;
    if (a.supportReason) out.supportReason = a.supportReason;
    if (a.remedies?.length) {
      const seen = new Set((listing.remedies ?? []).map((r) => `${r.kind}\0${r.title}`));
      out.remedies = [...(listing.remedies ?? []), ...a.remedies.filter((r) => !seen.has(`${r.kind}\0${r.title}`))];
    }
    if (a.notes.length) {
      const notes = [...(listing.notes ?? [])];
      for (const n of a.notes) if (!notes.includes(n)) notes.push(n);
      out.notes = notes;
    }
    return out;
  }
}
