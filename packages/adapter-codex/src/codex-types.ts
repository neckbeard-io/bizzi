// Typed view over the vendored `codex app-server generate-ts` output (see src/generated/VERSION).
// Only the subset the adapter uses is re-exported here.

export type { InitializeParams } from './generated/InitializeParams.ts';
export type { InitializeResponse } from './generated/InitializeResponse.ts';
export type { ReviewDecision } from './generated/ReviewDecision.ts';
export type { ExecCommandApprovalParams } from './generated/ExecCommandApprovalParams.ts';
export type { ApplyPatchApprovalParams } from './generated/ApplyPatchApprovalParams.ts';
export type { AskForApproval } from './generated/v2/AskForApproval.ts';
export type { SandboxMode } from './generated/v2/SandboxMode.ts';
export type { SandboxPolicy } from './generated/v2/SandboxPolicy.ts';
export type { ThreadStartParams } from './generated/v2/ThreadStartParams.ts';
export type { ThreadStartResponse } from './generated/v2/ThreadStartResponse.ts';
export type { ThreadResumeParams } from './generated/v2/ThreadResumeParams.ts';
export type { ThreadResumeResponse } from './generated/v2/ThreadResumeResponse.ts';
export type { TurnStartParams } from './generated/v2/TurnStartParams.ts';
export type { TurnStartResponse } from './generated/v2/TurnStartResponse.ts';
export type { TurnSteerParams } from './generated/v2/TurnSteerParams.ts';
export type { TurnSteerResponse } from './generated/v2/TurnSteerResponse.ts';
export type { TurnInterruptParams } from './generated/v2/TurnInterruptParams.ts';
export type { Turn } from './generated/v2/Turn.ts';
export type { ThreadItem } from './generated/v2/ThreadItem.ts';
export type { UserInput } from './generated/v2/UserInput.ts';
export type { FileUpdateChange } from './generated/v2/FileUpdateChange.ts';
export type { TokenUsageBreakdown } from './generated/v2/TokenUsageBreakdown.ts';
export type { ThreadTokenUsage } from './generated/v2/ThreadTokenUsage.ts';
export type { GetAccountResponse } from './generated/v2/GetAccountResponse.ts';
export type { Model } from './generated/v2/Model.ts';
export type { ModelListParams } from './generated/v2/ModelListParams.ts';
export type { ModelListResponse } from './generated/v2/ModelListResponse.ts';
export type { CommandExecutionRequestApprovalParams } from './generated/v2/CommandExecutionRequestApprovalParams.ts';
export type { CommandExecutionApprovalDecision } from './generated/v2/CommandExecutionApprovalDecision.ts';
export type { FileChangeRequestApprovalParams } from './generated/v2/FileChangeRequestApprovalParams.ts';
export type { FileChangeApprovalDecision } from './generated/v2/FileChangeApprovalDecision.ts';
export type { PermissionsRequestApprovalParams } from './generated/v2/PermissionsRequestApprovalParams.ts';
export type { PermissionsRequestApprovalResponse } from './generated/v2/PermissionsRequestApprovalResponse.ts';
export type { McpServerElicitationRequestResponse } from './generated/v2/McpServerElicitationRequestResponse.ts';
export type { McpServerElicitationRequestParams } from './generated/v2/McpServerElicitationRequestParams.ts';
export type { ToolRequestUserInputParams } from './generated/v2/ToolRequestUserInputParams.ts';
export type { ToolRequestUserInputResponse } from './generated/v2/ToolRequestUserInputResponse.ts';
export type { ThreadForkParams } from './generated/v2/ThreadForkParams.ts';
export type { ThreadForkResponse } from './generated/v2/ThreadForkResponse.ts';

import type { ServerNotification } from './generated/ServerNotification.ts';
import type { ServerRequest } from './generated/ServerRequest.ts';

export type { ServerNotification, ServerRequest };

export type NotificationMethod = ServerNotification['method'];
export type NotificationParams<M extends NotificationMethod> = Extract<ServerNotification, { method: M }>['params'];
export type ServerRequestMethod = ServerRequest['method'];
export type ServerRequestParams<M extends ServerRequestMethod> = Extract<ServerRequest, { method: M }>['params'];
