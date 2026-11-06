// Markdown rendering off the main thread, with an LRU cache so re-mounting a virtualized row is free.

const MAX_CACHE = 400;
const cache = new Map<string, string>();

export function cachedMarkdown(text: string): string | undefined {
  const hit = cache.get(text);
  if (hit !== undefined) {
    cache.delete(text);
    cache.set(text, hit);
  }
  return hit;
}

function remember(text: string, html: string): void {
  cache.set(text, html);
  if (cache.size > MAX_CACHE) {
    const first = cache.keys().next();
    if (!first.done) cache.delete(first.value);
  }
}

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 0;
const waiting = new Map<number, { text: string; resolve: (html: string) => void }>();
const inflight = new Map<string, Promise<string>>();

function getWorker(): Worker | null {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; html: string }>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      remember(w.text, e.data.html);
      w.resolve(e.data.html);
    };
    worker.onerror = () => {
      workerFailed = true;
      worker?.terminate();
      worker = null;
      // Re-run anything still waiting on the main thread.
      const pending = [...waiting.values()];
      waiting.clear();
      for (const w of pending) void renderOnMain(w.text).then(w.resolve);
    };
  } catch {
    workerFailed = true;
    worker = null;
  }
  return worker;
}

async function renderOnMain(text: string): Promise<string> {
  const { renderMarkdown } = await import('./markdown.ts');
  const html = renderMarkdown(text);
  remember(text, html);
  return html;
}

export function renderMarkdownAsync(text: string): Promise<string> {
  const hit = cachedMarkdown(text);
  if (hit !== undefined) return Promise.resolve(hit);
  const existing = inflight.get(text);
  if (existing) return existing;
  const w = getWorker();
  const p = w
    ? new Promise<string>((resolve) => {
        const id = ++nextId;
        waiting.set(id, { text, resolve });
        w.postMessage({ id, text });
      })
    : renderOnMain(text);
  inflight.set(text, p);
  void p.finally(() => inflight.delete(text));
  return p;
}
