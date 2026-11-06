import { memo, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { cachedMarkdown, renderMarkdownAsync } from '../../lib/markdownClient.ts';

/** Completed assistant text rendered as markdown. Parsing runs in a worker; results are cached. */
export const Markdown = memo(function Markdown(props: { text: string; className?: string }): ReactNode {
  const { text } = props;
  const [state, setState] = useState<{ text: string; html: string | null }>(() => ({ text, html: cachedMarkdown(text) ?? null }));
  const html = state.text === text ? state.html : (cachedMarkdown(text) ?? null);

  useEffect(() => {
    if (cachedMarkdown(text) !== undefined) {
      setState({ text, html: cachedMarkdown(text) ?? null });
      return;
    }
    let alive = true;
    void renderMarkdownAsync(text).then((h) => {
      if (alive) setState({ text, html: h });
    });
    return () => {
      alive = false;
    };
  }, [text]);

  if (html === null) return <div className={`whitespace-pre-wrap ${props.className ?? ''}`}>{text}</div>;
  return <div className={`md ${props.className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
});
