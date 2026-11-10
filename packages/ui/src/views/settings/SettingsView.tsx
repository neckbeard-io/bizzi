import type { ReactNode } from 'react';
import { useBizzi, useBizziContext } from '../../app/context.tsx';
import { navigate } from '../../app/hooks.ts';
import { Page, PageHeader, SectionTitle } from '../../components/layout.tsx';
import { Button, Card, Tabs } from '../../components/ui.tsx';
import type { SettingsSection } from '../../lib/router.ts';
import { KnowledgeSettings } from '../knowledge/KnowledgeSettings.tsx';
import { AppearanceSettings } from './AppearanceSettings.tsx';
import { DevicesSettings } from './DevicesSettings.tsx';

/**
 * App-level settings only (the gear in the sidebar header): appearance, knowledge, devices (hub), connection.
 * Machine-scoped settings (agents and their policies, API keys, widgets, agent-to-agent limits) are on each
 * machine's page.
 */
export function SettingsView(props: { section: SettingsSection }): ReactNode {
  const hub = useBizzi((s) => s.role === 'hub');
  const items: { value: SettingsSection; label: string }[] = [
    { value: 'general', label: 'Appearance' },
    { value: 'knowledge', label: 'Knowledge' },
  ];
  if (hub) items.push({ value: 'devices', label: 'Devices' });
  items.push({ value: 'connection', label: 'Connection' });
  const section = props.section === 'devices' && !hub ? 'general' : props.section;
  return (
    <Page header={<PageHeader title="Settings" subtitle="For the whole app; machine settings are on each machine's page" />}>
      <Tabs<SettingsSection> className="mb-4" value={section} onChange={(s) => navigate({ name: 'settings', section: s }, { replace: true })} items={items} />
      {section === 'general' ? <AppearanceSettings /> : section === 'knowledge' ? <KnowledgeSettings /> : section === 'devices' ? <DevicesSettings /> : <ConnectionSettings />}
    </Page>
  );
}

function ConnectionSettings(): ReactNode {
  const { target, disconnect } = useBizziContext();
  const conn = useBizzi((s) => s.connection);
  const role = useBizzi((s) => s.role);
  const machine = useBizzi((s) => s.machine);
  return (
    <>
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
