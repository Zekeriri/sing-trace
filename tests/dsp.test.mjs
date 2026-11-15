import assert from "node:assert/strict";
import test from "node:test";
import { fft, ifft } from "../js/fft.js";
import { frameTime, summarizePitch, trackPitch } from "../js/pitch.js";

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

function sine(sampleRate, seconds, freq) {
  const n = Math.floor(sampleRate * seconds);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.4 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return x;
}

function vibratoTone(sampleRate, seconds, freq, rateHz, depthCents) {
  const n = Math.floor(sampleRate * seconds);
  const x = new Float32Array(n);
  const depth = depthCents / 1200;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const inst = freq * 2 ** (depth * Math.sin(2 * Math.PI * rateHz * t));
    phase += (2 * Math.PI * inst) / sampleRate;
    x[i] = 0.45 * Math.sin(phase);
  }
  return x;
}

function harmonicTone(sampleRate, seconds, freq) {
  const n = Math.floor(sampleRate * seconds);
  const x = new Float32Array(n);
  const amps = [1, 0.55, 0.32, 0.18, 0.1];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let h = 0; h < amps.length; h++) {
      s += amps[h] * Math.sin((2 * Math.PI * freq * (h + 1) * i) / sampleRate);
    }
    x[i] = 0.22 * s;
  }
  return x;
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
  const pitch = trackPitch(sine(sampleRate, 1, 440), sampleRate);
  const hz = medianHz(pitch, 0.2, 0.8);
  assert.ok(Math.abs(hz - 440) < 2, `median f0 ${hz}`);
  const vib = vibratoStats(pitch, 0.2, 0.8);
  assert.ok(vib.ratio < 0.2, `steady tone vibrato ratio ${vib.ratio}`);
  const summary = summarizePitch(pitch);
  assert.ok(summary.voicedRatio > 0.5);
});

test("harmonic tone stays on the fundamental", () => {
  const sampleRate = 44100;
  const pitch = trackPitch(harmonicTone(sampleRate, 1.4, 220), sampleRate);
  const hz = medianHz(pitch, 0.25, 1.15);
  assert.ok(Math.abs(hz - 220) < 3, `fundamental ${hz}`);
  assert.ok(hz < 300, "octave up");
});

test("vibrato sine reports rate and depth", () => {
  const sampleRate = 44100;
  const pitch = trackPitch(vibratoTone(sampleRate, 2.4, 440, 5.2, 50), sampleRate);
  const hz = medianHz(pitch, 0.4, 2.0);
  assert.ok(Math.abs(hz - 440) < 6, `median f0 ${hz}`);
  const vib = vibratoStats(pitch, 0.45, 2.0);
  assert.ok(vib.ratio > 0.45, `vibrato coverage ${vib.ratio}`);
  assert.ok(vib.rate > 4.2 && vib.rate < 6.4, `vibrato rate ${vib.rate}`);
  assert.ok(vib.depth > 25 && vib.depth < 120, `vibrato depth ${vib.depth}`);
});
