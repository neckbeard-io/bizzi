// Option-logit readout (spec §11.2): one chat completion with `max_tokens: 1` and `top_logprobs`, the
// options lettered A, B, C…, and the probability of each letter as the next token. Any OpenAI-compatible
// endpoint that returns logprobs works: vLLM directly or behind a gateway (the H200 Qwen through
// Bifrost), and the cloud models that still return them (gpt-4.1 / gpt-4o through LiteLLM, which
// are much less calibrated). Reasoning models and Claude don't return logprobs.

import { BizziError } from '@bizzi/protocol';

/** One pass scores at most this many options: vLLM's default `--max-logprobs` and OpenAI's `top_logprobs` cap. */
export const MAX_LOGPROB_OPTIONS = 20;
export const OPTION_LETTERS = 'ABCDEFGHIJKLMNOPQRST'.split('');

export interface LogprobBackend {
  /** Base URL of the OpenAI-compatible API, e.g. https://englab-12918-2.lab.ppops.net/v1 (`/chat/completions` is appended). */
  url: string;
  model: string;
  apiKey?: string;
  /**
   * Extra request fields, merged last. vLLM with Qwen needs thinking off:
   * `{ "chat_template_kwargs": { "enable_thinking": false } }`.
   */
  body?: Record<string, unknown>;
  /** Default 10 s. */
  timeoutMs?: number;
  /** Options per pass (default and maximum 20). */
  maxOptions?: number;
  fetch?: typeof fetch;
}

export interface LogprobResult {
  /** One per option, normalized over the letters (sums to 1 unless no letter came back). */
  probabilities: number[];
  /** Raw probability mass on option letters before normalizing. */
  letterMass: number;
  ms: number;
}

export function optionLimit(b: LogprobBackend): number {
  return Math.max(1, Math.min(MAX_LOGPROB_OPTIONS, b.maxOptions ?? MAX_LOGPROB_OPTIONS));
}

export function buildMessages(text: string, options: string[]): { role: 'system' | 'user'; content: string }[] {
  const list = options.map((o, i) => `${OPTION_LETTERS[i]}. ${o}`).join('\n');
  return [
    { role: 'system', content: `You route a developer's request to the machine and workspace where it should run. Targets:\n${list}` },
    { role: 'user', content: `Request: ${text}\n\nAnswer with the single letter of the best target.` },
  ];
}

/** Score `options` for `text`. Throws BizziError('agent_unavailable') when the backend fails or returns no logprobs. */
export async function scoreOptions(b: LogprobBackend, text: string, options: string[]): Promise<LogprobResult> {
  if (options.length === 0 || options.length > optionLimit(b)) {
    throw new BizziError('bad_request', `between 1 and ${optionLimit(b)} options can be scored in one pass`);
  }
  const doFetch = b.fetch ?? fetch;
  const t0 = performance.now();
  let res: Response;
  try {
    res = await doFetch(`${b.url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(b.apiKey ? { authorization: `Bearer ${b.apiKey}` } : {}) },
      body: JSON.stringify({
        model: b.model,
        messages: buildMessages(text, options),
        max_tokens: 1,
        temperature: 0,
        logprobs: true,
        top_logprobs: MAX_LOGPROB_OPTIONS,
        ...b.body,
      }),
      signal: AbortSignal.timeout(b.timeoutMs ?? 10_000),
    });
  } catch (err) {
    throw new BizziError('agent_unavailable', `routing classifier unreachable: ${(err as Error).message}`);
  }
  const raw = await res.text();
  if (!res.ok) throw new BizziError('agent_unavailable', `routing classifier answered ${res.status}: ${raw.slice(0, 200)}`);
  let top: unknown;
  try {
    top = (JSON.parse(raw) as { choices?: { logprobs?: { content?: { top_logprobs?: unknown }[] } }[] }).choices?.[0]?.logprobs?.content?.[0]
      ?.top_logprobs;
  } catch {
    throw new BizziError('agent_unavailable', 'routing classifier returned invalid JSON');
  }
  if (!Array.isArray(top) || top.length === 0) {
    throw new BizziError('agent_unavailable', `routing classifier returned no logprobs (model ${b.model} may not support them)`);
  }
  const probs = options.map(() => 0);
  for (const t of top as { token?: unknown; logprob?: unknown }[]) {
    if (typeof t?.token !== 'string' || typeof t.logprob !== 'number') continue;
    const i = OPTION_LETTERS.indexOf(t.token.trim().toUpperCase());
    if (i >= 0 && i < probs.length) probs[i]! += Math.exp(t.logprob);
  }
  const mass = probs.reduce((a, b) => a + b, 0);
  return { probabilities: mass > 0 ? probs.map((p) => p / mass) : probs, letterMass: mass, ms: Math.round(performance.now() - t0) };
}

/** 1 − entropy / ln(N): 1 when one option has everything, 0 when all are equal. */
export function confidence(p: number[]): number {
  if (p.length <= 1) return 1;
  const sum = p.reduce((a, b) => a + b, 0);
  if (sum <= 0) return 0;
  let h = 0;
  for (const x of p) if (x > 0) h -= (x / sum) * Math.log(x / sum);
  return Math.max(0, 1 - h / Math.log(p.length));
}

/** Something that can score options: the router's own backend, or a machine's borrowed over the hub's link (`route.score`). */
export interface OptionScorer {
  model: string;
  /** The machine whose classifier this is, for a borrowed one. */
  via?: string;
  /** Options per pass. */
  limit: number;
  score(text: string, options: string[]): Promise<LogprobResult>;
}

export function backendScorer(b: LogprobBackend): OptionScorer {
  return { model: b.model, limit: optionLimit(b), score: (text, options) => scoreOptions(b, text, options) };
}
