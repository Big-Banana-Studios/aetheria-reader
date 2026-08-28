/* ═══════════════════════════════════════════════════════════════════
   SERVICE WORKER
   Three caches with different lifetimes:

     shell     the app itself — precached on install, replaced whenever
               VERSION changes, so updates actually reach people
     library   the public-domain book texts — cached as they are read and
               deliberately NOT versioned, so an app update never throws
               away 57 MB the reader has already downloaded
     runtime   the AI libraries pulled from jsDelivr, cached on first use

   (transformers.js keeps model weights in its own cache, which likewise
    survives going offline.)
   ═══════════════════════════════════════════════════════════════════ */

const VERSION = 'v6';
const SHELL = `aetheria-shell-${VERSION}`;
const LIBRARY = 'aetheria-library';
const RUNTIME = `aetheria-runtime-${VERSION}`;

// Everything needed to open the app and read an already-cached book
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
  './js/library.js',
  './js/media-session.js',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './library/index.json',
];

// Hosts whose responses are worth keeping for offline use
const CACHEABLE_HOSTS = new Set([
  'cdn.jsdelivr.net',       // transformers.js + ONNX Runtime wasm
  'huggingface.co',         // model config and tokenizer
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.hf.co',
]);

const isLibraryBook = (url) =>
  url.origin === self.location.origin &&
  url.pathname.includes('/library/') &&
  url.pathname.endsWith('.json') &&
  !url.pathname.endsWith('/index.json');

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
    const keep = new Set([SHELL, LIBRARY, RUNTIME]);
    for (const key of await caches.keys()) {
      if (key.startsWith('aetheria-') && !keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg === 'skip-waiting') return self.skipWaiting();

  // Pre-download the whole library so it is readable with no network.
  if (msg?.type === 'cache-library') {
    event.waitUntil((async () => {
      const cache = await caches.open(LIBRARY);
      const urls = msg.urls || [];
      let done = 0, failed = 0;
      for (const url of urls) {
        try {
          if (!(await cache.match(url))) {
            const res = await fetch(url, { cache: 'no-cache' });
            if (res.ok) await cache.put(url, res.clone());
            else failed++;
          }
        } catch { failed++; }
        done++;
        if (done % 5 === 0 || done === urls.length) {
          for (const c of await self.clients.matchAll()) {
            c.postMessage({ type: 'cache-library-progress', done, total: urls.length, failed });
          }
        }
      }
      for (const c of await self.clients.matchAll()) {
        c.postMessage({ type: 'cache-library-done', done, total: urls.length, failed });
      }
    })());
  }
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

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
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

  // Book texts never change once published, and are far too bulky to
  // re-fetch: keep them in their own cache, and keep them for good.
  if (isLibraryBook(url)) {
    event.respondWith(cacheFirst(request, LIBRARY));
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
    event.respondWith(cacheFirst(request, RUNTIME));
  }
});
