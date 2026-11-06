// Minimal request/response client over the bizzi WebSocket protocol (used by `bizzi status`).

import { BizziError, PROTOCOL_VERSION, type MethodName, type MethodParams, type MethodResult, type ResponseMsg } from '@bizzi/protocol';
import WebSocket from 'ws';

export class ProtocolClient {
  readonly #ws: WebSocket;
  readonly #pending = new Map<string, { resolve: (m: ResponseMsg) => void; reject: (e: Error) => void }>();
  #n = 0;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const m = msg as ResponseMsg;
      if (typeof m?.id !== 'string') return;
      const p = this.#pending.get(m.id);
      if (p) {
        this.#pending.delete(m.id);
        p.resolve(m);
      }
    });
    ws.on('close', (code, reason) => {
      const err = new Error(`connection closed (${code}${reason.length ? `: ${reason.toString()}` : ''})`);
      for (const p of this.#pending.values()) p.reject(err);
      this.#pending.clear();
    });
  }

  static async connect(url: string, token: string, timeoutMs = 5000): Promise<ProtocolClient> {
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const client = new ProtocolClient(ws);
    await client.call('hello', { protocol: PROTOCOL_VERSION, client: { name: 'bizzi-cli', version: '0' }, token });
    return client;
  }

  async call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    const id = `r_${++this.#n}`;
    const res = await new Promise<ResponseMsg>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
    if ('error' in res) throw new BizziError(res.error.code, res.error.message, res.error.data);
    return res.result as MethodResult<M>;
  }

  close(): void {
    this.#ws.close();
  }
}
