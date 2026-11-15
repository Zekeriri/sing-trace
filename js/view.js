import { describeHz, midiToHz, hzToMidi } from "./notes.js";
import { pitchAtTime, vibratoAtTime } from "./pitch.js";

const MIN_SPAN = 1.2;

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function layoutOf(width, height) {
  const gutter = width < 560 ? 46 : 58;
  const axis = 22;
  const gap = 8;
  const plotW = Math.max(1, width - gutter);
  const lanes = Math.max(1, height - axis);
  const waveH = Math.round(clamp(lanes * 0.28, 64, 128));
  const pitchY = waveH + gap;
  return {
    gutter,
    width,
    height,
    plotX: gutter,
    plotW,
    waveY: 0,
    waveH,
    pitchY,
    pitchH: Math.max(48, lanes - pitchY),
    axisY: height - axis,
    axisH: axis,
  };
}

function fitCanvas(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const pxW = Math.round(width * dpr);
  const pxH = Math.round(height * dpr);
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function rangeFor(pitch) {
  const vals = [];
  if (pitch) {
    for (let i = 0; i < pitch.f0.length; i++) if (pitch.f0[i] > 0) vals.push(pitch.f0[i]);
  }
  if (vals.length < 4) {
    return { min: midiToHz(48), max: midiToHz(72), minMidi: 48, maxMidi: 72 };
  }
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor((vals.length - 1) * 0.02)];
  const hi = vals[Math.floor((vals.length - 1) * 0.98)];
  let minMidi = Math.floor(hzToMidi(lo)) - 3;
  let maxMidi = Math.ceil(hzToMidi(hi)) + 3;
  if (maxMidi - minMidi < 12) {
    const mid = (maxMidi + minMidi) / 2;
    minMidi = Math.floor(mid - 6);
    maxMidi = Math.ceil(mid + 6);
  }
  return { min: midiToHz(minMidi), max: midiToHz(maxMidi), minMidi, maxMidi };
}

function yForHz(hz, box, range) {
  const t = (Math.log(hz) - Math.log(range.min)) / (Math.log(range.max) - Math.log(range.min));
  return box.pitchY + box.pitchH - t * box.pitchH;
}

function colorForHz(hz) {
  const midi = hzToMidi(hz);
  const cents = Math.abs(midi - Math.round(midi)) * 100;
  if (cents <= 18) return "#b7d98a";
  if (cents <= 40) return "#e2b15a";
  return "#e57a55";
}

function chooseLevel(peaks, samplesPerPixel) {
  let best = peaks.levels[0];
  for (const level of peaks.levels) {
    if (level.bucket <= samplesPerPixel * 1.35) best = level;
  }
  return best;
}

function formatTick(sec) {
  const sign = sec < 0 ? "-" : "";
  const abs = Math.abs(sec);
  const m = Math.floor(abs / 60);
  const s = abs - m * 60;
  if (abs < 10 && m === 0) return `${sign}${s.toFixed(s < 1 ? 2 : 1)}`;
  return `${sign}${m}:${String(Math.floor(s)).padStart(2, "0")}`;
}

export function createTimeline(mainCanvas, overviewCanvas) {
  const api = {
    onSeek() {},
    onHover() {},
    onChange() {},
  };

  let data = null;
  let range = rangeFor(null);
  let viewStart = 0;
  let viewEnd = 1;
  let playhead = 0;
  let follow = true;
  let hoverTime = null;
  let drag = null;
  let overviewDrag = null;

  function emitChange() {
    api.onChange();
  }

  function clampView() {
    if (!data) return;
    const duration = data.duration;
    let span = viewEnd - viewStart;
    const minSpan = Math.min(duration, MIN_SPAN);
    if (span < minSpan) span = minSpan;
    if (span > duration) span = duration;
    if (viewStart < 0) viewStart = 0;
    viewEnd = viewStart + span;
    if (viewEnd > duration) {
      viewEnd = duration;
      viewStart = Math.max(0, duration - span);
    }
  }

  function resize() {
    if (!data) return;
    draw();
  }

  function draw() {
    if (!data) return;
    drawMain();
    drawOverview();
  }

  function drawMain() {
    const { ctx, width, height } = fitCanvas(mainCanvas);
    const box = layoutOf(width, height);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#10120e";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#0c0d0a";
    ctx.fillRect(0, 0, box.gutter, height);
    ctx.fillStyle = "#161910";
    ctx.fillRect(box.plotX, box.waveY, box.plotW, box.waveH);
    ctx.fillStyle = "#12150f";
    ctx.fillRect(box.plotX, box.pitchY, box.plotW, box.pitchH);

    drawGrid(ctx, box);
    drawWave(ctx, box);
    drawPitch(ctx, box);
    drawLabels(ctx, box);
    drawPlayhead(ctx, box);
    if (hoverTime != null && !drag) drawHover(ctx, box, hoverTime);
    drawAxis(ctx, box);
  }

  function drawGrid(ctx, box) {
    const span = viewEnd - viewStart;
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.plotX, 0, box.plotW, box.axisY);
    ctx.clip();
    const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    let step = steps[steps.length - 1];
    for (const candidate of steps) {
      if ((candidate / span) * box.plotW >= 72) {
        step = candidate;
        break;
      }
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(239, 231, 210, 0.05)";
    ctx.beginPath();
    const first = Math.ceil(viewStart / step) * step;
    for (let t = first; t < viewEnd; t += step) {
      const x = box.plotX + ((t - viewStart) / span) * box.plotW;
      ctx.moveTo(x, box.waveY);
      ctx.lineTo(x, box.pitchY + box.pitchH);
    }
    ctx.stroke();

    ctx.font = "11px ui-sans-serif, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const semitonePx = box.pitchH / Math.max(1, range.maxMidi - range.minMidi);
    for (let midi = range.minMidi; midi <= range.maxMidi; midi++) {
      const hz = midiToHz(midi);
      const y = yForHz(hz, box, range);
      const isC = ((midi % 12) + 12) % 12 === 0;
      ctx.strokeStyle = isC ? "rgba(239, 231, 210, 0.16)" : "rgba(239, 231, 210, 0.045)";
      ctx.beginPath();
      ctx.moveTo(box.plotX, y);
      ctx.lineTo(box.plotX + box.plotW, y);
      ctx.stroke();
      if (isC || semitonePx >= 16) {
        const note = describeHz(hz);
        ctx.fillStyle = isC ? "rgba(239, 231, 210, 0.72)" : "rgba(239, 231, 210, 0.38)";
        ctx.fillText(note.name, box.gutter - 8, y);
      }
    }
    ctx.restore();
  }

  function drawWave(ctx, box) {
    const { peaks, sampleRate } = data;
    if (!peaks || !peaks.length) return;
    const span = viewEnd - viewStart;
    const samplesPerPixel = (span * sampleRate) / box.plotW;
    const level = chooseLevel(peaks, samplesPerPixel);
    const mid = box.waveY + box.waveH / 2;
    const amp = (box.waveH / 2) * 0.82;
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.plotX, box.waveY, box.plotW, box.waveH);
    ctx.clip();
    ctx.strokeStyle = "rgba(183, 201, 164, 0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let px = 0; px < box.plotW; px++) {
      const s0 = ((viewStart + (px / box.plotW) * span) * sampleRate);
      const s1 = ((viewStart + ((px + 1) / box.plotW) * span) * sampleRate);
      let b0 = Math.floor(s0 / level.bucket);
      let b1 = Math.ceil(s1 / level.bucket);
      b0 = clamp(b0, 0, level.min.length - 1);
      b1 = clamp(Math.max(b1, b0 + 1), 0, level.min.length);
      let lo = Infinity;
      let hi = -Infinity;
      for (let b = b0; b < b1; b++) {
        if (level.min[b] < lo) lo = level.min[b];
        if (level.max[b] > hi) hi = level.max[b];
      }
      if (lo === Infinity) continue;
      const x = box.plotX + px + 0.5;
      ctx.moveTo(x, mid - hi * amp);
      ctx.lineTo(x, mid - lo * amp);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(239, 231, 210, 0.16)";
    ctx.beginPath();
    ctx.moveTo(box.plotX, mid);
    ctx.lineTo(box.plotX + box.plotW, mid);
    ctx.stroke();
    ctx.restore();
  }

  function framesInView() {
    const pitch = data.pitch;
    if (!pitch || !pitch.f0.length) return [];
    const frameDur = pitch.hop / pitch.rate;
    const center = pitch.window / 2 / pitch.rate;
    const i0 = Math.max(0, Math.floor((viewStart - center) / frameDur) - 1);
    const i1 = Math.min(pitch.f0.length, Math.ceil((viewEnd - center) / frameDur) + 1);
    return [i0, i1, frameDur, center];
  }

  function drawPitch(ctx, box) {
    const pitch = data.pitch;
    if (!pitch || !pitch.f0.length) return;
    const [i0, i1, frameDur, center] = framesInView();
    const span = viewEnd - viewStart;
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.plotX, box.pitchY, box.plotW, box.pitchH);
    ctx.clip();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    const count = i1 - i0;
    const detailed = count <= box.plotW * 3;
    if (detailed) drawDetailedPitch(ctx, box, i0, i1, frameDur, center, span);
    else drawAggregatedPitch(ctx, box, i0, i1, frameDur, center, span);
    ctx.restore();
  }

  function xAtTime(time, box, span) {
    return box.plotX + ((time - viewStart) / span) * box.plotW;
  }

  function drawDetailedPitch(ctx, box, i0, i1, frameDur, center, span) {
    const pitch = data.pitch;
    const points = [];
    for (let i = i0; i < i1; i++) {
      const hz = pitch.f0[i];
      if (hz <= 0) {
        points.push(null);
        continue;
      }
      points.push({
        x: xAtTime(i * frameDur + center, box, span),
        y: yForHz(hz, box, range),
        hz,
        vib: pitch.vibrato[i] === 1,
      });
    }
    strokeVibratoHalo(ctx, points);
    strokeColored(ctx, points);
  }

  function drawAggregatedPitch(ctx, box, i0, i1, frameDur, center, span) {
    const pitch = data.pitch;
    const columns = [];
    for (let px = 0; px < box.plotW; px++) {
      const t0 = viewStart + (px / box.plotW) * span;
      const t1 = viewStart + ((px + 1) / box.plotW) * span;
      const a = clamp(Math.floor((t0 - center) / frameDur), i0, i1);
      const b = clamp(Math.ceil((t1 - center) / frameDur), a, i1);
      let logSum = 0;
      let n = 0;
      let minHz = Infinity;
      let maxHz = 0;
      let vib = 0;
      for (let i = a; i < b; i++) {
        const hz = pitch.f0[i];
        if (hz <= 0) continue;
        logSum += Math.log(hz);
        n++;
        if (hz < minHz) minHz = hz;
        if (hz > maxHz) maxHz = hz;
        if (pitch.vibrato[i]) vib++;
      }
      if (!n) {
        columns.push(null);
        continue;
      }
      const mean = Math.exp(logSum / n);
      columns.push({
        x: box.plotX + px + 0.5,
        y: yForHz(mean, box, range),
        hz: mean,
        minY: yForHz(maxHz, box, range),
        maxY: yForHz(minHz, box, range),
        vib: vib / n > 0.45,
      });
    }
    ctx.fillStyle = "rgba(186, 156, 222, 0.38)";
    for (const col of columns) {
      if (!col || !col.vib) continue;
      const top = Math.min(col.minY, col.maxY);
      const h = Math.max(2, Math.abs(col.maxY - col.minY));
      ctx.fillRect(col.x - 0.5, top, 1.4, h);
    }
    strokeColored(ctx, columns);
  }

  function strokeVibratoHalo(ctx, points) {
    ctx.strokeStyle = "rgba(186, 156, 222, 0.85)";
    ctx.lineWidth = 7;
    strokeRuns(ctx, points, (point) => (point.vib ? "rgba(186, 156, 222, 0.8)" : null));
  }

  function strokeColored(ctx, points) {
    ctx.lineWidth = 3.6;
    strokeRuns(ctx, points, () => "rgba(8, 9, 6, 0.72)");
    ctx.lineWidth = 1.75;
    strokeRuns(ctx, points, (point) => colorForHz(point.hz));
  }

  function strokeRuns(ctx, points, colorOf) {
    let run = [];
    let color = null;
    const flush = () => {
      if (run.length === 0) return;
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.moveTo(run[0].x, run[0].y);
      for (let i = 1; i < run.length; i++) ctx.lineTo(run[i].x, run[i].y);
      if (run.length === 1) ctx.lineTo(run[0].x + 1, run[0].y);
      ctx.stroke();
      run = [];
    };
    for (const point of points) {
      const next = point ? colorOf(point) : null;
      if (!point || !next) {
        flush();
        color = null;
        continue;
      }
      if (next !== color) {
        const bridge = run.length ? run[run.length - 1] : null;
        flush();
        color = next;
        if (bridge) run.push(bridge);
        run.push(point);
      } else {
        run.push(point);
      }
    }
    flush();
  }

  function drawLabels(ctx, box) {
    ctx.save();
    ctx.font = "11px ui-sans-serif, sans-serif";
    ctx.fillStyle = "rgba(239, 231, 210, 0.45)";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("波形", box.plotX + 8, box.waveY + 6);
    ctx.fillText("音高", box.plotX + 8, box.pitchY + 6);
    ctx.restore();
  }

  function drawPlayhead(ctx, box) {
    if (playhead < viewStart || playhead > viewEnd) return;
    const x = xAtTime(playhead, box, viewEnd - viewStart);
    ctx.strokeStyle = "#f4efe2";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, box.pitchY + box.pitchH);
    ctx.stroke();
    const hz = data.pitch ? pitchAtTime(data.pitch, playhead) : 0;
    if (hz > 0) {
      const y = clamp(yForHz(hz, box, range), box.pitchY + 12, box.pitchY + box.pitchH - 12);
      const note = describeHz(hz);
      const label = note.name;
      ctx.font = "12px ui-sans-serif, sans-serif";
      const w = ctx.measureText(label).width + 12;
      const left = clamp(x + 8, box.plotX, box.plotX + box.plotW - w);
      ctx.fillStyle = "#f4efe2";
      roundRect(ctx, left, y - 10, w, 20, 9);
      ctx.fill();
      ctx.fillStyle = "#1a1c14";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, left + 6, y);
    }
  }

  function drawHover(ctx, box, time) {
    if (time < viewStart || time > viewEnd) return;
    const x = xAtTime(time, box, viewEnd - viewStart);
    ctx.strokeStyle = "rgba(226, 177, 90, 0.8)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, box.waveY);
    ctx.lineTo(x, box.pitchY + box.pitchH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawAxis(ctx, box) {
    const span = viewEnd - viewStart;
    const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    let step = steps[steps.length - 1];
    for (const candidate of steps) {
      if ((candidate / span) * box.plotW >= 72) {
        step = candidate;
        break;
      }
    }
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillStyle = "rgba(239, 231, 210, 0.62)";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const first = Math.ceil(viewStart / step) * step;
    for (let t = first; t < viewEnd; t += step) {
      const x = box.plotX + ((t - viewStart) / span) * box.plotW;
      ctx.fillText(formatTick(t), x, box.axisY + 4);
    }
  }

  function drawOverview() {
    const { ctx, width, height } = fitCanvas(overviewCanvas);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#14170f";
    ctx.fillRect(0, 0, width, height);
    const { peaks } = data;
    if (peaks && peaks.levels.length) {
      const level = peaks.levels[peaks.levels.length - 1];
      const mid = height / 2;
      const amp = height * 0.36;
      ctx.strokeStyle = "rgba(183, 201, 164, 0.75)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < width; x++) {
        const b0 = Math.floor((x / width) * level.min.length);
        const b1 = Math.max(b0 + 1, Math.ceil(((x + 1) / width) * level.min.length));
        let lo = Infinity;
        let hi = -Infinity;
        for (let b = b0; b < Math.min(level.min.length, b1); b++) {
          if (level.min[b] < lo) lo = level.min[b];
          if (level.max[b] > hi) hi = level.max[b];
        }
        if (lo === Infinity) continue;
        ctx.moveTo(x + 0.5, mid - hi * amp);
        ctx.lineTo(x + 0.5, mid - lo * amp);
      }
      ctx.stroke();
    }
    const duration = data.duration || 1;
    const x0 = (viewStart / duration) * width;
    const x1 = (viewEnd / duration) * width;
    ctx.fillStyle = "rgba(226, 177, 90, 0.16)";
    ctx.fillRect(x0, 0, Math.max(2, x1 - x0), height);
    ctx.strokeStyle = "#e2b15a";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0 + 0.5, 0.5, Math.max(2, x1 - x0) - 1, height - 1);
    if (playhead >= 0 && playhead <= duration) {
      const px = (playhead / duration) * width;
      ctx.strokeStyle = "#f4efe2";
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      ctx.stroke();
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function localBox() {
    const rect = mainCanvas.getBoundingClientRect();
    return { rect, box: layoutOf(rect.width, rect.height) };
  }

  function timeAtClient(clientX) {
    if (!data) return null;
    const { rect, box } = localBox();
    const x = clientX - rect.left;
    if (x < box.plotX || x > box.plotX + box.plotW) return null;
    const ratio = (x - box.plotX) / box.plotW;
    return viewStart + ratio * (viewEnd - viewStart);
  }

  function overviewTime(clientX) {
    const rect = overviewCanvas.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    return ratio * data.duration;
  }

  function pointerDown(event) {
    if (!data) return;
    mainCanvas.setPointerCapture(event.pointerId);
    drag = {
      id: event.pointerId,
      x: event.clientX,
      viewStart,
      span: viewEnd - viewStart,
      moved: false,
    };
  }

  function pointerMove(event) {
    if (!data) return;
    if (drag && event.pointerId === drag.id) {
      const dx = event.clientX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      if (drag.moved) {
        follow = false;
        const { box } = localBox();
        viewStart = drag.viewStart - (dx / box.plotW) * drag.span;
        viewEnd = viewStart + drag.span;
        clampView();
        mainCanvas.style.cursor = "grabbing";
        draw();
        emitChange();
      }
      return;
    }
    const time = timeAtClient(event.clientX);
    hoverTime = time;
    api.onHover(time == null ? null : describeTime(time));
    draw();
  }

  function pointerUp(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    mainCanvas.style.cursor = "crosshair";
    if (!moved) {
      const time = timeAtClient(event.clientX);
      if (time != null) api.onSeek(time);
    }
    draw();
  }

  function onWheel(event) {
    if (!data) return;
    event.preventDefault();
    const dy = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const factor = Math.exp(dy * 0.0016);
    const { box } = localBox();
    const rect = mainCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const ratio = x < box.plotX ? 0.5 : clamp((x - box.plotX) / box.plotW, 0, 1);
    const span = viewEnd - viewStart;
    const anchor = viewStart + ratio * span;
    let next = span * factor;
    const minSpan = Math.min(data.duration, MIN_SPAN);
    next = clamp(next, minSpan, data.duration);
    viewStart = anchor - ratio * next;
    viewEnd = viewStart + next;
    clampView();
    draw();
    emitChange();
  }

  function overviewDown(event) {
    if (!data) return;
    overviewCanvas.setPointerCapture(event.pointerId);
    const t = overviewTime(event.clientX);
    const span = viewEnd - viewStart;
    const inside = t >= viewStart && t <= viewEnd;
    overviewDrag = {
      id: event.pointerId,
      grab: inside ? t - viewStart : span / 2,
      span,
    };
    viewStart = t - overviewDrag.grab;
    viewEnd = viewStart + span;
    clampView();
    follow = false;
    draw();
    emitChange();
  }

  function overviewMove(event) {
    if (!overviewDrag || event.pointerId !== overviewDrag.id) return;
    const t = overviewTime(event.clientX);
    viewStart = t - overviewDrag.grab;
    viewEnd = viewStart + overviewDrag.span;
    clampView();
    draw();
    emitChange();
  }

  function overviewUp(event) {
    if (!overviewDrag || event.pointerId !== overviewDrag.id) return;
    overviewDrag = null;
  }

  function describeTime(time) {
    const hz = data.pitch ? pitchAtTime(data.pitch, time) : 0;
    return {
      time,
      hz,
      note: hz ? describeHz(hz) : null,
      vibrato: data.pitch ? vibratoAtTime(data.pitch, time) : null,
    };
  }

  mainCanvas.addEventListener("pointerdown", pointerDown);
  mainCanvas.addEventListener("pointermove", pointerMove);
  mainCanvas.addEventListener("pointerup", pointerUp);
  mainCanvas.addEventListener("pointercancel", pointerUp);
  mainCanvas.addEventListener("pointerleave", () => {
    if (drag) return;
    hoverTime = null;
    api.onHover(null);
    if (data) draw();
  });
  mainCanvas.addEventListener("wheel", onWheel, { passive: false });
  overviewCanvas.addEventListener("pointerdown", overviewDown);
  overviewCanvas.addEventListener("pointermove", overviewMove);
  overviewCanvas.addEventListener("pointerup", overviewUp);
  overviewCanvas.addEventListener("pointercancel", overviewUp);

  const observer = new ResizeObserver(() => {
    if (data) draw();
  });
  observer.observe(mainCanvas);
  observer.observe(overviewCanvas);

  return {
    onSeek: (fn) => {
      api.onSeek = fn;
    },
    onHover: (fn) => {
      api.onHover = fn;
    },
    onChange: (fn) => {
      api.onChange = fn;
    },
    setData(next) {
      data = next;
      range = rangeFor(next.pitch);
      viewStart = 0;
      viewEnd = next.duration || 1;
      playhead = 0;
      follow = true;
      hoverTime = null;
      clampView();
      resize();
      emitChange();
    },
    setPlayhead(time, options = {}) {
      playhead = time;
      if (!data) return;
      let moved = false;
      if (options.follow && follow) {
        const span = viewEnd - viewStart;
        const margin = span * 0.18;
        if (time > viewEnd - margin || time < viewStart) {
          const before = viewStart;
          viewEnd = time + margin;
          viewStart = viewEnd - span;
          clampView();
          moved = Math.abs(before - viewStart) > 0.0005;
        }
      }
      draw();
      if (moved) emitChange();
    },
    panBy(seconds) {
      if (!data) return;
      const span = viewEnd - viewStart;
      viewStart += seconds;
      viewEnd = viewStart + span;
      follow = false;
      clampView();
      draw();
      emitChange();
    },
    fit() {
      if (!data) return;
      viewStart = 0;
      viewEnd = data.duration;
      draw();
      emitChange();
    },
    setFollow(value) {
      follow = value;
      if (follow && data) {
        const span = viewEnd - viewStart;
        if (playhead < viewStart || playhead > viewEnd) {
          viewStart = playhead - span * 0.3;
          viewEnd = viewStart + span;
          clampView();
          draw();
          emitChange();
        }
      }
    },
    getFollow() {
      return follow;
    },
    getView() {
      return { start: viewStart, end: viewEnd, follow };
    },
    describe(time) {
      if (!data) return null;
      return describeTime(time);
    },
    resize,
  };
}
