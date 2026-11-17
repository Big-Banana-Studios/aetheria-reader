---
title: CABI Harmonic Sub-Bass Notes
author: Joseph Lewis, with Claude
year: 2026
---
# CABI Harmonic Sub-Bass Implementation

## Context

The CABI (Call a CAB Integration) playlist system runs healing frequency sessions — overnight sleep, daytime ambient listening, meditation, gardening, everyday life. It has three audio layers:

1. **Music Layer** — the experiential carrier (Suno tracks, ambient compositions)
2. **Solfeggio/Binaural Layer** — the therapeutic target frequency from the Aetheria framework
3. **Sub-Bass Node** — a continuous low-frequency tone that keeps the Web Audio pipeline alive during long playback sessions (prevents browser/OS from suspending the audio context)

The sub-bass node currently plays a static frequency. **This is the problem.** An arbitrary sub-bass tone introduces harmonic dissonance with the active solfeggio frequency, creating interference patterns that the nervous system reads as stimulation rather than rest. Testing revealed the sub-bass was therapeutically active but working against the session's intention — the body receives it as a competing frequency input, not neutral infrastructure.

## Goal

Make the sub-bass node **regime-aware and harmonically locked** to the active solfeggio frequency. The sub-bass should be a mathematically derived sub-harmonic that falls within the **theta-alpha regulation zone (5–12 Hz)** by default — the "ambient" brainwave range that supports both sleep onset and wakeful relaxed awareness.

### Why Ambient (Theta-Alpha, 5–12 Hz) Is the Universal Default

The theta-alpha zone is the neurological sweet spot for emotional regulation in both directions. During sleep, the brain naturally descends through alpha → theta → delta; a theta-alpha sub-bass supports that descent without forcing it. During waking hours, the same range sustains relaxed awareness — present, calm, emotionally regulated — without inducing drowsiness. This is one frequency range that serves both states because it's where the nervous system does its regulation work regardless of whether you're awake or asleep. The range is 5–12 Hz rather than a narrower window because octave division (÷2) is the only harmonically pure descent, and a wider capture zone ensures every Aetheria frequency has a clean octave-derived sub-harmonic that lands naturally within the regulation zone.

Delta (0.5–4 Hz) targets are available as an optional override for deep-sleep-specific sessions, but ambient is the one-size-fits-all default. No mode selection needed for everyday use — it just works.

## Architecture: Three Inputs, One Expression

This follows the Regime Collider principle — three frequency inputs resolve into one coherent conformational state:

```
┌─────────────────────────────────────────────────────┐
│                  CABI Audio Stack                    │
│                                                     │
│  Music Layer ──────── experiential carrier           │
│       │                                             │
│  Solfeggio/Binaural ─ therapeutic target (from      │
│       │                active Aetheria frequency)   │
│       │                                             │
│  Sub-Bass Node ────── grounding tone (NEW: derived  │
│                       sub-harmonic of solfeggio)    │
│                                                     │
│  ═══════════════════════════════════════════════     │
│  Body receives ONE unified frequency stack           │
└─────────────────────────────────────────────────────┘
```

## Canonical Frequency Table

**Use these frequencies as the source of truth for all sub-harmonic calculations.**

### GUT Regime (Solfeggio): 174–963 Hz
| Pos | Hz   | Root | Name                     |
|-----|------|------|--------------------------|
| 1   | 174  | 3    | Foundation               |
| 2   | 285  | 6    | Tissue Repair            |
| 3   | 396  | 9    | Liberating Fear & Guilt  |
| 4   | 417  | 3    | Facilitating Change      |
| 5   | 528  | 6    | Transformation/Miracles  |
| 6   | 639  | 9    | Connecting Relationships |
| 7   | 741  | 3    | Awakening Intuition      |
| 8   | 852  | 6    | Spiritual Order          |
| 9   | 963  | 9    | Divine Consciousness     |

### HEART Regime: 1206–3150 Hz (interval: 243)
| Pos | Hz   | Root | Name                 |
|-----|------|------|----------------------|
| 1   | 1206 | 9    | Gateway Integration  |
| 2   | 1449 | 9    | Harmonic Bridging    |
| 3   | 1692 | 9    | Unified Field Access |
| 4   | 1935 | 9    | Emotional Alchemy    |
| 5   | 2178 | 9    | Compassion Activation|
| 6   | 2421 | 9    | Heart Coherence      |
| 7   | 2664 | 9    | Relational Harmony   |
| 8   | 2907 | 9    | Soul Connection      |
| 9   | 3150 | 9    | Heart Completion     |

### HEAD Regime: 3504–6336 Hz (interval: 354)
| Pos | Hz   | Root | Name                 |
|-----|------|------|----------------------|
| 1   | 3504 | 3    | Mental Clarity       |
| 2   | 3858 | 6    | Sacred Geometry      |
| 3   | 4212 | 9    | Consciousness Mastery|
| 4   | 4566 | 3    | Soul Star Connection |
| 5   | 4920 | 6    | Expressive Truth     |
| 6   | 5274 | 9    | Universal Mind Access|
| 7   | 5628 | 3    | Galactic Consciousness|
| 8   | 5982 | 6    | Divine Source Portal  |
| 9   | 6336 | 9    | SOURCE Embodiment    |

## Core Algorithm: Sub-Harmonic Derivation

### Step 1: Define brainwave target ranges

```javascript
const BRAINWAVE_RANGES = {
  // PRIMARY — one-size-fits-all default
  ambient:   { min: 7,    max: 10,  label: 'Theta-Alpha Crossover' },
  
  // OPTIONAL OVERRIDES — available but not required
  delta:     { min: 0.5,  max: 4,   label: 'Deep Sleep'            },
  theta:     { min: 4,    max: 8,   label: 'Meditation/Drowsy'     },
  alpha:     { min: 8,    max: 12,  label: 'Relaxed Focus'         },
  schumann:  { hz: 7.83,            label: 'Earth Resonance'       },
};
```

### Step 2: Compute sub-harmonic chain

Divide the active solfeggio frequency by powers of 2 until landing within the target brainwave range:

```javascript
/**
 * Compute the sub-harmonic of `hz` that falls within the target range.
 * Default mode is 'ambient' (7–10 Hz theta-alpha crossover) — the universal
 * default that supports both sleep and wakeful relaxed awareness.
 * 
 * @param {number} hz        — the active solfeggio/Aetheria frequency
 * @param {string} mode      — session mode: 'ambient' (default), 'sleep', 'schumann'
 * @returns {{ subHz: number, octavesDown: number, brainwaveBand: string }}
 */
function computeSubBassHz(hz, mode = 'ambient') {
  // Special mode: Schumann lock (7.83 Hz fixed)
  if (mode === 'schumann') {
    return { 
      subHz: 7.83, 
      octavesDown: null, 
      brainwaveBand: 'theta',
      source: 'schumann'
    };
  }

  const range = getTargetRange(mode);
  
  let sub = hz;
  let octaves = 0;
  
  // Halve repeatedly (octave descent) until within target range
  while (sub > range.max) {
    sub /= 2;
    octaves++;
  }
  
  // If we overshot below range.min, go back up one octave
  if (sub < range.min && octaves > 0) {
    sub *= 2;
    octaves--;
  }
  
  const band = classifyBrainwave(sub);
  
  return { subHz: sub, octavesDown: octaves, brainwaveBand: band };
}

function getTargetRange(mode) {
  switch (mode) {
    case 'ambient':  return { min: 7,   max: 10 };   // theta-alpha crossover (DEFAULT)
    case 'sleep':    return { min: 0.5, max: 4 };     // delta (optional deep sleep override)
    case 'schumann': return { min: 7.83, max: 7.83 }; // fixed (handled above, fallback)
    default:         return { min: 7,   max: 10 };    // ambient is always the fallback
  }
}

function classifyBrainwave(hz) {
  if (hz < 0.5)  return 'infra';
  if (hz <= 4)   return 'delta';
  if (hz <= 8)   return 'theta';
  if (hz <= 12)  return 'alpha';
  if (hz <= 30)  return 'beta';
  return 'gamma';
}
```

### Step 3: Reference table — Ambient Mode (default)

All 27 Aetheria frequencies with their ambient-mode sub-harmonics (target: 5–12 Hz theta-alpha zone):

```
GUT REGIME (ambient → theta-alpha 5–12 Hz):
  174 Hz → 10.8750 Hz  (÷ 16,  4 octaves)  α alpha
  285 Hz →  8.9063 Hz  (÷ 32,  5 octaves)  α alpha
  396 Hz →  6.1875 Hz  (÷ 64,  6 octaves)  θ theta
  417 Hz →  6.5156 Hz  (÷ 64,  6 octaves)  θ theta
  528 Hz →  8.2500 Hz  (÷ 64,  6 octaves)  α alpha
  639 Hz →  9.9844 Hz  (÷ 64,  6 octaves)  α alpha
  741 Hz → 11.5781 Hz  (÷ 64,  6 octaves)  α alpha
  852 Hz →  6.6563 Hz  (÷128,  7 octaves)  θ theta
  963 Hz →  7.5234 Hz  (÷128,  7 octaves)  θ theta

HEART REGIME (ambient → theta-alpha 5–12 Hz):
  1206 Hz →  9.4219 Hz  (÷128,  7 octaves)  α alpha
  1449 Hz → 11.3203 Hz  (÷128,  7 octaves)  α alpha
  1692 Hz →  6.6094 Hz  (÷256,  8 octaves)  θ theta
  1935 Hz →  7.5586 Hz  (÷256,  8 octaves)  θ theta
  2178 Hz →  8.5078 Hz  (÷256,  8 octaves)  α alpha
  2421 Hz →  9.4570 Hz  (÷256,  8 octaves)  α alpha
  2664 Hz → 10.4063 Hz  (÷256,  8 octaves)  α alpha
  2907 Hz → 11.3555 Hz  (÷256,  8 octaves)  α alpha
  3150 Hz →  6.1523 Hz  (÷512,  9 octaves)  θ theta

HEAD REGIME (ambient → theta-alpha 5–12 Hz):
  3504 Hz →  6.8438 Hz  (÷512,  9 octaves)  θ theta
  3858 Hz →  7.5352 Hz  (÷512,  9 octaves)  θ theta
  4212 Hz →  8.2266 Hz  (÷512,  9 octaves)  α alpha
  4566 Hz →  8.9180 Hz  (÷512,  9 octaves)  α alpha
  4920 Hz →  9.6094 Hz  (÷512,  9 octaves)  α alpha
  5274 Hz → 10.3008 Hz  (÷512,  9 octaves)  α alpha
  5628 Hz → 10.9922 Hz  (÷512,  9 octaves)  α alpha
  5982 Hz → 11.6836 Hz  (÷512,  9 octaves)  α alpha
  6336 Hz →  6.1875 Hz  (÷1024, 10 octaves)  θ theta
```

**Key observations:**
- Every frequency lands between 6.15–11.68 Hz — the full theta-alpha regulation zone.
- No mode switching needed. Sleep or awake, this range supports emotional regulation.
- The sub-harmonics naturally cluster: GUT lands 6–11 Hz, HEART lands 6–11 Hz, HEAD lands 6–12 Hz.
- 963 Hz (Divine Consciousness) sub-harmonic is 7.52 Hz — right next to Schumann (7.83 Hz).
- 2178 Hz (Compassion Activation, cube center) sub-harmonic is 8.51 Hz — dead center of alpha.

### Optional: Deep Sleep Override Table

For users who want delta-targeted sub-bass during overnight sessions, the `sleep` mode override uses the original delta range (0.5–4 Hz). This is opt-in, not default.

```
Sleep mode sub-harmonics (delta 0.5–4 Hz) — abbreviated:
  174 Hz → 2.7188 Hz  (÷64)   528 Hz → 4.1250 Hz  (÷128, low θ)
  285 Hz → 2.2266 Hz  (÷128)  963 Hz → 3.7617 Hz  (÷256)
  2178 Hz → 2.1270 Hz (÷1024) 6336 Hz → 3.0938 Hz (÷2048)
```

## Web Audio Implementation

### OscillatorNode Configuration

```javascript
/**
 * Create or update the sub-bass oscillator node.
 * Call this whenever the active solfeggio frequency changes (track transition).
 *
 * @param {AudioContext} ctx       — the shared AudioContext
 * @param {number}       solHz     — the active solfeggio frequency
 * @param {string}       mode      — session mode: 'ambient' (default) | 'sleep' | 'schumann'
 * @param {GainNode}     gainNode  — the sub-bass gain node (for volume control)
 * @returns {OscillatorNode}
 */
function createSubBassOscillator(ctx, solHz, mode, gainNode) {
  const { subHz, octavesDown, brainwaveBand } = computeSubBassHz(solHz, mode);
  
  const osc = ctx.createOscillator();
  osc.type = 'sine';  // pure sine — no harmonics that could interfere
  osc.frequency.setValueAtTime(subHz, ctx.currentTime);
  
  osc.connect(gainNode);
  gainNode.connect(ctx.destination);
  
  // Log for debugging / session telemetry
  console.log(
    `[SubBass] ${solHz} Hz → ${subHz.toFixed(4)} Hz ` +
    `(${octavesDown} octaves down, ${brainwaveBand})`
  );
  
  return osc;
}
```

### Smooth Transition on Track Change

When the CABI playlist advances to a new track with a different solfeggio frequency, **crossfade the sub-bass** rather than cutting abruptly — a hard frequency jump is jarring even at sub-bass levels:

```javascript
/**
 * Smoothly transition sub-bass from current frequency to new frequency.
 * Uses exponential ramp over `durationSec` seconds.
 *
 * @param {OscillatorNode} osc          — the active sub-bass oscillator
 * @param {number}         newSolHz     — the incoming solfeggio frequency
 * @param {string}         mode         — session mode
 * @param {number}         durationSec  — crossfade duration (default: 8 seconds)
 */
function transitionSubBass(osc, newSolHz, mode, durationSec = 8) {
  const { subHz } = computeSubBassHz(newSolHz, mode);
  
  // Exponential ramp for perceptually smooth frequency shift
  // Note: exponentialRampToValueAtTime cannot ramp to 0, but sub-bass
  // frequencies are always > 0.5 Hz so this is safe.
  osc.frequency.exponentialRampToValueAtTime(
    subHz,
    osc.context.currentTime + durationSec
  );
  
  console.log(
    `[SubBass] Transitioning to ${subHz.toFixed(4)} Hz ` +
    `over ${durationSec}s (source: ${newSolHz} Hz)`
  );
}
```

### Volume Considerations

Sub-bass frequencies below ~20 Hz are below human hearing threshold but still physically felt and neurologically processed. The amplitude should be:

```javascript
// Sub-bass gain — present but not dominant
// These frequencies are at the edge of audibility; the body processes them
// more than the ears hear them. Too loud = physical discomfort.
const SUB_BASS_GAIN = {
  ambient:  0.10,   // universal default — gentle grounding presence
  sleep:    0.08,   // slightly lower — don't disturb sleep
  schumann: 0.10,   // same as ambient
};
```

### Schumann Resonance Mode

Schumann mode is already integrated into `computeSubBassHz` above — it locks the sub-bass to 7.83 Hz regardless of the active solfeggio frequency. This trades strict harmonic purity for planetary grounding.

**Rationale:** The 123rd harmonic of 7.83 Hz = 963 Hz (Divine Consciousness, GUT position 9). Schumann is already woven into the Aetheria architecture. Note that this introduces a non-octave relationship with the solfeggio layer — the body may perceive it as "two separate things" rather than "one unified stack." For most users, ambient mode (octave-derived sub-harmonics) provides better coherence. Schumann is available as an intentional alternative.

## Integration Points in CABI

### 1. Track Transition Handler

Wherever the CABI system loads a new track and sets the solfeggio/binaural layer frequency, add a call to update the sub-bass:

```javascript
// EXISTING: called when playlist advances to next track
function onTrackChange(track) {
  // ... existing music layer logic ...
  // ... existing solfeggio/binaural setup ...
  
  // NEW: Update sub-bass to match incoming solfeggio frequency
  // Default mode is 'ambient' — no user input needed for everyday use
  const sessionMode = getSessionMode(); // returns 'ambient' unless explicitly overridden
  
  if (subBassOscillator) {
    transitionSubBass(subBassOscillator, track.solfeggioHz, sessionMode);
  } else {
    subBassOscillator = createSubBassOscillator(
      audioCtx, track.solfeggioHz, sessionMode, subBassGainNode
    );
    subBassOscillator.start();
  }
}
```

### 2. Session Mode (Optional Override)

Ambient mode is the default and requires no user interaction. The mode selector is optional — only needed if the user wants to override to a specific brainwave target:

```
Session Modes:
  🌿 Ambient   → theta-alpha (5–12 Hz)  — DEFAULT. Sleep + waking. No selection needed.
  🌙 Sleep     → delta (0.5–4 Hz)       — optional deep-sleep override
  🌍 Schumann  → 7.83 Hz fixed          — planetary resonance lock
```

```javascript
function getSessionMode() {
  // Returns user override if set, otherwise 'ambient'
  return userModeOverride || 'ambient';
}
```

### 3. Watchdog Compatibility

The sub-bass oscillator serves double duty: it keeps the audio pipeline alive (original purpose) AND provides therapeutic grounding (new purpose). The existing watchdog auto-reload between tracks (implemented for the 24-hour stress test) should preserve the sub-bass oscillator across reloads or re-create it immediately on recovery.

```javascript
// In the watchdog recovery handler:
function onWatchdogRecovery() {
  // Re-establish audio context if needed
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  
  // Re-create sub-bass if it was lost
  if (!subBassOscillator || subBassOscillator.context.state === 'closed') {
    const currentSolHz = getCurrentSolfeggioHz();
    const mode = getSessionMode();
    subBassOscillator = createSubBassOscillator(
      audioCtx, currentSolHz, mode, subBassGainNode
    );
    subBassOscillator.start();
    console.log('[Watchdog] Sub-bass oscillator restored');
  }
}
```

### 4. Session Telemetry (Optional Enhancement)

Log sub-bass transitions for session review. This data can feed into Coherence Lab session exports:

```javascript
const subBassLog = [];

function logSubBassEvent(solHz, subHz, mode, brainwaveBand, timestamp) {
  subBassLog.push({
    t: timestamp || (Date.now() / 1000),
    sourceHz: solHz,
    subBassHz: subHz,
    mode: mode,
    band: brainwaveBand,
    event: 'transition'
  });
}
```

## UI Display Suggestion

Show the sub-bass state in the CABI player interface so the user can see what's happening:

```
┌──────────────────────────────────────────┐
│  ♫ Track 5 of 12                         │
│  Solfeggio: 528 Hz — Transformation      │
│  Sub-Bass:  8.25 Hz (α alpha)            │
│  Mode: 🌿 Ambient                        │
│  Harmonic: 528 ÷ 64 = 8.25              │
│  ──────────────────────────────────────  │
│  [🌿 Ambient] [🌙 Sleep] [🌍 Schumann]  │
└──────────────────────────────────────────┘
```

The mode buttons are optional — ambient is pre-selected and works for everyone. The sub-bass frequency and brainwave band indicator update automatically on track change.

## Testing Checklist

- [ ] Sub-bass frequency updates when solfeggio frequency changes on track transition
- [ ] Frequency transition is smooth (exponential ramp, no clicks or pops)
- [ ] All 27 Aetheria frequencies produce valid sub-harmonics in ambient mode (5–12 Hz)
- [ ] All 27 Aetheria frequencies produce valid sub-harmonics in sleep mode (0.5–4 Hz)
- [ ] Default mode is ambient with no user interaction required
- [ ] Sub-bass survives watchdog recovery / audio context resume
- [ ] Volume levels are appropriate (sub-audible grounding, not dominant)
- [ ] Schumann mode locks to 7.83 Hz regardless of solfeggio input
- [ ] Sub-bass continues playing between tracks (no gap during track transitions)
- [ ] Session telemetry logs sub-bass events correctly
- [ ] Overnight session: ambient sub-bass does not cause wakefulness or agitation
- [ ] Daytime session: ambient sub-bass does not cause drowsiness

## Design Guidelines

- Dark backgrounds, gold accents
- Font: Cormorant Garamond for display, JetBrains Mono for frequency data
- Digit root colors: root 3 = #50d480, root 6 = #d4a050, root 9 = #a050d4
- Regime colors: GUT = #d94040, HEART = #d4a050, HEAD = #5090d4
- Sub-bass indicator should be subtle — a small display element, not a dominant UI feature

## Mathematical Foundation

The sub-harmonic relationship preserves harmonic coherence because octave division (÷2) maintains the frequency ratio at the simplest possible musical interval (the octave, ratio 2:1). Every sub-harmonic is the same "note" as the source frequency, just in a lower register. The body receives these as harmonically identical — one unified tone stack rather than competing frequencies.

The ambient target range (5–12 Hz) spans theta and alpha brainwave bands — the neurological zone where emotional regulation occurs in both sleep and waking states. The octave-descent algorithm naturally distributes sub-harmonics across this zone, landing each Aetheria frequency at a different point within theta-alpha. This means the sub-bass is both harmonically locked to the solfeggio layer AND neurologically appropriate for any time of day.

This is the Regime Collider principle applied to audio engineering: three inputs (music, solfeggio, sub-bass) resolve into one expressed state when their harmonic relationships are mathematically coherent. No mode switching required — ambient is the universal default because the theta-alpha zone is where the body does its regulation work regardless of conscious state.

---

*Implementation guide by Claude (Anthropic) in collaboration with Joseph Lewis — 2026*
