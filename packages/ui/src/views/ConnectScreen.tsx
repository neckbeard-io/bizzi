import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { getNative, hubHttpBase, pairWithHub, parsePairLink } from '@bizzi/client';
import type { FetchLike } from '@bizzi/client';
import { useAction } from '../app/hooks.ts';
import { Icon } from '../components/icons.tsx';
import type { IconName } from '../components/icons.tsx';
import { Button, Card, ErrorText, Field, Input, cx } from '../components/ui.tsx';
import {
  MOCK_HUB_URL,
  MOCK_URL,
  defaultDeviceName,
  defaultHubUrl,
  defaultUrl,
  forgetHub,
  hubTarget,
  isMockHub,
  normalizeUrl,
  rememberHub,
  rememberMode,
  rememberTarget,
  savedHub,
  savedTarget,
} from '../lib/connection.ts';
import type { ConnectionTarget } from '../lib/connection.ts';
import { formatPairingCode } from '../lib/qr.ts';

type Mode = 'local' | 'hub' | 'node';

/** First screen: this computer (desktop app), a hub (pair with a code or QR), or a node URL + token. */
export function ConnectScreen(props: { error: string | null; pairCode?: string | null; onConnect: (t: ConnectionTarget) => void }): ReactNode {
  const local = window.bizzi?.connection;
  const [hub, setHub] = useState(savedHub);
  const [mode, setMode] = useState<Mode>(() => (props.pairCode || !local ? 'hub' : 'local'));

  const connectLocal = (): void => {
    if (!local) return;
    rememberMode('local');
    props.onConnect(local.token === undefined ? { url: local.url, source: 'electron' } : { url: local.url, token: local.token, source: 'electron' });
  };

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-md p-6">
        <div className="mb-5 flex items-center gap-2">
          <Logo />
          <div>
            <div className="text-lg font-semibold">bizzi</div>
            <div className="text-xs text-muted">Your coding agents, on your machines, from anywhere</div>
          </div>
        </div>

        <div className={cx('mb-4 grid gap-2', local ? 'grid-cols-2' : 'grid-cols-1')}>
          {local ? <ModeTile icon="machine" title="This computer" subtitle="The node in this app" active={mode === 'local'} onClick={() => setMode('local')} /> : null}
          <ModeTile icon="link" title="Hub" subtitle="All your machines" active={mode === 'hub'} onClick={() => setMode('hub')} />
        </div>

        {props.error ? <ErrorText error={props.error} className="mb-3" /> : null}

        {mode === 'local' && local ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">Work with the agents on this computer. No pairing needed; the app talks to its own node.</p>
            <Button variant="primary" onClick={connectLocal}>
              Open this computer
            </Button>
          </div>
        ) : mode === 'node' ? (
          <NodeForm onConnect={props.onConnect} />
        ) : hub && !props.pairCode ? (
          <SavedHub
            hubUrl={hub.hubUrl}
            name={hub.name}
            onConnect={() => {
              rememberMode('hub');
              props.onConnect(hubTarget(hub));
            }}
            onForget={() => {
              forgetHub();
              setHub(null);
            }}
          />
        ) : (
          <PairForm
            initialCode={props.pairCode ?? ''}
            onPaired={(creds) => {
              rememberHub(creds);
              props.onConnect(hubTarget(creds));
            }}
          />
        )}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted">
          {mode !== 'node' ? (
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => setMode('node')}>
              Connect to a node with a token
            </button>
          ) : (
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => setMode(local ? 'local' : 'hub')}>
              Back
            </button>
          )}
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => {
              const u = new URL(window.location.href);
              u.searchParams.set('mock', '1');
              window.history.replaceState(null, '', u);
              props.onConnect({ url: MOCK_URL, source: 'mock', mock: { role: 'hub', demo: [] } });
            }}
          >
            Try the demo
          </button>
        </div>
      </Card>
    </div>
  );
}

function ModeTile(props: { icon: IconName; title: string; subtitle: string; active: boolean; onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      className={cx(
        'flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
        props.active ? 'border-accent bg-accent-soft' : 'border-border hover:bg-panel-2',
      )}
    >
      <Icon name={props.icon} size={20} className={props.active ? 'text-accent' : 'text-muted'} />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{props.title}</span>
        <span className="block truncate text-xs text-muted">{props.subtitle}</span>
      </span>
    </button>
  );
}

function SavedHub(props: { hubUrl: string; name: string; onConnect: () => void; onForget: () => void }): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-panel-2 px-3 py-2.5">
        <Icon name="lock" size={18} className="shrink-0 text-ok" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{props.hubUrl}</div>
          <div className="truncate text-xs text-muted">Paired as “{props.name}”</div>
        </div>
      </div>
      <Button variant="primary" onClick={props.onConnect}>
        Connect to hub
      </Button>
      <button
        type="button"
        className="text-xs text-muted underline-offset-2 hover:underline"
        onClick={() => {
          if (window.confirm('Forget this hub? This device will need a new pairing code to connect again.')) props.onForget();
        }}
      >
        Forget this hub and pair again
      </button>
    </div>
  );
}

async function hubFetch(hubUrl: string): Promise<FetchLike | undefined> {
  if (!isMockHub(hubUrl)) return undefined;
  const mock = await import('../mock/index.ts');
  return mock.createMockHubFetch(mock.sharedMockHub());
}

function PairForm(props: { initialCode: string; onPaired: (creds: Awaited<ReturnType<typeof pairWithHub>>) => void }): ReactNode {
  const native = getNative();
  const [hubUrl, setHubUrl] = useState(() => defaultHubUrl(window.location));
  const [code, setCode] = useState(props.initialCode ? formatPairingCode(props.initialCode) : '');
  const [name, setName] = useState(() => defaultDeviceName(navigator.userAgent, native?.platform));
  const [scanError, setScanError] = useState<string | null>(null);

  const pair = useAction(async () => {
    const base = hubHttpBase(hubUrl);
    const fetch = await hubFetch(base);
    const creds = await pairWithHub({ hubUrl: base, code, name, ...(fetch ? { fetch } : {}) });
    props.onPaired(creds);
  });

  /** Accept a pasted or scanned pairing link in either field. */
  const applyLink = (text: string): boolean => {
    const link = parsePairLink(text);
    if (!link || (!link.hubUrl && !/[:/]/.test(text))) return false;
    if (link.hubUrl) setHubUrl(link.hubUrl);
    setCode(formatPairingCode(link.code));
    return true;
  };

  const scan = async (): Promise<void> => {
    setScanError(null);
    try {
      const text = await native?.scanQr();
      if (text && !applyLink(text)) setScanError('That QR code is not a bizzi pairing code.');
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    }
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    void pair.run();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {native ? (
        <Button icon="scan" onClick={() => void scan()}>
          Scan the pairing QR code
        </Button>
      ) : null}
      {scanError ? <ErrorText error={scanError} /> : null}
      <Field label="Hub URL" hint="Where your hub is reachable, e.g. https://bizzi.example.com">
        <Input
          value={hubUrl}
          onChange={(e) => {
            if (!applyLink(e.target.value)) setHubUrl(e.target.value);
          }}
          placeholder="https://bizzi.example.com"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
          required
        />
      </Field>
      <Field label="Pairing code" hint="From another paired device (Settings → Devices), or the hub's setup code on first start">
        <Input
          value={code}
          onChange={(e) => {
            if (!applyLink(e.target.value)) setCode(e.target.value.toUpperCase());
          }}
          placeholder="XXXX-XXXX"
          className="font-mono tracking-widest"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="one-time-code"
          required
        />
      </Field>
      <Field label="Name for this device">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Work phone" />
      </Field>
      <ErrorText error={pair.error} />
      <Button type="submit" variant="primary" busy={pair.busy} disabled={!hubUrl.trim() || !code.trim()}>
        Pair and connect
      </Button>
      <p className="text-center text-[11px] text-muted">
        This device creates its own key; the hub only learns the public half. Demo hub: <span className="font-mono">{MOCK_HUB_URL}</span>, code{' '}
        <span className="font-mono">DEMO-1234</span>.
      </p>
    </form>
  );
}

function NodeForm(props: { onConnect: (t: ConnectionTarget) => void }): ReactNode {
  const saved = savedTarget();
  const [url, setUrl] = useState(saved?.url ?? defaultUrl(window.location));
  const [token, setToken] = useState(saved?.token ?? '');
  const [remember, setRemember] = useState(true);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const u = normalizeUrl(url);
    if (!u) return;
    const t: ConnectionTarget = token ? { url: u, token, source: 'manual' } : { url: u, source: 'manual' };
    if (remember) rememberTarget(t);
    props.onConnect(t);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Field label="Node URL" hint="e.g. ws://127.0.0.1:7777/ws">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="ws://host:port/ws" autoCapitalize="off" autoCorrect="off" spellCheck={false} required />
      </Field>
      <Field label="Token">
        <Input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="printed by `bizzi serve`" autoComplete="current-password" />
      </Field>
      <label className="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-[var(--primary)]" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember on this device
      </label>
      <Button type="submit" variant="primary" className="mt-1">
        Connect
      </Button>
    </form>
  );
}

export function Logo(props: { size?: number }): ReactNode {
  const s = props.size ?? 28;
  return (
    <svg width={s} height={s} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--primary)" />
      <path d="M10 8v16h7a4.5 4.5 0 0 0 1.6-8.7A4 4 0 0 0 15.5 8z M13 11h2.5a1.5 1.5 0 0 1 0 3H13z M13 17h3.5a1.8 1.8 0 0 1 0 3.8H13z" fill="var(--primary-foreground)" fillRule="evenodd" />
    </svg>
  );
}
