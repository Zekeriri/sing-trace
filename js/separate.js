// Browser-side lead-vocal extraction.
//
// Stereo material: keep what is centered and in phase (typical lead vocal),
// then keep the harmonic part of that center image so drums fall away.
// Mono material has no pan cue, so only the harmonic-percussive split runs.

import { fft, ifft } from "./fft.js";

const NFFT = 2048;
const HOP = 512;

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

function bandWeight(freq) {
  if (freq < 75) return 0;
  if (freq < 150) return (freq - 75) / 75;
  if (freq < 5600) return 1;
  if (freq < 11000) return (11000 - freq) / 5400;
  return 0;
}

function medianTime(src, frames, bins, radius, dst) {
  const tmp = new Float32Array(radius * 2 + 1);
  for (let b = 0; b < bins; b++) {
    for (let t = 0; t < frames; t++) {
      const t0 = Math.max(0, t - radius);
      const t1 = Math.min(frames - 1, t + radius);
      let n = 0;
      for (let tt = t0; tt <= t1; tt++) tmp[n++] = src[tt * bins + b];
      dst[t * bins + b] = medianOf(tmp, n);
    }
  }
}

function medianFreq(src, frames, bins, radius, dst) {
  const tmp = new Float32Array(radius * 2 + 1);
  for (let t = 0; t < frames; t++) {
    const row = t * bins;
    for (let b = 0; b < bins; b++) {
      const b0 = Math.max(0, b - radius);
      const b1 = Math.min(bins - 1, b + radius);
      let n = 0;
      for (let bb = b0; bb <= b1; bb++) tmp[n++] = src[row + bb];
      dst[row + b] = medianOf(tmp, n);
    }
  }
}

function medianOf(buf, n) {
  for (let i = 1; i < n; i++) {
    const v = buf[i];
    let j = i - 1;
    while (j >= 0 && buf[j] > v) {
      buf[j + 1] = buf[j];
      j--;
    }
    buf[j + 1] = v;
  }
  return buf[n >> 1];
}

function blur(src, frames, bins, rTime, rFreq) {
  const mid = new Float32Array(src.length);
  for (let b = 0; b < bins; b++) {
    for (let t = 0; t < frames; t++) {
      const t0 = Math.max(0, t - rTime);
      const t1 = Math.min(frames - 1, t + rTime);
      let sum = 0;
      let count = 0;
      for (let tt = t0; tt <= t1; tt++) {
        sum += src[tt * bins + b];
        count++;
      }
      mid[t * bins + b] = sum / count;
    }
  }
  const dst = new Float32Array(src.length);
  for (let t = 0; t < frames; t++) {
    for (let b = 0; b < bins; b++) {
      const b0 = Math.max(0, b - rFreq);
      const b1 = Math.min(bins - 1, b + rFreq);
      let sum = 0;
      let count = 0;
      for (let bb = b0; bb <= b1; bb++) {
        sum += mid[t * bins + bb];
        count++;
      }
      dst[t * bins + b] = sum / count;
    }
  }
  return dst;
}

function stftFrame(signal, offset, window, re, im) {
  const n = window.length;
  for (let i = 0; i < n; i++) {
    const idx = offset + i;
    re[i] = idx >= 0 && idx < signal.length ? signal[idx] * window[i] : 0;
    im[i] = 0;
  }
  fft(re, im);
}

function separateBlock(left, right, sampleRate) {
  const mono = right == null;
  const length = left.length;
  const window = hann(NFFT);
  const frames = Math.max(1, Math.floor((length - NFFT) / HOP) + 1);
  const bins = NFFT / 2 + 1;
  const band = new Float32Array(bins);
  for (let b = 0; b < bins; b++) band[b] = bandWeight((b * sampleRate) / NFFT);

  const midRe = new Float32Array(frames * NFFT);
  const midIm = new Float32Array(frames * NFFT);
  const magMid = new Float32Array(frames * bins);
  const center = new Float32Array(frames * bins);

  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const lRe = new Float64Array(NFFT);
  const lIm = new Float64Array(NFFT);

  for (let t = 0; t < frames; t++) {
    const offset = t * HOP;
    stftFrame(left, offset, window, re, im);
    lRe.set(re);
    lIm.set(im);
    if (!mono) stftFrame(right, offset, window, re, im);
    else {
      re.set(lRe);
      im.set(lIm);
    }
    const base = t * NFFT;
    for (let i = 0; i < NFFT; i++) {
      midRe[base + i] = (lRe[i] + re[i]) * 0.5;
      midIm[base + i] = (lIm[i] + im[i]) * 0.5;
    }
    const row = t * bins;
    for (let b = 0; b < bins; b++) {
      const mr = midRe[base + b];
      const mi = midIm[base + b];
      magMid[row + b] = Math.hypot(mr, mi);
      const pL = lRe[b] * lRe[b] + lIm[b] * lIm[b];
      const pR = re[b] * re[b] + im[b] * im[b];
      const magL = Math.sqrt(pL);
      const magR = Math.sqrt(pR);
      const cross = lRe[b] * re[b] + lIm[b] * im[b];
      let c = 1;
      if (!mono) {
        if (pL + pR < 1e-8) c = 0;
        else {
          const balance = Math.abs(magL - magR) / (magL + magR + 1e-12);
          c = 1 - balance;
          if (cross < 0) c *= 0.2;
          c **= 1.7;
        }
      }
      center[row + b] = c;
    }
  }

  const harm = new Float32Array(magMid.length);
  const perc = new Float32Array(magMid.length);
  medianTime(magMid, frames, bins, 8, harm);
  medianFreq(magMid, frames, bins, 8, perc);

  const mask = new Float32Array(magMid.length);
  for (let i = 0; i < mask.length; i++) {
    const b = i % bins;
    const hp = harm[i] * harm[i];
    const pp = perc[i] * perc[i];
    const harmMask = hp / (hp + pp + 1e-8);
    let m = harmMask * center[i] * band[b];
    if (m < 0.06) m = 0;
    mask[i] = m;
  }
  const smooth = blur(mask, frames, bins, 1, 2);

  const output = new Float32Array((frames - 1) * HOP + NFFT);
  const norm = new Float32Array(output.length);
  for (let t = 0; t < frames; t++) {
    const base = t * NFFT;
    const row = t * bins;
    for (let b = 0; b < bins; b++) {
      const m = smooth[row + b];
      re[b] = midRe[base + b] * m;
      im[b] = midIm[base + b] * m;
      if (b > 0 && b < NFFT / 2) {
        re[NFFT - b] = midRe[base + NFFT - b] * m;
        im[NFFT - b] = midIm[base + NFFT - b] * m;
      }
    }
    ifft(re, im);
    const offset = t * HOP;
    for (let i = 0; i < NFFT; i++) {
      const w = window[i];
      output[offset + i] += re[i] * w;
      norm[offset + i] += w * w;
    }
  }
  const trimmed = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    trimmed[i] = norm[i] > 1e-6 ? output[i] / norm[i] : 0;
  }
  return trimmed;
}

function softenSilence(samples, sampleRate) {
  const frame = Math.max(1, Math.floor(sampleRate * 0.02));
  const nFrames = Math.ceil(samples.length / frame);
  const env = new Float32Array(nFrames);
  let peak = 0;
  for (let i = 0; i < nFrames; i++) {
    const a = i * frame;
    const b = Math.min(samples.length, a + frame);
    let s = 0;
    for (let j = a; j < b; j++) s += samples[j] * samples[j];
    const rms = Math.sqrt(s / (b - a));
    env[i] = rms;
    if (rms > peak) peak = rms;
  }
  if (peak < 1e-6) return;
  const th = peak * 0.045;
  const gain = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    const r = Math.min(1, env[i] / th);
    gain[i] = r * r * (3 - 2 * r);
  }
  let g = 0;
  for (let i = 0; i < nFrames; i++) {
    const target = gain[i];
    g += (target - g) * (target > g ? 0.5 : 0.15);
    gain[i] = g;
  }
  for (let i = 0; i < samples.length; i++) {
    const f = i / frame;
    const i0 = Math.min(nFrames - 1, Math.floor(f));
    const i1 = Math.min(nFrames - 1, i0 + 1);
    const t = f - i0;
    samples[i] *= gain[i0] * (1 - t) + gain[i1] * t;
  }
}

function peakNormalize(samples, peak = 0.95) {
  let max = 0;
  for (let i = 0; i < samples.length; i++) max = Math.max(max, Math.abs(samples[i]));
  if (max < 1e-6 || max <= peak) return;
  const g = peak / max;
  for (let i = 0; i < samples.length; i++) samples[i] *= g;
}

export function separateVocals(left, right, sampleRate, onProgress) {
  if (!left || left.length < NFFT) {
    return left ? Float32Array.from(left) : new Float32Array(0);
  }
  const pad = NFFT;
  const n = left.length;
  const leftPad = new Float32Array(n + pad * 2);
  leftPad.set(left, pad);
  let rightPad = null;
  if (right) {
    rightPad = new Float32Array(n + pad * 2);
    rightPad.set(right, pad);
  }
  const outPad = new Float32Array(leftPad.length);
  const chunk = Math.floor(sampleRate * 1.6);
  const context = HOP * 20 + NFFT;
  const total = leftPad.length;
  for (let start = 0; start < total; start += chunk) {
    const end = Math.min(total, start + chunk);
    const a = Math.max(0, start - context);
    const b = Math.min(total, end + context);
    const piece = separateBlock(leftPad.subarray(a, b), rightPad ? rightPad.subarray(a, b) : null, sampleRate);
    const offset = start - a;
    outPad.set(piece.subarray(offset, offset + (end - start)), start);
    if (onProgress) onProgress(Math.min(1, end / total));
  }
  const vocal = new Float32Array(n);
  vocal.set(outPad.subarray(pad, pad + n));
  softenSilence(vocal, sampleRate);
  const fade = Math.min(vocal.length >> 1, Math.floor(sampleRate * 0.008));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    vocal[i] *= g;
    vocal[vocal.length - 1 - i] *= g;
  }
  peakNormalize(vocal, 0.95);
  return vocal;
}
