// The phone app's worker: it keeps the app's shell so the page opens with no signal, and is where notifications
// are shown. It never caches an answer from the daemon: a card is only ever as fresh as the connection.
const SHELL = 'tendb-app-shell';
const SHELL_URL = '/app/app.html';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

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
