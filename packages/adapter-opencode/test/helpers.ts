import type { AdapterContext, Logger, SessionEventBody, SessionEventMap } from '@bizzi/protocol';

export const silentLogger: Logger = {
  log() {},
  child() {
    return silentLogger;
  },
};

export const ctx: AdapterContext = { logger: silentLogger };

type Type = keyof SessionEventMap;

export class Recorder {
  readonly events: SessionEventBody[] = [];

  emit = (e: SessionEventBody): void => {
    this.events.push(e);
  };

  of<T extends Type>(type: T): SessionEventMap[T][] {
    return this.events.filter((e) => e.type === type).map((e) => e.data as SessionEventMap[T]);
  }

  types(): string[] {
    return this.events.map((e) => e.type);
  }

  async waitFor<T extends Type>(type: T, pred: (d: SessionEventMap[T]) => boolean = () => true, timeoutMs = 5_000): Promise<SessionEventMap[T]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.of(type).find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}; got: ${this.types().join(', ')}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

export async function until(pred: () => boolean, timeoutMs = 5_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
