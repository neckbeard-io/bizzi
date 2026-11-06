import type {
  EffortLevel,
  Options,
  PermissionMode,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

/** The subset of the SDK's `Query` the adapter uses (tests provide fakes). */
export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: { effortLevel?: EffortLevel | null }): Promise<void>;
  initializationResult?(): Promise<SDKControlInitializeResponse>;
  close(): void;
}

/** Signature-compatible with the SDK's `query()` in streaming-input mode. */
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeQuery;
