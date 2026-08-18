const CACHE_NAME = 'warriors-hub-v3';
const APP_SHELL = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/crest.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Cache each file independently rather than cache.addAll(), which
      // fails the ENTIRE install if even one URL 404s. That's exactly what
      // happened with the old /logo.png entry — a single missing file was
      // silently breaking the service worker for everyone.
      Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn('sw: failed to precache', url, err))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept page navigations. Cloudflare redirects clean URLs
  // (e.g. /fines.html -> /fines), and caching or replaying a redirected
  // response for a navigation request causes ERR_FAILED in Chrome/Safari.
  // Letting these go straight to the network avoids that entirely.
  if (event.request.mode === 'navigate') {
    return;
  }

  // Never cache API calls — fines, tally, fixtures, and payment info must
  // always come from the network so everyone sees live, shared data.
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          // Skip caching redirected or non-OK responses.
          if (response && response.status === 200 && !response.redirected) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
