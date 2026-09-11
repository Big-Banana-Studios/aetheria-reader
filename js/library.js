/* ═══════════════════════════════════════════════════════════════════
   BUNDLED LIBRARY
   The public-domain collection published alongside the app. Only the
   cleaned text ships — the source PDFs are far too large for a static
   host, and the text is what the reader actually needs.

   Books are fetched one at a time as they are opened, and the service
   worker keeps them, so a book read once stays readable offline.
   ═══════════════════════════════════════════════════════════════════ */

const BASE = new URL('../library/', import.meta.url);

export const bookUrl = (id) => new URL(`${id}.json`, BASE).href;

// A book in another language may be published with an English rendering
// beside it, made once by tools/translate_library.py. It has the same
// shape as the original, section for section, so the reader treats it
// as just another text.
export const englishUrl = (id) => new URL(`${id}.en.json`, BASE).href;

/** Fetch the catalogue. Returns null when no library is published. */
export async function loadCatalog() {
  try {
    const res = await fetch(new URL('index.json', BASE), { cache: 'no-cache' });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.books) && data.books.length ? data : null;
  } catch {
    return null;
  }
}

/** Fetch one book's cleaned text, or its published English translation. */
export async function loadBook(id, { english = false } = {}) {
  const res = await fetch(english ? englishUrl(id) : bookUrl(id));
  if (!res.ok) throw new Error(`That book could not be loaded (${res.status}).`);
  const data = await res.json();
  if (!data?.sections?.length) throw new Error('That book arrived empty.');
  return data;
}

/**
 * Turn catalogue rows into library entries, in the same shape the reader
 * uses for books opened from disk.
 */
export function toEntries(catalog, progress) {
  return catalog.books.map((b) => ({
    id: b.id,
    title: b.t,
    author: b.a || null,
    year: b.y || null,
    note: b.n || null,
    collection: b.c || null,
    prose: typeof b.p === 'number' ? b.p : null,
    language: b.l || null,
    english: !!b.e,               // an English translation is published
    englishBytes: (b.e || 0) * 1024,
    words: b.w,
    sectionCount: b.s,
    bytes: (b.kb || 0) * 1024,
    bundled: true,
    name: `bundled:${b.id}`,      // stable key for reading position
    key: `bundled:${b.id}`,
    progress: progress?.get(`bundled:${b.id}`) || null,
    cached: false,
  }));
}

/** Every book URL in the catalogue, translations included, for pre-caching the whole library. */
export const allBookUrls = (catalog) => catalog.books.flatMap((b) =>
  b.e ? [bookUrl(b.id), englishUrl(b.id)] : [bookUrl(b.id)]);

/** The collections in the catalogue, oldest format tolerated. */
export const collections = (catalog) =>
  Array.isArray(catalog?.collections) ? catalog.collections : [];

/** Total published size, in bytes. */
export const totalBytes = (catalog) =>
  catalog.books.reduce((a, b) => a + ((b.kb || 0) + (b.e || 0)) * 1024, 0);

/** Ask the service worker to download the whole library for offline use. */
export function cacheWholeLibrary(catalog, onProgress) {
  return new Promise((resolve, reject) => {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) {
      reject(new Error('The offline cache is not ready yet. Reload and try again.'));
      return;
    }

    const onMessage = (e) => {
      const m = e.data;
      if (m?.type === 'cache-library-progress') {
        onProgress?.(m.done, m.total, m.failed);
      } else if (m?.type === 'cache-library-done') {
        navigator.serviceWorker.removeEventListener('message', onMessage);
        resolve(m);
      }
    };

    navigator.serviceWorker.addEventListener('message', onMessage);
    sw.postMessage({ type: 'cache-library', urls: allBookUrls(catalog) });
  });
}

/** How much of the library is already stored for offline reading. */
export async function cachedCount(catalog) {
  try {
    const cache = await caches.open('aetheria-library');
    const keys = await cache.keys();
    const have = new Set(keys.map((r) => new URL(r.url).pathname));
    return catalog.books.filter((b) =>
      have.has(new URL(bookUrl(b.id)).pathname)).length;
  } catch {
    return 0;
  }
}
