// bizzi service worker: Web Push notifications (docs/tech-choices.md D9). Plain JS, copied as-is into
// dist/ so it is served next to index.html and its scope covers the app. No fetch handler: nothing is
// cached or intercepted.
//
// A push carries a WebPushPayload (packages/protocol/src/hub.ts). For a single pending approval the
// notification gets Approve / Deny buttons that POST the payload's one-time token to the hub's
// /api/push/action; if that fails (or the browser has no action buttons) a click opens the session.

/* eslint-env serviceworker */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  event.waitUntil(showPush(event.data));
});

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  notification.close();
  event.waitUntil(onClick(event.action, notification.data || {}));
});

function parsePayload(data) {
  let p = null;
  try {
    p = data ? data.json() : null;
  } catch {
    p = null;
  }
  if (!p || typeof p.title !== 'string') {
    let text = '';
    try {
      text = data ? data.text() : '';
    } catch {
      text = '';
    }
    p = { title: 'bizzi', body: text, tag: 'bizzi', url: './' };
  }
  return p;
}

async function showPush(data) {
  const p = parsePayload(data);
  const url = new URL(p.url || './', self.registration.scope).href;
  // Already looking at this session in a focused window: the app shows it, skip the notification.
  if (p.sessionId && (await focusedOn(url))) return;
  const options = {
    body: p.body || '',
    tag: p.tag || 'bizzi',
    renotify: true,
    data: { url, approval: p.approval || null },
    requireInteraction: Boolean(p.approval),
  };
  if (p.approval && Array.isArray(p.approval.options)) {
    const actions = [];
    if (p.approval.options.includes('allow')) actions.push({ action: 'allow', title: 'Approve' });
    if (p.approval.options.includes('deny')) actions.push({ action: 'deny', title: 'Deny' });
    options.actions = actions;
  }
  await self.registration.showNotification(p.title, options);
}

async function focusedOn(url) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windows.some((c) => c.focused && c.visibilityState === 'visible' && c.url === url);
}

async function onClick(action, data) {
  const approval = data.approval;
  if (approval && (action === 'allow' || action === 'deny')) {
    try {
      const res = await fetch(approval.actionUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: approval.token, decision: action }),
      });
      if (res.ok) return;
    } catch {
      // Offline or hub unreachable: open the session instead.
    }
  }
  await openApp(data.url || self.registration.scope);
}

async function openApp(url) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const scope = self.registration.scope;
  const existing = windows.find((c) => c.url.startsWith(scope)) || windows[0];
  if (existing) {
    // The app routes by hash; let it navigate in place (lib/webPush.ts listens for this).
    existing.postMessage({ type: 'bizzi:open', url });
    if (typeof existing.focus === 'function') await existing.focus();
    return;
  }
  await self.clients.openWindow(url);
}
