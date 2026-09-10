/* ═══════════════════════════════════════════════════════════════════
   TRANSLATOR
   Renders a section of a foreign-language book into English on-device.

   Roughly half this library is not in English — the Alchemy set alone
   runs to Latin, French, German and Italian — and those books extract
   perfectly well while being unlistenable in an English voice. A small
   Marian model per language pair fixes that for the languages one
   exists for; where none exists, the app says so rather than guessing.
   ═══════════════════════════════════════════════════════════════════ */

// An encoder and a merged decoder, quantised: about 220 MB for a pair,
// fetched only when a book in that language is actually opened.
//
// These are the onnx-community exports, not the older Xenova ones. The
// latter quantise the decoder down to 54 MB and the result will not load
// at all — ONNX Runtime Web cannot find the scale for a shared weight and
// refuses to create a session. The conservative export is three times the
// size and works.
export const TRANSLATORS = {
  French:  { model: 'onnx-community/opus-mt-fr-en', size: '~220 MB' },
  German:  { model: 'onnx-community/opus-mt-de-en', size: '~220 MB' },
  Italian: { model: 'onnx-community/opus-mt-it-en', size: '~240 MB' },
  Spanish: { model: 'onnx-community/opus-mt-es-en', size: '~220 MB' },
  Dutch:   { model: 'onnx-community/opus-mt-nl-en', size: '~220 MB' },
  // A catch-all covering some 120 source languages, for anything the
  // language tagger names that has no pair of its own. It does NOT cover
  // Latin, whatever its name suggests.
  Other:   { model: 'onnx-community/opus-mt-mul-en', size: '~230 MB' },
};

/** Can this language be translated at all? */
export const canTranslate = (language) =>
  !!language && language !== 'English' && !!TRANSLATORS[language];

export class Translator extends EventTarget {
  constructor() {
    super();
    this.worker = null;
    this.language = null;
    this.ready = false;
    this.nextId = 1;
    this.jobs = new Map();
    this.lastError = null;
  }

  #emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }

  #ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./translate-worker.js', import.meta.url), { type: 'module' });

    this.worker.addEventListener('message', (e) => {
      const m = e.data;
      switch (m.type) {
        case 'load-start':    this.#emit('load-start', m); break;
        case 'load-dtype':    this.#emit('load-dtype', m); break;
        case 'load-progress': this.#emit('load-progress', m); break;
        case 'ready':
          this.ready = true;
          this.dtype = m.dtype;
          this.#emit('ready', m);
          break;
        case 'line': {
          const job = this.jobs.get(m.id);
          if (job) job.onLine?.(m.index, m.text, m.error);
          break;
        }
        case 'done': {
          const job = this.jobs.get(m.id);
          this.jobs.delete(m.id);
          job?.resolve();
          break;
        }
        case 'error': {
          this.lastError = m.message;
          if (m.id != null && this.jobs.has(m.id)) {
            const job = this.jobs.get(m.id);
            this.jobs.delete(m.id);
            job.reject(new Error(m.message));
          } else {
            this.#emit('error', m);
          }
          break;
        }
      }
    });

    this.worker.addEventListener('error', (e) => {
      this.lastError = e.message || 'The translator failed to start.';
      this.#emit('error', { message: this.lastError });
    });
    return this.worker;
  }

  /**
   * Download (first time) and initialise the model for a language.
   *
   * Enforces a deadline from out here, because it cannot be enforced in
   * the worker: creating a session blocks that thread inside wasm, so it
   * stops answering rather than failing, and a timer set inside it never
   * runs. Some builds of these models never finish at all. Terminating
   * the worker is the only way back.
   */
  async prepare(language, deadlineMs = 180000) {
    const spec = TRANSLATORS[language] || TRANSLATORS.Other;
    if (this.ready && this.language === language) return;
    this.ready = false;
    this.language = language;
    this.#ensureWorker().postMessage({ type: 'load', model: spec.model });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        this.destroy();          // the thread is wedged; nothing else frees it
        reject(new Error(
          'The translator for this language would not start on this device. '
          + 'It downloaded, then stopped responding while loading.'));
      }, deadlineMs);

      const ok = () => { off(); resolve(); };
      const bad = (e) => { off(); reject(new Error(e.detail?.message || 'The translator failed to load.')); };
      const off = () => {
        clearTimeout(timer);
        this.removeEventListener('ready', ok);
        this.removeEventListener('error', bad);
      };
      this.addEventListener('ready', ok);
      this.addEventListener('error', bad);
    });
  }

  /**
   * Translate a list of strings. `onLine(index, text)` fires as each
   * arrives, so the passage fills in rather than appearing all at once.
   */
  run(items, onLine) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, onLine });
      this.#ensureWorker().postMessage({ type: 'translate', id, items });
    });
  }

  cancel() {
    this.worker?.postMessage({ type: 'cancel' });
    for (const job of this.jobs.values()) job.resolve();
    this.jobs.clear();
  }

  destroy() {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
  }
}
