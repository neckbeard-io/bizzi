import type {
  AccountInfo,
  EffortLevel,
  Options,
  PermissionMode,
  SDKControlGetContextUsageResponse,
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
  getContextUsage?(opts?: { detail?: 'summary' | 'full' }): Promise<SDKControlGetContextUsageResponse>;
  accountInfo?(): Promise<AccountInfo>;
  // The experimental usage query is reached through `readPlanUsage` (usage.ts), never typed here.
  close(): void;
}

/** Signature-compatible with the SDK's `query()` in streaming-input mode. */
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeQuery;
