// One API chat session: the conversation history, one streaming request per turn, interrupt by abort.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import {
  BizziError,
  type AccountUsage,
  type AdapterSession,
  type ApprovalDecision,
  type EmitFn,
  type InputBlock,
  type Logger,
  type StopReason,
  type Usage,
} from '@bizzi/protocol';
import { modelLimits, streamChat, type ChatMessage, type ChatPart, type ChatTarget } from './chat.ts';
import { resolveApiKey, type ResolvedModel } from './config.ts';
import { ApiError, type HttpOptions } from './http.ts';
import type { Transcript, TranscriptStore } from './transcript.ts';
import { addUsage, contextOf, toUsage } from './usage.ts';

/** Largest file attached through an InputBlock of type 'file'. */
export const MAX_FILE_BYTES = 256 * 1024;

export interface ApiChatSessionOptions {
  ref: string;
  emit: EmitFn;
  logger: Logger;
  store: TranscriptStore;
  transcript: Transcript;
  /** `provider/model` (or undefined for the default) → provider and model; throws BizziError. */
  resolve: (model: string | undefined) => ResolvedModel;
  /** Where keys are looked up: the session environment (agent secrets) over the node's. */
  env: Readonly<Record<string, string | undefined>>;
  http: HttpOptions;
  cwd: string;
  system?: string;
  /** Estimated tokens of what bizzi injects (the system prompt append). */
  bizziTokens: number;
  onStop?: () => void;
}

interface Turn {
  id: string;
  abort: AbortController;
  done: Promise<void>;
}

export function accountIdOf(providerId: string, apiKey: string | undefined): string {
  // A short fingerprint tells two keys for the same provider apart without revealing either.
  return apiKey ? `${providerId}:${createHash('sha256').update(apiKey).digest('hex').slice(0, 12)}` : providerId;
}

export class ApiChatSession implements AdapterSession {
  readonly #o: ApiChatSessionOptions;
  readonly #t: Transcript;
  #turn: Turn | undefined;
  #stopped = false;
  #total: Usage | undefined;
  #account: string | undefined;

  constructor(o: ApiChatSessionOptions) {
    this.#o = o;
    this.#t = o.transcript;
  }

  agentSessionRef(): string {
    return this.#o.ref;
  }

  get model(): string | undefined {
    return this.#t.model;
  }

  /** Resolve the current model and its key; reports the login (billing class) when it changes. */
  target(): ChatTarget {
    const r = this.#o.resolve(this.#t.model);
    const apiKey = resolveApiKey(r.providerId, r.provider, this.#o.env);
    const accountId = accountIdOf(r.providerId, apiKey);
    if (accountId !== this.#account) {
      this.#account = accountId;
      const usage: AccountUsage = {
        agent: 'api',
        accountId,
        label: `api · ${r.provider.label ?? r.providerId}`,
        billing: r.provider.billing ?? 'metered',
        machines: [],
        status: 'ok',
        observedAt: new Date().toISOString(),
      };
      this.#o.emit({ type: 'account.usage', data: usage });
    }
    return apiKey ? { ...r, apiKey } : r;
  }

  async send(turnId: string, input: InputBlock[]): Promise<void> {
    if (this.#stopped) throw new BizziError('conflict', 'session stopped');
    if (this.#turn) throw new BizziError('conflict', 'a turn is already running');
    const parts = await this.#parts(input);
    const target = this.target();
    this.#t.messages.push({ role: 'user', parts });
    const abort = new AbortController();
    const turn: Turn = { id: turnId, abort, done: Promise.resolve() };
    this.#turn = turn;
    turn.done = this.#run(turn, target).finally(() => {
      if (this.#turn === turn) this.#turn = undefined;
    });
  }

  async #parts(input: InputBlock[]): Promise<ChatPart[]> {
    const parts: ChatPart[] = [];
    for (const b of input) {
      if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') parts.push({ type: 'image', mediaType: b.mediaType, dataBase64: b.dataBase64 });
      else parts.push({ type: 'text', text: await this.#fileText(b.path) });
    }
    return parts;
  }

  /** A file input becomes its text (a chat model can't open paths). */
  async #fileText(path: string): Promise<string> {
    const abs = isAbsolute(path) ? path : resolvePath(this.#o.cwd, path);
    let buf: Buffer;
    try {
      buf = await readFile(abs);
    } catch (err) {
      throw new BizziError('bad_request', `cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
    if (buf.includes(0)) throw new BizziError('bad_request', `${path} looks binary; only text files can be attached to an API chat`);
    const truncated = buf.length > MAX_FILE_BYTES;
    const text = buf.subarray(0, MAX_FILE_BYTES).toString('utf8');
    return `File ${path}${truncated ? ` (first ${MAX_FILE_BYTES / 1024} KiB of ${Math.ceil(buf.length / 1024)} KiB)` : ''}:\n\`\`\`\n${text}\n\`\`\``;
  }

  async #run(turn: Turn, target: ChatTarget): Promise<void> {
    const { emit } = this.#o;
    const messageId = `${turn.id}-a`;
    const reasoningId = `${turn.id}-r`;
    let text = '';
    let reasoning = '';
    let stopReason: StopReason = 'end_turn';
    let error: string | undefined;
    let usage: Usage | undefined;
    let assistant: ChatMessage | undefined;
    try {
      const limits = await modelLimits(target, this.#o.http);
      const r = await streamChat(
        target,
        {
          messages: this.#t.messages,
          ...(this.#o.system ? { system: this.#o.system } : {}),
          ...(this.#t.effort ? { effort: this.#t.effort } : {}),
        },
        {
          ...this.#o.http,
          signal: turn.abort.signal,
          onDelta: (d) => {
            if (d.type === 'text') {
              text += d.text;
              emit({ type: 'message.delta', data: { messageId, role: 'assistant', text: d.text } });
            } else {
              reasoning += d.text;
              emit({ type: 'reasoning.delta', data: { messageId: reasoningId, text: d.text } });
            }
          },
        },
      );
      assistant = { role: 'assistant', parts: [{ type: 'text', text: r.text }] };
      if (r.native) assistant.native = r.native;
      if (r.finish === 'refusal') stopReason = 'refusal';
      else if (r.finish === 'other') stopReason = 'other';
      if (r.finish === 'max_tokens') {
        stopReason = 'other';
        emit({ type: 'error', data: { message: 'The reply reached the output limit (max_tokens) and was cut off.', code: 'max_tokens' } });
      }
      if (r.usage) {
        usage = toUsage(r.usage, target.spec?.price, limits.contextWindow);
        this.#total = addUsage(this.#total, usage);
        const ctx = contextOf(r.usage, limits.contextWindow, this.#o.bizziTokens);
        emit({ type: 'usage.updated', data: { ...this.#total } });
        if (ctx) emit({ type: 'context.updated', data: ctx });
      }
    } catch (err) {
      if (turn.abort.signal.aborted) {
        stopReason = 'interrupted';
      } else {
        stopReason = 'error';
        error = err instanceof ApiError || err instanceof BizziError ? err.message : `unexpected error: ${(err as Error).message}`;
        this.#o.logger.log('warn', 'api chat request failed', { model: target.ref, status: err instanceof ApiError ? err.status : undefined, err: error });
        emit({ type: 'error', data: { message: `${target.ref}: ${error}`, code: 'api_error' } });
      }
      if (text) assistant = { role: 'assistant', parts: [{ type: 'text', text }] };
      // A failed request with nothing to show leaves the history as it was, so sending again doesn't repeat it.
      else if (stopReason === 'error') this.#t.messages.pop();
    }
    if (reasoning) emit({ type: 'reasoning.completed', data: { messageId: reasoningId, text: reasoning } });
    if (text) emit({ type: 'message.completed', data: { messageId, role: 'assistant', text } });
    if (assistant) this.#t.messages.push(assistant);
    this.#save();
    const done: { turnId: string; stopReason: StopReason; usage?: Usage; error?: string } = { turnId: turn.id, stopReason };
    if (usage) done.usage = usage;
    if (error) done.error = error;
    emit({ type: 'turn.completed', data: done });
  }

  #save(): void {
    try {
      this.#o.store.save(this.#o.ref, this.#t);
    } catch (err) {
      this.#o.logger.log('warn', 'could not save api chat transcript', { ref: this.#o.ref, err: String(err) });
    }
  }

  async interrupt(): Promise<void> {
    this.#turn?.abort.abort();
  }

  async respondApproval(_approvalId: string, _decision: ApprovalDecision): Promise<void> {
    throw new BizziError('unsupported', 'API chat has no tools and never asks for approval');
  }

  async set(opts: { model?: string; permissionMode?: string; effort?: string }): Promise<void> {
    if (opts.permissionMode) throw new BizziError('unsupported', 'API chat has no permission modes (it has no tools)');
    const info: { model?: string; effort?: string } = {};
    if (opts.model) {
      const r = this.#o.resolve(opts.model);
      resolveApiKey(r.providerId, r.provider, this.#o.env);
      this.#t.model = r.ref;
      info.model = r.ref;
    }
    if (opts.effort !== undefined) {
      if (opts.effort === '' || opts.effort === 'default') delete this.#t.effort;
      else this.#t.effort = opts.effort;
      info.effort = opts.effort;
    }
    if (info.model) this.target();
    this.#save();
    if (info.model || info.effort !== undefined) this.#o.emit({ type: 'session.info', data: info });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const turn = this.#turn;
    if (turn) {
      turn.abort.abort();
      await turn.done;
    }
    this.#o.onStop?.();
  }
}
