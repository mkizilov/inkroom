/* global self, caches, fetch */
// Keeps the web app's own files, so the page can open without a connection once it has loaded
// online. API responses are never cached: board content is kept by the app in IndexedDB instead.
// See docs/offline.md.

const CACHE = 'inkroom-shell-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  ) {
    return;
  }
  event.respondWith(networkFirst(event.request));
});

// Asks the network first, so an online page always gets the latest files. A successful response is
// kept for when the network is gone. Every page navigation shares one entry, because each route of
// the single-page app is served the same HTML.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const key = request.mode === 'navigate' ? '/' : request;
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(key, response.clone()).catch(() => undefined);
    }
    return response;
  } catch (error) {
    const cached = await cache.match(key);
    if (cached) {
      return cached;
    }
    throw error;
  }
}
