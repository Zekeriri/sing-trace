function fromSamples(samples, bucket) {
  const n = Math.max(1, Math.ceil(samples.length / bucket));
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = i * bucket;
    const b = Math.min(samples.length, a + bucket);
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = a; j < b; j++) {
      const v = samples[j];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[i] = lo === Infinity ? 0 : lo;
    max[i] = hi === -Infinity ? 0 : hi;
  }
  return { bucket, min, max };
}

function downsample(level, factor) {
  const n = Math.ceil(level.min.length / factor);
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = i * factor;
    const b = Math.min(level.min.length, a + factor);
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = a; j < b; j++) {
      if (level.min[j] < lo) lo = level.min[j];
      if (level.max[j] > hi) hi = level.max[j];
    }
    min[i] = lo;
    max[i] = hi;
  }
  return { bucket: level.bucket * factor, min, max };
}

export function buildPeaks(samples) {
  const bucket = samples.length > 240000 ? 256 : 64;
  const levels = [fromSamples(samples, bucket)];
  while (levels[levels.length - 1].min.length > 2800) {
    levels.push(downsample(levels[levels.length - 1], 4));
  }
  return { length: samples.length, levels };
}
