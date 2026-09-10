/* ═══════════════════════════════════════════════════════════════════
   TRANSLATE WORKER
   Runs a Marian translation model on-device through transformers.js.

   These are small models — around 100 MB for a language pair — and one
   is fetched only when a book in that language is opened. Sentences go
   through one at a time so progress can be reported and a long section
   does not run past the model's context.

   The community ONNX exports vary in quality, and not every quantisation
   of every model actually loads: the q8 build of these Marian models is
   rejected outright by ONNX Runtime Web, which cannot find the scale for
   a shared weight. So rather than pick one and hope, DTYPES are tried in
   turn from smallest to largest until a session is created, and the one
   that worked is reported back.
   ═══════════════════════════════════════════════════════════════════ */

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';

// Smallest first. fp32 is deliberately absent: at 400 MB it downloaded
// fine and then sat for six minutes without ever creating a session, so
// it is not a fallback, it is a hang.
const DTYPES = ['int8', 'uint8', 'q8', 'fp16'];

// A note for whoever comes next: do NOT try to time these attempts out
// from in here. Creating a session blocks this thread synchronously
// inside wasm, so no timer set here will ever fire and no error is ever
// thrown — the worker simply stops answering. The deadline has to be
// imposed from the main thread, which can still see the clock and
// terminate this worker. See Translator#prepare.

let translator = null;
let loadedModel = null;
let lib = null;
let generation = 0;

function progressReporter() {
  const files = new Map();
  return (e) => {
    if (e.status === 'progress' && e.file) {
      files.set(e.file, { loaded: e.loaded || 0, total: e.total || 0 });
    } else if (e.status === 'done' && e.file && files.has(e.file)) {
      const f = files.get(e.file);
      files.set(e.file, { loaded: f.total, total: f.total });
    }
    let loaded = 0, total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    self.postMessage({
      type: 'load-progress', loaded, total,
      percent: total ? Math.min(100, (loaded / total) * 100) : 0,
    });
  };
}

async function load({ model }) {
  if (translator && loadedModel === model) {
    self.postMessage({ type: 'ready', model, dtype: translator.__dtype });
    return;
  }
  if (!lib) lib = await import(TRANSFORMERS);

  self.postMessage({ type: 'load-start', model });

  const failures = [];
  for (const dtype of DTYPES) {
    try {
      self.postMessage({ type: 'load-dtype', model, dtype });
      // Marian encoder-decoders are more dependable on wasm than on
      // WebGPU, and at this size the CPU keeps up perfectly well.
      translator = await lib.pipeline('translation', model, {
        dtype, device: 'wasm',
        progress_callback: progressReporter(),
      });
      translator.__dtype = dtype;
      loadedModel = model;
      self.postMessage({ type: 'ready', model, dtype });
      return;
    } catch (err) {
      failures.push(`${dtype}: ${(err?.message || err).toString().slice(0, 120)}`);
      translator = null;
    }
  }
  throw new Error('No usable build of this translator. ' + failures.join(' | '));
}

/**
 * Translate a batch of strings, reporting each as it lands so the reader
 * sees the passage fill in rather than waiting for all of it.
 */
async function translate({ id, items, gen }) {
  if (!translator) {
    self.postMessage({ type: 'error', id, message: 'No translator is loaded.' });
    return;
  }

  for (let i = 0; i < items.length; i++) {
    if (gen !== generation) return;                  // superseded
    const text = items[i];
    try {
      const out = await translator(text, { max_new_tokens: 512 });
      const translated = Array.isArray(out)
        ? (out[0]?.translation_text ?? '')
        : (out?.translation_text ?? '');
      self.postMessage({ type: 'line', id, index: i, text: translated });
    } catch (err) {
      self.postMessage({
        type: 'line', id, index: i,
        text: '', error: err?.message || String(err),
      });
    }
  }
  if (gen === generation) self.postMessage({ type: 'done', id });
}

self.addEventListener('message', async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'load':   await load(msg); break;
      case 'translate': await translate({ ...msg, gen: generation }); break;
      case 'cancel': generation++; break;
    }
  } catch (err) {
    self.postMessage({
      type: 'error', id: msg?.id ?? null,
      message: err?.message || String(err),
    });
  }
});
