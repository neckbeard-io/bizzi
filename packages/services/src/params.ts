// Parameter validation for extension methods (params arrive untyped from the wire).

import { AGENT_KINDS, BizziError, type AgentKind } from '@bizzi/protocol';

export type Params = Record<string, unknown>;

export function asParams(p: unknown): Params {
  if (p === undefined || p === null) return {};
  if (typeof p !== 'object' || Array.isArray(p)) throw new BizziError('bad_request', 'params must be an object');
  return p as Params;
}

export function reqString(p: Params, key: string): string {
  const v = p[key];
  if (typeof v !== 'string' || v === '') throw new BizziError('bad_request', `${key} must be a non-empty string`);
  return v;
}

export function optString(p: Params, key: string): string | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new BizziError('bad_request', `${key} must be a string`);
  return v;
}

export function optBool(p: Params, key: string): boolean | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new BizziError('bad_request', `${key} must be a boolean`);
  return v;
}

export function optInt(p: Params, key: string, min: number, max: number): number | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new BizziError('bad_request', `${key} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

export function oneOf<T extends string>(p: Params, key: string, values: readonly T[]): T | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    throw new BizziError('bad_request', `${key} must be one of ${values.join(', ')}`);
  }
  return v as T;
}

export function isAgentKind(v: unknown): v is AgentKind {
  return typeof v === 'string' && (AGENT_KINDS as readonly string[]).includes(v);
}

export function reqAgent(p: Params, key = 'agent'): AgentKind {
  const v = p[key];
  if (!isAgentKind(v)) throw new BizziError('bad_request', `${key} must be one of ${AGENT_KINDS.join(', ')}`);
  return v;
}

export function optAgent(p: Params, key = 'agent'): AgentKind | undefined {
  return p[key] === undefined || p[key] === null ? undefined : reqAgent(p, key);
}

export function optStringArray(p: Params, key: string): string[] | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new BizziError('bad_request', `${key} must be an array of strings`);
  return v as string[];
}

export function reqStringArray(p: Params, key: string): string[] {
  const v = optStringArray(p, key);
  if (!v) throw new BizziError('bad_request', `${key} is required`);
  return v;
}

/** Hub routing: a node accepts its own machine id (or none); anything else is `not_found`. */
export function checkMachine(p: Params, machineId: string): void {
  const m = p.machineId;
  if (m === undefined || m === null || m === '') return;
  if (m !== machineId) throw new BizziError('not_found', `machine ${String(m)} is not this node`);
}

/** Wrap an unknown error thrown by a library into a BizziError (BizziErrors pass through). */
export function toBizziError(err: unknown, code: 'internal' | 'bad_request' = 'internal'): BizziError {
  if (err instanceof BizziError) return err;
  return new BizziError(code, err instanceof Error ? err.message : String(err));
}
