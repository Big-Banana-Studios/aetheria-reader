/* ═══════════════════════════════════════════════════════════════════
   READER
   Renders a book and speaks it. Playback is one small state machine:
   speak the current sentence, then advance, pausing a little longer at
   paragraph breaks and longer still when crossing into a new section.
   ═══════════════════════════════════════════════════════════════════ */

const PARA = '¶';

/** Split a paragraph into sentences, tolerating abbreviations. */
export function splitSentences(text) {
  if (!text.trim()) return [];
  const raw = text.match(/(?:[^.!?…]|\.(?=[a-z]|[A-Z]\.|\d))*[.!?…]+["'")\]]?\s*/g) || [text];
  return raw.map((s) => s.trim()).filter((s) => s.length > 2);
}

/** Convert stored sections { h, p[] } into renderable sentence lists. */
export function toReaderDoc(sections) {
  return sections.map((s) => {
    const sentences = [];
    for (const para of s.p) {
      const parts = splitSentences(para);
      if (!parts.length) continue;
      sentences.push(...parts, PARA);
    }
    while (sentences.length && sentences[sentences.length - 1] === PARA) sentences.pop();
    return { heading: s.h, sentences };
  }).filter((s) => s.sentences.length);
}

export const countSentences = (section) =>
  section.sentences.reduce((a, s) => a + (s === PARA ? 0 : 1), 0);

export class Reader extends EventTarget {
  /**
   * @param {{heading:string,sentences:string[]}[]} doc
   * @param {{body:HTMLElement, heading:HTMLElement, scroller:HTMLElement}} els
   * @param {object} settings
   */
  constructor(doc, els, settings) {
    super();
    this.doc = doc;
    this.els = els;
    this.settings = settings;
    this.sec = 0;
    this.sen = 0;
    this.playing = false;
    this.timer = null;
    this.keepAlive = null;
  }

  #emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }

  get section() { return this.doc[this.sec]; }

  /* ── Rendering ────────────────────────────────────────────────── */

  render() {
    const section = this.section;
    if (!section) return;
    this.els.heading.textContent = section.heading;

    const frag = document.createDocumentFragment();
    section.sentences.forEach((s, i) => {
      if (s === PARA) {
        const br = document.createElement('div');
        br.className = 'para-break';
        frag.appendChild(br);
        return;
      }
      const span = document.createElement('span');
      span.className = 'sentence' + (i === this.sen ? ' active' : '');
      span.textContent = s + ' ';
      span.dataset.idx = i;
      frag.appendChild(span);
    });

    this.els.body.replaceChildren(frag);
    this.els.body.style.fontSize = this.settings.fontSize + 'px';
    this.#emit('position');
    this.scrollToActive();
  }

  highlight() {
    for (const el of this.els.body.querySelectorAll('.sentence')) {
      el.classList.toggle('active', Number(el.dataset.idx) === this.sen);
    }
    this.scrollToActive();
    this.#emit('position');
  }

  scrollToActive() {
    if (!this.settings.autoScroll) return;
    const active = this.els.body.querySelector('.sentence.active');
    active?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /** Fraction of the whole book already read, 0–1. */
  progress() {
    const total = this.doc.reduce((a, s) => a + countSentences(s), 0);
    if (!total) return 0;
    let done = 0;
    for (let i = 0; i < this.sec; i++) done += countSentences(this.doc[i]);
    done += this.section.sentences.slice(0, this.sen).filter((s) => s !== PARA).length;
    return done / total;
  }

  /* ── Navigation ───────────────────────────────────────────────── */

  goTo(sec, sen = 0) {
    this.#clearTimer();
    speechSynthesis.cancel();
    this.sec = Math.max(0, Math.min(sec, this.doc.length - 1));
    this.sen = sen;
    this.render();
    this.#emit('section');
    if (this.playing) this.#schedule(this.settings.sectionPause);
  }

  select(index) {
    this.#clearTimer();
    speechSynthesis.cancel();
    this.sen = index;
    this.highlight();
    if (this.playing) this.#schedule(80);
  }

  skip(dir) {
    this.#clearTimer();
    speechSynthesis.cancel();
    const sentences = this.section.sentences;

    let i = this.sen + dir;
    while (i >= 0 && i < sentences.length && sentences[i] === PARA) i += dir;

    if (i >= 0 && i < sentences.length) {
      this.sen = i;
      this.highlight();
    } else if (dir > 0 && this.sec + 1 < this.doc.length) {
      this.sec++; this.sen = 0;
      this.render(); this.#emit('section');
    } else if (dir < 0 && this.sec > 0) {
      this.sec--;
      const prev = this.section.sentences;
      let last = prev.length - 1;
      while (last >= 0 && prev[last] === PARA) last--;
      this.sen = Math.max(0, last);
      this.render(); this.#emit('section');
    }
    if (this.playing) this.#schedule(80);
  }

  /* ── Playback ─────────────────────────────────────────────────── */

  toggle() { this.playing ? this.stop() : this.play(); }

  play() {
    this.playing = true;
    this.#emit('playing', { playing: true });
    this.#startKeepAlive();
    this.#schedule(50);
  }

  stop() {
    this.playing = false;
    this.#clearTimer();
    this.#stopKeepAlive();
    speechSynthesis.cancel();
    this.#emit('playing', { playing: false });
  }

  #clearTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  #schedule(delay) {
    this.#clearTimer();
    this.timer = setTimeout(() => { this.timer = null; this.#speak(); }, delay);
  }

  #speak() {
    if (!this.playing) return;
    const sentences = this.section.sentences;

    // Step over paragraph markers before speaking
    while (this.sen < sentences.length && sentences[this.sen] === PARA) this.sen++;

    if (this.sen >= sentences.length) return this.#nextSection();

    this.highlight();
    const utter = new SpeechSynthesisUtterance(sentences[this.sen]);
    utter.rate = this.settings.rate;
    const voice = this.getVoice?.();
    if (voice) { utter.voice = voice; utter.lang = voice.lang; }

    utter.onend = () => {
      if (!this.playing) return;
      // A paragraph marker directly ahead earns the longer pause
      const breakAhead = sentences[this.sen + 1] === PARA;
      this.sen++;
      if (this.sen >= sentences.length) return this.#nextSection();
      this.#schedule(breakAhead ? this.settings.paraPause : 60);
    };

    utter.onerror = (e) => {
      if (e.error === 'canceled' || e.error === 'interrupted') return;
      this.#emit('speech-error', { error: e.error });
      this.stop();
    };

    speechSynthesis.speak(utter);
  }

  #nextSection() {
    if (this.sec + 1 < this.doc.length) {
      this.sec++; this.sen = 0;
      this.render();
      this.#emit('section');
      this.#schedule(this.settings.sectionPause);
    } else {
      this.stop();
      this.#emit('finished');
    }
  }

  /**
   * Chrome stops speaking after roughly fifteen seconds unless the queue
   * is nudged. Pausing and resuming on a timer keeps it alive without
   * affecting the audio.
   */
  #startKeepAlive() {
    this.#stopKeepAlive();
    this.keepAlive = setInterval(() => {
      if (!this.playing) return;
      if (speechSynthesis.speaking && !speechSynthesis.paused) {
        speechSynthesis.pause();
        speechSynthesis.resume();
      }
    }, 10000);
  }

  #stopKeepAlive() {
    if (this.keepAlive) { clearInterval(this.keepAlive); this.keepAlive = null; }
  }

  destroy() {
    this.stop();
    this.#stopKeepAlive();
  }
}
