import type { ReactNode } from 'react';
import { hotkeyStore, isMac, useHotkeyPrefs } from '../../app/hotkeys.ts';
import { SectionTitle } from '../../components/layout.tsx';
import { Button, Card, Checkbox, Kbd } from '../../components/ui.tsx';
import { HOTKEYS, hotkeyLabel } from '../../lib/hotkeys.ts';
import { updateBridge } from '../../lib/updates.ts';

/** App-wide keyboard shortcuts, switched on or off for this device. */
export function HotkeysSettings(): ReactNode {
  const prefs = useHotkeyPrefs();
  const mac = isMac();
  const desktop = updateBridge() !== undefined;
  const allOn = HOTKEYS.every((h) => prefs[h.id]);
  return (
    <>
      <SectionTitle>Hotkeys</SectionTitle>
      <Card className="divide-y divide-border text-sm">
        {HOTKEYS.map((h) => (
          <div key={h.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 font-medium">
                {h.label}
                <Kbd>{hotkeyLabel(h, mac)}</Kbd>
              </div>
              <p className="mt-0.5 text-xs text-muted">{h.description}</p>
              <p className="mt-0.5 text-[11px] text-muted">
                {hotkeyLabel(h, true)} on macOS · {hotkeyLabel(h, false)} on Windows and Linux
              </p>
            </div>
            <Checkbox checked={prefs[h.id]} onChange={(on) => hotkeyStore.setEnabled(h.id, on)} label="On" />
          </div>
        ))}
      </Card>
      <div className="mt-2 flex flex-wrap items-start gap-3 text-xs text-muted">
        <p className="min-w-0 flex-1">
          Saved on this device.{' '}
          {desktop
            ? 'The File menu lists them too; with a hotkey off, its menu item still works.'
            : 'In a browser tab the browser may keep these keys for itself (new window, new tab, close tab); the desktop app always gets them.'}{' '}
          {mac ? '' : 'Inside a terminal session Ctrl+N, Ctrl+T and Ctrl+W go to the shell.'}
        </p>
        {allOn ? null : (
          <Button size="sm" variant="ghost" onClick={() => hotkeyStore.reset()}>
            Turn all on
          </Button>
        )}
      </div>
    </>
  );
}
