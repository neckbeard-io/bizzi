// The only IPC between renderer (preload) and main: a one-shot synchronous read of the bootstrap
// data the preload exposes as `window.bizzi`. The renderer talks to the core directly over ws.

export const IPC_BOOTSTRAP = 'bizzi:bootstrap';

export interface BizziConnection {
  url: string;
  token: string;
}

export interface Bootstrap {
  connection: BizziConnection | null;
  appVersion: string;
}
