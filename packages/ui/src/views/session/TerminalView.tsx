import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { useBizzi, useStore } from '../../app/context.tsx';
import { themeStore, useResolvedTheme } from '../../app/theme.ts';
import { xtermTheme } from '../../lib/theme/terminal.ts';

function wantsWebgl(): boolean {
  if (new URLSearchParams(location.search).get('term') === 'webgl') return true;
  try {
    return localStorage.getItem('bizzi.term.renderer') === 'webgl';
  } catch {
    return false;
  }
}

/**
 * Terminal-mode session (and login PTYs): xterm.js, colored with the theme's terminal palette
 * (derived from its UI colors when it has none). Output comes straight from the client's
 * TerminalStreams (never through the React store); keystrokes go out as term.input, size as term.resize.
 */
export function TerminalView(props: { sessionId: string }): ReactNode {
  const { sessionId } = props;
  const store = useStore();
  const theme = useResolvedTheme().terminal;
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const exited = useBizzi((s) => s.timelines[sessionId]?.terminalExit ?? null);
  const status = useBizzi((s) => s.timelines[sessionId]?.status ?? s.sessions[sessionId]?.status);
  const [renderer, setRenderer] = useState<'webgl' | 'dom'>('dom');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      // No CSS-only generic keywords (ui-monospace): the WebGL renderer draws its glyph atlas with
      // canvas `ctx.font`, which rejects them and falls back to 10px sans-serif (tiny, widely spaced text).
      fontFamily: "'SF Mono', Menlo, Monaco, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: false,
      theme: xtermTheme(themeStore.get().resolved.terminal),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // Renderer: DOM by default. With @xterm/xterm 6.0.0 + @xterm/addon-webgl 0.19.0 in Electron 45 /
    // Chromium 156 (2x display) the WebGL glyph atlas rasterizes glyphs at roughly the canvas default
    // font size: cell metrics are right but glyphs are tiny, so text looks widely spaced. Font stack,
    // fonts-ready and fit ordering were ruled out. Opt in with `?term=webgl` or
    // localStorage `bizzi.term.renderer = 'webgl'` to re-test after upgrading xterm.
    const forceDom = !wantsWebgl();
    let disposed = false;
    let webgl: WebglAddon | undefined;
    const attachWebgl = () => {
      if (disposed || forceDom) return;
      try {
        webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl?.dispose();
          webgl = undefined;
          setRenderer('dom');
        });
        term.loadAddon(webgl);
        setRenderer('webgl');
      } catch {
        webgl = undefined;
        setRenderer('dom');
      }
    };
    const fontsReady: Promise<unknown> = document.fonts?.ready ?? Promise.resolve();
    void fontsReady.then(() => requestAnimationFrame(attachWebgl));
    const dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onDprChange = () => webgl && term.clearTextureAtlas();
    dprQuery.addEventListener('change', onDprChange);

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
      disposed = true;
      dprQuery.removeEventListener('change', onDprChange);
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
    if (t) t.options.theme = xtermTheme(theme);
  }, [theme]);

  return (
    <div className="flex h-full flex-col bg-panel">
      <div ref={hostRef} className="term-host min-h-0 flex-1 overflow-hidden" style={{ background: theme.background }} />
      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border px-3 text-[11px] text-muted">
        <span>{renderer === 'webgl' ? 'WebGL renderer' : 'DOM renderer'}</span>
        {exited ? (
          <span className="text-warn">
            Process exited{exited.exitCode !== null ? ` with code ${exited.exitCode}` : ''}
            {exited.signal ? ` (${exited.signal})` : ''}
            {status !== 'ended' ? ' · press a key to start it again' : ''}
          </span>
        ) : null}
      </div>
    </div>
  );
}
