// Routing a prompt to a machine · workspace (spec §11.2), cheapest step first: explicit tokens, a single
// target, then the logprob classifier. Continuation and routing preferences (steps 2–3) belong to the
// client and to rules, which aren't built yet.

import { BizziError, type Logger, type RouteCandidate, type RouteSuggestion } from '@bizzi/protocol';
import { buildTargets, type CatalogueInput, type RouteTarget } from './catalogue.ts';
import { parseExplicit } from './explicit.ts';
import { backendScorer, confidence, type LogprobBackend, type OptionScorer } from './logprobs.ts';
import { MAX_REMOTE_ATTEMPTS } from './remote.ts';

export interface RouterOptions {
  /** No backend: explicit tokens and single targets only. */
  backend?: LogprobBackend;
  /** Confidence at or above which a suggestion is `confident` (default 0.8). */
  threshold?: number;
  /** Without a backend, the machine (name, hostname or id) whose classifier to borrow first. */
  via?: string;
  logger?: Logger;
}

export interface SuggestOptions {
  /** Machines' classifiers to borrow, best first (`remoteScorers`); used only when the router has no backend. */
  remote?: OptionScorer[];
}

export const DEFAULT_THRESHOLD = 0.8;
const MAX_TEXT = 4000;

export class Router {
  readonly backend: LogprobBackend | undefined;
  readonly threshold: number;
  readonly via: string | undefined;
  readonly #log: Logger | undefined;

  constructor(o: RouterOptions = {}) {
    this.backend = o.backend;
    this.threshold = o.threshold ?? DEFAULT_THRESHOLD;
    this.via = o.via;
    this.#log = o.logger;
  }

  async suggest(rawText: unknown, input: CatalogueInput, o: SuggestOptions = {}): Promise<RouteSuggestion> {
    if (typeof rawText !== 'string' || rawText.trim() === '') throw new BizziError('bad_request', 'text is required');
    const all = buildTargets(input, { includeOffline: true });
    const ex = parseExplicit(rawText.slice(0, MAX_TEXT), all, input.machines);
    const base = { text: ex.text, ...(ex.agent ? { agent: ex.agent } : {}) };
    const sure = (source: 'explicit' | 'single', t: RouteTarget): RouteSuggestion => ({
      ...base,
      source,
      candidates: [candidate(t, 1)],
      confidence: 1,
      confident: true,
      offered: 1,
    });
    const none = (offered: number, note: string): RouteSuggestion => ({ ...base, source: 'none', candidates: [], confidence: 0, confident: false, offered, note });
    // Tokens left several targets (`#acme-shop` on two machines) and nothing can choose: the user picks among them.
    const pick = (note: string): RouteSuggestion => ({
      ...base,
      source: 'explicit',
      candidates: ex.targets.slice(0, 3).map((t) => candidate(t, 1 / ex.targets.length)),
      confidence: 0,
      confident: false,
      offered: ex.targets.length,
      note,
    });

    if (ex.problem) return none(0, ex.problem);
    if (ex.targets.length === 0) return none(0, 'no workspace on an online machine');
    if (ex.targets.length === 1) return sure(ex.narrowed ? 'explicit' : 'single', ex.targets[0]!);
    const matches = `${ex.used.join(' ')} matches ${ex.targets.length} workspaces`;
    const scorers = this.backend ? [backendScorer(this.backend)] : (o.remote ?? []).slice(0, MAX_REMOTE_ATTEMPTS);
    if (scorers.length === 0) return ex.narrowed ? pick(matches) : none(ex.targets.length, 'no routing classifier configured');

    // A borrowed classifier can fail for reasons of its own (the machine went to sleep): try the next one.
    let failure = '';
    let offered: RouteTarget[] = [];
    for (const scorer of scorers) {
      // Most recently active first, so a cap keeps the likely ones.
      offered = ex.targets.slice(0, scorer.limit);
      try {
        const r = await scorer.score(ex.text || rawText, offered.map((t) => t.detail));
        const ranked = offered.map((t, i) => candidate(t, r.probabilities[i] ?? 0)).sort((a, b) => b.probability - a.probability);
        const conf = r.letterMass > 0 ? confidence(r.probabilities) : 0;
        return {
          ...base,
          source: 'classifier',
          candidates: ranked.slice(0, 3),
          confidence: round(conf),
          confident: conf >= this.threshold,
          offered: offered.length,
          classifier: { model: scorer.model, ...(scorer.via ? { via: scorer.via } : {}), ms: r.ms, letterMass: round(r.letterMass) },
          ...(ex.targets.length > offered.length ? { note: `${ex.targets.length - offered.length} less recently used targets were left out` } : {}),
        };
      } catch (err) {
        failure = (err as Error).message;
        this.#log?.log('warn', 'routing classifier failed', { model: scorer.model, ...(scorer.via ? { via: scorer.via } : {}), err: failure });
      }
    }
    return ex.narrowed ? pick(`${matches}; ${failure}`) : none(offered.length, failure);
  }
}

function candidate(t: RouteTarget, probability: number): RouteCandidate {
  return { machineId: t.machine.id, workspaceId: t.workspace.id, label: t.label, probability: round(probability) };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Router settings from the environment, shared by `bizzi serve` and `bizzi hub serve`:
 *   BIZZI_ROUTER_URL        OpenAI-compatible base URL (enables the classifier)
 *   BIZZI_ROUTER_MODEL      model name (required with the URL)
 *   BIZZI_ROUTER_API_KEY    bearer token, if the endpoint wants one
 *   BIZZI_ROUTER_BODY       JSON merged into each request, e.g. {"chat_template_kwargs":{"enable_thinking":false}}
 *   BIZZI_ROUTER_THRESHOLD  confidence needed to send without asking (default 0.8)
 *   BIZZI_ROUTER_VIA        hub without a URL: the machine whose classifier to borrow first (else any
 *                           online machine with one, always-on first)
 */
export function routerOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): RouterOptions {
  const o: RouterOptions = {};
  if (env.BIZZI_ROUTER_THRESHOLD) {
    const t = Number(env.BIZZI_ROUTER_THRESHOLD);
    if (!Number.isFinite(t) || t < 0 || t > 1) throw new Error('BIZZI_ROUTER_THRESHOLD must be a number between 0 and 1');
    o.threshold = t;
  }
  if (env.BIZZI_ROUTER_VIA?.trim()) o.via = env.BIZZI_ROUTER_VIA.trim();
  if (!env.BIZZI_ROUTER_URL) return o;
  if (!env.BIZZI_ROUTER_MODEL) throw new Error('BIZZI_ROUTER_MODEL is required with BIZZI_ROUTER_URL');
  const backend: LogprobBackend = { url: env.BIZZI_ROUTER_URL, model: env.BIZZI_ROUTER_MODEL };
  if (env.BIZZI_ROUTER_API_KEY) backend.apiKey = env.BIZZI_ROUTER_API_KEY;
  if (env.BIZZI_ROUTER_BODY) {
    let body: unknown;
    try {
      body = JSON.parse(env.BIZZI_ROUTER_BODY);
    } catch {
      throw new Error('BIZZI_ROUTER_BODY must be a JSON object');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('BIZZI_ROUTER_BODY must be a JSON object');
    backend.body = body as Record<string, unknown>;
  }
  o.backend = backend;
  return o;
}
