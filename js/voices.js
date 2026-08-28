/* ═══════════════════════════════════════════════════════════════════
   VOICES
   Two ways of speaking a sentence, behind one interface so the reader
   does not care which is in use.

   SystemVoice   the browser's own engine. Free, instant, every voice
                 installed on the device — but switched off the moment
                 the page is hidden, so it cannot read in the background.

   NeuralVoice   Kokoro-82M, downloaded once and run on-device. Produces
                 real audio, which plays on with the screen off like any
                 other media. Costs a download and some work per sentence.

   Interface:
     lookahead            how many items to keep queued
     backgroundCapable    whether reading survives the page being hidden
     chunk(text)          split a sentence if the engine needs it
     enqueue(text, opts)  opts: { rate, gapAfter, onStart, onEnd, onError }
     cancel()             drop everything queued
     busy                 is anything playing or waiting
   ═══════════════════════════════════════════════════════════════════ */

const MAX_UTTER_CHARS = 200;     // browser engines drop very long utterances

/**
 * Break an over-long sentence at a clause boundary. Speech engines drop
 * an utterance that runs past about fifteen seconds, and these
 * translations contain some enormous Victorian sentences.
 */
function chunkText(text) {
  if (text.length <= MAX_UTTER_CHARS) return [text];
  const out = [];
  let rest = text;
  while (rest.length > MAX_UTTER_CHARS) {
    const window = rest.slice(0, MAX_UTTER_CHARS);
    let cut = Math.max(
      window.lastIndexOf('; '), window.lastIndexOf(', '),
      window.lastIndexOf(': '), window.lastIndexOf(' — '));
    if (cut > MAX_UTTER_CHARS * 0.4) cut += 1;
    else cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = MAX_UTTER_CHARS;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/* ── The browser's own engine ───────────────────────────────────── */

export class SystemVoice {
  constructor(getVoice) {
    this.getVoice = getVoice;
    this.live = [];              // references kept: see note below
  }

  get id() { return 'system'; }
  get lookahead() { return 4; }
  get backgroundCapable() { return false; }
  async prepare() {}
  chunk(text) { return chunkText(text); }

  enqueue(text, { rate, onStart, onEnd, onError }) {
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = rate;
    const voice = this.getVoice?.();
    if (voice) { utter.voice = voice; utter.lang = voice.lang; }

    const drop = () => {
      const at = this.live.indexOf(utter);
      if (at >= 0) this.live.splice(at, 1);
    };
    utter.onstart = () => onStart?.();
    utter.onend = () => { drop(); onEnd?.(); };
    utter.onerror = (e) => {
      drop();
      if (e.error === 'canceled' || e.error === 'interrupted') return;
      onError?.(e.error);
    };

    // Chrome stops speaking if an utterance is collected before it
    // finishes, so every one is held until it is done with.
    this.live.push(utter);
    speechSynthesis.speak(utter);
  }

  cancel() {
    this.live.length = 0;
    speechSynthesis.cancel();
  }

  get busy() { return speechSynthesis.speaking || speechSynthesis.pending; }

  destroy() { this.cancel(); }
}

/* ── Kokoro, on-device ──────────────────────────────────────────── */

export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// Only the British and best-graded American voices: the full set of 54 is
// more choice than it is help. Grades are the model card's own.
export const KOKORO_VOICES = [
  { id: 'bf_emma',     label: 'Emma — British',      grade: 'B−' },
  { id: 'bf_isabella', label: 'Isabella — British',  grade: 'C'  },
  { id: 'bf_alice',    label: 'Alice — British',     grade: 'D'  },
  { id: 'bf_lily',     label: 'Lily — British',      grade: 'D'  },
  { id: 'bm_george',   label: 'George — British',    grade: 'C'  },
  { id: 'bm_fable',    label: 'Fable — British',     grade: 'C'  },
  { id: 'bm_daniel',   label: 'Daniel — British',    grade: 'D'  },
  { id: 'bm_lewis',    label: 'Lewis — British',     grade: 'D+' },
  { id: 'af_heart',    label: 'Heart — American',    grade: 'A'  },
  { id: 'af_bella',    label: 'Bella — American',    grade: 'A−' },
  { id: 'am_michael',  label: 'Michael — American',  grade: 'C+' },
  { id: 'am_fenrir',   label: 'Fenrir — American',   grade: 'C+' },
];

export const KOKORO_BUILDS = [
  { dtype: 'fp32',  device: 'webgpu', size: '310 MB', label: 'Best quality' },
  { dtype: 'fp16',  device: 'webgpu', size: '156 MB', label: 'Balanced' },
  { dtype: 'q8',    device: 'wasm',   size: ' 82 MB', label: 'Smallest (CPU)' },
];

export const hasWebGPU = () => 'gpu' in navigator && !!navigator.gpu;

export class NeuralVoice extends EventTarget {
  constructor(voiceId = 'bf_emma') {
    super();
    this.voiceId = voiceId;
    this.worker = null;
    this.ctx = null;
    this.gain = null;
    this.el = null;
    this.ready = false;
    this.nextId = 1;
    this.pending = new Map();    // id -> callbacks awaiting audio
    this.playing = new Set();    // scheduled sources not yet finished
    this.nextTime = 0;           // context time the next buffer starts at
    this.gen = 0;
    this.lastError = null;
  }

  get id() { return 'neural'; }
  // A deeper queue than the browser engine: each sentence must be
  // synthesised before it can be scheduled, so we want more runway.
  get lookahead() { return 6; }
  get backgroundCapable() { return true; }
  chunk(text) { return [text]; }        // Kokoro splits long text itself

  #emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }

  /* ── Output ───────────────────────────────────────────────────── */

  /**
   * Audio goes out through a MediaStream attached to an audio element
   * rather than straight to the speakers. An element playing a stream is
   * unambiguously media as far as the platform is concerned, which is the
   * whole reason for doing any of this.
   */
  #openOutput() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.gain = this.ctx.createGain();

    try {
      const dest = this.ctx.createMediaStreamDestination();
      this.gain.connect(dest);
      const el = new Audio();
      el.srcObject = dest.stream;
      el.autoplay = true;
      el.style.display = 'none';
      document.body.appendChild(el);
      el.play().catch((err) => {
        // If the stream route is refused, fall back to the speakers.
        this.lastError = err?.message || String(err);
        try { this.gain.connect(this.ctx.destination); } catch {}
      });
      this.el = el;
    } catch {
      this.gain.connect(this.ctx.destination);
    }
  }

  async resume() {
    this.#openOutput();
    if (this.ctx?.state === 'suspended') { try { await this.ctx.resume(); } catch {} }
    if (this.el?.paused) { try { await this.el.play(); } catch {} }
  }

  /* ── Model ────────────────────────────────────────────────────── */

  #ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });

    this.worker.addEventListener('message', (e) => {
      const m = e.data;
      switch (m.type) {
        case 'load-start':    this.#emit('load-start', m); break;
        case 'load-progress': this.#emit('load-progress', m); break;
        case 'ready':
          this.ready = true;
          this.#emit('ready', m);
          break;
        case 'audio': {
          const cbs = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (cbs && cbs.gen === this.gen) this.#schedule(m.pcm, m.sampleRate, cbs);
          break;
        }
        case 'synth-error': {
          const cbs = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (cbs && cbs.gen === this.gen) cbs.onError?.(m.message);
          break;
        }
        case 'error':
          this.lastError = m.message;
          this.#emit('error', m);
          break;
      }
    });

    this.worker.addEventListener('error', (e) => {
      this.lastError = e.message || 'The voice worker failed to start.';
      this.#emit('error', { message: this.lastError });
    });

    return this.worker;
  }

  /** Download (first time) and initialise the model. */
  async prepare({ dtype, device } = {}) {
    if (this.ready) return;
    const build = dtype && device ? { dtype, device }
      : hasWebGPU() ? { dtype: 'fp32', device: 'webgpu' } : { dtype: 'q8', device: 'wasm' };

    this.#openOutput();
    this.#ensureWorker().postMessage({ type: 'load', model: KOKORO_MODEL, ...build });

    await new Promise((resolve, reject) => {
      const ok = () => { off(); resolve(); };
      const bad = (e) => { off(); reject(new Error(e.detail?.message || 'The voice failed to load.')); };
      const off = () => {
        this.removeEventListener('ready', ok);
        this.removeEventListener('error', bad);
      };
      this.addEventListener('ready', ok);
      this.addEventListener('error', bad);
    });
  }

  /* ── Speaking ─────────────────────────────────────────────────── */

  enqueue(text, { rate, gapAfter = 0, onStart, onEnd, onError }) {
    const id = this.nextId++;
    this.pending.set(id, { gen: this.gen, gapAfter, onStart, onEnd, onError });
    this.#ensureWorker().postMessage({
      type: 'synth', id, text, voice: this.voiceId, speed: rate ?? 1,
    });
  }

  /**
   * Hand a finished buffer to the audio clock. Once scheduled, playback is
   * the audio thread's problem — it happens whether or not JavaScript is
   * being throttled, which is what lets reading continue in the background.
   */
  #schedule(pcm, sampleRate, cbs) {
    const ctx = this.ctx;
    if (!ctx || !pcm.length) { cbs.onEnd?.(); return; }

    const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
    buffer.copyToChannel(pcm, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    const startAt = Math.max(this.nextTime, ctx.currentTime + 0.08);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration + (cbs.gapAfter / 1000);

    const gen = this.gen;
    this.playing.add(source);
    source.onended = () => {
      this.playing.delete(source);
      if (gen === this.gen) cbs.onEnd?.();
    };

    if (cbs.onStart) {
      const delay = Math.max(0, (startAt - ctx.currentTime) * 1000);
      setTimeout(() => { if (gen === this.gen) cbs.onStart(); }, delay);
    }
  }

  cancel() {
    this.gen++;
    this.pending.clear();
    this.worker?.postMessage({ type: 'cancel' });
    for (const source of this.playing) { try { source.stop(); } catch {} }
    this.playing.clear();
    this.nextTime = 0;
  }

  get busy() {
    if (this.playing.size || this.pending.size) return true;
    // Everything scheduled has not necessarily finished sounding yet
    return !!this.ctx && this.nextTime > this.ctx.currentTime;
  }

  report() {
    return {
      ready: this.ready,
      voice: this.voiceId,
      context: this.ctx?.state ?? 'none',
      element: this.el ? (this.el.paused ? 'paused' : 'playing') : 'none',
      queued: this.pending.size,
      sounding: this.playing.size,
      error: this.lastError,
    };
  }

  destroy() {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
    this.el?.remove();
    try { this.ctx?.close(); } catch {}
    this.ctx = null;
    this.ready = false;
  }
}
