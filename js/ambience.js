/* ═══════════════════════════════════════════════════════════════════
   AMBIENCE
   A soft loop to read over — and, less romantically, the thing that
   makes background playback work at all.

   Browsers deliberately discount inaudible audio: a silent loop earns no
   audio focus, no media notification and no exemption from background
   throttling. Real, audible music is treated as real media, so the page
   holds focus properly and keeps reading when the screen goes off.

   Nothing is downloaded. The loop is synthesised once, offline, and
   encoded to a WAV the audio element can play on repeat: a slow warm
   chord progression under a low-pass filter, with a little noise for
   texture. The last seconds are cross-faded into the first so it comes
   round without a seam.
   ═══════════════════════════════════════════════════════════════════ */

const SAMPLE_RATE = 22050;       // lo-fi in the literal sense, and half the bytes
const XFADE = 3;                 // seconds blended end-to-start for a clean loop

// Four bars of something calm and unremarkable. Deliberately unmemorable:
// this plays for hours under someone else's words.
const PROGRESSION = [
  [146.83, 174.61, 220.00, 261.63],   // Dm7
  [116.54, 146.83, 174.61, 220.00],   // B♭maj7
  [ 87.31, 110.00, 130.81, 164.81],   // Fmaj7
  [ 98.00, 116.54, 146.83, 174.61],   // Gm7
];

function noiseBuffer(ctx, seconds) {
  const buf = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    // Brown-ish noise: softer and less hissy than white
    last = (last + Math.random() * 2 - 1) * 0.5;
    data[i] = last * 0.5;
  }
  return buf;
}

/** Render the loop into an AudioBuffer. */
async function renderLoop(seconds) {
  const total = seconds + XFADE;
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Offline(1, Math.ceil(total * SAMPLE_RATE), SAMPLE_RATE);

  const master = ctx.createGain();
  master.gain.value = 0.5;

  // One warm filter over everything, drifting slowly so the loop breathes
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 900;
  tone.Q.value = 0.6;
  const drift = ctx.createOscillator();
  const driftDepth = ctx.createGain();
  drift.frequency.value = 1 / 17;          // one slow sweep, unrelated to the bars
  driftDepth.gain.value = 320;
  drift.connect(driftDepth).connect(tone.frequency);
  drift.start();

  tone.connect(master).connect(ctx.destination);

  const bar = total / PROGRESSION.length;
  PROGRESSION.forEach((chord, index) => {
    const at = index * bar;
    chord.forEach((freq, voice) => {
      const osc = ctx.createOscillator();
      osc.type = voice === 0 ? 'sine' : 'triangle';
      // A few cents of detune keeps it from sounding like a test tone
      osc.frequency.value = freq * (1 + (voice - 1.5) * 0.0009);

      const env = ctx.createGain();
      const peak = 0.16 / (voice + 1.4);
      env.gain.setValueAtTime(0.0001, at);
      env.gain.exponentialRampToValueAtTime(peak, at + 1.8);
      env.gain.setValueAtTime(peak, at + bar - 1.4);
      env.gain.exponentialRampToValueAtTime(0.0001, at + bar + 0.9);

      osc.connect(env).connect(tone);
      osc.start(at);
      osc.stop(at + bar + 1.2);
    });
  });

  // Vinyl-ish texture, well under the pad
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx, total);
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.value = 1400;
  noiseFilter.Q.value = 0.4;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0.05;
  noise.connect(noiseFilter).connect(noiseGain).connect(master);
  noise.start(0);

  return ctx.startRendering();
}

/**
 * Fold the overhanging tail back over the opening so the loop joins
 * cleanly, and return exactly `seconds` of audio.
 */
function seamless(rendered, seconds) {
  const src = rendered.getChannelData(0);
  const length = Math.floor(seconds * SAMPLE_RATE);
  const fade = Math.floor(XFADE * SAMPLE_RATE);
  const out = new Float32Array(length);
  out.set(src.subarray(0, length));

  for (let i = 0; i < fade && length + i < src.length; i++) {
    const t = i / fade;                     // equal-power crossfade
    out[i] = out[i] * Math.sqrt(t) + src[length + i] * Math.sqrt(1 - t);
  }
  return out;
}

function encodeWav(samples, sampleRate) {
  const size = 44 + samples.length * 2;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, size - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

let cached = null;

/**
 * A blob URL for the ambience loop. Rendered once and reused; takes a
 * moment the first time, so it is kicked off as soon as the app loads
 * rather than when someone presses play.
 */
export function ambienceUrl(seconds = 30) {
  if (!cached) {
    cached = renderLoop(seconds)
      .then((rendered) => URL.createObjectURL(encodeWav(seamless(rendered, seconds), SAMPLE_RATE)))
      .catch(() => null);
  }
  return cached;
}
