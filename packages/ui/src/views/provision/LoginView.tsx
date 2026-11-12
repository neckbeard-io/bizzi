import { Suspense, lazy, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { LoginState } from '@bizzi/client';
import { useBizzi, useStore } from '../../app/context.tsx';
import { navigate, useAction, useMediaQuery } from '../../app/hooks.ts';
import { useMachine, useMachineOnline } from '../../app/machine.ts';
import { Icon } from '../../components/icons.tsx';
import { PageHeader } from '../../components/layout.tsx';
import { Badge, Button, CopyButton, Empty, ErrorText, Input, Spinner, StatusBadge, cx } from '../../components/ui.tsx';

const TerminalView = lazy(() => import('../session/TerminalView.tsx').then((m) => ({ default: m.TerminalView })));

/**
 * An `agent.login` flow: the CLI runs in a terminal on the target machine; URLs and one-time codes it
 * prints come in as `login.prompt` and become Open link / Copy code buttons, so the OAuth can be finished
 * in this device's browser even when the machine is headless.
 */
export function LoginView(props: { sessionId: string }): ReactNode {
  const { sessionId } = props;
  const store = useStore();
  const session = useBizzi((s) => s.sessions[sessionId] ?? null);
  const sessionsLoaded = useBizzi((s) => s.sessionsLoaded);
  const login = useBizzi((s) => s.timelines[sessionId]?.login ?? null);
  const exit = useBizzi((s) => s.timelines[sessionId]?.terminalExit ?? null);
  const status = useBizzi((s) => s.timelines[sessionId]?.status ?? s.sessions[sessionId]?.status ?? null);
  const prompt = useBizzi((s) => s.timelines[sessionId]?.prompt ?? null);
  const machine = useMachine(session?.machineId);
  const online = useMachineOnline(session?.machineId);
  const side = useMediaQuery('(min-width: 1024px)');
  const [openError, setOpenError] = useState<unknown>(null);

  useEffect(() => {
    setOpenError(null);
    store.openSession(sessionId).catch((e: unknown) => setOpenError(e));
  }, [store, sessionId]);

  const machineId = session?.machineId ?? null;
  const back = (): void => navigate(machineId ? { name: 'machine', machineId } : { name: 'machine' });
  const retry = useAction(async () => {
    if (!session) return;
    const next = await store.loginAgent({ machineId: session.machineId, agent: session.agent });
    navigate({ name: 'login', sessionId: next.id }, { replace: true });
  });
  const done = (): void => {
    if (machineId) void store.loadAgents(machineId, true).catch(() => {});
    back();
  };

  if (!session) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Log in" back={() => navigate({ name: 'machine' })} />
        {openError ? (
          <div className="p-4">
            <ErrorText error={openError} />
          </div>
        ) : sessionsLoaded ? (
          <Empty icon="key" title="Login session not found" />
        ) : (
          <div className="flex flex-1 items-center justify-center text-muted">
            <Spinner />
          </div>
        )}
      </div>
    );
  }

  const helper = (
    <LoginHelper
      sessionId={sessionId}
      agent={session.agent}
      machineName={machine?.name ?? session.machineId}
      login={login}
      exited={exit}
      online={online}
      onDone={done}
      onRetry={() => void retry.run()}
      retrying={retry.busy}
    />
  );
  const terminal = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-panel px-3 text-xs text-muted">
        <Icon name="terminal" size={14} />
        <span className="min-w-0 flex-1 truncate">
          {session.agent} login on {machine?.name ?? session.machineId}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-muted">
              <Spinner />
            </div>
          }
        >
          <TerminalView sessionId={sessionId} />
        </Suspense>
      </div>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={
          <span>
            Log in to <span className="capitalize">{session.agent}</span>
          </span>
        }
        subtitle={`on ${machine?.name ?? session.machineId}`}
        back={back}
        actions={<StatusBadge status={status} prompt={prompt} />}
      />
      <ErrorText error={openError ?? retry.error} className="m-3" />
      {side ? (
        <div className="flex min-h-0 flex-1">
          <aside className="w-[420px] shrink-0 overflow-y-auto border-r border-border bg-bg p-4">{helper}</aside>
          <section className="min-w-0 flex-1">{terminal}</section>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="max-h-[60%] shrink-0 overflow-y-auto border-b border-border bg-bg p-3">{helper}</div>
          <div className="min-h-[240px] flex-1">{terminal}</div>
        </div>
      )}
    </div>
  );
}

function LoginHelper(props: {
  sessionId: string;
  agent: string;
  machineName: string;
  login: LoginState | null;
  exited: { exitCode: number | null; signal?: string } | null;
  online: boolean;
  onDone: () => void;
  onRetry: () => void;
  retrying: boolean;
}): ReactNode {
  const { login, exited } = props;
  const result = login?.result ?? null;

  if (result?.ok) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-ok/40 bg-ok/5 px-4 py-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ok text-white dark:text-black">
          <Icon name="check" size={26} />
        </span>
        <div>
          <div className="text-lg font-semibold">Signed in</div>
          <div className="text-sm text-muted">
            <span className="capitalize">{props.agent}</span> on {props.machineName} is ready{result.account ? ` as ${result.account}` : ''}.
          </div>
          {result.message ? <div className="mt-1 text-xs text-muted">{result.message}</div> : null}
        </div>
        <Button variant="primary" icon="check" onClick={props.onDone}>
          Done
        </Button>
      </div>
    );
  }

  if (result && !result.ok) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-err/40 bg-err/5 p-4">
        <div className="flex items-center gap-2 font-semibold text-err">
          <Icon name="alert" size={18} /> Login failed
        </div>
        {result.message ? <div className="text-sm">{result.message}</div> : null}
        <div className="flex gap-2">
          <Button variant="primary" icon="refresh" busy={props.retrying} disabled={!props.online} onClick={props.onRetry}>
            Try again
          </Button>
          <Button variant="ghost" onClick={props.onDone}>
            Back to machine
          </Button>
        </div>
      </div>
    );
  }

  if (exited) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-warn/40 bg-warn/5 p-4">
        <div className="flex items-center gap-2 font-semibold text-warn">
          <Icon name="alert" size={18} /> The login process exited{exited.exitCode !== null ? ` (code ${exited.exitCode})` : ''}
        </div>
        <div className="text-sm text-muted">Check the terminal output for details.</div>
        <div className="flex gap-2">
          <Button variant="primary" icon="refresh" busy={props.retrying} disabled={!props.online} onClick={props.onRetry}>
            Try again
          </Button>
          <Button variant="ghost" onClick={props.onDone}>
            Back to machine
          </Button>
        </div>
      </div>
    );
  }

  const urls = login?.urls ?? [];
  const codes = login?.codes ?? [];
  if (urls.length === 0 && codes.length === 0 && !login?.awaitingCodeInput) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-panel px-4 py-8 text-center text-sm text-muted">
        <Spinner size={20} />
        <div className="font-medium text-fg">Waiting for the sign-in link…</div>
        <div className="max-w-xs">
          The login runs on {props.machineName}. Links and codes it prints show up here, so you can finish in this device's browser.
        </div>
      </div>
    );
  }

  let n = 0;
  return (
    <div className="flex flex-col gap-4">
      {urls.length > 0 ? (
        <Step n={++n} title="Open the sign-in page" hint="Any browser works, on this device or another one.">
          {urls.map((u) => (
            <div key={u} className="flex flex-col gap-2 rounded-lg border border-border bg-panel p-3">
              <div className="truncate font-mono text-xs text-muted" title={u}>
                {u}
              </div>
              <div className="flex flex-wrap gap-2">
                <a
                  href={u}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:opacity-90"
                >
                  <Icon name="external" size={16} /> Open link
                </a>
                <CopyButton text={u} label="Copy link" size="md" />
              </div>
            </div>
          ))}
        </Step>
      ) : null}
      {codes.length > 0 ? (
        <Step n={++n} title={codes.length > 1 ? 'Enter these codes' : 'Enter this code'} hint="The sign-in page asks for it.">
          {codes.map((c) => (
            <div key={c} className="flex items-center gap-3 rounded-lg border border-border bg-panel p-3">
              <span className="min-w-0 flex-1 truncate font-mono text-2xl font-semibold tracking-[0.15em]">{c}</span>
              <CopyButton text={c} label="Copy code" size="md" variant="primary" />
            </div>
          ))}
        </Step>
      ) : null}
      {login?.awaitingCodeInput ? (
        <Step n={++n} title="Paste the code from the browser" hint="After signing in, the page shows a code for the terminal.">
          <PasteCode sessionId={props.sessionId} disabled={!props.online} />
        </Step>
      ) : (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Spinner size={12} /> Waiting for the sign-in to finish…
        </div>
      )}
      {login?.callbackPort ? (
        <div className="flex items-start gap-1.5 text-xs text-muted">
          <Icon name="link" size={13} className="mt-0.5 shrink-0" />
          <span>
            The CLI waits for a browser redirect to <span className="font-mono">localhost:{login.callbackPort}</span> on {props.machineName}; bizzi forwards it while the login runs.
          </span>
        </div>
      ) : null}
    </div>
  );
}

function Step(props: { n: number; title: string; hint?: string; children: ReactNode }): ReactNode {
  return (
    <section className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-text">{props.n}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div>
          <div className="font-medium">{props.title}</div>
          {props.hint ? <div className="text-xs text-muted">{props.hint}</div> : null}
        </div>
        {props.children}
      </div>
    </section>
  );
}

function PasteCode(props: { sessionId: string; disabled: boolean }): ReactNode {
  const store = useStore();
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const send = useAction(async () => {
    await store.termInput(props.sessionId, `${code.trim()}\r`);
    setSent(true);
    setCode('');
  });
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (code.trim()) void send.run();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <Input
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setSent(false);
          }}
          placeholder="Paste code"
          className={cx('h-10 font-mono')}
          autoComplete="one-time-code"
          spellCheck={false}
          autoCapitalize="off"
          disabled={props.disabled}
        />
        <Button type="submit" variant="primary" icon="send" className="h-10" busy={send.busy} disabled={props.disabled || !code.trim()}>
          Send
        </Button>
      </div>
      {sent ? (
        <div className="flex items-center gap-1.5 text-xs text-muted">
          <Badge tone="info">sent</Badge> Typed into the terminal; waiting for the CLI…
        </div>
      ) : null}
      <ErrorText error={send.error} />
    </form>
  );
}
