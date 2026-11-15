// Two cascaded Butterworth low-passes, then linear interpolation.

function lowpass(input, sampleRate, cutoff) {
  const out = new Float32Array(input.length);
  const omega = (2 * Math.PI * cutoff) / sampleRate;
  const sn = Math.sin(omega);
  const cs = Math.cos(omega);
  const alpha = sn / (2 * Math.SQRT1_2);
  const b0 = (1 - cs) / 2;
  const b1 = 1 - cs;
  const b2 = (1 - cs) / 2;
  const a0 = 1 + alpha;
  const a1 = (-2 * cs) / a0;
  const a2 = (1 - alpha) / a0;
  const bb0 = b0 / a0;
  const bb1 = b1 / a0;
  const bb2 = b2 / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = bb0 * x0 + bb1 * x1 + bb2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

export function resampleTo(input, inRate, outRate) {
  if (inRate === outRate) return Float32Array.from(input);
  const cutoff = Math.min(inRate, outRate) * 0.45;
  let filtered = lowpass(input, inRate, cutoff);
  filtered = lowpass(filtered, inRate, cutoff);
  const outLen = Math.max(1, Math.floor((input.length * outRate) / inRate));
  const out = new Float32Array(outLen);
  const step = inRate / outRate;
  const last = filtered.length - 1;
  for (let i = 0; i < outLen; i++) {
    const x = i * step;
    const i0 = Math.min(last, Math.floor(x));
    const i1 = Math.min(last, i0 + 1);
    const f = x - i0;
    out[i] = filtered[i0] * (1 - f) + filtered[i1] * f;
  }
  return out;
}
