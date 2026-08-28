/* ═══════════════════════════════════════════════════════════════════
   AETHERIA READER
   A spoken-word reader for a folder of books you already own. Nothing
   is uploaded: books are read from disk, their text is cleaned in the
   browser, and the assistant runs on your own hardware.
   ═══════════════════════════════════════════════════════════════════ */

import { extractPdf, NoTextLayerError } from './extract.js';
import { buildSections, parseFilename } from './textclean.js';
import { Reader, toReaderDoc, countSentences } from './reader.js';
import { Assistant, MODELS, hasWebGPU, buildPassage, explainMessages, questionMessages } from './ai.js';
import { MediaSessionKeepAlive } from './media-session.js';
import * as lib from './library.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const BOOK_RE = /\.(pdf|txt|html?)$/i;

const COLORS = {
  gold:  { accent: '#c8a050', dim: '#c8a05022', mid: '#c8a05055' },
  blue:  { accent: '#5090d4', dim: '#5090d422', mid: '#5090d455' },
  green: { accent: '#50b47a', dim: '#50b47a22', mid: '#50b47a55' },
  white: { accent: '#d8d4cc', dim: '#d8d4cc22', mid: '#d8d4cc55' },
};

let settings = store.loadSettings();
let books = [];            // entries currently on screen
let catalog = null;        // the published library, when one exists
let bundledBooks = [];
let localBooks = [];
let source = 'bundled';    // which shelf the library screen is showing
let voices = [];
let reader = null;
let current = null;        // the open book entry
let assistant = null;
let cancelLoad = false;
let reopenFolder = null;   // set when a remembered folder needs a fresh gesture

// Keeps the tab audible while reading, so the browser does not freeze it
// and the operating system shows the book on the lock screen.
const media = new MediaSessionKeepAlive({
  play:  () => reader?.play(),
  pause: () => reader?.stop(),
  next:  () => reader?.skip(1),
  prev:  () => reader?.skip(-1),
});

/* ── Screens & chrome ───────────────────────────────────────────── */

function show(screenId) {
  for (const el of document.querySelectorAll('.screen')) {
    el.classList.toggle('active', el.id === screenId);
  }
}

let toastTimer = null;
function toast(message, ms = 3600) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ── Library sources ────────────────────────────────────────────── */

const supportsDirectoryPicker = 'showDirectoryPicker' in window;

/** Build library entries from File System Access directory entries. */
async function entriesFromDirectory(dirHandle) {
  const out = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file' && BOOK_RE.test(entry.name)) {
      out.push({ name: entry.name, handle: entry });
    }
  }
  return out;
}

/** Build library entries from a FileList (folder input or file picker). */
function entriesFromFiles(fileList) {
  return [...fileList]
    .filter((f) => BOOK_RE.test(f.name))
    .map((f) => ({ name: f.name, file: f }));
}

/** Attach metadata, cache keys and saved progress to raw entries. */
async function materialise(raw) {
  const progress = await store.allProgress();
  const entries = [];

  for (const item of raw) {
    let file = item.file;
    try {
      if (!file && item.handle) file = await item.handle.getFile();
    } catch {
      continue;                             // vanished or unreadable
    }
    if (!file) continue;

    const meta = parseFilename(item.name);
    entries.push({
      ...meta,
      name: item.name,
      handle: item.handle || null,
      file: item.file || null,              // kept only for picked files
      key: store.fileKey(file),
      size: file.size,
      progress: progress.get(item.name) || null,
      cached: false,
    });
  }

  // Flag the ones whose text we already hold
  const keys = new Set(await store.cachedKeys());
  for (const e of entries) e.cached = keys.has(e.key);

  entries.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  return entries;
}

/** Re-fetch a File for an entry (handles go stale far less often than files). */
async function fileFor(entry) {
  if (entry.file) return entry.file;
  if (entry.handle) return entry.handle.getFile();
  throw new Error('This book is no longer reachable. Pick the folder again.');
}

/* ── Shelves ────────────────────────────────────────────────────── */

/**
 * Switch between the published library and books on this device.
 * Picking "my books" with nothing chosen yet opens the folder picker.
 */
function setSource(next) {
  // Nothing chosen yet: reopen the remembered folder if there is one
  // (browsers only allow that prompt from a gesture like this click),
  // otherwise ask for a folder outright.
  if (next === 'local' && !localBooks.length) { (reopenFolder || pickFolder)(); return; }
  source = next;
  books = next === 'bundled' ? bundledBooks : localBooks;
  for (const btn of document.querySelectorAll('.src-btn')) {
    btn.classList.toggle('active', btn.dataset.src === next);
  }
  $('btn-change-folder').hidden = next !== 'local';
  settings.lastSource = next;
  persist();
  renderLibrary();
}

/* ── Library UI ─────────────────────────────────────────────────── */

function renderLibrary() {
  const query = $('lib-search').value.trim().toLowerCase();
  const grid = $('lib-grid');
  const shown = query
    ? books.filter((b) =>
        b.title.toLowerCase().includes(query) ||
        (b.author || '').toLowerCase().includes(query))
    : books;

  $('lib-count').textContent =
    shown.length === books.length
      ? `${books.length} book${books.length === 1 ? '' : 's'}`
      : `${shown.length} of ${books.length}`;

  grid.replaceChildren();
  $('lib-empty').hidden = shown.length > 0;
  if (!shown.length) {
    $('lib-empty').textContent = books.length
      ? 'Nothing matches that search.'
      : 'No books found in that folder.';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const book of shown) {
    const card = document.createElement('button');
    card.className = 'book-card';

    const title = document.createElement('div');
    title.className = 'book-title';
    title.textContent = book.title;
    card.appendChild(title);

    if (book.author) {
      const author = document.createElement('div');
      author.className = 'book-author';
      author.textContent = book.author;
      card.appendChild(author);
    }

    const foot = document.createElement('div');
    foot.className = 'book-foot';
    if (book.year) foot.append(String(book.year));
    foot.append(book.bundled
      ? `${Math.round(book.words / 1000)}k words`
      : `${(book.size / 1048576).toFixed(1)} MB`);
    if (book.unreadable) {
      foot.appendChild(badge('no text layer', 'unreadable'));
    } else if (book.cached) {
      foot.appendChild(badge('ready', 'ready'));
    }
    card.appendChild(foot);

    const pct = book.progress?.pct;
    if (pct > 0.01) {
      const bar = document.createElement('div');
      bar.className = 'book-progress';
      bar.style.width = Math.min(100, pct * 100) + '%';
      card.appendChild(bar);
    }

    card.addEventListener('click', () => openBook(book));
    frag.appendChild(card);
  }
  grid.appendChild(frag);
}

function badge(text, cls) {
  const el = document.createElement('span');
  el.className = 'badge ' + cls;
  el.textContent = text;
  return el;
}

/* ── Opening a book ─────────────────────────────────────────────── */

/** Split flat text into pseudo-pages so sectioning behaves consistently. */
function chunkPlain(text, target = 3000) {
  const paras = text.split(/\n\s*\n+/);
  const pages = [];
  let buf = '';
  for (const p of paras) {
    buf += (buf ? '\n\n' : '') + p;
    if (buf.length >= target) { pages.push(buf); buf = ''; }
  }
  if (buf.trim()) pages.push(buf);
  return pages.length ? pages : [text];
}

async function extractBook(entry, onProgress) {
  const file = await fileFor(entry);

  if (/\.pdf$/i.test(entry.name)) {
    return extractPdf(file, onProgress);
  }

  let text = await file.text();
  if (/\.html?$/i.test(entry.name)) {
    const dom = new DOMParser().parseFromString(text, 'text/html');
    for (const el of dom.querySelectorAll('script, style, nav, footer')) el.remove();
    text = dom.body?.innerText || dom.body?.textContent || '';
  }
  const sections = buildSections(chunkPlain(text));
  const words = sections.reduce(
    (a, s) => a + s.p.reduce((b, p) => b + p.split(/\s+/).length, 0), 0);
  if (!words) throw new NoTextLayerError('No readable text in this file.');
  return { sections, pages: 1, words };
}

async function openBook(entry) {
  cancelLoad = false;
  show('loading-screen');
  $('loading-title').textContent = entry.title;
  $('loading-sub').textContent = 'Checking for saved text…';
  $('loading-bar').style.width = '0%';

  try {
    let data;

    if (entry.bundled) {
      // Already cleaned and published; the service worker keeps a copy
      $('loading-sub').textContent = 'Fetching the text…';
      $('loading-bar').style.width = '40%';
      data = await lib.loadBook(entry.id);
      $('loading-bar').style.width = '100%';
    } else {
      data = await store.getCachedBook(entry.key);
      if (!data) {
        $('loading-sub').textContent = 'Extracting text — this happens once per book.';
        data = await extractBook(entry, (done, total) => {
          if (cancelLoad) throw new CancelledError();
          $('loading-bar').style.width = (done / total) * 100 + '%';
          $('loading-sub').textContent = `Page ${done} of ${total}`;
        });
        if (cancelLoad) throw new CancelledError();
        await store.cacheBook(entry.key, data);
        entry.cached = true;
      }
    }

    const doc = toReaderDoc(data.sections);
    if (!doc.length) throw new NoTextLayerError('No readable text in this book.');

    startReading(entry, doc);
  } catch (err) {
    if (err instanceof CancelledError) { show('library-screen'); return; }

    if (err instanceof NoTextLayerError) {
      entry.unreadable = true;
      toast(`“${entry.title}” has no text layer — it is a picture-only scan, so it cannot be read aloud.`, 6000);
    } else if (err?.name === 'NotAllowedError') {
      toast('Permission to read that folder was withdrawn. Choose it again.');
    } else {
      console.error(err);
      toast(`Could not open that book: ${err.message || err}`);
    }
    show('library-screen');
    renderLibrary();
  }
}

class CancelledError extends Error {}

/* ── Reading ────────────────────────────────────────────────────── */

function startReading(entry, doc) {
  reader?.destroy();
  current = entry;

  reader = new Reader(doc, {
    body: $('text-body'),
    heading: $('section-heading'),
    scroller: $('reading-area'),
  }, settings);
  reader.getVoice = getVoice;

  const saved = entry.progress;
  if (saved && saved.sec < doc.length) {
    reader.sec = saved.sec;
    reader.sen = Math.min(saved.sen ?? 0, doc[saved.sec].sentences.length - 1);
  }

  $('doc-title').textContent = entry.title.toUpperCase();
  reader.addEventListener('position', updateMeta);
  reader.addEventListener('section', () => { renderNav(); describeForLockScreen(); });
  reader.addEventListener('playing', (e) => {
    const on = e.detail.playing;
    $('btn-play').classList.toggle('playing', on);
    $('play-icon').hidden = on;
    $('pause-icon').hidden = !on;
    if (on) media.start(); else media.stop();
  });
  reader.addEventListener('finished', () => toast('End of the book.'));
  reader.addEventListener('speech-error', () =>
    toast('The speech engine stopped unexpectedly. Press play to resume.'));

  reader.render();
  renderNav();
  describeForLockScreen();
  applySettings();
  show('reader-screen');
}

/** Keep the lock-screen card naming the chapter being read. */
function describeForLockScreen() {
  if (!current || !reader) return;
  media.setBook({
    title: current.title,
    author: current.author,
    section: reader.section?.heading,
  });
}

function updateMeta() {
  if (!reader) return;
  const pct = reader.progress();
  $('doc-meta').textContent =
    `Section ${reader.sec + 1} of ${reader.doc.length}  ·  ${Math.round(pct * 100)}% read`;
  $('progress-fill').style.width = pct * 100 + '%';
}

function renderNav() {
  const nav = $('section-nav');
  const frag = document.createDocumentFragment();
  reader.doc.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.className = 'nav-item' + (i === reader.sec ? ' active' : '');
    const num = document.createElement('span');
    num.className = 'nav-num';
    num.textContent = String(i + 1);
    btn.append(num, s.heading);
    btn.addEventListener('click', () => {
      reader.goTo(i, 0);
      nav.classList.remove('open');
      $('btn-nav').classList.remove('active');
    });
    frag.appendChild(btn);
  });
  nav.replaceChildren(frag);
  updateMeta();
}

function saveProgress() {
  if (!reader || !current) return;
  const pos = { sec: reader.sec, sen: reader.sen, pct: reader.progress() };
  current.progress = pos;
  store.setProgress(current.name, pos);
}

function leaveReader() {
  saveProgress();
  reader?.stop();
  show('library-screen');
  renderLibrary();
}

/* ── Voices & settings ──────────────────────────────────────────── */

function loadVoices() {
  const all = speechSynthesis.getVoices();
  if (!all.length) return;
  const english = all.filter((v) => v.lang.startsWith('en'));
  voices = english.length ? english : all;
  populateVoices();
}

function populateVoices() {
  const sel = $('set-voice');
  sel.replaceChildren();
  voices.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = v.name.replace(/Microsoft |Google |Apple /g, '') + (v.localService ? '' : ' (online)');
    sel.appendChild(opt);
  });
  const saved = voices.findIndex((v) => v.name === settings.voiceName);
  if (saved >= 0) {
    sel.value = String(saved);
  } else {
    const pref = voices.findIndex((v) => /natural|neural|enhanced|premium/i.test(v.name));
    sel.value = String(pref >= 0 ? pref : 0);
  }
}

const getVoice = () => voices[Number($('set-voice').value)] || voices[0] || null;

function applyHighlightColor() {
  const c = COLORS[settings.highlightColor] || COLORS.gold;
  const root = document.documentElement.style;
  root.setProperty('--hl-accent', c.accent);
  root.setProperty('--hl-dim', c.dim);
  root.setProperty('--hl-mid', c.mid);
  for (const s of document.querySelectorAll('.color-swatch')) {
    s.style.borderColor = s.dataset.color === settings.highlightColor ? 'var(--text)' : 'transparent';
  }
}

function applySettings() {
  $('speed-slider').value = settings.rate;
  $('speed-value').textContent = settings.rate.toFixed(1) + '×';
  $('size-value').textContent = settings.fontSize;
  $('text-body').style.fontSize = settings.fontSize + 'px';

  $('set-speed').value = settings.rate;
  $('set-speed-val').textContent = settings.rate.toFixed(1) + '×';
  $('set-font').value = settings.fontSize;
  $('set-font-val').textContent = settings.fontSize + 'px';
  $('set-para-pause').value = settings.paraPause;
  $('set-para-pause-val').textContent = settings.paraPause + 'ms';
  $('set-sec-pause').value = settings.sectionPause;
  $('set-sec-pause-val').textContent = settings.sectionPause + 'ms';

  const as = $('set-autoscroll');
  as.textContent = settings.autoScroll ? 'On' : 'Off';
  as.classList.toggle('on', settings.autoScroll);

  applyHighlightColor();
}

function persist() { store.saveSettings(settings); }

// Speed and voice are baked into utterances when they are queued, so a
// change only reaches the listener once the queue is rebuilt. Debounced,
// or dragging the slider would restart the sentence on every pixel.
let refreshTimer = null;
function refreshSpeech() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => reader?.refresh(), 400);
}

function openSettings() {
  $('settings-overlay').classList.add('open');
  applySettings();
  renderModelList();
  updateCacheNote();
  updateOfflineNote();
  $('offline-row').hidden = !catalog;
}

/* ── Assistant ──────────────────────────────────────────────────── */

function getAssistant() {
  if (!assistant) {
    assistant = new Assistant();
    assistant.addEventListener('load-progress', (e) => {
      const { percent, total } = e.detail;
      if (total) {
        setAiStatus('loading',
          `Downloading model — ${Math.round(percent)}% of ${(total / 1048576).toFixed(0)} MB`);
      }
    });
    assistant.addEventListener('ready', (e) => {
      setAiStatus('ready',
        `Ready · ${e.detail.model.split('/').pop()} · ${e.detail.device.toUpperCase()}`);
      $('ai-setup').hidden = true;
      $('ai-main').hidden = false;
      refreshPassage();
    });
    assistant.addEventListener('error', (e) => {
      setAiStatus('error', e.detail.message || 'The assistant failed.');
    });
  }
  return assistant;
}

function setAiStatus(state, text) {
  $('ai-dot').className = 'dot ' + state;
  $('ai-status-text').textContent = text;
}

function modelButton(model, selected, onPick) {
  const btn = document.createElement('button');
  btn.className = 'model-opt' + (selected ? ' sel' : '');
  const body = document.createElement('div');
  const head = document.createElement('div');
  head.className = 'm-label';
  head.append(model.label + ' ');
  const size = document.createElement('span');
  size.className = 'm-size';
  size.textContent = model.size;
  head.appendChild(size);
  const note = document.createElement('div');
  note.className = 'm-note';
  note.textContent = model.note;
  body.append(head, note);
  btn.appendChild(body);
  btn.addEventListener('click', () => onPick(model));
  return btn;
}

function renderModelList() {
  for (const id of ['model-list', 'ai-model-list']) {
    const host = $(id);
    if (!host) continue;
    const frag = document.createDocumentFragment();
    for (const m of MODELS) {
      frag.appendChild(modelButton(m, m.id === settings.aiModel, (picked) => {
        settings.aiModel = picked.id;
        persist();
        renderModelList();
      }));
    }
    host.replaceChildren(frag);
  }
  const note = $('ai-device-note');
  if (note) {
    note.textContent = hasWebGPU()
      ? 'Runs on this device via WebGPU. Downloaded once, then cached.'
      : 'This browser has no WebGPU, so the model will run slowly on the CPU.';
  }
}

function refreshPassage() {
  if (!reader) return;
  const passage = buildPassage(reader.section, reader.sen);
  $('ai-passage').textContent = passage.context || '(nothing selected)';
  return passage;
}

async function runAi(buildMessages, maxTokens) {
  const a = getAssistant();
  if (a.state !== 'ready') { toast('Load a model first.'); return; }

  const passage = refreshPassage();
  if (!passage?.focus) { toast('Nothing to explain here yet.'); return; }

  const answer = $('ai-answer');
  answer.classList.remove('empty');
  answer.textContent = '';
  setBusy(true);

  try {
    await a.ask(buildMessages(passage), (_, full) => { answer.textContent = full; }, maxTokens);
  } catch (err) {
    answer.textContent = `The assistant could not answer: ${err.message}`;
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  for (const id of ['btn-explain', 'btn-simpler', 'btn-terms', 'btn-ask']) $(id).disabled = busy;
  $('btn-ai-stop').hidden = !busy;
}

function openAi() {
  if (!reader) return;
  reader.stop();                       // the reader has paused to ask
  $('ai-overlay').classList.add('open');
  renderModelList();

  const a = getAssistant();
  const ready = a.state === 'ready';
  $('ai-setup').hidden = ready;
  $('ai-main').hidden = !ready;

  if (ready) {
    refreshPassage();
  } else if (a.state === 'loading') {
    setAiStatus('loading', 'Loading the model…');
  } else {
    setAiStatus('idle', 'Choose a model to download');
    const warn = $('ai-warn');
    if (!hasWebGPU()) {
      warn.hidden = false;
      warn.textContent =
        'This browser does not support WebGPU, so the assistant will fall back to the CPU ' +
        'and answer slowly. Chrome or Edge on a desktop gives much better results.';
    } else {
      warn.hidden = true;
    }
  }
}

/* ── Folder selection ───────────────────────────────────────────── */

async function useDirectoryHandle(handle, { remember = true } = {}) {
  const raw = await entriesFromDirectory(handle);
  if (!raw.length) {
    toast('No PDF, text or HTML books were found in that folder.');
    return false;
  }
  localBooks = await materialise(raw);
  if (remember) { try { await store.setDirHandle(handle); } catch {} }
  setSource('local');
  show('library-screen');
  return true;
}

async function pickFolder() {
  $('welcome-error').textContent = '';

  if (supportsDirectoryPicker) {
    try {
      const handle = await window.showDirectoryPicker({ id: 'aetheria-books', mode: 'read' });
      await useDirectoryHandle(handle);
    } catch (err) {
      if (err?.name !== 'AbortError') {
        $('welcome-error').textContent = 'That folder could not be opened.';
      }
    }
  } else {
    $('dir-input').click();          // Firefox / Safari: one-off folder upload
  }
}

async function useFiles(fileList, { label = 'books' } = {}) {
  const raw = entriesFromFiles(fileList);
  if (!raw.length) {
    $('welcome-error').textContent = `No readable ${label} in that selection.`;
    return;
  }
  localBooks = await materialise(raw);
  setSource('local');
  show('library-screen');
  if (!supportsDirectoryPicker) {
    toast('This browser cannot remember a folder, so you will need to choose it again next time.', 5000);
  }
}

/** Try to reopen the folder chosen on a previous visit. */
async function restoreFolder() {
  let handle;
  try { handle = await store.getDirHandle(); } catch { return false; }
  if (!handle) return false;

  if (!(await store.verifyPermission(handle, false))) {
    // Browsers will not raise a permission prompt from a bare page load,
    // so turn the drop zone into a one-tap way back into the folder.
    $('drop-label').textContent = 'Reopen your books folder';
    $('drop-hint').textContent = 'Tap to confirm access again';
    reopenFolder = async () => {
      if (await store.verifyPermission(handle, true)) {
        reopenFolder = null;
        await useDirectoryHandle(handle, { remember: false });
      } else {
        toast('Access was declined.');
      }
    };
    return false;
  }
  return useDirectoryHandle(handle, { remember: false });
}

/* ── Wiring ─────────────────────────────────────────────────────── */

function wire() {
  // Welcome
  $('drop-zone').addEventListener('click', () => (reopenFolder || pickFolder)());
  $('btn-pick-files').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    if (e.target.files.length) useFiles(e.target.files);
  });
  $('dir-input').addEventListener('change', (e) => {
    if (e.target.files.length) useFiles(e.target.files, { label: 'books in that folder' });
  });

  const dz = $('drop-zone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    if (e.dataTransfer.files.length) useFiles(e.dataTransfer.files);
  });

  if (!supportsDirectoryPicker) {
    $('welcome-note').innerHTML =
      '<strong>Nothing is uploaded.</strong> This browser cannot remember a folder between ' +
      'visits — Chrome or Edge can. Your books are still read entirely on this device.';
  }

  // Library
  for (const btn of document.querySelectorAll('.src-btn')) {
    btn.addEventListener('click', () => setSource(btn.dataset.src));
  }
  $('btn-browse-library').addEventListener('click', () => {
    setSource('bundled');
    show('library-screen');
  });
  $('btn-offline').addEventListener('click', downloadLibraryForOffline);
  $('btn-bg-check').addEventListener('click', reportBackgroundState);
  $('lib-search').addEventListener('input', renderLibrary);
  $('btn-change-folder').addEventListener('click', pickFolder);
  $('btn-lib-settings').addEventListener('click', openSettings);

  // Loading
  $('btn-cancel-load').addEventListener('click', () => { cancelLoad = true; });

  // Reader transport
  $('btn-back').addEventListener('click', leaveReader);
  $('btn-play').addEventListener('click', () => reader?.toggle());
  $('btn-next').addEventListener('click', () => reader?.skip(1));
  $('btn-prev').addEventListener('click', () => reader?.skip(-1));
  $('btn-nav').addEventListener('click', () => {
    const open = $('section-nav').classList.toggle('open');
    $('btn-nav').classList.toggle('active', open);
  });
  $('text-body').addEventListener('click', (e) => {
    const s = e.target.closest('.sentence');
    if (s) reader?.select(Number(s.dataset.idx));
  });

  $('speed-slider').addEventListener('input', (e) => {
    settings.rate = parseFloat(e.target.value);
    applySettings(); persist(); refreshSpeech();
  });
  $('btn-size-down').addEventListener('click', () => {
    settings.fontSize = Math.max(14, settings.fontSize - 2);
    applySettings(); persist();
  });
  $('btn-size-up').addEventListener('click', () => {
    settings.fontSize = Math.min(32, settings.fontSize + 2);
    applySettings(); persist();
  });

  // Settings
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-close-settings').addEventListener('click', () => $('settings-overlay').classList.remove('open'));
  $('settings-overlay').addEventListener('click', (e) => {
    if (e.target === $('settings-overlay')) $('settings-overlay').classList.remove('open');
  });

  $('set-voice').addEventListener('change', (e) => {
    const v = voices[Number(e.target.value)];
    if (v) { settings.voiceName = v.name; persist(); refreshSpeech(); }
  });
  $('btn-test-voice').addEventListener('click', () => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(
      'All conditioned things are impermanent. Work out your own salvation with diligence.');
    u.rate = settings.rate;
    const v = getVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    speechSynthesis.speak(u);
  });

  const bind = (id, key, parse, speech) => $(id).addEventListener('input', (e) => {
    settings[key] = parse(e.target.value);
    applySettings(); persist();
    if (speech) refreshSpeech();
  });
  bind('set-speed', 'rate', parseFloat, true);
  bind('set-font', 'fontSize', (v) => parseInt(v, 10));
  bind('set-para-pause', 'paraPause', (v) => parseInt(v, 10));
  bind('set-sec-pause', 'sectionPause', (v) => parseInt(v, 10));

  $('set-autoscroll').addEventListener('click', () => {
    settings.autoScroll = !settings.autoScroll;
    applySettings(); persist();
  });
  for (const sw of document.querySelectorAll('.color-swatch')) {
    sw.addEventListener('click', () => {
      settings.highlightColor = sw.dataset.color;
      applySettings(); persist();
    });
  }
  $('btn-clear-cache').addEventListener('click', async () => {
    await store.clearBookCache();
    for (const b of books) b.cached = false;
    renderLibrary();
    updateCacheNote();
    toast('Extracted text cleared. Books will be re-read when next opened.');
  });
  $('btn-reset').addEventListener('click', () => {
    const keepModel = settings.aiModel;
    settings = { ...store.DEFAULTS, aiModel: keepModel };
    persist(); applySettings(); populateVoices();
    toast('Settings reset.');
  });

  // Assistant
  $('btn-ai').addEventListener('click', openAi);
  $('btn-close-ai').addEventListener('click', () => $('ai-overlay').classList.remove('open'));
  $('ai-overlay').addEventListener('click', (e) => {
    if (e.target === $('ai-overlay')) $('ai-overlay').classList.remove('open');
  });
  $('btn-load-model').addEventListener('click', async () => {
    const btn = $('btn-load-model');
    btn.disabled = true;
    setAiStatus('loading', 'Starting…');
    try {
      await getAssistant().load(settings.aiModel);
    } catch (err) {
      setAiStatus('error', err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-explain').addEventListener('click', () =>
    runAi((p) => explainMessages(current, reader.section, p)));
  $('btn-simpler').addEventListener('click', () =>
    runAi((p) => questionMessages(current, reader.section, p,
      'Restate this passage in plain modern English, as simply as you can.')));
  $('btn-terms').addEventListener('click', () =>
    runAi((p) => questionMessages(current, reader.section, p,
      'List and briefly define any Pali, Sanskrit, doctrinal or archaic terms used here.')));
  $('btn-ai-stop').addEventListener('click', () => assistant?.stop());

  $('ai-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('ai-input').value.trim();
    if (!q) return;
    $('ai-input').value = '';
    runAi((p) => questionMessages(current, reader.section, p, q));
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (!reader || !$('reader-screen').classList.contains('active')) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (document.querySelector('.overlay.open')) return;

    switch (e.code) {
      case 'Space':      e.preventDefault(); reader.toggle(); break;
      case 'ArrowRight': e.preventDefault(); reader.skip(1); break;
      case 'ArrowLeft':  e.preventDefault(); reader.skip(-1); break;
      case 'Escape':     e.preventDefault(); leaveReader(); break;
      case 'KeyA':       e.preventDefault(); openAi(); break;
      case 'ArrowUp':
        e.preventDefault();
        settings.rate = Math.min(2, +(settings.rate + 0.1).toFixed(1));
        applySettings(); persist(); refreshSpeech();
        break;
      case 'ArrowDown':
        e.preventDefault();
        settings.rate = Math.max(0.5, +(settings.rate - 0.1).toFixed(1));
        applySettings(); persist(); refreshSpeech();
        break;
    }
  });

  // Keep the reading position safe
  setInterval(saveProgress, 5000);
  window.addEventListener('pagehide', saveProgress);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveProgress();
  });
}

async function downloadLibraryForOffline() {
  if (!catalog) return;
  const btn = $('btn-offline');
  const note = $('offline-note');
  btn.disabled = true;

  try {
    const done = await lib.cacheWholeLibrary(catalog, (n, total) => {
      note.textContent = `Downloading ${n} of ${total}…`;
    });
    note.textContent = done.failed
      ? `${done.total - done.failed} of ${done.total} books stored — ${done.failed} failed.`
      : `All ${done.total} books stored for offline reading.`;
    toast(done.failed
      ? `${done.failed} book${done.failed === 1 ? '' : 's'} could not be downloaded.`
      : 'The whole library is now available offline.');
  } catch (err) {
    note.textContent = err.message;
    toast(err.message);
  } finally {
    btn.disabled = false;
    updateOfflineNote();
  }
}

/**
 * Report whether the browser actually granted audio focus. Without it the
 * page is throttled the moment it is hidden and there is no lock-screen
 * card — and the failure is otherwise completely silent.
 */
function reportBackgroundState() {
  const r = media.report();
  const bits = [];

  if (!r.audioElement) {
    bits.push('Not started — press play first.');
  } else {
    bits.push(r.playing ? '✓ silent loop playing' : '✗ silent loop NOT playing');
    bits.push(r.longEnough
      ? `✓ loop ${r.duration}s (over the 5s floor)`
      : `✗ loop ${r.duration ?? '?'}s — too short for audio focus`);
  }
  bits.push(r.toneState === 'running' ? '✓ web-audio tone running' : `✗ tone ${r.toneState}`);
  bits.push(r.mediaSession ? '✓ media session' : '✗ no media session');
  bits.push(r.metadata ? '✓ lock-screen info set' : '✗ no lock-screen info');
  bits.push(r.handlers ? '✓ media keys wired' : '✗ media keys not wired');
  bits.push(`state: ${r.playbackState}`);
  bits.push(`revivals: ${r.revivals}`);
  if (r.error) bits.push(`audio refused: ${r.error}`);
  if (reader) bits.push(`speech: ${speechSynthesis.speaking ? 'speaking' : 'idle'}${speechSynthesis.pending ? ' +queued' : ''}`);

  $('bg-note').textContent = bits.join(' · ');
}

async function updateOfflineNote() {
  if (!catalog) return;
  const have = await lib.cachedCount(catalog);
  const mb = (lib.totalBytes(catalog) / 1048576).toFixed(0);
  $('offline-note').textContent = have >= catalog.books.length
    ? `All ${catalog.books.length} books stored offline.`
    : `${have} of ${catalog.books.length} stored · about ${mb} MB in total`;
}

async function updateCacheNote() {
  const keys = await store.cachedKeys();
  const bytes = await store.cacheSize();
  $('cache-note').textContent = keys.length
    ? `${keys.length} book${keys.length === 1 ? '' : 's'} extracted · ${(bytes / 1048576).toFixed(1)} MB`
    : 'Nothing extracted yet';
}

/* ── Boot ───────────────────────────────────────────────────────── */

/**
 * Ask the browser to keep our data. Without this, extracted text, the
 * remembered folder and the cached model are all evictable under storage
 * pressure — which would quietly break offline use.
 */
async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {}
}

function watchConnection() {
  const paint = () => {
    document.body.classList.toggle('offline', !navigator.onLine);
    const chip = $('btn-change-folder');
    if (chip) chip.title = navigator.onLine ? 'Choose a different folder' : 'Offline — your books still work';
  };
  window.addEventListener('online', () => { paint(); toast('Back online.', 2000); });
  window.addEventListener('offline', () => {
    paint();
    toast('Offline. Your books and any downloaded model keep working.', 4000);
  });
  paint();
}

async function init() {
  wire();
  applySettings();
  renderModelList();
  loadVoices();
  speechSynthesis.addEventListener('voiceschanged', loadVoices);
  watchConnection();
  requestPersistence();

  if (!supportsDirectoryPicker) {
    $('drop-label').textContent = 'Choose your books folder';
    $('drop-hint').textContent = 'Your browser will ask to upload the folder — nothing leaves this device';
  }

  catalog = await lib.loadCatalog();
  if (catalog) {
    bundledBooks = lib.toEntries(catalog, await store.allProgress());
    $('src-toggle').hidden = false;
    setSource('bundled');
    show('library-screen');
  }

  const restored = await restoreFolder();
  if (restored && (settings.lastSource === 'local' || !catalog)) setSource('local');
  else if (catalog) setSource('bundled');
  if (!catalog && !restored) show('welcome-screen');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      // A new version that has finished installing takes over on the next
      // visit; nudge it along so users are not stuck on a stale build.
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            sw.postMessage('skip-waiting');
          }
        });
      });
    }).catch(() => {});
  }
}

init();
