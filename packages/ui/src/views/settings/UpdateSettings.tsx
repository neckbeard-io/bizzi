import type { ReactNode } from 'react';
import { SectionTitle } from '../../components/layout.tsx';
import { Badge, Button, Card, Checkbox, ProgressBar, Segmented } from '../../components/ui.tsx';
import { formatBytes, updateBridge, useUpdates, type UpdateAction, type UpdateChannel, type UpdateState } from '../../lib/updates.ts';
import { Markdown } from '../session/Markdown.tsx';

/** Settings › Updates (desktop app only): channel, background checks, and the update on offer. */
export function UpdateSettings(): ReactNode {
  const s = useUpdates();
  if (!s) return null;
  const act = (a: UpdateAction) => void updateBridge()?.act(a);
  const busy = s.stage === 'checking' || s.stage === 'downloading' || s.stage === 'installing';
  return (
    <>
      <SectionTitle>Updates</SectionTitle>
      <Card className="grid gap-3 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1">
            bizzi <span className="font-mono">v{s.currentVersion}</span>
          </span>
          <Badge>{s.methodLabel}</Badge>
        </div>
        {s.hint ? <p className="text-muted">{s.hint}</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-28 shrink-0 text-muted">Channel</span>
          <Segmented<UpdateChannel>
            size="sm"
            value={s.channel}
            onChange={(channel) => act({ type: 'channel', channel })}
            items={[
              { value: 'stable', label: 'Stable' },
              { value: 'dev', label: 'Dev' },
            ]}
          />
          <span className="text-xs text-muted">{s.channel === 'stable' ? 'Tested releases (recommended)' : 'Every pre-release from the dev branch'}</span>
        </div>
        <Checkbox checked={s.autoCheck} onChange={(enabled) => act({ type: 'autoCheck', enabled })} label="Check for updates automatically" />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon="refresh" busy={s.stage === 'checking'} disabled={busy} onClick={() => act({ type: 'check' })}>
            Check now
          </Button>
          <span className="text-xs text-muted">{statusLine(s)}</span>
        </div>
      </Card>
      {s.latest && s.stage !== 'up-to-date' && s.stage !== 'idle' ? <Offer s={s} act={act} /> : null}
    </>
  );
}

function Offer(props: { s: UpdateState; act: (a: UpdateAction) => void }): ReactNode {
  const { s, act } = props;
  const latest = s.latest!;
  const p = s.progress;
  return (
    <Card className="mt-3 grid gap-3 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 font-medium">
          v{s.currentVersion} → v{latest.version}
        </span>
        {latest.prerelease ? <Badge tone="warn">dev build</Badge> : null}
        <a className="text-xs text-accent hover:underline" href={latest.url} target="_blank" rel="noreferrer">
          Release page
        </a>
      </div>
      <div className="scrollbar-thin max-h-72 overflow-y-auto rounded-md border border-border bg-panel-2/40 px-3 py-2">
        <Markdown text={latest.notes || 'Bug fixes and improvements.'} />
      </div>
      {s.stage === 'downloading' && p ? (
        <div className="grid gap-1">
          <ProgressBar value={p.total > 0 ? p.received / p.total : null} />
          <span className="text-xs text-muted">
            {formatBytes(p.received)} of {formatBytes(p.total)}
          </span>
        </div>
      ) : null}
      {s.error && s.stage === 'error' ? <p className="text-err">{s.error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {s.stage === 'downloading' ? (
          <Button size="sm" variant="ghost" icon="x" onClick={() => act({ type: 'cancel' })}>
            Cancel
          </Button>
        ) : s.stage === 'ready' || s.stage === 'installing' ? (
          <Button size="sm" variant="primary" icon="refresh" busy={s.stage === 'installing'} onClick={() => act({ type: 'install' })}>
            {s.method === 'deb' ? 'Open installer' : 'Restart and update'}
          </Button>
        ) : s.asset ? (
          <Button size="sm" variant="primary" icon="download" onClick={() => act({ type: 'download' })}>
            Download ({formatBytes(s.asset.size)})
          </Button>
        ) : (
          <a className="text-accent hover:underline" href={latest.url} target="_blank" rel="noreferrer">
            Download it from the release page
          </a>
        )}
        {s.stage === 'available' || s.stage === 'error' ? (
          <Button size="sm" variant="ghost" onClick={() => act({ type: 'skip' })}>
            Skip this version
          </Button>
        ) : null}
      </div>
      {s.stage === 'ready' && s.method !== 'deb' ? <p className="text-xs text-muted">bizzi quits, its core finishes what it's doing, and the new version opens.</p> : null}
    </Card>
  );
}

function statusLine(s: UpdateState): string {
  const when = s.lastCheckedAt ? ` · checked ${new Date(s.lastCheckedAt).toLocaleString()}` : '';
  switch (s.stage) {
    case 'checking':
      return 'Checking GitHub…';
    case 'up-to-date':
      return `Up to date${when}`;
    case 'error':
      return s.latest ? when.slice(3) : (s.error ?? 'Update check failed');
    case 'idle':
      return s.skippedVersion && s.latest?.version === s.skippedVersion ? `v${s.skippedVersion} skipped${when}` : when.slice(3);
    default:
      return s.latest ? `v${s.latest.version} available${when}` : when.slice(3);
  }
}
