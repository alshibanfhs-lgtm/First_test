// sw.js — caches the app shell so the PWA launches and works fully offline
// (spec requirement: "must continue working offline"). Data itself lives in
// IndexedDB (see js/db.js), not in this cache — this only caches code/assets.

const CACHE_NAME = 'invoice-ledger-shell-v1';
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/arabicUtils.js',
  './js/db.js',
  './js/validation.js',
  './js/pdfExtract.js',
  './js/ocr.js',
  './js/aiFallback.js',
  './js/pipeline.js',
  './js/barcode.js',
  './js/sync.js',
  './js/ui.js',
  './js/parsers/common.js',
  './js/columnParser.js',
  './js/learning.js',
  './js/parsers/smartShopper.js',
  './js/parsers/alHatab.js',
  './js/parsers/generic.js',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './vendor/zxing.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return; // never cache mutating requests

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          // Cache-as-you-go for same-origin assets so later offline launches work too.
          if (response.ok && new URL(event.request.url).origin === self.location.origin) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached); // offline and not cached: nothing we can do for this asset
    })
  );
});
