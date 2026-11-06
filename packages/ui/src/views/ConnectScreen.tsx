import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Button, Card, ErrorText, Field, Input } from '../components/ui.tsx';
import { MOCK_URL, defaultUrl, normalizeUrl, rememberTarget, savedTarget } from '../lib/connection.ts';
import type { ConnectionTarget } from '../lib/connection.ts';

export function ConnectScreen(props: { error: string | null; onConnect: (t: ConnectionTarget) => void }): ReactNode {
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
    <div className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-5 flex items-center gap-2">
          <Logo />
          <div>
            <div className="text-lg font-semibold">bizzi</div>
            <div className="text-xs text-muted">Connect to a bizzi node or hub</div>
          </div>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field label="Server URL" hint="e.g. ws://127.0.0.1:7777/ws or wss://hub.example.com/ws">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="ws://host:port/ws" autoCapitalize="off" autoCorrect="off" spellCheck={false} required />
          </Field>
          <Field label="Token">
            <Input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="printed by `bizzi serve`" autoComplete="current-password" />
          </Field>
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember on this device
          </label>
          {props.error ? <ErrorText error={props.error} /> : null}
          <Button type="submit" variant="primary" className="mt-1">
            Connect
          </Button>
          <button
            type="button"
            className="text-xs text-muted underline-offset-2 hover:underline"
            onClick={() => {
              const u = new URL(window.location.href);
              u.searchParams.set('mock', '1');
              window.history.replaceState(null, '', u);
              props.onConnect({ url: MOCK_URL, source: 'mock' });
            }}
          >
            Try the demo (mock server)
          </button>
        </form>
      </Card>
    </div>
  );
}

export function Logo(props: { size?: number }): ReactNode {
  const s = props.size ?? 28;
  return (
    <svg width={s} height={s} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--accent)" />
      <path d="M10 8v16h7a4.5 4.5 0 0 0 1.6-8.7A4 4 0 0 0 15.5 8z M13 11h2.5a1.5 1.5 0 0 1 0 3H13z M13 17h3.5a1.8 1.8 0 0 1 0 3.8H13z" fill="var(--accent-fg)" fillRule="evenodd" />
    </svg>
  );
}
