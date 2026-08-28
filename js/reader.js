/* ═══════════════════════════════════════════════════════════════════
   READER
   Renders a book and speaks it.

   Playback keeps several sentences queued inside the voice engine at
   once, rather than speaking one and using a timer to start the next.
   That matters: a background tab has its timers clamped, so a
   timer-driven reader falls silent the moment you switch away. With a
   queue, the engine plays straight through on its own and JavaScript
   only tops it up.

   Which engine does the speaking is up to voices.js — the browser's own,
   or Kokoro running on-device. Only the second keeps going once the page
   is hidden, so `backgroundCapable` decides whether being hidden pauses
   the reading or is simply ignored.
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
  constructor(doc, els, settings, engine) {
    super();
    this.doc = doc;
    this.els = els;
    this.settings = settings;
    this.engine = engine;

    this.sec = 0;                 // position currently being spoken
    this.sen = 0;
    this.feed = { sec: 0, sen: 0 };// position next to be queued, runs ahead
    this.playing = false;
    this.inFlight = 0;            // items handed to the engine, not yet done
    this.gen = 0;                 // bumped to disown callbacks after a flush
    this.timer = null;
    this.watchdog = null;
    this.quiet = 0;
    this.wakeLock = null;

    this.resumeOnReturn = false;

    // Browser speech is suspended outright while the page is hidden, and
    // no arrangement of audio focus changes it. Rather than die
    // mid-sentence and leave the controls insisting all is well, stop
    // cleanly and pick the same sentence back up on return. An on-device
    // voice produces ordinary audio and needs none of this.
    this.onVisibility = () => {
      if (document.hidden) {
        if (this.playing && !this.engine.backgroundCapable) {
          this.resumeOnReturn = true;
          this.stop();
          this.#emit('suspended');
        }
        return;
      }
      if (this.resumeOnReturn) {
        this.resumeOnReturn = false;
        this.play();
        this.#emit('resumed');
        return;
      }
      if (!this.playing) return;
      this.#requestWakeLock();    // a lock is dropped whenever we are hidden
      this.#pump();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
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
    if (!this.settings.autoScroll || document.hidden) return;
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

  /** Move the spoken position, discarding anything already queued. */
  #moveTo(sec, sen, rerender) {
    this.#flush();
    this.sec = sec;
    this.sen = sen;
    this.feed = { sec, sen };
    if (rerender) { this.render(); this.#emit('section'); }
    else this.highlight();
    if (this.playing) this.#pump();
  }

  goTo(sec, sen = 0) {
    this.#moveTo(Math.max(0, Math.min(sec, this.doc.length - 1)), sen, true);
  }

  select(index) { this.#moveTo(this.sec, index, false); }

  skip(dir) {
    const sentences = this.section.sentences;
    let i = this.sen + dir;
    while (i >= 0 && i < sentences.length && sentences[i] === PARA) i += dir;

    if (i >= 0 && i < sentences.length) {
      this.#moveTo(this.sec, i, false);
    } else if (dir > 0 && this.sec + 1 < this.doc.length) {
      this.#moveTo(this.sec + 1, 0, true);
    } else if (dir < 0 && this.sec > 0) {
      const prev = this.doc[this.sec - 1].sentences;
      let last = prev.length - 1;
      while (last >= 0 && prev[last] === PARA) last--;
      this.#moveTo(this.sec - 1, Math.max(0, last), true);
    }
  }

  /* ── Playback ─────────────────────────────────────────────────── */

  toggle() { this.playing ? this.stop() : this.play(); }

  play() {
    if (this.playing) return;
    this.playing = true;
    this.feed = { sec: this.sec, sen: this.sen };
    this.#emit('playing', { playing: true });
    this.#requestWakeLock();
    this.#startWatchdog();
    this.#pump();
  }

  stop() {
    if (!document.hidden) this.resumeOnReturn = false;   // a deliberate pause
    this.playing = false;
    this.#flush();
    this.#clearTimer();
    this.#stopWatchdog();
    this.#releaseWakeLock();
    this.#emit('playing', { playing: false });
  }

  /**
   * Re-queue from the sentence being spoken. Queued utterances carry the
   * speed and voice they were created with, so a change to either only
   * reaches the listener once the queue has been rebuilt.
   */
  refresh() {
    if (!this.playing) return;
    this.#flush();
    this.#clearTimer();
    this.feed = { sec: this.sec, sen: this.sen };
    this.#pump();
  }

  /** Drop everything queued and disown its callbacks. */
  #flush() {
    this.gen++;
    this.inFlight = 0;
    this.quiet = 0;
    this.engine.cancel();
  }

  #clearTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /**
   * The next sentence to speak, with any pause that should precede it.
   * Paragraph markers and section ends are stepped over here so the
   * queue can run straight across them.
   */
  #peek() {
    let { sec, sen } = this.feed;
    let pause = 0;
    for (;;) {
      const section = this.doc[sec];
      if (!section) return null;
      if (sen >= section.sentences.length) {
        if (sec + 1 >= this.doc.length) return null;
        sec++; sen = 0;
        pause = Math.max(pause, this.settings.sectionPause);
        continue;
      }
      if (section.sentences[sen] === PARA) {
        pause = Math.max(pause, this.settings.paraPause);
        sen++;
        continue;
      }
      return { sec, sen, text: section.sentences[sen], pause, next: { sec, sen: sen + 1 } };
    }
  }

  /** Keep the engine's queue topped up. */
  #pump() {
    if (!this.playing || this.timer) return;

    while (this.inFlight < this.engine.lookahead) {
      const item = this.#peek();
      if (!item) {
        if (!this.inFlight) { this.stop(); this.#emit('finished'); }
        return;
      }

      // A pause costs a timer, and a hidden tab may not run one for a
      // minute. An engine that can play buffers back to back takes its
      // pause as a gap in the schedule instead; the browser engine has to
      // skip them while hidden, or the reading stalls.
      const pause = (document.hidden && !this.engine.backgroundCapable) ? 0 : item.pause;
      if (pause > 0 && !this.engine.backgroundCapable) {
        if (this.inFlight) return;          // let what is queued play out
        this.feed = item.next;
        this.#pauseThen(item, pause);
        return;
      }

      this.feed = item.next;
      this.#enqueue(item, pause);
    }
  }

  #pauseThen(item, ms) {
    const gen = this.gen;
    this.#clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.playing || gen !== this.gen) return;
      this.#enqueue(item);
      this.#pump();
    }, ms);
  }

  #enqueue(item, gapAfter = 0) {
    const gen = this.gen;
    const chunks = this.engine.chunk(item.text);

    chunks.forEach((text, i) => {
      const last = i === chunks.length - 1;
      this.inFlight++;

      this.engine.enqueue(text, {
        rate: this.settings.rate,
        gapAfter: last ? gapAfter : 0,

        // The highlight follows what is actually being spoken, not what
        // has been queued — the two are several sentences apart.
        onStart: i === 0 ? () => {
          if (gen !== this.gen) return;
          this.quiet = 0;
          if (item.sec !== this.sec) {
            this.sec = item.sec;
            this.sen = item.sen;
            this.render();
            this.#emit('section');
          } else {
            this.sen = item.sen;
            this.highlight();
          }
        } : null,

        onEnd: () => {
          if (gen !== this.gen) return;
          this.inFlight = Math.max(0, this.inFlight - 1);
          this.#pump();
        },

        onError: (error) => {
          if (gen !== this.gen) return;
          this.inFlight = Math.max(0, this.inFlight - 1);
          this.#emit('speech-error', { error });
          this.#pump();
        },
      });
    });
  }

  /**
   * Speech engines occasionally go quiet without firing `end` or `error`.
   * If nothing is speaking or pending for two checks running, pick the
   * reading back up from the last sentence we heard start.
   */
  #startWatchdog() {
    this.#stopWatchdog();
    this.watchdog = setInterval(() => {
      if (!this.playing || this.timer) { this.quiet = 0; return; }
      if (this.engine.busy || this.inFlight) { this.quiet = 0; return; }
      if (++this.quiet < 2) return;
      this.#flush();
      this.feed = { sec: this.sec, sen: this.sen };
      this.#pump();
    }, 3000);
  }

  #stopWatchdog() {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    this.quiet = 0;
  }

  /** Keep the screen awake while reading, where the browser allows it. */
  async #requestWakeLock() {
    if (this.wakeLock || document.hidden) return;
    try {
      this.wakeLock = await navigator.wakeLock?.request('screen') ?? null;
      this.wakeLock?.addEventListener('release', () => { this.wakeLock = null; });
    } catch { this.wakeLock = null; }
  }

  #releaseWakeLock() {
    try { this.wakeLock?.release(); } catch {}
    this.wakeLock = null;
  }

  destroy() {
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}
