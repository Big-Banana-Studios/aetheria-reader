/* ═══════════════════════════════════════════════════════════════════
   STORE
   IndexedDB holds three things: the handle to the reader's book folder,
   the cleaned text of every book already opened, and where the reader
   got to in each. Extraction of a long scan takes a while, so a book is
   only ever parsed once.
   ═══════════════════════════════════════════════════════════════════ */

const DB_NAME = 'aetheria-reader';
const DB_VERSION = 1;
const META = 'meta';        // directory handle, misc singletons
const BOOKS = 'books';      // cleaned text, keyed by file identity
const PROGRESS = 'progress';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(BOOKS)) db.createObjectStore(BOOKS);
      if (!db.objectStoreNames.contains(PROGRESS)) db.createObjectStore(PROGRESS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
const put = (store, key, val) => tx(store, 'readwrite', (s) => s.put(val, key));
const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));

/* ── Book folder ────────────────────────────────────────────────── */

export const getDirHandle = () => get(META, 'dirHandle');
export const setDirHandle = (handle) => put(META, 'dirHandle', handle);
export const clearDirHandle = () => del(META, 'dirHandle');

/**
 * Confirm we may still read a remembered folder.
 * `interactive` may only be true inside a user gesture — browsers reject
 * a permission request raised from a bare page load.
 */
export async function verifyPermission(handle, interactive = false) {
  if (!handle?.queryPermission) return true;      // not a real FS handle
  const opts = { mode: 'read' };
  if (await handle.queryPermission(opts) === 'granted') return true;
  if (!interactive) return false;
  return await handle.requestPermission(opts) === 'granted';
}

/* ── Cached book text ───────────────────────────────────────────── */

/**
 * Identify a file by name, size and last-modified date, so that editing
 * or replacing a PDF invalidates its cached text automatically.
 */
export function fileKey(file) {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

export const getCachedBook = (key) => get(BOOKS, key);
export const cacheBook = (key, data) =>
  put(BOOKS, key, { ...data, cachedAt: Date.now() });

export async function cachedKeys() {
  return tx(BOOKS, 'readonly', (s) => s.getAllKeys());
}

export async function cacheSize() {
  const db = await openDb();
  return new Promise((resolve) => {
    let bytes = 0;
    const t = db.transaction(BOOKS, 'readonly');
    const cursor = t.objectStore(BOOKS).openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return resolve(bytes);
      // Rough but cheap: the text dominates every record
      const v = c.value;
      if (v?.sections) {
        for (const sec of v.sections) for (const p of sec.p) bytes += p.length * 2;
      }
      c.continue();
    };
    t.onerror = () => resolve(bytes);
  });
}

export const clearBookCache = () => tx(BOOKS, 'readwrite', (s) => s.clear());

/* ── Reading position ───────────────────────────────────────────── */

export const getProgress = (id) => get(PROGRESS, id);
export const setProgress = (id, pos) => put(PROGRESS, id, { ...pos, at: Date.now() });

export async function allProgress() {
  const db = await openDb();
  return new Promise((resolve) => {
    const out = new Map();
    const t = db.transaction(PROGRESS, 'readonly');
    const cursor = t.objectStore(PROGRESS).openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return resolve(out);
      out.set(c.key, c.value);
      c.continue();
    };
    t.onerror = () => resolve(out);
  });
}

/* ── Settings (small, synchronous, kept in localStorage) ────────── */

export const DEFAULTS = {
  rate: 1.0, fontSize: 20, voiceName: '', paraPause: 400,
  sectionPause: 800, autoScroll: true, highlightColor: 'gold',
  aiModel: 'onnx-community/LFM2-700M-ONNX', aiEnabled: true,
  lastSource: 'bundled', music: true, musicVolume: 20,
};

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('aetheria-reader-settings')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem('aetheria-reader-settings', JSON.stringify(s)); } catch {}
}
