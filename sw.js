/* The Mini — service worker.

   The app already generates puzzles on the client and caches its word bank in
   localStorage, so nothing but the shell stands between it and working fully
   offline. This caches that shell.

   Strategy:
     app shell  — cache-first, refreshed in the background (stale-while-revalidate)
     /api/*     — never cached; the network is the only source of truth
     navigation — falls back to the cached index.html when offline

   Bump CACHE_VERSION whenever shell assets change, or clients keep the old
   copy until their cache is evicted.

   CACHE_VERSION alone is not enough: bumping it only forces *this* service
   worker to refetch. The ?v= on each URL below is what forces the browser's
   own HTTP cache — and the hosting CDN in front of it — to treat the file as
   new, which matters for every visitor, not just ones with this SW already
   installed. Bump both together whenever game.js/wordsource.js/etc. change,
   in index.html's <script> tags and in the SHELL list here — they were left
   at ?v=3 across four straight commits that changed game.js and wordsource.js,
   so returning visitors kept the pre-fix code no matter how many times
   CACHE_VERSION alone was bumped. */
'use strict';

const CACHE_VERSION = 'mini-v19';

// Query strings are part of the cache key, so these must match the URLs in
// index.html exactly (including ?v=), or every asset is fetched twice.
const SHELL = [
  './',
  './index.html',
  './styles.css?v=11',
  './words.js?v=11',
  './words4.js?v=11',
  './words5a.js?v=11',
  './words5b.js?v=11',
  './clues.js?v=11',
  './generator.js?v=11',
  './wordsource.js?v=11',
  './share.js?v=11',
  './versus.js?v=11',
  './game.js?v=11',
  './manifest.webmanifest',
  './icon.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // addAll is atomic: one 404 discards the whole cache. Add individually
      // so a single missing asset cannot leave the app with no offline copy.
      .then(function (cache) {
        return Promise.all(SHELL.map(function (url) {
          return cache.add(url).catch(function (err) {
            console.warn('[sw] skipped ' + url + ': ' + err.message);
          });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          return key === CACHE_VERSION ? null : caches.delete(key);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // let cross-origin through
  if (url.pathname.startsWith('/api/')) return;      // live data only

  // A navigation must always resolve to the shell, even offline, or the app
  // shows the browser's dinosaur instead of a playable puzzle.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(function () {
        return caches.match('./index.html', { ignoreSearch: true })
          .then(function (hit) { return hit || Response.error(); });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(function (hit) {
      const network = fetch(req).then(function (res) {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit || Response.error(); });

      return hit || network;
    })
  );
});
