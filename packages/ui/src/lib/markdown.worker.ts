import { renderMarkdown } from './markdown.ts';

interface Req {
  id: number;
  text: string;
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, text } = e.data;
  let html: string;
  try {
    html = renderMarkdown(text);
  } catch (err) {
    html = `<pre>${String(err)}</pre>`;
  }
  (self as unknown as { postMessage(m: unknown): void }).postMessage({ id, html });
};
