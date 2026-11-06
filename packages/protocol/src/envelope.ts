import type { ChannelEvent } from './events.ts';
import type { MethodName, MethodParams, MethodResult } from './methods.ts';

export const PROTOCOL_VERSION = 'bizzi/1';

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'unsupported'
  | 'machine_offline'
  | 'agent_unavailable'
  | 'internal';

export interface ErrorObject {
  code: ErrorCode;
  message: string;
  data?: unknown;
}

export interface RequestMsg<M extends MethodName = MethodName> {
  id: string;
  method: M;
  params: MethodParams<M>;
}

export interface ResponseOkMsg<M extends MethodName = MethodName> {
  id: string;
  result: MethodResult<M>;
}

export interface ResponseErrMsg {
  id: string;
  error: ErrorObject;
}

export type ResponseMsg = ResponseOkMsg | ResponseErrMsg;
export type EventMsg = ChannelEvent;

export type ClientMsg = RequestMsg;
export type ServerMsg = ResponseMsg | EventMsg;

export class BizziError extends Error {
  readonly code: ErrorCode;
  readonly data?: unknown;
  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = 'BizziError';
    this.code = code;
    this.data = data;
  }
  toObject(): ErrorObject {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isRequest(v: unknown): v is RequestMsg {
  return isObject(v) && typeof v.id === 'string' && typeof v.method === 'string';
}

export function isResponse(v: unknown): v is ResponseMsg {
  return isObject(v) && typeof v.id === 'string' && ('result' in v || 'error' in v) && !('method' in v);
}

export function isErrorResponse(v: ResponseMsg): v is ResponseErrMsg {
  return 'error' in v;
}

export function isEvent(v: unknown): v is EventMsg {
  return isObject(v) && typeof v.ch === 'string' && typeof v.seq === 'number' && typeof v.type === 'string';
}

/** Parse one wire message (one WebSocket text frame). Throws BizziError('bad_request') on garbage. */
export function decode(text: string): RequestMsg | ServerMsg {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new BizziError('bad_request', 'invalid JSON');
  }
  if (isRequest(v) || isResponse(v) || isEvent(v)) return v;
  throw new BizziError('bad_request', 'not a bizzi message');
}

export function encode(msg: RequestMsg | ServerMsg): string {
  return JSON.stringify(msg);
}
