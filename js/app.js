import { summarizePitch } from "./pitch.js";
import { createTimeline } from "./view.js";

const SAMPLE_FILE = "秒針を噛む   feat.尤里 - 人声.mp3";

const $ = (id) => document.getElementById(id);

const appEl = document.querySelector(".app");
const emptyEl = $("empty");
const workspaceEl = $("workspace");
const progressEl = $("progress");
const progressFill = $("progress-fill");
const progressLabel = $("progress-label");
const errorEl = $("error");
const fileInput = $("file");
const openBtn = $("open");
const demoBtn = $("demo");
const playBtn = $("play");
const followBtn = $("follow");
const fitBtn = $("fit");
const volumeInput = $("volume");
const titleEl = $("track-title");
const statsEl = $("stats");
const curEl = $("cur");
const durEl = $("dur");
const rdTime = $("rd-time");
const rdNote = $("rd-note");
const rdCents = $("rd-cents");
const rdHz = $("rd-hz");
const rdVib = $("rd-vib");
const rdWindow = $("rd-window");

const view = createTimeline($("main"), $("overview"));

const state = {
  name: "",
  channels: 0,
  duration: 0,
  sampleRate: 0,
  audio: null,
  position: 0,
  playing: false,
  startedAt: 0,
  source: null,
};

let audioCtx = null;
let gainNode = null;
let worker = null;
let pendingReject = null;
let runToken = 0;
let playGen = 0;
let hovering = false;
let raf = 0;

function audio() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = Number(volumeInput.value);
    gainNode.connect(audioCtx.destination);
  }
  return audioCtx;
}

function formatClock(sec, precise = false) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  if (precise) return `${m}:${s.toFixed(1).padStart(4, "0")}`;
  return `${m}:${String(Math.floor(s)).padStart(2, "0")}`;
}

function showProgress(ratio) {
  progressEl.hidden = false;
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  progressFill.style.width = `${pct}%`;
  progressLabel.textContent = ratio < 0.08 ? `正在解码音频 ${pct}%` : `正在画出音高线 ${pct}%`;
}

function fail(message) {
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function setBusy(busy) {
  openBtn.disabled = busy;
  demoBtn.disabled = busy;
  const ready = !busy && !!state.audio;
  playBtn.disabled = !ready;
  followBtn.disabled = !ready;
  fitBtn.disabled = !ready;
  appEl.dataset.busy = busy ? "true" : "false";
}

function syncFollow() {
  const on = view.getFollow();
  followBtn.classList.toggle("on", on);
  followBtn.setAttribute("aria-pressed", on ? "true" : "false");
}

function renderClock(time) {
  curEl.textContent = formatClock(time);
  durEl.textContent = formatClock(state.duration);
}

function renderReadout(info) {
  if (!info) {
    rdTime.textContent = "—";
    rdNote.textContent = "—";
    rdCents.textContent = "—";
    rdHz.textContent = "—";
    rdVib.textContent = "—";
    rdCents.className = "";
    return;
  }
  rdTime.textContent = formatClock(info.time, true);
  if (!info.note) {
    rdNote.textContent = "—";
    rdCents.textContent = "—";
    rdHz.textContent = "—";
    rdVib.textContent = "无稳定音高";
    rdCents.className = "";
    return;
  }
  rdNote.textContent = info.note.name;
  const cents = info.note.cents;
  rdCents.textContent = `${cents > 0 ? "+" : ""}${cents} 音分`;
  rdCents.className = info.note.absCents <= 18 ? "good" : info.note.absCents <= 40 ? "warn" : "bad";
  rdHz.textContent = `${info.hz.toFixed(1)} Hz`;
  rdVib.textContent = info.vibrato
    ? `${info.vibrato.rate.toFixed(1)} Hz · ±${Math.round(info.vibrato.depth)} 音分`
    : "平稳";
}

function renderWindow() {
  const span = view.getView();
  rdWindow.textContent = `${formatClock(span.start, true)} – ${formatClock(span.end, true)}`;
  syncFollow();
}

function currentTime() {
  if (!state.playing || !audioCtx) return state.position;
  return state.position + (audioCtx.currentTime - state.startedAt);
}

function stopSource() {
  const source = state.source;
  state.source = null;
  if (!source) return;
  source.onended = null;
  try {
    source.stop();
  } catch {
    /* already stopped */
  }
}

function halt(at) {
  playGen += 1;
  stopSource();
  state.playing = false;
  state.position = Math.max(0, Math.min(state.duration || 0, at));
  playBtn.textContent = "播放";
  playBtn.setAttribute("aria-pressed", "false");
  if (state.audio) {
    view.setPlayhead(state.position, { follow: false });
    renderClock(state.position);
    if (!hovering) renderReadout(view.describe(state.position));
  }
}

function tick() {
  if (!state.playing) return;
  const time = currentTime();
  if (time >= state.duration - 0.03) {
    halt(state.duration);
    return;
  }
  view.setPlayhead(time, { follow: true });
  renderClock(time);
  if (!hovering) renderReadout(view.describe(time));
  raf = requestAnimationFrame(tick);
}

async function play() {
  if (!state.audio) return;
  const gen = ++playGen;
  const ctx = audio();
  await ctx.resume();
  if (gen !== playGen || !state.audio) return;
  if (state.position >= state.duration - 0.05) state.position = 0;
  stopSource();
  const source = ctx.createBufferSource();
  source.buffer = state.audio;
  source.connect(gainNode);
  source.onended = () => {
    if (state.source !== source) return;
    halt(state.duration);
  };
  state.source = source;
  state.startedAt = ctx.currentTime;
  state.playing = true;
  source.start(0, state.position);
  playBtn.textContent = "暂停";
  playBtn.setAttribute("aria-pressed", "true");
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

function togglePlay() {
  if (state.playing) halt(currentTime());
  else play();
}

function seek(time) {
  const wasPlaying = state.playing;
  halt(time);
  if (wasPlaying) play();
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  return worker;
}

function cancelWorker() {
  if (pendingReject) {
    const reject = pendingReject;
    pendingReject = null;
    reject(new DOMException("已取消", "AbortError"));
  }
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

function processAudio(samples, sampleRate, token) {
  cancelWorker();
  const current = ensureWorker();
  return new Promise((resolve, reject) => {
    pendingReject = reject;
    const finish = (fn, value) => {
      if (pendingReject === reject) pendingReject = null;
      current.removeEventListener("message", onMessage);
      fn(value);
    };
    const onMessage = (event) => {
      if (!event.data || event.data.id !== token) return;
      if (event.data.type === "progress") {
        if (token === runToken) showProgress(0.08 + event.data.ratio * 0.92);
        return;
      }
      if (event.data.type === "done") finish(resolve, event.data);
      else finish(reject, new Error(event.data.message || "处理失败"));
    };
    current.addEventListener("message", onMessage);
    current.addEventListener("error", () => {
      finish(reject, new Error("分析线程中断了"));
    }, { once: true });
    current.postMessage({ id: token, sampleRate, samples }, [samples.buffer]);
  });
}

function monoMix(decoded) {
  const n = decoded.length;
  const channels = decoded.numberOfChannels;
  const out = new Float32Array(n);
  for (let c = 0; c < channels; c++) {
    const data = decoded.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i];
  }
  if (channels > 1) {
    for (let i = 0; i < n; i++) out[i] /= channels;
  }
  return out;
}

function renderLoaded(summary) {
  const khz = (state.sampleRate / 1000).toFixed(1).replace(/\.0$/, "");
  titleEl.textContent = `${state.name} · ${khz} kHz · ${state.channels > 1 ? "立体声" : "单声道"} · ${formatClock(state.duration)}`;
  if (!summary.low || !summary.high) {
    statsEl.textContent = "没有检出稳定音高。换一段更清晰的人声再试。";
    return;
  }
  const voiced = `有声 ${Math.round(summary.voicedRatio * 100)}%`;
  const vib = summary.vibratoRatio > 0.08 && summary.medianRate
    ? ` · 颤音 ${summary.medianRate.toFixed(1)} Hz / ±${Math.round(summary.medianDepth)} 音分`
    : "";
  statsEl.textContent = `音域 ${summary.low.name}–${summary.high.name} · ${voiced}${vib}`;
}

async function analyze(token, { name, sampleRate, samples, buffer, channels }) {
  if (state.playing) halt(0);
  errorEl.hidden = true;
  showProgress(0.08);
  const result = await processAudio(samples, sampleRate, token);
  if (token !== runToken) return;
  state.name = name;
  state.sampleRate = sampleRate;
  state.channels = channels;
  state.audio = buffer;
  state.duration = buffer.duration;
  state.position = 0;
  emptyEl.hidden = true;
  workspaceEl.hidden = false;
  view.setData({
    pitch: result.pitch,
    duration: state.duration,
  });
  renderLoaded(summarizePitch(result.pitch));
  renderClock(0);
  renderWindow();
  renderReadout(view.describe(0));
  requestAnimationFrame(() => view.resize());
}

async function loadFile(file) {
  const token = ++runToken;
  setBusy(true);
  errorEl.hidden = true;
  try {
    if (state.playing) halt(0);
    showProgress(0.01);
    const ctx = audio();
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    if (token !== runToken) return;
    if (decoded.duration > 12 * 60) throw new Error("超过 12 分钟了，请先截出要看的片段。");
    if (decoded.length < 2048) throw new Error("这段音频太短，听不出音高。");
    await analyze(token, {
      name: file.name.replace(/\.[^.]+$/, "").replace(/\s+/g, " ").trim(),
      sampleRate: decoded.sampleRate,
      samples: monoMix(decoded),
      buffer: decoded,
      channels: decoded.numberOfChannels,
    });
  } catch (error) {
    if (token === runToken && error.name !== "AbortError") fail(error.message || "这个文件没能打开。");
  } finally {
    if (token === runToken) {
      progressEl.hidden = true;
      setBusy(false);
    }
  }
}

async function loadSample() {
  const token = runToken;
  setBusy(true);
  errorEl.hidden = true;
  try {
    showProgress(0.01);
    const url = new URL(`../${SAMPLE_FILE}`, import.meta.url);
    const response = await fetch(url);
    if (!response.ok) throw new Error("示例人声没有载入。");
    if (token !== runToken) return;
    const blob = await response.blob();
    if (token !== runToken) return;
    await loadFile(new File([blob], SAMPLE_FILE, { type: blob.type || "audio/mpeg" }));
  } catch (error) {
    if (token === runToken && error.name !== "AbortError") fail(error.message || "示例人声没有载入。");
    if (token === runToken) setBusy(false);
  }
}

view.onSeek((time) => seek(time));
view.onHover((info) => {
  hovering = !!info;
  renderReadout(info || view.describe(currentTime()));
});
view.onChange(() => {
  if (state.audio) renderWindow();
});

openBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = "";
  if (file) loadFile(file);
});
demoBtn.addEventListener("click", () => loadSample());
playBtn.addEventListener("click", () => togglePlay());
fitBtn.addEventListener("click", () => view.fit());
followBtn.addEventListener("click", () => {
  view.setFollow(!view.getFollow());
  syncFollow();
  if (view.getFollow()) view.setPlayhead(currentTime(), { follow: true });
});
volumeInput.addEventListener("input", () => {
  if (gainNode) gainNode.gain.value = Number(volumeInput.value);
});

let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth += 1;
  appEl.classList.add("dragover");
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) appEl.classList.remove("dragover");
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  appEl.classList.remove("dragover");
  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (file) loadFile(file);
});

window.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const tag = event.target && event.target.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (event.code === "Space") {
    event.preventDefault();
    if (state.audio) togglePlay();
  } else if (event.code === "ArrowLeft") {
    event.preventDefault();
    if (!state.audio) return;
    if (event.shiftKey) view.panBy(-(view.getView().end - view.getView().start) * 0.2);
    else seek(currentTime() - 1);
  } else if (event.code === "ArrowRight") {
    event.preventDefault();
    if (!state.audio) return;
    if (event.shiftKey) view.panBy((view.getView().end - view.getView().start) * 0.2);
    else seek(currentTime() + 1);
  } else if (event.code === "Home") {
    event.preventDefault();
    if (state.audio) seek(0);
  }
});

setBusy(false);
syncFollow();
loadSample();
