import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useBizziContext, useStore } from '../../app/context.tsx';
import { useAction } from '../../app/hooks.ts';
import { SectionTitle } from '../../components/layout.tsx';
import { Badge, Button, Card, ErrorText } from '../../components/ui.tsx';
import { currentSubscription, disableWebPush, enableWebPush, refreshWebPush, webPushSupport } from '../../lib/webPush.ts';

/** Web Push on this device (tech-choices.md D9): approvals, questions, long turns and usage limits. */
export function NotificationSettings(): ReactNode {
  const store = useStore();
  const { target } = useBizziContext();
  const support = webPushSupport();
  const [on, setOn] = useState<boolean | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const request = useCallback<Parameters<typeof enableWebPush>[0]>((method, params) => store.client.request(method, params), [store]);
  const name = target.hub?.name;

  // Re-send an existing subscription so the hub has it (and this device's current URL).
  useEffect(() => {
    if (support !== 'ok' || target.source === 'mock') {
      setOn(false);
      return;
    }
    let live = true;
    void (async () => {
      const sub = await currentSubscription().catch(() => null);
      if (!live) return;
      setOn(sub !== null);
      if (sub) await refreshWebPush(request, name).catch(() => {});
    })();
    return () => {
      live = false;
    };
  }, [support, target.source, request, name]);

  const enable = useAction(async () => {
    await enableWebPush(request, name);
    setOn(true);
    setNote(null);
  });
  const disable = useAction(async () => {
    await disableWebPush(request);
    setOn(false);
    setNote(null);
  });
  const test = useAction(async () => {
    const r = await store.client.request('push.test', {});
    setNote(r.sent > 0 ? 'Test notification sent.' : r.failed > 0 ? 'The push service rejected the test notification.' : 'This device has no subscription on the hub.');
  });

  return (
    <>
      <SectionTitle>Notifications</SectionTitle>
      <Card className="grid gap-3 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1">On this device</span>
          {support !== 'ok' ? <Badge>unavailable</Badge> : on ? <Badge tone="ok">on</Badge> : on === false ? <Badge>off</Badge> : null}
        </div>
        <p className="text-muted">
          {support === 'native'
            ? 'The mobile app uses its own push notifications.'
            : support === 'insecure'
              ? 'Browsers only allow notifications over https (or on localhost). Open bizzi through the hub’s https address.'
              : support === 'unsupported'
                ? 'This browser or app window can’t receive Web Push.'
                : 'Approvals, questions, long turns finishing and usage limits, while you’re away. Approvals get Approve / Deny buttons where the browser supports them.'}
        </p>
        {support === 'ok' && target.source !== 'mock' ? (
          <div className="flex flex-wrap gap-2">
            {on ? (
              <>
                <Button size="sm" icon="send" busy={test.busy} onClick={() => void test.run()}>
                  Send test
                </Button>
                <Button size="sm" variant="ghost" icon="x" busy={disable.busy} onClick={() => void disable.run()}>
                  Turn off
                </Button>
              </>
            ) : (
              <Button size="sm" variant="primary" icon="bolt" busy={enable.busy} disabled={on === null} onClick={() => void enable.run()}>
                Turn on notifications
              </Button>
            )}
          </div>
        ) : null}
        {note ? <p className="text-muted">{note}</p> : null}
        <ErrorText error={enable.error ?? disable.error ?? test.error} />
      </Card>
    </>
  );
}
