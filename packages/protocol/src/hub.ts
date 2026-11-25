// Hub contracts: HTTP pairing/auth API and the node link. See docs/topology.md §1 and docs/tech-choices.md D8.
//
// Identity: every device (phone, browser, desktop app) and every node (machine) holds an Ed25519 keypair.
// Pairing registers the public key with a one-time code; afterwards the key proves identity by signing
// a hub-issued nonce, which buys a short-lived bearer token used in `hello` (clients) or `node.hello` (nodes).
//
// HTTP endpoints (all JSON, POST unless noted), served by the hub next to /ws and /ws/node:
//   POST /api/pair             PairRequest      → PairResponse
//   POST /api/auth/challenge   ChallengeRequest → ChallengeResponse
//   POST /api/auth/token       TokenRequest     → TokenResponse
//   POST /api/push/action      PushActionRequest → PushActionResponse   (Web Push notification buttons)
//   GET  /healthz                               → { ok: true, role: 'hub' }
// Errors: HTTP 4xx/5xx with body { error: ErrorObject }.
//
// The setup code: on first start (no devices paired yet) the hub prints a one-time setup code to its log
// and writes it to <dataDir>/setup-code. The first device paired with it becomes the owner. Later codes
// come from `pairing.create`, called by an already-paired device.
//
// Node link (/ws/node): the node dials the hub and sends `NodeHelloMsg` as its first frame. The hub answers
// with `NodeWelcomeMsg` (or closes with code 4401). From then on the roles flip: the hub is a *client* of the
// node over this socket and speaks the ordinary client protocol (requests, responses, subscribe/replay
// events), minus `hello`. The node keeps its event log as the outbox: after a reconnect the hub
// re-subscribes every channel with `since` = the last seq it stored, so nothing is lost or duplicated.
// Request ids from the hub are prefixed `h:` so a node can tell them apart in logs.

import type { ApprovalDecisionKind, DeviceKind, MachineInfo } from './model.ts';

/** Ed25519 public key as a JWK (`{ kty: 'OKP', crv: 'Ed25519', x }`). */
export interface Ed25519PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
}

export interface PairRequest {
  /** One-time pairing code (or the setup code). Case-insensitive; dashes/spaces ignored. */
  code: string;
  kind: DeviceKind;
  name: string;
  publicKey: Ed25519PublicJwk;
  /** For kind 'node': the machine id of the node being paired. */
  machineId?: string;
}

export interface PairResponse {
  deviceId: string;
  kind: DeviceKind;
  owner: boolean;
  /** WebSocket URLs to use from now on. */
  clientUrl: string;
  nodeUrl: string;
}

export interface ChallengeRequest {
  deviceId: string;
}

export interface ChallengeResponse {
  nonce: string;
  expiresAt: string;
}

export interface TokenRequest {
  deviceId: string;
  nonce: string;
  /** base64url Ed25519 signature over UTF-8 `authMessage(deviceId, nonce)`. */
  signature: string;
}

export interface TokenResponse {
  /** Bearer token for `hello` / `node.hello`. */
  token: string;
  expiresAt: string;
}

/** The exact bytes a device signs to obtain a token. */
export function authMessage(deviceId: string, nonce: string): string {
  return `bizzi-auth:v1:${deviceId}:${nonce}`;
}

/** Normalize a human-entered pairing code ("ab12-cd34" → "AB12CD34"). */
export function normalizePairingCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

export interface NodeHelloMsg {
  type: 'node.hello';
  protocol: string;
  /** Token from /api/auth/token for a device of kind 'node'. */
  token: string;
  machine: MachineInfo;
}

export interface NodeWelcomeMsg {
  type: 'node.welcome';
  hubVersion: string;
}

export type NodeLinkControlMsg = NodeHelloMsg | NodeWelcomeMsg;

/** Prefix the hub puts on request ids it sends over a node link. */
export const HUB_REQUEST_PREFIX = 'h:';

// ---- Web Push (tech-choices.md D9)
//
// The hub encrypts a `WebPushPayload` (JSON, RFC 8291) to each subscription registered with
// `push.register`. The UI's service worker shows it. For an approval it adds Approve / Deny buttons, which
// POST the payload's single-use `token` to `actionUrl` (/api/push/action): a service worker has no
// protocol connection, and the token stands in for one, scoped to exactly that approval and device.

export interface WebPushPayload {
  v: 1;
  title: string;
  body: string;
  /** Notifications with the same tag replace each other (one per session, or per login for usage). */
  tag: string;
  /** Absolute click-through URL (`<ui>/#/s/<sessionId>`), or relative to the service worker scope. */
  url: string;
  sessionId?: string;
  urgent?: boolean;
  /** Present when the notification is about exactly one pending approval. */
  approval?: {
    sessionId: string;
    approvalId: string;
    options: ApprovalDecisionKind[];
    token: string;
    actionUrl: string;
  };
}

export interface PushActionRequest {
  token: string;
  decision: ApprovalDecisionKind;
}

export interface PushActionResponse {
  ok: true;
}
