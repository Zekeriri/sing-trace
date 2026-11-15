// Monophonic pitch (YIN) plus a vibrato estimate for sung notes.
// Vibrato here means a 3.5–9 Hz oscillation of pitch, deeper than about 18 cents.

import { fft, ifft } from "./fft.js";
import { resampleTo } from "./resample.js";
import { describeHz } from "./notes.js";

const WINDOW = 1024;
const HOP = 160;
const F_MIN = 70;
const F_MAX = 800;
const YIN_THRESHOLD = 0.45;

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

function refineDip(cm, tau) {
  const s0 = cm[tau - 1];
  const s1 = cm[tau];
  const s2 = cm[tau + 1];
  const denom = 2 * (s0 - 2 * s1 + s2);
  if (Math.abs(denom) < 1e-12) return tau;
  const delta = (s0 - s2) / denom;
  if (delta < -1 || delta > 1) return tau;
  return tau + delta;
}

function collectCandidates(cm, sampleRate, tauMin, tauMax) {
  const found = [];
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cm[tau] > YIN_THRESHOLD) continue;
    if (!(cm[tau] <= cm[tau - 1] && cm[tau] <= cm[tau + 1])) continue;
    const refined = refineDip(cm, tau);
    const hz = sampleRate / refined;
    if (hz < F_MIN || hz > F_MAX) continue;
    found.push({ hz, cm: cm[tau] });
  }
  found.sort((a, b) => a.cm - b.cm);
  return found.slice(0, 4);
}

function transitionCost(prev, next) {
  if (!prev || !next) return 0.02;
  const cents = Math.abs(1200 * Math.log2(next / prev));
  if (cents < 150) return cents / 700;
  if (cents < 800) return 0.1;
  if (Math.abs(cents - 1200) < 90) return 0.85;
  if (Math.abs(cents - 2400) < 90) return 1.2;
  return 0.4;
}

function decodeContour(frames) {
  const n = frames.length;
  const score = new Array(n);
  const back = new Array(n);
  for (let i = 0; i < n; i++) {
    const cands = frames[i].length ? frames[i] : [{ hz: 0, cm: 0.2 }];
    score[i] = new Float64Array(cands.length);
    back[i] = new Int16Array(cands.length);
    for (let j = 0; j < cands.length; j++) {
      const local = cands[j].hz ? cands[j].cm : 0.08;
      if (i === 0) {
        score[i][j] = local;
        back[i][j] = -1;
        continue;
      }
      const prevCands = frames[i - 1].length ? frames[i - 1] : [{ hz: 0, cm: 0.2 }];
      let best = Infinity;
      let arg = 0;
      for (let k = 0; k < prevCands.length; k++) {
        const cost = score[i - 1][k] + transitionCost(prevCands[k].hz, cands[j].hz);
        if (cost < best) {
          best = cost;
          arg = k;
        }
      }
      score[i][j] = best + local;
      back[i][j] = arg;
    }
  }
  const f0 = new Float32Array(n);
  if (!n) return f0;
  const last = frames[n - 1].length ? frames[n - 1] : [{ hz: 0 }];
  let arg = 0;
  for (let j = 1; j < last.length; j++) if (score[n - 1][j] < score[n - 1][arg]) arg = j;
  for (let i = n - 1; i >= 0; i--) {
    const cands = frames[i].length ? frames[i] : [{ hz: 0 }];
    f0[i] = cands[arg].hz;
    arg = back[i][arg];
    if (arg < 0) break;
  }
  return f0;
}

function trackRaw(samples, sampleRate, onProgress) {
  const frames = Math.max(0, Math.floor((samples.length - WINDOW) / HOP));
  const rms = new Float32Array(frames);
  const cands = new Array(frames);
  if (!frames) return { f0: new Float32Array(0), rms };

  const nfft = 2048;
  const win = hann(WINDOW);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const prefix = new Float64Array(WINDOW + 1);
  const cm = new Float64Array(WINDOW);
  const tauMin = Math.max(2, Math.floor(sampleRate / F_MAX));
  const tauMax = Math.min(WINDOW - 3, Math.ceil(sampleRate / F_MIN));

  for (let i = 0; i < frames; i++) {
    const offset = i * HOP;
    re.fill(0);
    im.fill(0);
    prefix[0] = 0;
    let prev = offset > 0 ? samples[offset - 1] : samples[offset];
    for (let n = 0; n < WINDOW; n++) {
      const raw = samples[offset + n];
      const emph = raw - 0.97 * prev;
      prev = raw;
      const s = emph * win[n];
      re[n] = s;
      prefix[n + 1] = prefix[n] + s * s;
    }
    const energy = prefix[WINDOW];
    rms[i] = Math.sqrt(energy / WINDOW);
    if (energy < 1e-8) {
      cands[i] = [];
      if (onProgress && i % 250 === 0) onProgress(i / frames);
      continue;
    }
    fft(re, im);
    for (let k = 0; k < nfft; k++) {
      re[k] = re[k] * re[k] + im[k] * im[k];
      im[k] = 0;
    }
    ifft(re, im);
    cm[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      const d = Math.max(0, prefix[WINDOW - tau] + (prefix[WINDOW] - prefix[tau]) - 2 * re[tau]);
      running += d;
      cm[tau] = running > 0 ? (d * tau) / running : 1;
    }
    cands[i] = collectCandidates(cm, sampleRate, tauMin, tauMax);
    if (onProgress && i % 250 === 0) onProgress(i / frames);
  }
  return { f0: decodeContour(cands), rms };
}

function gateByEnergy(f0, rms) {
  const voiced = [];
  for (let i = 0; i < rms.length; i++) if (f0[i] > 0) voiced.push(rms[i]);
  if (!voiced.length) return;
  voiced.sort((a, b) => a - b);
  const median = voiced[voiced.length >> 1];
  const floor = Math.max(1e-4, median * 0.12);
  for (let i = 0; i < f0.length; i++) if (rms[i] < floor) f0[i] = 0;
}

function despike(f0) {
  const out = Float32Array.from(f0);
  for (let i = 1; i < out.length - 1; i++) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    if (a <= 0 || b <= 0 || c <= 0) continue;
    const neighbors = Math.abs(1200 * Math.log2(c / a));
    const jump = Math.abs(1200 * Math.log2(b / a));
    if (neighbors < 50 && jump > 150) out[i] = Math.sqrt(a * c);
  }
  return out;
}

function fixOctaves(f0) {
  const out = Float32Array.from(f0);
  const radius = 2;
  for (let i = 0; i < f0.length; i++) {
    if (f0[i] <= 0) continue;
    const vals = [];
    for (let k = i - radius; k <= i + radius; k++) {
      if (k >= 0 && k < f0.length && f0[k] > 0) vals.push(Math.log(f0[k]));
    }
    if (vals.length < 3) continue;
    vals.sort((a, b) => a - b);
    const med = Math.exp(vals[vals.length >> 1]);
    if (Math.abs(1200 * Math.log2(f0[i] / med)) > 150) out[i] = med;
  }
  return out;
}

function foldOctaves(f0) {
  const out = Float32Array.from(f0);
  const radius = 14;
  for (let i = 0; i < out.length; i++) {
    if (out[i] <= 0) continue;
    const vals = [];
    for (let k = i - radius; k <= i + radius; k++) {
      if (k >= 0 && k < out.length && out[k] > 0) vals.push(Math.log(out[k]));
    }
    if (vals.length < 7) continue;
    vals.sort((a, b) => a - b);
    const med = Math.exp(vals[vals.length >> 1]);
    let best = out[i];
    let bestDist = Math.abs(1200 * Math.log2(best / med));
    for (const factor of [0.5, 2]) {
      const cand = out[i] * factor;
      if (cand < F_MIN || cand > F_MAX) continue;
      const dist = Math.abs(1200 * Math.log2(cand / med));
      if (dist + 50 < bestDist) {
        best = cand;
        bestDist = dist;
      }
    }
    out[i] = best;
  }
  return out;
}

function analyzeVibrato(f0, frameSec) {
  const n = f0.length;
  const flag = new Uint8Array(n);
  const rate = new Float32Array(n);
  const depth = new Float32Array(n);
  const minRun = Math.round(0.32 / frameSec);
  const baseRadius = Math.max(2, Math.round(0.18 / frameSec));
  const win = Math.max(8, Math.round(0.72 / frameSec));
  const lagMin = Math.max(2, Math.round(1 / (9 * frameSec)));
  const lagMax = Math.max(lagMin + 1, Math.round(1 / (3.5 * frameSec)));

  let i = 0;
  while (i < n) {
    if (f0[i] <= 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && f0[j] > 0) j++;
    if (j - i >= minRun) measureRun(f0, i, j);
    i = j;
  }
  return { flag, rate, depth };

  function measureRun(series, a, b) {
    const len = b - a;
    const cents = new Float64Array(len);
    for (let k = 0; k < len; k++) cents[k] = 1200 * Math.log2(series[a + k]);
    const base = new Float64Array(len);
    for (let k = 0; k < len; k++) {
      const a0 = Math.max(0, k - baseRadius);
      const b0 = Math.min(len - 1, k + baseRadius);
      let sum = 0;
      let count = 0;
      for (let t = a0; t <= b0; t++) {
        sum += cents[t];
        count++;
      }
      base[k] = sum / count;
    }
    const residual = new Float64Array(len);
    for (let k = 0; k < len; k++) residual[k] = cents[k] - base[k];

    for (let k = 0; k < len; k++) {
      const a0 = Math.max(0, k - (win >> 1));
      const b0 = Math.min(len, a0 + win);
      const start = Math.max(0, b0 - win);
      const span = b0 - start;
      if (span < lagMin * 2) continue;
      let bestLag = 0;
      let best = 0;
      for (let lag = lagMin; lag <= lagMax; lag++) {
        if (span < lag * 2) break;
        let e1 = 0;
        let e2 = 0;
        let sum = 0;
        for (let t = start; t < b0 - lag; t++) {
          const x = residual[t];
          const y = residual[t + lag];
          e1 += x * x;
          e2 += y * y;
          sum += x * y;
        }
        const corr = e1 > 1e-6 && e2 > 1e-6 ? sum / Math.sqrt(e1 * e2) : 0;
        if (corr > best) {
          best = corr;
          bestLag = lag;
        }
      }
      if (bestLag && best > 0.55) {
        const hz = 1 / (bestLag * frameSec);
        let peak = 0;
        for (let t = start; t < b0; t++) peak = Math.max(peak, Math.abs(residual[t]));
        if (peak >= 18 && peak <= 220 && hz >= 3.5 && hz <= 9) {
          flag[a + k] = 1;
          rate[a + k] = hz;
          depth[a + k] = peak;
        }
      }
    }
  }
}

function solidifyVibrato(vib, frameSec) {
  const { flag, rate, depth } = vib;
  const maxGap = Math.max(1, Math.round(0.08 / frameSec));
  const minOn = Math.max(2, Math.round(0.12 / frameSec));
  let i = 0;
  while (i < flag.length) {
    if (flag[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < flag.length && !flag[j]) j++;
    if (i > 0 && j < flag.length && j - i <= maxGap) {
      for (let k = i; k < j; k++) {
        flag[k] = 1;
        rate[k] = rate[i - 1];
        depth[k] = depth[i - 1];
      }
    }
    i = j;
  }
  i = 0;
  while (i < flag.length) {
    if (!flag[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < flag.length && flag[j]) j++;
    if (j - i < minOn) {
      for (let k = i; k < j; k++) flag[k] = 0;
    }
    i = j;
  }
}

function fillShortGaps(f0) {
  const out = Float32Array.from(f0);
  let i = 0;
  while (i < out.length) {
    if (out[i] > 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && out[j] <= 0) j++;
    const gap = j - i;
    if (i > 0 && j < out.length && gap <= 4) {
      const left = out[i - 1];
      const right = out[j];
      if (Math.abs(1200 * Math.log2(right / left)) < 180) {
        for (let k = i; k < j; k++) {
          const t = (k - i + 1) / (gap + 1);
          out[k] = left * (right / left) ** t;
        }
      }
    }
    i = j;
  }
  return out;
}

export function trackPitch(samples, sampleRate, onProgress) {
  const rate = sampleRate > 18000 ? 16000 : sampleRate;
  const x = rate === sampleRate ? samples : resampleTo(samples, sampleRate, rate);
  const raw = trackRaw(x, rate, onProgress);
  gateByEnergy(raw.f0, raw.rms);
  let f0 = fillShortGaps(raw.f0);
  f0 = despike(f0);
  f0 = foldOctaves(f0);
  f0 = fixOctaves(f0);
  f0 = despike(f0);
  const frameSec = HOP / rate;
  const vib = analyzeVibrato(f0, frameSec);
  solidifyVibrato(vib, frameSec);
  return {
    f0,
    hop: HOP,
    window: WINDOW,
    rate,
    vibrato: vib.flag,
    vibratoRate: vib.rate,
    vibratoDepth: vib.depth,
  };
}

export function frameTime(pitch, index) {
  return (index * pitch.hop + pitch.window / 2) / pitch.rate;
}

export function pitchAtTime(pitch, time) {
  if (!pitch || pitch.f0.length === 0) return 0;
  const center = pitch.window / 2 / pitch.rate;
  const idx = Math.round((time - center) / (pitch.hop / pitch.rate));
  if (idx < 0 || idx >= pitch.f0.length) return 0;
  return pitch.f0[idx];
}

export function vibratoAtTime(pitch, time) {
  if (!pitch || pitch.f0.length === 0) return null;
  const center = pitch.window / 2 / pitch.rate;
  const idx = Math.round((time - center) / (pitch.hop / pitch.rate));
  if (idx < 0 || idx >= pitch.f0.length || !pitch.vibrato[idx]) return null;
  return { rate: pitch.vibratoRate[idx], depth: pitch.vibratoDepth[idx] };
}

export function summarizePitch(pitch) {
  const n = pitch.f0.length;
  let voiced = 0;
  let vib = 0;
  const voicedHz = [];
  const rates = [];
  const depths = [];
  for (let i = 0; i < n; i++) {
    const hz = pitch.f0[i];
    if (hz <= 0) continue;
    voiced++;
    voicedHz.push(hz);
    if (pitch.vibrato[i]) {
      vib++;
      rates.push(pitch.vibratoRate[i]);
      depths.push(pitch.vibratoDepth[i]);
    }
  }
  const median = (arr) => {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    return s[s.length >> 1];
  };
  voicedHz.sort((a, b) => a - b);
  const lowHz = voicedHz.length ? voicedHz[Math.floor((voicedHz.length - 1) * 0.02)] : 0;
  const highHz = voicedHz.length ? voicedHz[Math.floor((voicedHz.length - 1) * 0.98)] : 0;
  return {
    voicedRatio: n ? voiced / n : 0,
    vibratoRatio: voiced ? vib / voiced : 0,
    low: lowHz ? describeHz(lowHz) : null,
    high: highHz ? describeHz(highHz) : null,
    medianRate: median(rates),
    medianDepth: median(depths),
  };
}
