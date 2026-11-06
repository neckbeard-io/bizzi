import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { useBizzi, useStore } from '../../app/context.tsx';
import { useDomTheme } from '../../app/hooks.ts';

const DARK: ITheme = { background: '#0c0c10', foreground: '#e7e7ec', cursor: '#8b93ff', selectionBackground: '#3b3f7a' };
const LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#17171c',
  cursor: '#4f46e5',
  selectionBackground: '#c7cbff',
  black: '#17171c',
  brightBlack: '#6b6b76',
  white: '#a1a1aa',
  brightWhite: '#52525b',
  yellow: '#a16207',
  brightYellow: '#854d0e',
  green: '#15803d',
  brightGreen: '#166534',
  blue: '#1d4ed8',
  brightBlue: '#1e40af',
};

/**
 * Terminal-mode session: xterm.js with the WebGL renderer. Output comes straight from the client's
 * TerminalStreams (never through the React store); keystrokes go out as term.input, size as term.resize.
 */
export function TerminalView(props: { sessionId: string }): ReactNode {
  const { sessionId } = props;
  const store = useStore();
  const theme = useDomTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const exited = useBizzi((s) => s.timelines[sessionId]?.terminalExit ?? null);
  const [renderer, setRenderer] = useState<'webgl' | 'dom'>('dom');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: false,
      theme: document.documentElement.dataset.theme === 'dark' ? DARK : LIGHT,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        setRenderer('dom');
      });
      term.loadAddon(webgl);
      setRenderer('webgl');
    } catch {
      setRenderer('dom');
    }

    const unsubOut = store.terminal.subscribe(sessionId, (chunk) => term.write(chunk));
    const onData = term.onData((d) => {
      store.termInput(sessionId, d).catch(() => {});
    });
    let lastSize = '';
    const onResize = term.onResize(({ cols, rows }) => {
      const key = `${cols}x${rows}`;
      if (key === lastSize) return;
      lastSize = key;
      store.termResize(sessionId, cols, rows).catch(() => {});
    });
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          // host not visible
        }
      });
    });
    ro.observe(host);
    try {
      fit.fit();
    } catch {
      // ignore
    }
    store.termResize(sessionId, term.cols, term.rows).catch(() => {});
    lastSize = `${term.cols}x${term.rows}`;
    term.focus();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsubOut();
      onData.dispose();
      onResize.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [store, sessionId]);

  useEffect(() => {
    const t = termRef.current;
    if (t) t.options.theme = theme === 'dark' ? DARK : LIGHT;
  }, [theme]);

  return (
    <div className="flex h-full flex-col bg-panel">
      <div ref={hostRef} className="term-host min-h-0 flex-1 overflow-hidden" />
      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border px-3 text-[11px] text-muted">
        <span>{renderer === 'webgl' ? 'WebGL renderer' : 'DOM renderer'}</span>
        {exited ? (
          <span className="text-warn">
            Process exited{exited.exitCode !== null ? ` with code ${exited.exitCode}` : ''}
            {exited.signal ? ` (${exited.signal})` : ''}
          </span>
        ) : null}
      </div>
    </div>
  );
}
