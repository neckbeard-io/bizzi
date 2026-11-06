import type { ReactNode } from 'react';
import { useBizzi, useBizziContext } from '../../app/context.tsx';
import { navigate, useTheme } from '../../app/hooks.ts';
import type { ThemePref } from '../../app/hooks.ts';
import { Page, PageHeader, SectionTitle } from '../../components/layout.tsx';
import { Button, Card, Segmented, Tabs } from '../../components/ui.tsx';
import type { SettingsSection } from '../../lib/router.ts';
import { KnowledgeSettings } from '../knowledge/KnowledgeSettings.tsx';
import { DevicesSettings } from './DevicesSettings.tsx';

export function SettingsView(props: { section: SettingsSection }): ReactNode {
  const hub = useBizzi((s) => s.role === 'hub');
  const items: { value: SettingsSection; label: string }[] = [
    { value: 'general', label: 'General' },
    { value: 'knowledge', label: 'Knowledge' },
  ];
  if (hub) items.push({ value: 'devices', label: 'Devices' });
  const section = props.section === 'devices' && !hub ? 'general' : props.section;
  return (
    <Page header={<PageHeader title="Settings" />}>
      <Tabs<SettingsSection> className="mb-4" value={section} onChange={(s) => navigate({ name: 'settings', section: s }, { replace: true })} items={items} />
      {section === 'general' ? <GeneralSettings /> : section === 'knowledge' ? <KnowledgeSettings /> : <DevicesSettings />}
    </Page>
  );
}

function GeneralSettings(): ReactNode {
  const { target, disconnect } = useBizziContext();
  const conn = useBizzi((s) => s.connection);
  const role = useBizzi((s) => s.role);
  const machine = useBizzi((s) => s.machine);
  const [theme, setTheme] = useTheme();
  return (
    <>
      <SectionTitle>Appearance</SectionTitle>
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <span className="flex-1 text-sm">Theme</span>
        <Segmented<ThemePref>
          value={theme}
          onChange={setTheme}
          items={[
            { value: 'system', label: 'Auto' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </Card>
      <SectionTitle>Connection</SectionTitle>
      <Card className="grid gap-2 p-4 text-sm">
        <Row label="Connected to">{role === 'hub' ? `hub ${machine?.name ?? ''}` : `node ${machine?.name ?? ''}`}</Row>
        <Row label="Endpoint">
          <span className="font-mono text-xs">{target.hub?.hubUrl ?? target.url}</span>
        </Row>
        {target.hub ? (
          <Row label="This device">
            {target.hub.name} <span className="font-mono text-xs text-muted">({target.hub.deviceId})</span>
          </Row>
        ) : null}
        <Row label="Server">{conn.serverVersion ?? '–'}</Row>
        <div className="mt-2">
          <Button size="sm" icon="logout" onClick={disconnect}>
            {target.source === 'mock' ? 'Exit demo' : 'Disconnect'}
          </Button>
        </div>
      </Card>
    </>
  );
}

function Row(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-wrap gap-x-3">
      <span className="w-28 shrink-0 text-muted">{props.label}</span>
      <span className="min-w-0 flex-1 break-words">{props.children}</span>
    </div>
  );
}
