// Subset of the OpenCode v2 server API (`opencode serve`, OpenAPI "opencode HttpApi").
// Written against the OpenAPI document served at GET /openapi.json by opencode v2.0.25, plus the
// SSE event payloads observed on GET /api/event (the OpenAPI types the stream data as an opaque
// JSON string, so the event shapes below come from captured traffic).

export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export interface LocationRef {
  directory: string;
}

export type PermissionEffect = 'allow' | 'deny' | 'ask';
export interface PermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}
export type PermissionReply = 'once' | 'always' | 'reject';

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface SessionInfo {
  id: string;
  parentID?: string;
  /** Set on forks: the source session and the message boundary. */
  fork?: { sessionID: string; boundary: { type: 'before' | 'through'; messageID: string } };
  projectID: string;
  agent?: string;
  model?: ModelRef;
  cost: number;
  tokens: TokenUsage;
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  time: { created: number; updated: number; idle?: number };
  title?: string;
  permissions?: PermissionRule[];
  location: LocationRef;
}

export interface CreateSessionBody {
  id?: string;
  parentID?: string;
  title?: string;
  agent?: string;
  model?: ModelRef;
  location?: LocationRef;
  metadata?: Record<string, unknown>;
  permissions?: PermissionRule[];
}

export interface PromptFileAttachment {
  uri: string;
  name?: string;
  description?: string;
}

export interface PromptBody {
  id?: string;
  text: string;
  files?: PromptFileAttachment[];
  metadata?: Record<string, unknown>;
  delivery?: 'steer' | 'queue';
  resume?: boolean;
}

export interface InboxUser {
  id: string;
  sessionID: string;
  type: 'user';
  delivery: 'steer' | 'queue';
}

export interface ServerInfo {
  version: string;
  pid: number;
  urls: string[];
}

export interface ModelInfo {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  variants: { id: string }[];
  enabled: boolean;
  status?: string;
  limit?: { context: number; input?: number; output: number };
}

export interface AgentInfo {
  id: string;
  name: string;
  mode: 'subagent' | 'primary' | 'all';
  hidden: boolean;
  description?: string;
}

export type McpConfig =
  | { type: 'local'; command: string[]; environment?: Record<string, string>; cwd?: string }
  | { type: 'remote'; url: string; headers?: Record<string, string>; oauth?: false };

export interface StructuredError {
  type: string;
  message: string;
  status?: number;
}

export type ToolContent = { type: 'text'; text: string } | { type: 'file'; uri: string; mime: string; name?: string | null };

export interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: { type: 'tool'; messageID: string; id: string };
  message?: string;
}

export interface FormOption {
  value: string;
  label: string;
  description?: string;
}

/** One field of a form (`Form.Field` in the OpenAPI document). */
export interface FormField {
  key: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'multiselect' | 'external' | string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  options?: FormOption[];
  /** Free text allowed besides the options. */
  custom?: boolean;
  default?: unknown;
  url?: string;
}

/**
 * A pending form (`Form.Info`). The `question` tool creates one per call with
 * `metadata.kind === 'question'` and `metadata.tool` pointing at the tool call; fields are keyed
 * `q0`, `q1`, … (type `string` for single choice, `multiselect` for multiple, `custom: true`).
 */
export interface FormInfo {
  id: string;
  sessionID: string;
  title: string;
  metadata?: { kind?: string; tool?: { messageID: string; id: string }; [k: string]: unknown };
  fields: FormField[];
}

/** A form answer (`Form.Answer`): field key -> value. */
export type FormAnswer = Record<string, string | number | boolean | string[]>;

export type FormState =
  | { status: 'pending' }
  | { status: 'answered'; answer: FormAnswer }
  | { status: 'cancelled'; message?: string };

/** Message history entries (GET /api/session/{id}/message), used to reconcile after a stream gap. */
export type MessageInfo =
  | { id: string; type: 'user'; time: { created: number }; text: string }
  | {
      id: string;
      type: 'assistant';
      time: { created: number; completed?: number };
      agent: string;
      model: ModelRef;
      content: (
        | { type: 'text'; text: string }
        | { type: 'reasoning'; text: string }
        | {
            type: 'tool';
            id: string;
            name: string;
            state:
              | { status: 'streaming'; input: string }
              | { status: 'running'; input: Record<string, unknown> }
              | { status: 'completed'; input: Record<string, unknown>; content: ToolContent[] }
              | { status: 'error'; input: Record<string, unknown>; error: StructuredError; content?: ToolContent[] };
          }
      )[];
      finish?: string;
      cost?: number;
      tokens?: TokenUsage;
      error?: StructuredError;
    }
  | { id: string; type: 'idle'; time: { created: number }; outcome: 'succeeded' | 'failed' | 'interrupted' }
  | { id: string; type: string; time: { created: number } };

// ---------------------------------------------------------------------------------------------
// SSE events (GET /api/event). One global stream for every location and session on the server.

export interface OcEvent {
  id: string;
  type: string;
  data: unknown;
  created?: number;
  location?: LocationRef;
  /** Present on events persisted in the session's durable log. */
  durable?: { aggregateID: string; seq: number; version: number };
  metadata?: Record<string, unknown>;
}

interface SessionScoped {
  sessionID: string;
}
interface MessageScoped extends SessionScoped {
  assistantMessageID: string;
}
interface Ordinal extends MessageScoped {
  ordinal: number;
}
interface ToolScoped extends MessageScoped {
  id: string;
}

/** `data` payloads by event type, for the events the adapter interprets. */
export interface OcEventMap {
  'server.connected': Record<string, never>;
  'session.created': SessionScoped & {
    parentID?: string;
    title?: string;
    agent?: string;
    model?: ModelRef;
    location?: LocationRef;
  };
  'session.renamed': SessionScoped & { title: string };
  'session.deleted': SessionScoped;
  'session.agent.selected': SessionScoped & { agent: string; previous?: string };
  'session.model.selected': SessionScoped & { model: ModelRef; previous?: ModelRef };
  'session.execution.started': SessionScoped;
  'session.execution.succeeded': SessionScoped;
  'session.execution.failed': SessionScoped & { error?: StructuredError };
  'session.execution.interrupted': SessionScoped & { reason?: string };
  'session.step.started': MessageScoped & { agent: string; model: ModelRef };
  'session.step.streamed': MessageScoped;
  'session.step.ended': MessageScoped & { finish?: string; cost?: number; tokens?: TokenUsage };
  'session.step.failed': MessageScoped & { error: StructuredError };
  'session.text.started': Ordinal;
  'session.text.delta': Ordinal & { delta: string };
  'session.text.ended': Ordinal & { text: string };
  'session.reasoning.started': Ordinal;
  'session.reasoning.delta': Ordinal & { delta: string };
  'session.reasoning.ended': Ordinal & { text: string };
  'session.tool.input.started': ToolScoped & { name: string };
  'session.tool.input.delta': ToolScoped & { delta: string };
  'session.tool.input.ended': ToolScoped & { text: string };
  'session.tool.called': ToolScoped & { input: Record<string, unknown>; executed?: boolean };
  'session.tool.progress': ToolScoped & { metadata: Record<string, unknown> };
  'session.tool.success': ToolScoped & { content?: ToolContent[]; metadata?: Record<string, unknown> };
  'session.tool.failed': ToolScoped & { error: StructuredError; content?: ToolContent[] };
  'session.usage.updated': SessionScoped & { cost: number; tokens: TokenUsage };
  'session.retry.scheduled': MessageScoped & { attempt: number; at: number; error: StructuredError };
  'permission.asked': PermissionRequest;
  'permission.replied': SessionScoped & { requestID: string; reply: PermissionReply };
  'form.created': { form: FormInfo };
  'form.replied': SessionScoped & { id: string; answer?: FormAnswer };
  'form.cancelled': SessionScoped & { id: string };
}

export type OcEventType = keyof OcEventMap;

/** Narrow an event's payload by its type. */
export function dataOf<K extends OcEventType>(ev: OcEvent, _type: K): OcEventMap[K] {
  return ev.data as OcEventMap[K];
}

/** The session an event belongs to, if any. */
export function eventSessionId(ev: { type: string; data?: unknown }): string | undefined {
  const d = ev.data as Record<string, unknown> | undefined;
  if (!d || typeof d !== 'object') return undefined;
  if (typeof d.sessionID === 'string') return d.sessionID;
  const form = d.form as Record<string, unknown> | undefined;
  if (form && typeof form.sessionID === 'string') return form.sessionID;
  const info = d.info as Record<string, unknown> | undefined;
  const meta = info?.metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta.sessionID === 'string') return meta.sessionID;
  return undefined;
}
