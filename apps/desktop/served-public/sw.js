// The phone app's worker: it keeps the app's shell so the page opens with no signal, and is where notifications
// are shown. It never caches an answer from the daemon: a card is only ever as fresh as the connection.
const SHELL = 'tendb-app-shell';
const SHELL_URL = '/app/app.html';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([self.clients.claim(), pruneAssets()]));
});

// Hashed files of an earlier build are never asked for again, so they are dropped instead of piling up.
async function pruneAssets() {
  const cache = await caches.open(SHELL);
  for (const request of await cache.keys()) {
    if (new URL(request.url).pathname.startsWith('/app/assets/')) await cache.delete(request);
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (
    request.mode === 'navigate' &&
    url.pathname.startsWith('/app/') &&
    url.pathname !== '/app/pair'
  ) {
    // The page itself comes from the network, so a new build is seen at once; the kept copy is for no signal.
    event.respondWith(
      fetch(request).then(
        async (response) => {
          if (response.ok) (await caches.open(SHELL)).put(SHELL_URL, response.clone());
          return response;
        },
        async () => (await caches.match(SHELL_URL)) ?? Response.error(),
      ),
    );
    return;
  }
  if (url.pathname.startsWith('/app/assets/')) {
    // Hashed files never change, so one kept is as good as a fresh one.
    event.respondWith(
      caches.match(request).then(
        (kept) =>
          kept ??
          fetch(request).then(async (response) => {
            if (response.ok) (await caches.open(SHELL)).put(request, response.clone());
            return response;
          }),
      ),
    );
  }
});

// What a lock screen may show: the card's kind and its headline (the daemon sends nothing else).
const KIND_TITLES = {
  question: 'A question needs you',
  permission: 'A permission needs you',
  proposal: 'A proposal needs you',
  review: 'A review needs you',
  flag: 'Something needs a look',
  check: 'A check needs you',
  plan: 'A plan needs you',
};
const CARD_ID = /^[A-Za-z0-9_-]{1,80}$/;

self.addEventListener('push', (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  const kind = payload && typeof payload.kind === 'string' ? payload.kind : '';
  const headline = payload && typeof payload.headline === 'string' ? payload.headline : '';
  const id = payload && typeof payload.inboxItemId === 'string' ? payload.inboxItemId : '';
  event.waitUntil(
    self.registration.showNotification(KIND_TITLES[kind] ?? 'Something needs you', {
      body: headline,
      icon: '/app/icons/icon-192.png',
      // One notification per card: a second push for the same card replaces the first.
      tag: CARD_ID.test(id) ? id : 'tendb',
      data: { id: CARD_ID.test(id) ? id : null },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.id;
  const target = id ? `/app/inbox/${id}` : '/app/inbox';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).pathname.startsWith('/app/'));
      if (open) {
        // A window that can't be navigated (it is not ours any more) gives way to a new one.
        return open.navigate(target).then(
          (w) => w && w.focus(),
          () => self.clients.openWindow(target),
        );
      }
      return self.clients.openWindow(target);
    }),
  );
});

// The push service rotated the subscription. The worker can subscribe again with the same key, but the device token
// lives in the page's storage, which a worker cannot read, so the Mac hears of the new one when the app next runs
// (it puts whatever subscription the browser holds when it starts, and a page already open is told now).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const key = event.oldSubscription && event.oldSubscription.options.applicationServerKey;
      if (key) {
        await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        });
      }
      for (const client of await self.clients.matchAll({ type: 'window' })) {
        client.postMessage({ type: 'push-resync' });
      }
    })(),
  );
});
