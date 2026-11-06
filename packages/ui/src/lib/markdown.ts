// Markdown → safe HTML. Pure (no DOM), so it runs in a web worker and in Node tests.
import { Marked } from 'marked';
import type { Tokens } from 'marked';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

const SAFE_URL = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;

export function safeUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  const h = href.trim();
  // Relative paths without a scheme are fine; anything with a scheme must be allow-listed.
  if (SAFE_URL.test(h)) return h;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(h)) return h;
  return null;
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  renderer: {
    // Raw HTML from agents is shown as text, never injected.
    html(token: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(token.text);
    },
    link(this: unknown, token: Tokens.Link): string {
      const href = safeUrl(token.href);
      const inner = (this as { parser: { parseInline(t: Tokens.Link['tokens']): string } }).parser.parseInline(token.tokens);
      if (!href) return inner;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
    image(token: Tokens.Image): string {
      // No remote image loads from agent output; show the alt text as a link instead.
      const href = safeUrl(token.href);
      const alt = escapeHtml(token.text || 'image');
      return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">[${alt}]</a>` : `[${alt}]`;
    },
    code(token: Tokens.Code): string {
      const lang = (token.lang ?? '').match(/^\S*/)?.[0] ?? '';
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      return `<pre><code${cls}>${escapeHtml(token.text)}</code></pre>\n`;
    },
  },
});

export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}
