// @bizzi/adapter-api: plain model APIs (spec §6.5 item 1). The `api` agent (chat sessions without
// tools) and a utility completion helper for titles, briefs and extraction, over a provider
// abstraction for the Anthropic Messages API and OpenAI-compatible chat completions.

import type { AgentAdapter } from '@bizzi/protocol';
import { ApiChatAdapter, type ApiAdapterOptions } from './adapter.ts';

export { API_EFFORTS, ApiChatAdapter, type ApiAdapterOptions } from './adapter.ts';
export { ApiChatSession, accountIdOf, MAX_FILE_BYTES } from './session.ts';
export {
  CONFIG_FILE,
  ConfigSource,
  PRESET_PROVIDERS,
  PROVIDER_ID_RE,
  WIRE_APIS,
  buildConfig,
  defaultModelRef,
  listedModels,
  resolveApiKey,
  resolveModel,
  type ApiConfig,
  type ApiConfigFile,
  type LoadedConfig,
  type ModelPrice,
  type ModelSpec,
  type ProviderSpec,
  type ResolvedModel,
  type WireApi,
} from './config.ts';
export {
  clearDiscovered,
  modelLimits,
  streamChat,
  type ChatCallOptions,
  type ChatDelta,
  type ChatMessage,
  type ChatPart,
  type ChatRequest,
  type ChatResult,
  type ChatTarget,
  type FinishReason,
  type ModelLimits,
  type TokenCounts,
} from './chat.ts';
export { ApiError, Limiter, limiterFor, type HttpOptions } from './http.ts';
export { createUtilityCompleter, type CompleteRequest, type CompleteResult, type UtilityCompleter, type UtilityOptions } from './complete.ts';
export { TRANSCRIPT_DIR, TranscriptStore, type Transcript } from './transcript.ts';
export { approxTokens, contextOf, costOf, toUsage } from './usage.ts';
export { SseParser, type SseMessage } from './sse.ts';

/** Adapter discovery entry point used by the CLI. */
export function createAdapters(options?: ApiAdapterOptions): AgentAdapter[] {
  return [new ApiChatAdapter(options)];
}
