// Web Push on this device (docs/tech-choices.md D9): register the service worker (public/sw.js),
// subscribe with the hub's VAPID key and hand the subscription to the hub (`push.register`).

import type { MethodName, MethodParams, MethodResult, WebPushSubscription } from '@bizzi/protocol';

type Request = <M extends MethodName>(method: M, params: MethodParams<M>) => Promise<MethodResult<M>>;

export type WebPushSupport = 'ok' | 'insecure' | 'unsupported' | 'native';

/** Whether this runtime can do Web Push at all. */
export function webPushSupport(): WebPushSupport {
  const g = globalThis as { bizziNative?: unknown; isSecureContext?: boolean; location?: Location };
  // The mobile shell gets APNs/FCM through its native bridge instead (apps/mobile, Push).
  if (g.bizziNative) return 'native';
  // Electron has no push service behind PushManager, and file:// pages can't register a worker.
  if (typeof navigator === 'undefined' || /\bElectron\//.test(navigator.userAgent) || !/^https?:$/.test(g.location?.protocol ?? '')) return 'unsupported';
  if (g.isSecureContext === false) return 'insecure';
  if (!('serviceWorker' in navigator) || typeof PushManager === 'undefined' || typeof Notification === 'undefined') return 'unsupported';
  return 'ok';
}

/** base64url (VAPID public key) → bytes for `applicationServerKey`. */
export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(b: ArrayBuffer | null): string {
  if (!b) return '';
  let s = '';
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The subscription's wire shape (what `PushSubscription.toJSON()` gives, built explicitly). */
export function subscriptionJson(sub: PushSubscription): WebPushSubscription {
  return {
    endpoint: sub.endpoint,
    expirationTime: sub.expirationTime,
    keys: { p256dh: bytesToBase64Url(sub.getKey('p256dh')), auth: bytesToBase64Url(sub.getKey('auth')) },
  };
}

function sameKey(sub: PushSubscription, publicKey: string): boolean {
  const k = sub.options?.applicationServerKey;
  return !k || bytesToBase64Url(k) === publicKey;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('./sw.js');
  return navigator.serviceWorker.ready;
}

/** This device's current subscription, if notifications are on. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (webPushSupport() !== 'ok') return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Ask for permission, subscribe with the hub's key and register with the hub. */
export async function enableWebPush(request: Request, name?: string): Promise<PushSubscription> {
  if (webPushSupport() !== 'ok') throw new Error('Notifications need a browser with Web Push over https (or localhost)');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked for this site in the browser settings' : 'Permission not granted');
  const { webPush } = await request('push.config', {});
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // Subscribed with another hub's (or an old) key: start over.
  if (sub && !sameKey(sub, webPush.publicKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(webPush.publicKey) });
  await request('push.register', name ? { subscription: subscriptionJson(sub), name } : { subscription: subscriptionJson(sub) });
  return sub;
}

export async function disableWebPush(request: Request): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await request('push.unregister', { endpoint });
}

/**
 * Re-send an existing subscription to the hub (it may have been dropped, or the hub's URL changed).
 * Returns false when the subscription belongs to another VAPID key and needs `enableWebPush` again.
 */
export async function refreshWebPush(request: Request, name?: string): Promise<boolean> {
  const sub = await currentSubscription();
  if (!sub || Notification.permission !== 'granted') return false;
  const { webPush } = await request('push.config', {});
  if (!sameKey(sub, webPush.publicKey)) return false;
  await request('push.register', name ? { subscription: subscriptionJson(sub), name } : { subscription: subscriptionJson(sub) });
  return true;
}

/** Follow `bizzi:open` messages from the service worker (a notification click on an open window). */
export function listenForNotificationClicks(): void {
  if (webPushSupport() !== 'ok') return;
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as { type?: unknown; url?: unknown } | null;
    if (!m || m.type !== 'bizzi:open' || typeof m.url !== 'string') return;
    const target = new URL(m.url, location.href);
    if (target.origin === location.origin && target.pathname === location.pathname) location.hash = target.hash;
    else location.assign(target.href);
  });
}
