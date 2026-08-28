/* ═══════════════════════════════════════════════════════════════════
   AI BRIDGE
   Owns the worker, the model catalogue and the prompts. The reader asks
   it about whatever passage is on screen; everything runs on-device.
   ═══════════════════════════════════════════════════════════════════ */

export const MODELS = [
  {
    id: 'onnx-community/LFM2-350M-ONNX',
    label: 'LFM2 350M',
    size: '~255 MB',
    note: 'Fastest. Fine for plain-language paraphrase.',
  },
  {
    id: 'onnx-community/LFM2-700M-ONNX',
    label: 'LFM2 700M',
    size: '~496 MB',
    note: 'Balanced. Handles Pali and Sanskrit terms noticeably better.',
  },
  {
    id: 'onnx-community/LFM2-1.2B-ONNX',
    label: 'LFM2 1.2B',
    size: '~760 MB',
    note: 'Most capable. Best on dense doctrinal passages.',
  },
];

const SYSTEM_PROMPT = [
  'You are a reading companion for a library of classic Buddhist texts,',
  'most of them English translations printed between 1830 and 1935.',
  'The reader is listening to the book aloud and has paused to ask about',
  'the passage in front of them.',
  '',
  'Answer only from the passage you are given. Explain plainly and',
  'briefly — a short paragraph, not an essay. Gloss Pali and Sanskrit',
  'terms the first time they appear. Where the translation uses archaic',
  'or Victorian phrasing, say what it means in ordinary modern English.',
  'If the passage is too garbled or too fragmentary to interpret — these',
  'are scanned books and the text is sometimes imperfect — say so rather',
  'than inventing a reading.',
].join(' ');

export const hasWebGPU = () => 'gpu' in navigator && !!navigator.gpu;

export class Assistant extends EventTarget {
  constructor() {
    super();
    this.worker = null;
    this.state = 'idle';        // idle | loading | ready | error
    this.model = null;
    this.device = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  #ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });

    this.worker.addEventListener('message', (e) => {
      const m = e.data;
      switch (m.type) {
        case 'load-start':
          this.device = m.device;
          this.#emit('load-start', m);
          break;
        case 'load-progress':
          this.#emit('load-progress', m);
          break;
        case 'ready':
          this.state = 'ready';
          this.model = m.model;
          this.device = m.device;
          this.#emit('ready', m);
          break;
        case 'token': {
          const p = this.pending.get(m.id);
          if (p) { p.text += m.text; p.onToken?.(m.text, p.text); }
          break;
        }
        case 'done': {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          p?.resolve(m.text || p.text);
          break;
        }
        case 'error': {
          if (m.id != null && this.pending.has(m.id)) {
            const p = this.pending.get(m.id);
            this.pending.delete(m.id);
            p.reject(new Error(m.message));
          } else {
            this.state = 'error';
            this.#emit('error', m);
          }
          break;
        }
      }
    });

    this.worker.addEventListener('error', (e) => {
      this.state = 'error';
      this.#emit('error', { message: e.message || 'The assistant worker failed to start.' });
    });

    return this.worker;
  }

  /** Download (first time) and initialise a model. */
  async load(modelId) {
    if (this.state === 'ready' && this.model === modelId) return;
    this.state = 'loading';
    this.#ensureWorker().postMessage({ type: 'load', model: modelId, dtype: 'q4f16' });

    await new Promise((resolve, reject) => {
      const ok = () => { cleanup(); resolve(); };
      const bad = (e) => { cleanup(); reject(new Error(e.detail?.message || 'Model failed to load.')); };
      const cleanup = () => {
        this.removeEventListener('ready', ok);
        this.removeEventListener('error', bad);
      };
      this.addEventListener('ready', ok);
      this.addEventListener('error', bad);
    });
  }

  /** Ask a question. Returns the full answer; streams via onToken. */
  ask(messages, onToken, maxTokens) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onToken, text: '' });
      this.#ensureWorker().postMessage({ type: 'ask', id, messages, maxTokens });
    });
  }

  stop() {
    this.worker?.postMessage({ type: 'stop' });
  }
}

/* ── Prompt construction ────────────────────────────────────────── */

/**
 * Build the passage the model reasons over: the sentence being read plus
 * enough either side to make it intelligible, without burying a small
 * model in context.
 */
export function buildPassage(section, index, span = 6) {
  const sentences = section.sentences.filter((s) => s !== '¶');
  const flatIndex = section.sentences.slice(0, index + 1).filter((s) => s !== '¶').length - 1;
  const from = Math.max(0, flatIndex - span);
  const to = Math.min(sentences.length, flatIndex + span + 1);

  return {
    focus: sentences[flatIndex] || '',
    context: sentences.slice(from, to).join(' '),
  };
}

export function explainMessages(book, section, passage) {
  const where = [book.title, book.author, section.heading]
    .filter(Boolean).join(' · ');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `From "${where}".\n\n` +
        `PASSAGE:\n${passage.context}\n\n` +
        `The reader has stopped on this sentence:\n"${passage.focus}"\n\n` +
        `Explain what this is saying.`,
    },
  ];
}

export function questionMessages(book, section, passage, question) {
  const where = [book.title, book.author, section.heading]
    .filter(Boolean).join(' · ');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `From "${where}".\n\n` +
        `PASSAGE:\n${passage.context}\n\n` +
        `Question: ${question}`,
    },
  ];
}
