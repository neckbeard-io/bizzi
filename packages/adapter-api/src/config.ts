// Providers for plain model APIs (spec §6.5 item 1): built-in presets plus `<dataDir>/api-providers.json`.
// A model is addressed as `provider/model` (e.g. `anthropic/claude-opus-5-5`, `h200/qwen3.8-27b`,
// `openrouter/anthropic/claude-sonnet-5-5`: the provider is everything before the first slash).
// Keys never appear here: a provider names the environment variable (= bizzi secret name) holding it.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BizziError, type BillingClass } from '@bizzi/protocol';

/** Wire format: Anthropic Messages API, or OpenAI-compatible chat completions. */
export type WireApi = 'anthropic' | 'openai';
export const WIRE_APIS: readonly WireApi[] = ['anthropic', 'openai'];

export const CONFIG_FILE = 'api-providers.json';

/** USD per million tokens. Cache prices default to the input price when not given. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export interface ModelSpec {
  id: string;
  /** Context window in tokens (otherwise the provider's, otherwise discovered from its models endpoint). */
  contextWindow?: number;
  maxOutputTokens?: number;
  price?: ModelPrice;
  /** Extra request fields for this model, merged over the provider's `body`. */
  body?: Record<string, unknown>;
}

export interface ProviderSpec {
  api: WireApi;
  /** API root, e.g. https://api.anthropic.com/v1 (`/messages` or `/chat/completions` is appended). */
  baseUrl: string;
  /**
   * Environment variable holding the key: a secret stored for agent `api` (`agent.setSecret`), or the
   * node's environment. Unset = no auth (a local vLLM).
   */
  apiKeyEnv?: string;
  /** How the key is sent. Default: `x-api-key` for anthropic, `bearer` for openai. */
  auth?: 'bearer' | 'x-api-key';
  /** Extra (non-secret) request headers, e.g. `anthropic-version` or OpenRouter's `HTTP-Referer`. */
  headers?: Record<string, string>;
  /** Extra request fields, merged last (e.g. `{ "chat_template_kwargs": { "enable_thinking": false } }`). */
  body?: Record<string, unknown>;
  /** Known models. Listing every provider's models turns the capability `models` into a fixed list. */
  models?: (string | ModelSpec)[];
  /** Model used when a session names only the provider, or when this is the first configured provider. */
  defaultModel?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** spec §12.3. Default metered. */
  billing?: BillingClass;
  /** Requests in flight to this provider at once (from every session and utility call on this node); extra ones queue. */
  maxConcurrent?: number;
  /** openai: ask for a final usage chunk (`stream_options.include_usage`). Default true. */
  streamUsage?: boolean;
  /** openai: field for the output cap. Default `max_tokens`; OpenAI's own API wants `max_completion_tokens`. */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  /** Ask the provider's models endpoint for context windows and output caps. Default true. */
  discover?: boolean;
  label?: string;
}

export interface ApiConfig {
  providers: Record<string, ProviderSpec>;
  /** `provider/model` for sessions that don't name one. */
  defaultModel?: string;
  /** `provider/model` for utility completions (titles, briefs, extraction). Default: `defaultModel`. */
  utilityModel?: string;
}

/** The file's shape: providers merge field by field over the presets of the same id; `null` removes a preset. */
export interface ApiConfigFile {
  providers?: Record<string, Partial<ProviderSpec> | null>;
  defaultModel?: string;
  utilityModel?: string;
}

export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Built-in providers. Only the defaults needed to reach each API; no model lists or prices (they go
 * stale). Gemini and OpenRouter are used through their OpenAI-compatible endpoints.
 */
export const PRESET_PROVIDERS: Readonly<Record<string, ProviderSpec>> = {
  anthropic: {
    api: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    billing: 'metered',
    defaultModel: 'claude-opus-5-5',
    label: 'Anthropic',
  },
  openai: {
    api: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    billing: 'metered',
    maxTokensParam: 'max_completion_tokens',
    label: 'OpenAI',
  },
  gemini: {
    api: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    billing: 'metered',
    label: 'Gemini',
  },
  openrouter: {
    api: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    billing: 'metered',
    label: 'OpenRouter',
  },
};

const BILLING: readonly BillingClass[] = ['metered', 'plan', 'budgetless'];
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface LoadedConfig {
  config: ApiConfig;
  /** Problems with the file; invalid providers are skipped. */
  errors: string[];
  /** Provider ids defined (or overridden) by the file, in file order. */
  custom: string[];
}

/** Merge presets with a parsed config file. Never throws; problems are returned in `errors`. */
export function buildConfig(file: ApiConfigFile | undefined, presets: Readonly<Record<string, ProviderSpec>> = PRESET_PROVIDERS): LoadedConfig {
  const errors: string[] = [];
  const providers: Record<string, ProviderSpec> = {};
  const custom: string[] = [];
  for (const [id, p] of Object.entries(presets)) providers[id] = { ...p };
  const raw = file?.providers;
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    errors.push('providers must be an object keyed by provider id');
  } else if (raw) {
    for (const [id, p] of Object.entries(raw)) {
      if (!PROVIDER_ID_RE.test(id)) {
        errors.push(`provider "${id}": ids are lowercase letters, digits, ".", "_" and "-"`);
        continue;
      }
      if (p === null) {
        // `"gemini": null` removes a preset.
        delete providers[id];
        continue;
      }
      if (typeof p !== 'object' || Array.isArray(p)) {
        errors.push(`provider "${id}" must be an object`);
        continue;
      }
      const merged = { ...providers[id], ...p } as ProviderSpec;
      const problem = validateProvider(merged);
      if (problem) {
        errors.push(`provider "${id}": ${problem}`);
        continue;
      }
      merged.baseUrl = merged.baseUrl.replace(/\/+$/, '');
      providers[id] = merged;
      custom.push(id);
    }
  }
  const config: ApiConfig = { providers };
  for (const k of ['defaultModel', 'utilityModel'] as const) {
    const v = file?.[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !v) errors.push(`${k} must be a "provider/model" string`);
    else config[k] = v;
  }
  return { config, errors, custom };
}

function validateProvider(p: ProviderSpec): string | undefined {
  if (!WIRE_APIS.includes(p.api)) return `api must be one of ${WIRE_APIS.join(', ')}`;
  if (typeof p.baseUrl !== 'string' || !/^https?:\/\/[^/]/.test(p.baseUrl)) return 'baseUrl must be an http(s) URL';
  if (p.apiKeyEnv !== undefined && (typeof p.apiKeyEnv !== 'string' || !ENV_NAME_RE.test(p.apiKeyEnv))) {
    return 'apiKeyEnv must be an environment variable name (the key itself never goes in this file)';
  }
  if (p.auth !== undefined && p.auth !== 'bearer' && p.auth !== 'x-api-key') return 'auth must be "bearer" or "x-api-key"';
  if (p.billing !== undefined && !BILLING.includes(p.billing)) return `billing must be one of ${BILLING.join(', ')}`;
  for (const k of ['contextWindow', 'maxOutputTokens', 'maxConcurrent'] as const) {
    const v = p[k];
    if (v !== undefined && (!Number.isInteger(v) || v <= 0)) return `${k} must be a positive integer`;
  }
  if (p.headers !== undefined && !isStringRecord(p.headers)) return 'headers must map names to strings';
  if (p.body !== undefined && !isPlainObject(p.body)) return 'body must be an object';
  if (p.models !== undefined) {
    if (!Array.isArray(p.models)) return 'models must be an array';
    for (const m of p.models) {
      if (typeof m === 'string' ? !m : !isPlainObject(m) || typeof m.id !== 'string' || !m.id) return 'every model needs an id';
    }
  }
  return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return isPlainObject(v) && Object.values(v).every((x) => typeof x === 'string');
}

/** Reads the config file, re-reading only when its mtime changes. */
export class ConfigSource {
  readonly path: string | undefined;
  readonly #inline: ApiConfigFile | undefined;
  #cache: { mtimeMs: number; loaded: LoadedConfig } | undefined;

  constructor(opts: { dataDir?: string; path?: string; inline?: ApiConfigFile }) {
    this.path = opts.path ?? (opts.dataDir ? join(opts.dataDir, CONFIG_FILE) : undefined);
    this.#inline = opts.inline;
  }

  get(): LoadedConfig {
    let mtimeMs = -1;
    if (this.path) {
      try {
        mtimeMs = statSync(this.path).mtimeMs;
      } catch {
        mtimeMs = -1;
      }
    }
    if (this.#cache && this.#cache.mtimeMs === mtimeMs) return this.#cache.loaded;
    const errors: string[] = [];
    let file: ApiConfigFile | undefined;
    if (mtimeMs >= 0 && this.path) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
        if (isPlainObject(parsed)) file = parsed as ApiConfigFile;
        else errors.push(`${this.path}: expected a JSON object`);
      } catch (err) {
        errors.push(`${this.path}: ${(err as Error).message}`);
      }
    }
    const merged = mergeFiles(file, this.#inline);
    const loaded = buildConfig(merged);
    loaded.errors.unshift(...errors);
    this.#cache = { mtimeMs, loaded };
    return loaded;
  }
}

function mergeFiles(a: ApiConfigFile | undefined, b: ApiConfigFile | undefined): ApiConfigFile | undefined {
  if (!a) return b;
  if (!b) return a;
  return { ...a, ...b, providers: { ...a.providers, ...b.providers } };
}

export interface ResolvedModel {
  providerId: string;
  provider: ProviderSpec;
  /** The provider's model id. */
  model: string;
  /** `provider/model`, what sessions report. */
  ref: string;
  spec?: ModelSpec;
}

function modelSpecs(p: ProviderSpec): ModelSpec[] {
  return (p.models ?? []).map((m) => (typeof m === 'string' ? { id: m } : m));
}

/** The default `provider/model`: `defaultModel`, else the first file-defined provider with a model, else a preset's. */
export function defaultModelRef(loaded: LoadedConfig): string | undefined {
  if (loaded.config.defaultModel) return loaded.config.defaultModel;
  const ids = [...loaded.custom, ...Object.keys(loaded.config.providers)];
  for (const id of ids) {
    const p = loaded.config.providers[id];
    if (!p) continue;
    const m = p.defaultModel ?? modelSpecs(p)[0]?.id;
    if (m) return `${id}/${m}`;
  }
  return undefined;
}

/**
 * `provider/model` → provider and model. A bare provider id uses its default model; a bare model id
 * is looked up in the providers' model lists. Throws BizziError('bad_request') when nothing matches.
 */
export function resolveModel(loaded: LoadedConfig, ref: string | undefined): ResolvedModel {
  const providers = loaded.config.providers;
  const want = ref ?? defaultModelRef(loaded);
  if (!want) throw new BizziError('bad_request', 'no model given and no default model configured (set defaultModel in api-providers.json)');
  const slash = want.indexOf('/');
  let providerId: string | undefined;
  let model: string | undefined;
  if (slash > 0 && providers[want.slice(0, slash)]) {
    providerId = want.slice(0, slash);
    model = want.slice(slash + 1);
  } else if (providers[want]) {
    providerId = want;
    model = providers[want]!.defaultModel ?? modelSpecs(providers[want]!)[0]?.id;
    if (!model) throw new BizziError('bad_request', `provider ${want} has no default model; use ${want}/<model>`);
  } else {
    for (const [id, p] of Object.entries(providers)) {
      if (modelSpecs(p).some((m) => m.id === want)) {
        providerId = id;
        model = want;
        break;
      }
    }
  }
  if (!providerId || !model) {
    throw new BizziError('bad_request', `unknown model "${want}": use provider/model with one of ${Object.keys(providers).join(', ')}`);
  }
  const provider = providers[providerId]!;
  const spec = modelSpecs(provider).find((m) => m.id === model);
  const out: ResolvedModel = { providerId, provider, model, ref: `${providerId}/${model}` };
  if (spec) out.spec = spec;
  return out;
}

/** Every provider lists its models: a fixed `provider/model` list; otherwise undefined (dynamic). */
export function listedModels(config: ApiConfig): string[] | undefined {
  const out: string[] = [];
  for (const [id, p] of Object.entries(config.providers)) {
    const specs = modelSpecs(p);
    if (specs.length === 0) return undefined;
    for (const m of specs) out.push(`${id}/${m.id}`);
  }
  return out;
}

export function hasPricing(config: ApiConfig): boolean {
  return Object.values(config.providers).some((p) => modelSpecs(p).some((m) => m.price));
}

/** The provider's key from `env`, or undefined when it needs none. Throws when it needs one that is missing. */
export function resolveApiKey(providerId: string, p: ProviderSpec, env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (!p.apiKeyEnv) return undefined;
  const key = env[p.apiKeyEnv];
  if (key) return key;
  throw new BizziError(
    'agent_unavailable',
    `no API key for provider ${providerId}: store ${p.apiKeyEnv} as a secret for agent "api" (agent.setSecret), or set it in the node's environment`,
    { provider: providerId, secret: p.apiKeyEnv },
  );
}
