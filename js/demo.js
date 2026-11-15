// A short practice clip: centered sung notes over a stereo accompaniment.
// Timings are part of the contract used by the DSP tests.

export const DEMO_DURATION = 14.2;

export const DEMO_NOTES = [
  { t: 1.0, dur: 2.4, hz: 440, vibRate: 5.4, vibDepth: 55 },
  { t: 3.6, dur: 1.8, hz: 523.25, vibRate: 6.0, vibDepth: 40 },
  { t: 5.6, dur: 1.3, hz: 493.88, vibRate: 0, vibDepth: 0 },
  { t: 7.1, dur: 2.2, hz: 440, vibRate: 5.0, vibDepth: 68 },
  { t: 9.5, dur: 1.6, hz: 329.63, vibRate: 5.8, vibDepth: 34 },
  { t: 11.3, dur: 2.4, hz: 392, vibRate: 6.3, vibDepth: 50 },
];

const HARMONICS = [1, 0.62, 0.38, 0.22, 0.12, 0.07, 0.04];

function renderVocal(sampleRate, n) {
  const vocal = new Float32Array(n);
  for (const note of DEMO_NOTES) {
    const i0 = Math.floor(note.t * sampleRate);
    const i1 = Math.min(n, Math.floor((note.t + note.dur) * sampleRate));
    const attack = 0.045 * sampleRate;
    const release = 0.09 * sampleRate;
    let phase = 0;
    for (let i = i0; i < i1; i++) {
      const ts = (i - i0) / sampleRate;
      const envIn = Math.min(1, (i - i0) / attack);
      const envOut = Math.min(1, (i1 - i) / release);
      const env = Math.min(envIn, envOut);
      const vibEnv = note.vibRate && ts > 0.28 ? Math.min(1, (ts - 0.28) / 0.22) : 0;
      const cents = vibEnv * note.vibDepth * Math.sin(2 * Math.PI * note.vibRate * ts);
      const hz = note.hz * 2 ** (cents / 1200);
      phase += (2 * Math.PI * hz) / sampleRate;
      let s = 0;
      for (let h = 0; h < HARMONICS.length; h++) s += HARMONICS[h] * Math.sin(phase * (h + 1));
      vocal[i] += env * 0.34 * s;
    }
  }
  return vocal;
}

function renderAccompaniment(sampleRate, n, drums) {
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const tones = [174.61, 220, 277.18, 311.13];
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    for (let k = 0; k < tones.length; k++) {
      const hz = tones[k] * (1 + 0.003 * Math.sin(t * (0.2 + k)));
      const trem = 0.65 + 0.35 * Math.sin(2 * Math.PI * (0.45 + k * 0.05) * t);
      const s = trem * 0.11 * Math.sin(2 * Math.PI * hz * t + k);
      const pan = k % 2 === 0 ? 0.82 : 0.18;
      left[i] += s * pan;
      right[i] += s * (1 - pan);
    }
    if (drums && t >= 1 && t % 0.5 < 0.016) {
      const u = (t % 0.5) / 0.016;
      const env = 1 - u;
      const thump = Math.sin(2 * Math.PI * 90 * t) * env * 0.22;
      const noise = Math.sin(2 * Math.PI * (1800 + 400 * u) * t) * env * 0.05;
      left[i] += thump + noise;
      right[i] += thump + noise;
    }
  }
  return { left, right };
}

function scalePeak(channels, peak = 0.92) {
  let max = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) max = Math.max(max, Math.abs(ch[i]));
  }
  if (max < 1e-8) return;
  const g = peak / max;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) ch[i] *= g;
  }
}

export function synthesizePracticeClip(sampleRate = 44100, options = {}) {
  const drums = options.drums !== false;
  const n = Math.floor(sampleRate * DEMO_DURATION);
  const vocal = renderVocal(sampleRate, n);
  const acc = renderAccompaniment(sampleRate, n, drums);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = vocal[i] + acc.left[i];
    right[i] = vocal[i] + acc.right[i];
  }
  scalePeak([left, right, vocal], 0.9);
  return { left, right, vocal, sampleRate, duration: DEMO_DURATION };
}
