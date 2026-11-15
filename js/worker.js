import { trackPitch } from "./pitch.js";

self.onmessage = (event) => {
  const { id, sampleRate, samples } = event.data;
  try {
    if (!samples || !samples.length) throw new Error("音频是空的");
    const pitch = trackPitch(samples, sampleRate, (ratio) => {
      self.postMessage({ id, type: "progress", ratio, stage: "pitch" });
    });
    self.postMessage(
      {
        id,
        type: "done",
        pitch: {
          f0: pitch.f0,
          hop: pitch.hop,
          window: pitch.window,
          rate: pitch.rate,
          vibrato: pitch.vibrato,
          vibratoRate: pitch.vibratoRate,
          vibratoDepth: pitch.vibratoDepth,
        },
      },
      [pitch.f0.buffer, pitch.vibrato.buffer, pitch.vibratoRate.buffer, pitch.vibratoDepth.buffer],
    );
  } catch (error) {
    self.postMessage({ id, type: "error", message: error && error.message ? error.message : "处理失败" });
  }
};
