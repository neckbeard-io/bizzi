// The node's way to send requests to its hub (spec §5.4, §12.4): node → hub requests over the node link.
//
// Core doesn't know about WebSockets or the hub package. The hub link (`@bizzi/hub` connectToHub)
// attaches a transport here once the hub has welcomed the node and advertised node requests; anything
// in the node (orchestration, forks) calls `request` and gets the hub's answer, or a fast
// `machine_offline` when there is no link, or `unsupported` when the hub is too old.

import { BizziError } from '@bizzi/protocol';

/** Default time a node→hub request may take (the hub's own forwarding timeout is separate). */
export const HUB_REQUEST_TIMEOUT_MS = 60_000;

export interface HubTransport {
  /** Send one request; reject with BizziError (the hub's error, or machine_offline when the link drops). */
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
}

export type HubPortState = 'disconnected' | 'connected' | 'unsupported';

export class HubPort {
  #transport?: HubTransport;
  #state: HubPortState = 'disconnected';
  readonly #listeners = new Set<(state: HubPortState) => void>();

  get state(): HubPortState {
    return this.#state;
  }

  get connected(): boolean {
    return this.#state === 'connected';
  }

  /** The link is up and the hub accepts node requests. */
  attach(t: HubTransport): void {
    this.#transport = t;
    this.#set('connected');
  }

  /** The link is up but the hub doesn't accept node requests (older hub). */
  markUnsupported(): void {
    this.#transport = undefined;
    this.#set('unsupported');
  }

  /** The link dropped. Only detaches `t` if it is still the current transport. */
  detach(t?: HubTransport): void {
    if (t && this.#transport !== t) return;
    this.#transport = undefined;
    this.#set('disconnected');
  }

  /** Called on every state change; returns an unsubscribe function. */
  onChange(fn: (state: HubPortState) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  request<T = unknown>(method: string, params: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    const t = this.#transport;
    if (!t) {
      return Promise.reject(
        this.#state === 'unsupported'
          ? new BizziError('unsupported', 'the hub does not accept requests from nodes; upgrade the hub')
          : new BizziError('machine_offline', 'this machine is not connected to a hub'),
      );
    }
    return t.request(method, params, opts.timeoutMs ?? HUB_REQUEST_TIMEOUT_MS) as Promise<T>;
  }

  #set(state: HubPortState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const fn of [...this.#listeners]) {
      try {
        fn(state);
      } catch {
        // listeners must not break the link
      }
    }
  }
}
