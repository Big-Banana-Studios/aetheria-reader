/* ═══════════════════════════════════════════════════════════════════
   TTS WORKER
   Runs Kokoro-82M on-device and hands back raw audio.

   The point of generating speech ourselves is that the result is real
   audio. The browser's own speech engine is switched off the moment the
   page is hidden — no arrangement of audio focus changes that — whereas
   audio we produce plays on like any other media, screen off and all.

   Synthesis happens one sentence at a time, in request order, so the
   player can simply schedule buffers as they arrive.
   ═══════════════════════════════════════════════════════════════════ */

const KOKORO = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';

let tts = null;
let loadedKey = null;
let generation = 0;          // bumped by cancel, to drop work already queued
let chain = Promise.resolve();

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

async function load({ model, dtype, device }) {
  const key = `${model}|${dtype}|${device}`;
  if (tts && loadedKey === key) {
    self.postMessage({ type: 'ready', device, dtype });
    return;
  }

  const { KokoroTTS } = await import(KOKORO);
  self.postMessage({ type: 'load-start', device, dtype });

  tts = await KokoroTTS.from_pretrained(model, {
    dtype, device,
    progress_callback: progressReporter(),
  });
  loadedKey = key;
  self.postMessage({ type: 'ready', device, dtype });
}

async function synth({ id, text, voice, speed, gen }) {
  if (!tts) {
    self.postMessage({ type: 'synth-error', id, message: 'The voice is not loaded yet.' });
    return;
  }
  if (gen !== generation) return;              // cancelled while queued

  try {
    const audio = await tts.generate(text, { voice, speed });
    if (gen !== generation) return;            // cancelled while generating

    // RawAudio: Float32Array samples plus its rate. Transferred, not copied.
    const pcm = audio.audio instanceof Float32Array
      ? audio.audio
      : new Float32Array(audio.audio);
    self.postMessage(
      { type: 'audio', id, pcm, sampleRate: audio.sampling_rate },
      [pcm.buffer],
    );
  } catch (err) {
    if (gen !== generation) return;
    self.postMessage({ type: 'synth-error', id, message: err?.message || String(err) });
  }
}

self.addEventListener('message', (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'load':
      chain = chain.then(() => load(msg)).catch((err) =>
        self.postMessage({ type: 'error', message: err?.message || String(err) }));
      break;

    case 'synth':
      // Queue behind whatever is already synthesising, so audio comes back
      // in the order it was asked for.
      chain = chain.then(() => synth({ ...msg, gen: generation })).catch(() => {});
      break;

    case 'cancel':
      generation++;
      break;

    case 'voices':
      self.postMessage({ type: 'voices', voices: tts ? tts.list_voices() : null });
      break;
  }
});
