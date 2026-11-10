// Scripted stand-in for the SDK's Query, plus builders for SDK messages.

import type { Logger, SessionEventBody, SessionEventMap, SessionEventType } from '@bizzi/protocol';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { PushQueue } from '../src/queue.ts';
import type { ClaudeQuery, QueryFn } from '../src/types.ts';

type Item = { m: SDKMessage } | { err: Error } | { end: true };

export type Script = (fq: FakeQuery, msg: SDKUserMessage) => void | Promise<void>;

export class FakeQuery implements ClaudeQuery {
  readonly options: Options;
  readonly received: SDKUserMessage[] = [];
  readonly calls: { method: string; args: unknown[] }[] = [];
  onInterrupt: (() => void) | undefined;
  #out = new PushQueue<Item>();

  constructor(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }, script: Script) {
    this.options = params.options;
    void (async () => {
      for await (const u of params.prompt) {
        this.received.push(u);
        await script(this, u);
      }
    })();
  }

  emit(...msgs: object[]): void {
    for (const m of msgs) if (!this.#out.ended) this.#out.push({ m: m as SDKMessage });
  }
  crash(message: string): void {
    this.#out.push({ err: new Error(message) });
  }
  exit(): void {
    this.#out.push({ end: true });
  }
  /** Ask the adapter for permission, like the CLI's can_use_tool control request. */
  ask(toolName: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const signal = new AbortController().signal;
    return this.options.canUseTool!(toolName, input, { signal, toolUseID: String(extra.toolUseID ?? 'toolu_x'), requestId: 'req_1', ...extra });
  }

  /** An MCP elicitation, like the CLI's elicitation control request. */
  elicit(req: Record<string, unknown>, signal: AbortSignal = new AbortController().signal) {
    return this.options.onElicitation!(req as unknown as Parameters<NonNullable<Options['onElicitation']>>[0], { signal, requestId: 'req_e' });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for await (const item of this.#out) {
      if ('err' in item) throw item.err;
      if ('end' in item) return;
      yield item.m;
    }
  }

  async interrupt(): Promise<unknown> {
    this.calls.push({ method: 'interrupt', args: [] });
    this.onInterrupt?.();
    return { still_queued: [] };
  }
  async setPermissionMode(mode: string): Promise<void> {
    this.calls.push({ method: 'setPermissionMode', args: [mode] });
  }
  async setModel(model?: string): Promise<void> {
    this.calls.push({ method: 'setModel', args: [model] });
  }
  async applyFlagSettings(s: object): Promise<void> {
    this.calls.push({ method: 'applyFlagSettings', args: [s] });
  }
  close(): void {
    this.calls.push({ method: 'close', args: [] });
    this.#out.end();
  }
}

export function fakeQueryFn(script: Script, extend?: (fq: FakeQuery) => void): { queryFn: QueryFn; last: () => FakeQuery } {
  let last: FakeQuery | undefined;
  return {
    queryFn: (params) => {
      last = new FakeQuery(params, script);
      extend?.(last);
      return last;
    },
    last: () => last!,
  };
}

export const silentLogger: Logger = {
  log() {},
  child() {
    return silentLogger;
  },
};

export function collector() {
  const events: SessionEventBody[] = [];
  return {
    events,
    emit: (e: SessionEventBody) => events.push(e),
    of: <T extends SessionEventType>(type: T): SessionEventMap[T][] =>
      events.filter((e) => e.type === type).map((e) => e.data as SessionEventMap[T]),
  };
}

export async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

export const tick = () => new Promise((r) => setTimeout(r, 5));

// ---------------------------------------------------------------- builders

const SID = 'sess';

export function init(sessionId: string, extra: object = {}) {
  return { type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-haiku-5-5', permissionMode: 'default', cwd: '/w', tools: [], mcp_servers: [], slash_commands: [], output_style: 'default', skills: [], plugins: [], apiKeySource: 'none', claude_code_version: '2.1.311', uuid: 'u-init', ...extra };
}

export function streamText(apiId: string, index: number, chunks: string[], kind: 'text' | 'thinking' = 'text') {
  const out: object[] = [];
  if (index === 0) out.push({ type: 'stream_event', parent_tool_use_id: null, session_id: SID, uuid: 'se', event: { type: 'message_start', message: { id: apiId } } });
  out.push({ type: 'stream_event', parent_tool_use_id: null, session_id: SID, uuid: 'se', event: { type: 'content_block_start', index, content_block: { type: kind } } });
  for (const c of chunks) {
    const delta = kind === 'text' ? { type: 'text_delta', text: c } : { type: 'thinking_delta', thinking: c };
    out.push({ type: 'stream_event', parent_tool_use_id: null, session_id: SID, uuid: 'se', event: { type: 'content_block_delta', index, delta } });
  }
  out.push({ type: 'stream_event', parent_tool_use_id: null, session_id: SID, uuid: 'se', event: { type: 'content_block_stop', index } });
  return out;
}

export function assistant(apiId: string, block: object, extra: object = {}) {
  return { type: 'assistant', message: { id: apiId, role: 'assistant', content: [block] }, parent_tool_use_id: null, session_id: SID, uuid: `a-${apiId}`, ...extra };
}

export function toolUse(apiId: string, id: string, name: string, input: object, parent: string | null = null) {
  return assistant(apiId, { type: 'tool_use', id, name, input }, { parent_tool_use_id: parent });
}

export function toolResult(id: string, content: unknown, isError = false, toolUseResult?: unknown) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
    parent_tool_use_id: null,
    session_id: SID,
    uuid: `tr-${id}`,
    ...(toolUseResult !== undefined ? { tool_use_result: toolUseResult } : {}),
  };
}

export function result(uuids: string[], cost: number, extra: object = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    stop_reason: 'end_turn',
    num_turns: 1,
    duration_ms: 10,
    duration_api_ms: 10,
    total_cost_usd: cost,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
    modelUsage: {
      'claude-haiku-5-5': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20, webSearchRequests: 0, costUSD: cost, contextWindow: 200000, maxOutputTokens: 64000 },
    },
    permission_denials: [],
    user_message_uuids: uuids,
    user_message_uuid: uuids[uuids.length - 1],
    terminal_reason: 'completed',
    session_id: SID,
    uuid: 'u-result',
    ...extra,
  };
}
