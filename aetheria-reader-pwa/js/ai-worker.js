/* ═══════════════════════════════════════════════════════════════════
   AI WORKER
   Runs a Liquid AI LFM2 model on-device through transformers.js and
   ONNX Runtime Web. It lives in a worker so that token generation never
   competes with the speech synthesiser or the scrolling text.

   Model weights are fetched from the Hugging Face CDN and kept in the
   browser's Cache Storage, so the download happens once per device and
   nothing about it touches the site's own hosting.
   ═══════════════════════════════════════════════════════════════════ */

const TRANSFORMERS_VERSION = '4.2.0';
const CDN = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}`;

let generator = null;
let stopper = null;
let loadedModel = null;
let lib = null;

/** Collapse per-file download progress into one overall percentage. */
function makeProgressReporter() {
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
      type: 'load-progress',
      status: e.status,
      file: e.file || null,
      loaded, total,
      percent: total ? Math.min(100, (loaded / total) * 100) : 0,
    });
  };
}

async function load({ model, dtype }) {
  if (generator && loadedModel === model) {
    self.postMessage({ type: 'ready', model, device: generator.__device });
    return;
  }

  if (!lib) lib = await import(`${CDN}/dist/transformers.min.js`);
  const { pipeline } = lib;

  // WebGPU is the whole point; wasm keeps the feature alive on browsers
  // that lack it, just far more slowly.
  const device = 'gpu' in navigator && navigator.gpu ? 'webgpu' : 'wasm';
  const effectiveDtype = device === 'webgpu' ? (dtype || 'q4f16') : 'q4';

  self.postMessage({ type: 'load-start', model, device });

  generator = await pipeline('text-generation', model, {
    device,
    dtype: effectiveDtype,
    progress_callback: makeProgressReporter(),
  });
  generator.__device = device;
  loadedModel = model;

  self.postMessage({ type: 'ready', model, device });
}

async function ask({ id, messages, maxTokens }) {
  if (!generator) {
    self.postMessage({ type: 'error', id, message: 'The model is not loaded yet.' });
    return;
  }

  const { TextStreamer, InterruptableStoppingCriteria } = lib;
  stopper = InterruptableStoppingCriteria ? new InterruptableStoppingCriteria() : null;

  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text) => self.postMessage({ type: 'token', id, text }),
  });

  try {
    const out = await generator(messages, {
      max_new_tokens: maxTokens || 320,
      do_sample: true,
      temperature: 0.4,
      top_p: 0.9,
      repetition_penalty: 1.05,
      streamer,
      ...(stopper ? { stopping_criteria: stopper } : {}),
    });

    const last = out?.[0]?.generated_text;
    const text = Array.isArray(last) ? (last.at(-1)?.content ?? '') : String(last ?? '');
    self.postMessage({ type: 'done', id, text });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err?.message || String(err) });
  } finally {
    stopper = null;
  }
}

self.addEventListener('message', async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'load':   await load(msg); break;
      case 'ask':    await ask(msg); break;
      case 'stop':   stopper?.interrupt(); break;
      case 'unload':
        generator = null; loadedModel = null;
        self.postMessage({ type: 'unloaded' });
        break;
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      id: msg?.id ?? null,
      message: err?.message || String(err),
    });
  }
});
