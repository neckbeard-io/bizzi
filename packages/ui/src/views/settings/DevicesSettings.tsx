import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { DeviceInfo, DeviceKind, MethodResult } from '@bizzi/protocol';
import { useBizzi, useBizziContext, useStore } from '../../app/context.tsx';
import { useAction, useNow } from '../../app/hooks.ts';
import { Icon } from '../../components/icons.tsx';
import { PresenceDot } from '../../components/MachineSwitcher.tsx';
import { QrCode } from '../../components/QrCode.tsx';
import { SectionTitle } from '../../components/layout.tsx';
import { Badge, Button, Card, CopyButton, Empty, ErrorText, Field, Input, Modal, Spinner, cx } from '../../components/ui.tsx';
import { formatCountdown, formatRelative } from '../../lib/format.ts';
import { formatPairingCode } from '../../lib/qr.ts';

/** Hub devices: who can reach this hub (phones, browsers, desktop apps) and which machines serve it. */
export function DevicesSettings(): ReactNode {
  const store = useStore();
  const { deviceId, target } = useBizziContext();
  const devices = useBizzi((s) => s.devices);
  const machines = useBizzi((s) => s.machines);
  // `?mock=1&demo=pair` opens the pairing dialog straight away (demos, screenshots).
  const demo = target.mock?.demo.includes('pair') ?? false;
  const [pairing, setPairing] = useState<DeviceKind | null>(demo ? 'device' : null);
  const reload = useAction(() => store.loadDevices());

  const { people, nodes } = useMemo(() => {
    const list = Object.values(devices ?? {}).sort((a, b) => {
      if (a.id === deviceId) return -1;
      if (b.id === deviceId) return 1;
      if (!!a.revoked !== !!b.revoked) return a.revoked ? 1 : -1;
      return (b.lastSeenAt ?? b.createdAt).localeCompare(a.lastSeenAt ?? a.createdAt);
    });
    return { people: list.filter((d) => d.kind === 'device'), nodes: list.filter((d) => d.kind === 'node') };
  }, [devices, deviceId]);

  return (
    <>
      <SectionTitle
        actions={
          <>
            <Button size="sm" variant="ghost" icon="refresh" busy={reload.busy} onClick={() => void reload.run()}>
              Refresh
            </Button>
            <Button size="sm" variant="primary" icon="phone" onClick={() => setPairing('device')}>
              Pair new device
            </Button>
          </>
        }
      >
        Devices
      </SectionTitle>
      <ErrorText error={reload.error} />
      {devices === null ? (
        <div className="flex justify-center py-6 text-muted">
          <Spinner />
        </div>
      ) : people.length === 0 ? (
        <Empty icon="phone" title="No devices" />
      ) : (
        <Card className="divide-y divide-border">
          {people.map((d) => (
            <DeviceRow key={d.id} device={d} self={d.id === deviceId} />
          ))}
        </Card>
      )}

      <SectionTitle
        actions={
          <Button size="sm" icon="machine" onClick={() => setPairing('node')}>
            Pair new machine
          </Button>
        }
      >
        Machines
      </SectionTitle>
      {devices !== null && nodes.length === 0 ? (
        <Empty icon="machine" title="No machines paired">
          Pair a machine running <span className="font-mono">bizzi serve</span> so you can work on it from anywhere.
        </Empty>
      ) : (
        <Card className="divide-y divide-border">
          {nodes.map((d) => (
            <DeviceRow key={d.id} device={d} self={false} online={d.machineId ? (machines[d.machineId]?.online ?? false) : undefined} />
          ))}
        </Card>
      )}
      <p className="mt-3 text-xs text-muted">
        Each device holds its own key; revoking one signs it out everywhere at once. Sessions keep running on their machines.
      </p>
      {pairing ? <PairingModal kind={pairing} autoCreate={demo} onClose={() => setPairing(null)} /> : null}
    </>
  );
}

function DeviceRow(props: { device: DeviceInfo; self: boolean; online?: boolean | undefined }): ReactNode {
  const store = useStore();
  const d = props.device;
  const revoke = useAction(() => store.revokeDevice(d.id));
  return (
    <div className={cx('flex flex-wrap items-center gap-3 px-4 py-3', d.revoked && 'opacity-60')}>
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-panel-2 text-muted">
        <Icon name={d.kind === 'node' ? 'machine' : 'phone'} size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {props.online !== undefined ? <PresenceDot online={props.online} /> : null}
          <span className={cx('truncate font-medium', d.revoked && 'line-through')}>{d.name}</span>
          {props.self ? <Badge tone="accent">this device</Badge> : null}
          {d.owner ? <Badge>owner</Badge> : null}
          {d.revoked ? <Badge tone="err">revoked</Badge> : null}
        </div>
        <div className="truncate text-xs text-muted">
          paired {formatRelative(d.createdAt)}
          {d.lastSeenAt ? ` · last seen ${formatRelative(d.lastSeenAt)}` : ''}
          {d.machineId ? <span className="font-mono"> · {d.machineId}</span> : null}
        </div>
        <ErrorText error={revoke.error} className="mt-1" />
      </div>
      {!d.revoked && !props.self ? (
        <Button
          size="sm"
          variant="ghost"
          icon="x"
          busy={revoke.busy}
          onClick={() => {
            if (window.confirm(`Revoke "${d.name}"? It loses access to this hub immediately and must be paired again.`)) void revoke.run();
          }}
        >
          Revoke
        </Button>
      ) : null}
    </div>
  );
}

type Pairing = MethodResult<'pairing.create'>;

/** Create a one-time code and show it as text, QR (of the pairUrl) and link. */
function PairingModal(props: { kind: DeviceKind; autoCreate?: boolean; onClose: () => void }): ReactNode {
  const store = useStore();
  const [name, setName] = useState('');
  const [pairing, setPairing] = useState<{ result: Pairing; at: string } | null>(null);
  const create = useAction(async () => {
    const at = new Date().toISOString();
    const result = await store.createPairing(props.kind, name.trim() || undefined);
    setPairing({ result, at });
  });
  const paired = useBizzi((s) => {
    if (!pairing) return null;
    return Object.values(s.devices ?? {}).find((d) => d.kind === props.kind && d.createdAt >= pairing.at && !d.revoked) ?? null;
  });
  const now = useNow(1000, pairing !== null && paired === null);
  const { autoCreate } = props;
  const run = create.run;
  useEffect(() => {
    if (autoCreate) void run();
    // Once, on open.
  }, []);
  const remaining = pairing ? Math.max(0, Date.parse(pairing.result.expiresAt) - now) : 0;
  const expired = pairing !== null && remaining === 0;
  const isNode = props.kind === 'node';

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    void create.run();
  };

  return (
    <Modal
      title={isNode ? 'Pair a new machine' : 'Pair a new device'}
      onClose={props.onClose}
      footer={
        pairing ? (
          <>
            {expired && !paired ? (
              <Button icon="refresh" onClick={() => void create.run()} busy={create.busy}>
                New code
              </Button>
            ) : null}
            <Button variant={paired ? 'primary' : 'secondary'} onClick={props.onClose}>
              {paired ? 'Done' : 'Close'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="pairing-form" busy={create.busy}>
              Create code
            </Button>
          </>
        )
      }
    >
      {!pairing ? (
        <form id="pairing-form" onSubmit={submit} className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            {isNode
              ? 'Creates a one-time code. On the new machine, run bizzi pair with the hub URL and this code; the machine then dials the hub and shows up under Machines.'
              : 'Creates a one-time code. Scan the QR code with the bizzi app on the new device, open the link in its browser, or type the code on its connect screen.'}
          </p>
          <Field label="Name (optional)" hint={isNode ? 'e.g. mac-mini, gpu-box' : 'e.g. Work phone'}>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder={isNode ? 'machine name' : 'device name'} />
          </Field>
          <ErrorText error={create.error} />
        </form>
      ) : paired ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-ok/15 text-ok">
            <Icon name="check" size={26} />
          </div>
          <div className="font-medium">{paired.name} is paired</div>
          <div className="text-sm text-muted">{isNode ? 'It appears under Machines once its node connects.' : 'It can now reach this hub.'}</div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className={cx('rounded-lg border border-border bg-white p-2', expired && 'opacity-30')}>
            <QrCode value={pairing.result.pairUrl} size={200} title="Pairing QR code" />
          </div>
          <div className="text-center">
            <div className="text-[11px] font-medium tracking-wide text-muted uppercase">Pairing code</div>
            <div className={cx('font-mono text-3xl font-semibold tracking-[0.15em] select-all', expired && 'text-muted line-through')}>{formatPairingCode(pairing.result.code)}</div>
            <div className={cx('mt-1 text-xs', expired ? 'text-err' : 'text-muted')}>{expired ? 'Expired' : `Expires in ${formatCountdown(remaining)}`}</div>
          </div>
          <div className="flex w-full min-w-0 items-center gap-2 rounded-md border border-border bg-panel-2 px-2 py-1.5">
            <Icon name="link" size={14} className="shrink-0 text-muted" />
            <a href={pairing.result.pairUrl} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate font-mono text-xs text-accent-text hover:underline">
              {pairing.result.pairUrl}
            </a>
            <CopyButton text={pairing.result.pairUrl} label="Copy link" />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner size={12} /> Waiting for the {isNode ? 'machine' : 'device'} to pair…
          </div>
          <ErrorText error={create.error} />
        </div>
      )}
    </Modal>
  );
}
