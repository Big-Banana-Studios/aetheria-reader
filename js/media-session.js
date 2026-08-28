/* ═══════════════════════════════════════════════════════════════════
   MEDIA SESSION
   Speech synthesis is not media playback: it holds no audio focus, so
   the browser is free to freeze the page once it is hidden, and the
   operating system has nothing to show on the lock screen.

   Playing a loop alongside the speech fixes both. The tab counts as
   audible, which exempts it from background throttling and keeps it from
   being frozen, and an audible page is allowed to publish Media Session
   metadata — so the book appears on the lock screen and the hardware
   media keys work.

   The loop is real, audible music by default (see ambience.js). That is
   not decoration: browsers discount inaudible audio on purpose, and on
   Android a silent loop earned no focus at all — the speech engine took
   focus when it began talking and the loop was paused underneath us.
   Audible media is treated as media. Turning the volume to zero falls
   back to the near-silent loop below, which is better than nothing but
   is the arrangement that gave trouble.

   Two details decide whether this works at all:

   The loop is *near* silent rather than digitally silent, because some
   browsers treat a stream of zeroes as "nothing is playing". One
   least-significant bit is about 90 dB below full scale — inaudible, but
   unmistakably a signal.

   And it is thirty seconds long. Chrome takes audio focus only for media
   running longer than five seconds; anything shorter is written off as a
   UI sound effect and ignored outright — no focus, no media notification,
   no exemption from throttling. A short clip fails silently and looks for
   all the world like the feature simply does not work.

   There is a third problem, and it is why this needs two sources rather
   than one. On Android the speech engine takes audio focus of its own
   when it starts talking, and the browser responds by pausing our media
   element — so the loop dies the moment the reading begins, which is
   exactly when it is needed. The element is therefore restarted whenever
   something pauses it, and a Web Audio tone runs alongside it. Web Audio
   is not subject to the same focus arbitration, so it holds the tab
   audible even in the moments the element has been taken away from us.
   ═══════════════════════════════════════════════════════════════════ */

import { ambienceUrl } from './ambience.js';

const LOOP_SECONDS = 30;         // must clear Chrome's five-second floor

function silentLoopUrl(seconds = LOOP_SECONDS, sampleRate = 8000) {
  const frames = seconds * sampleRate;
  const size = 44 + frames * 2;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, size - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM header length
  view.setUint16(20, 1, true);           // format: PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  ascii(36, 'data');
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) view.setInt16(44 + i * 2, i % 2 ? 1 : -1, true);

  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

/**
 * A lock-screen line for the chapter. Headings recovered from a scan can
 * be a whole title page folded onto one line, which is no use on a phone,
 * so keep the first part and cut it short.
 */
function chapterLabel(section, title) {
  let s = (section || '').trim();
  if (!s) return title;
  if (s.length > 64) s = s.split(' — ')[0].trim();
  if (s.length > 64) s = s.slice(0, 61).replace(/\s+\S*$/, '') + '…';
  return s || title;
}

export class MediaSessionKeepAlive {
  /**
   * @param {{play:Function, pause:Function, next:Function, prev:Function}} handlers
   */
  constructor(handlers) {
    this.handlers = handlers;
    this.audio = null;
    this.url = null;
    this.book = null;
    this.registered = false;
    this.lastError = null;
    this.wanted = false;          // whether we are meant to be holding focus
    this.revivals = 0;            // times the element was paused underneath us
    this.ctx = null;
    this.toneStopper = null;
    this.keeper = null;
    this.usingMusic = false;
    this.musicEnabled = true;
    this.volume = 0.18;
    // Rendering takes a moment, so start it now rather than on first play.
    this.musicReady = ambienceUrl(LOOP_SECONDS);
  }

  /**
   * Point the element at whichever loop the settings call for: the music,
   * or the near-silent placeholder. Switching the source stops playback,
   * so it is restarted if we are meant to be holding focus.
   */
  async #applySource() {
    const audio = this.audio;
    if (!audio) return;
    const wantMusic = this.musicEnabled && this.volume > 0;

    if (wantMusic) {
      const url = await this.musicReady;
      if (!url) return;                     // still rendering; retried later
      if (!this.usingMusic) {
        audio.src = url;
        this.usingMusic = true;
      }
      audio.volume = this.volume;
    } else if (this.usingMusic) {
      audio.src = this.url;                 // back to the near-silent loop
      audio.volume = 1;                     // its samples are what is quiet
      this.usingMusic = false;
    }

    if (this.wanted && audio.paused) {
      try { await audio.play(); } catch (err) { this.lastError = err?.message || String(err); }
    }
  }

  /** @param {boolean} enabled @param {number} fraction 0–1 */
  setMusic(enabled, fraction) {
    this.musicEnabled = !!enabled;
    if (typeof fraction === 'number') this.volume = Math.max(0, Math.min(1, fraction));
    this.#applySource();
  }

  #element() {
    if (this.audio) return this.audio;
    this.url = silentLoopUrl();
    const audio = new Audio(this.url);
    this.usingMusic = false;
    audio.loop = true;
    audio.preload = 'auto';
    audio.volume = 1;                    // the samples are what is quiet
    // Keep it out of the way of the page, but attached so mobile browsers
    // treat it as real playback rather than a detached buffer.
    audio.setAttribute('aria-hidden', 'true');
    audio.style.display = 'none';

    // The speech engine grabbing focus shows up here as an ordinary pause.
    // Take it back, unless we asked for it ourselves.
    audio.addEventListener('pause', () => {
      if (!this.wanted) return;
      this.revivals++;
      audio.play().catch((err) => { this.lastError = err?.message || String(err); });
    });

    document.body.appendChild(audio);
    this.audio = audio;
    return audio;
  }

  /**
   * A Web Audio tone at roughly -86 dBFS. Inaudible, and — unlike a media
   * element — not something the platform's focus handling will pause on
   * our behalf, so the tab stays audible even while the element is being
   * wrestled over.
   */
  #startTone() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!this.ctx) this.ctx = new Ctx();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      if (this.toneStopper) return;

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      gain.gain.value = 0.00005;
      osc.frequency.value = 440;
      osc.connect(gain).connect(this.ctx.destination);
      osc.start();
      this.toneStopper = () => { try { osc.stop(); osc.disconnect(); } catch {} };
    } catch {}
  }

  #stopTone() {
    this.toneStopper?.();
    this.toneStopper = null;
    this.ctx?.suspend?.().catch(() => {});
  }

  #registerActions() {
    if (this.registered || !('mediaSession' in navigator)) return;
    const set = (action, fn) => {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch {}
    };
    set('play', () => this.handlers.play?.());
    set('pause', () => this.handlers.pause?.());
    set('nexttrack', () => this.handlers.next?.());
    set('previoustrack', () => this.handlers.prev?.());
    set('seekforward', () => this.handlers.next?.());
    set('seekbackward', () => this.handlers.prev?.());
    set('stop', () => this.handlers.pause?.());
    this.registered = true;
  }

  /**
   * Begin the silent loop. Must be reached from a user gesture — which it
   * is, since reading only ever starts from the play button.
   */
  async start() {
    this.wanted = true;
    const audio = this.#element();
    this.#registerActions();
    this.#startTone();
    try {
      if (audio.paused) await audio.play();
      this.lastError = null;
      this.#applySource();
    } catch (err) {
      // Autoplay refused: speech still works, we just lose the lock screen
      // card and the throttling exemption.
      this.lastError = err?.message || String(err);
    }
    this.#startKeeper();
    this.setPlaying(true);
  }

  stop() {
    this.wanted = false;
    this.#stopKeeper();
    this.#stopTone();
    this.setPlaying(false);
    try { this.audio?.pause(); } catch {}
  }

  /**
   * The `pause` event is not always delivered when the platform takes the
   * element away, so check on a timer as well.
   */
  #startKeeper() {
    this.#stopKeeper();
    this.keeper = setInterval(() => {
      if (!this.wanted) return;
      if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
      const a = this.audio;
      if (a && a.paused) {
        this.revivals++;
        a.play().catch((err) => { this.lastError = err?.message || String(err); });
      }
    }, 4000);
  }

  #stopKeeper() {
    if (this.keeper) { clearInterval(this.keeper); this.keeper = null; }
  }

  /** Describe the book for the lock screen and the media keys. */
  setBook({ title, author, section }) {
    this.book = { title, author, section };
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    const icon = new URL('../icons/icon-512.png', import.meta.url).href;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: chapterLabel(section, title),
        artist: author || 'Aetheria Reader',
        album: title,
        artwork: [
          { src: icon, sizes: '512x512', type: 'image/png' },
        ],
      });
    } catch {}
  }

  setPlaying(playing) {
    if (!('mediaSession' in navigator)) return;
    try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch {}
  }

  /** What the browser actually granted, for reporting to the user. */
  report() {
    const a = this.audio;
    const held = !!a && !a.paused && !a.ended;
    return {
      audioElement: !!a,
      playing: held,
      duration: a && isFinite(a.duration) ? Math.round(a.duration) : null,
      longEnough: !!a && isFinite(a.duration) && a.duration > 5,
      mediaSession: 'mediaSession' in navigator,
      metadata: !!(navigator.mediaSession?.metadata),
      playbackState: navigator.mediaSession?.playbackState ?? 'n/a',
      handlers: this.registered,
      error: this.lastError,
      revivals: this.revivals,
      toneState: this.ctx ? this.ctx.state : 'none',
      wanted: this.wanted,
      music: this.usingMusic,
      musicEnabled: this.musicEnabled,
      volume: this.volume,
    };
  }

  destroy() {
    this.stop();
    try { this.ctx?.close(); } catch {}
    this.ctx = null;
    this.audio?.remove();
    if (this.url) URL.revokeObjectURL(this.url);
    this.audio = null;
    this.url = null;
  }
}
