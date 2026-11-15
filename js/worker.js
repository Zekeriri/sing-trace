import { separateVocals } from "./separate.js";
import { trackPitch } from "./pitch.js";

self.onmessage = (event) => {
  const { id, sampleRate, left, right } = event.data;
  try {
    if (!left || !left.length) throw new Error("音频是空的");
    const vocal = separateVocals(left, right || null, sampleRate, (ratio) => {
      self.postMessage({ id, type: "progress", ratio: ratio * 0.72, stage: "separate" });
    });
    const pitch = trackPitch(vocal, sampleRate, (ratio) => {
      self.postMessage({ id, type: "progress", ratio: 0.72 + ratio * 0.28, stage: "pitch" });
    });
    self.postMessage(
      {
        id,
        type: "done",
        vocal,
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
      [vocal.buffer, pitch.f0.buffer, pitch.vibrato.buffer, pitch.vibratoRate.buffer, pitch.vibratoDepth.buffer],
    );
  } catch (error) {
    self.postMessage({ id, type: "error", message: error && error.message ? error.message : "处理失败" });
  }
};
