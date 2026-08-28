/* ═══════════════════════════════════════════════════════════════════
   SERVICE WORKER
   Three caches with different jobs:

     shell    the app itself — precached on install, so the reader opens
              with no network at all
     runtime  the AI libraries pulled from jsDelivr — cached the first
              time the assistant is used, and reused offline afterwards
     (transformers.js keeps model weights in its own cache, which
      likewise survives going offline)
   ═══════════════════════════════════════════════════════════════════ */

const VERSION = 'v1';
const SHELL = `aetheria-shell-${VERSION}`;
const RUNTIME = `aetheria-runtime-${VERSION}`;

// Everything needed to open the app and read an already-extracted book
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/reader.js',
  './js/store.js',
  './js/extract.js',
  './js/textclean.js',
  './js/ai.js',
  './js/ai-worker.js',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Hosts whose responses are worth keeping for offline use
const CACHEABLE_HOSTS = new Set([
  'cdn.jsdelivr.net',       // transformers.js + ONNX Runtime wasm
  'huggingface.co',         // model config and tokenizer
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.hf.co',
]);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // addAll fails the whole install if any single file 404s; add them
    // individually so one stale entry cannot break the app.
    await Promise.all(SHELL_ASSETS.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, RUNTIME]);
    for (const key of await caches.keys()) {
      // Leave transformers.js's own model cache strictly alone
      if (key.startsWith('aetheria-') && !keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const network = fetch(request).then((response) => {
    if (response && (response.ok || response.type === 'opaque')) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  }).catch(() => null);

  return cached || network || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Navigations: serve the app shell so a cold offline start still works
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(SHELL);
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Our own files: cache first, refresh in the background
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, SHELL));
    return;
  }

  // AI libraries and model metadata: keep whatever we successfully fetch,
  // so the assistant keeps working once it has been used online.
  if (CACHEABLE_HOSTS.has(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response && (response.ok || response.type === 'opaque')) {
          cache.put(request, response.clone()).catch(() => {});
        }
        return response;
      } catch {
        return Response.error();
      }
    })());
  }
});
