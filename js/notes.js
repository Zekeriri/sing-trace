const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function midiToHz(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / 440);
}

export function describeHz(hz) {
  if (!hz || hz <= 0 || !Number.isFinite(hz)) return null;
  const midiFloat = hzToMidi(hz);
  const midi = Math.round(midiFloat);
  const cents = Math.round((midiFloat - midi) * 100);
  const name = NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return {
    midi,
    cents,
    absCents: Math.abs(cents),
    name: `${name}${octave}`,
    letter: name,
    hz,
  };
}

export function formatCents(cents) {
  const sign = cents > 0 ? "+" : "";
  return `${sign}${cents}`;
}
