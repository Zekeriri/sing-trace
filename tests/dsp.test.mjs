import assert from "node:assert/strict";
import test from "node:test";
import { fft, ifft } from "../js/fft.js";
import { separateVocals } from "../js/separate.js";
import { frameTime, summarizePitch, trackPitch } from "../js/pitch.js";
import { DEMO_NOTES, synthesizePracticeClip } from "../js/demo.js";

function correlation(a, b, i0, i1) {
  let sa = 0;
  let sb = 0;
  let n = 0;
  for (let i = i0; i < i1; i++) {
    sa += a[i];
    sb += b[i];
    n++;
  }
  const ma = sa / n;
  const mb = sb / n;
  let sab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = i0; i < i1; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    aa += da * da;
    bb += db * db;
  }
  return sab / Math.sqrt(aa * bb);
}

function rms(x, t0, t1, sampleRate) {
  const i0 = Math.floor(t0 * sampleRate);
  const i1 = Math.floor(t1 * sampleRate);
  let s = 0;
  for (let i = i0; i < i1; i++) s += x[i] * x[i];
  return Math.sqrt(s / (i1 - i0));
}

function medianHz(pitch, t0, t1) {
  const vals = [];
  for (let i = 0; i < pitch.f0.length; i++) {
    const t = frameTime(pitch, i);
    if (t >= t0 && t < t1 && pitch.f0[i] > 0) vals.push(pitch.f0[i]);
  }
  vals.sort((a, b) => a - b);
  return vals.length ? vals[vals.length >> 1] : 0;
}

function vibratoStats(pitch, t0, t1) {
  let voiced = 0;
  let vib = 0;
  const rates = [];
  const depths = [];
  for (let i = 0; i < pitch.f0.length; i++) {
    const t = frameTime(pitch, i);
    if (t < t0 || t >= t1 || pitch.f0[i] <= 0) continue;
    voiced++;
    if (pitch.vibrato[i]) {
      vib++;
      rates.push(pitch.vibratoRate[i]);
      depths.push(pitch.vibratoDepth[i]);
    }
  }
  rates.sort((a, b) => a - b);
  depths.sort((a, b) => a - b);
  return {
    voiced,
    ratio: voiced ? vib / voiced : 0,
    rate: rates.length ? rates[rates.length >> 1] : 0,
    depth: depths.length ? depths[depths.length >> 1] : 0,
  };
}

test("fft roundtrip restores an impulse", () => {
  const n = 64;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re[3] = 1;
  fft(re, im);
  ifft(re, im);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(re[i] - (i === 3 ? 1 : 0)) < 1e-9, `re[${i}]=${re[i]}`);
    assert.ok(Math.abs(im[i]) < 1e-9);
  }
});

test("yin tracks a 440 Hz sine and ignores a steady tone as vibrato", () => {
  const sampleRate = 44100;
  const n = sampleRate;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  const pitch = trackPitch(x, sampleRate);
  const hz = medianHz(pitch, 0.2, 0.8);
  assert.ok(Math.abs(hz - 440) < 2, `median f0 ${hz}`);
  const vib = vibratoStats(pitch, 0.2, 0.8);
  assert.ok(vib.ratio < 0.2, `steady tone vibrato ratio ${vib.ratio}`);
});

test("mono vocal sine survives separation", () => {
  const sampleRate = 44100;
  const n = Math.floor(sampleRate * 1.2);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 200, (n - i) / 200);
    x[i] = env * 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  const y = separateVocals(x, null, sampleRate);
  const c = correlation(x, y, 4000, n - 4000);
  assert.ok(c > 0.9, `correlation ${c}`);
});

test("stereo mix yields the centered vibrato vocal", { timeout: 180000 }, () => {
  const sampleRate = 44100;
  const clip = synthesizePracticeClip(sampleRate, { drums: false });
  const started = Date.now();
  const vocal = separateVocals(clip.left, clip.right, sampleRate);
  const separatedMs = Date.now() - started;
  const quiet = rms(vocal, 0.2, 0.8, sampleRate);
  const sung = rms(vocal, 1.45, 2.7, sampleRate);
  assert.ok(sung / quiet > 4, `vocal rms ${sung} vs accompaniment residue ${quiet}`);
  const match = correlation(vocal, clip.vocal, Math.floor(sampleRate * 1.2), Math.floor(sampleRate * 13.4));
  assert.ok(match > 0.65, `correlation with dry vocal ${match}`);

  const pitchStarted = Date.now();
  const pitch = trackPitch(vocal, sampleRate);
  const pitchMs = Date.now() - pitchStarted;
  const a4 = medianHz(pitch, 1.5, 3.0);
  assert.ok(a4 > 425 && a4 < 455, `A4 median ${a4}`);
  const vib = vibratoStats(pitch, 1.55, 3.05);
  assert.ok(vib.ratio > 0.45, `vibrato coverage ${vib.ratio}`);
  assert.ok(vib.rate > 4.4 && vib.rate < 6.6, `vibrato rate ${vib.rate}`);
  assert.ok(vib.depth > 25 && vib.depth < 100, `vibrato depth ${vib.depth}`);

  const straight = vibratoStats(pitch, 5.85, 6.6);
  const straightHz = medianHz(pitch, 5.85, 6.6);
  assert.ok(Math.abs(straightHz - 493.88) < 8, `straight note ${straightHz}`);
  assert.ok(straight.ratio < 0.35, `straight note vibrato ratio ${straight.ratio}`);

  const summary = summarizePitch(pitch);
  assert.ok(summary.low && summary.high);
  assert.ok(summary.voicedRatio > 0.2);
  console.log(
    `separate ${separatedMs}ms, pitch ${pitchMs}ms, A4 ${a4.toFixed(1)} Hz, vibrato ${vib.rate.toFixed(2)} Hz ±${vib.depth.toFixed(0)}c`,
  );
  assert.equal(DEMO_NOTES[0].hz, 440);
});
