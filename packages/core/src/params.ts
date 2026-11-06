// Small runtime validators for request params arriving over the wire.

import { BizziError } from '@bizzi/protocol';

export type Params = Record<string, unknown>;

export function asParams(v: unknown): Params {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new BizziError('bad_request', 'params must be an object');
  return v as Params;
}

export function reqString(p: Params, key: string): string {
  const v = p[key];
  if (typeof v !== 'string' || v.length === 0) throw new BizziError('bad_request', `${key} must be a non-empty string`);
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

export function optInt(p: Params, key: string, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new BizziError('bad_request', `${key} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

export function reqInt(p: Params, key: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const v = optInt(p, key, min, max);
  if (v === undefined) throw new BizziError('bad_request', `${key} is required`);
  return v;
}

export function oneOf<T extends string>(p: Params, key: string, values: readonly T[]): T | undefined {
  const v = optString(p, key);
  if (v === undefined) return undefined;
  if (!(values as readonly string[]).includes(v)) {
    throw new BizziError('bad_request', `${key} must be one of ${values.join(', ')}`);
  }
  return v as T;
}

const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

export function reqBase64(p: Params, key: string): Uint8Array {
  const v = p[key];
  if (typeof v !== 'string' || !BASE64.test(v)) throw new BizziError('bad_request', `${key} must be base64`);
  return new Uint8Array(Buffer.from(v, 'base64'));
}
