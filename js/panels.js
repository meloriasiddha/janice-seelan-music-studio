// Full-screen tools: in-app recorder, file import, piano roll editor, instrument-from-song maker.
import { $, esc, icon, S, snapshot, undo, changed, toast, openPanel, closePanel, cssVar, fitCanvas, fmtBeats } from "./ui.js";
import { getCtx, decodeBlob, previewNote, instInfo, ctx as _ctx, preloadProject, clipBuffer } from "./engine.js";
import * as E from "./edit.js";
import { Recorder, openMic, encodeWav } from "./recorder.js";
import { toMono16k, analyzeHum, notesFromRaw, clipPitch } from "./pitch.js";
import { noteName, NOTE_NAMES, SCALES } from "./instruments.js";
import * as store from "./store.js";
import { addTrack, notesTrack, openInstrumentPicker, keyOptions, saveSettings, loadCustom, startPlay, stopPlay, trackColor, paintLane, openTrack } from "./app.js";

const T = S.transport;

// ======================= recorder =======================
export function openRecorder(mode = "hum") {
  stopPlay();
  let inst = S.settings.lastInst, playAlong = S.settings.playAlong !== false, click = S.settings.click !== false;
  const hasLayers = S.project.tracks.length > 0;
  const p = openPanel(`<div class="panel-head"><button class="icon-btn" id="rClose" aria-label="Close">${icon("close")}</button><h2>Record</h2></div>
    <div class="panel-body">
      <div class="seg" role="group" aria-label="What to record"><button data-m="hum" aria-pressed="${mode === "hum"}">Hum → instrument</button><button data-m="voice" aria-pressed="${mode === "voice"}">Voice recording</button></div>
      <div id="rInstRow" class="row" ${mode === "voice" ? "hidden" : ""}><span class="hint">Becomes</span><button class="btn" id="rInst"><i style="width:12px;height:12px;border-radius:4px;background:${instInfo(inst).color}"></i><span>${esc(instInfo(inst).name)}</span></button></div>
      <div class="row">
        ${hasLayers ? `<label class="chip"><input type="checkbox" id="rAlong" ${playAlong ? "checked" : ""}> Play my other layers</label>` : ""}
        <label class="chip"><input type="checkbox" id="rClick" ${click ? "checked" : ""}> Click track</label>
      </div>
      <div class="rec-stage">
        <div class="count" id="rCount"></div>
        <button class="rec-big" id="rBtn" aria-label="Start recording"><span></span></button>
        <div class="meter"><i id="rMeter"></i></div>
        <div class="hint" id="rMsg">${hasLayers ? "Wear headphones so the other layers don't leak into the mic." : "Hum each note on \"da\" or \"doo\". Tap the button when you're ready."}</div>
      </div>
    </div>`, () => { if (rec) { try { rec.stop(); } catch (e) { } } T.stop(true); });
  let rec = null, raf = 0, recording = false;
  const setMode = m => { mode = m; p.querySelectorAll("[data-m]").forEach(b => b.setAttribute("aria-pressed", b.dataset.m === m)); p.querySelector("#rInstRow").hidden = m === "voice"; };
  p.querySelector(".seg").onclick = e => { const m = e.target.closest("[data-m]")?.dataset.m; if (m && !recording) setMode(m); };
  p.querySelector("#rClose").onclick = () => closePanel();
  p.querySelector("#rInst").onclick = () => openInstrumentPicker(inst, id => { inst = id; S.settings.lastInst = id; saveSettings(); p.querySelector("#rInst span").textContent = instInfo(id).name; p.querySelector("#rInst i").style.background = instInfo(id).color; });
  p.querySelector("#rAlong")?.addEventListener("change", e => { playAlong = e.target.checked; S.settings.playAlong = playAlong; saveSettings(); });
  p.querySelector("#rClick").onchange = e => { click = e.target.checked; S.settings.click = click; saveSettings(); };
  const btn = p.querySelector("#rBtn"), msg = p.querySelector("#rMsg"), count = p.querySelector("#rCount"), meter = p.querySelector("#rMeter");

  btn.onclick = async () => {
    if (!recording) {
      getCtx();
      try { await openMic(); } catch (err) { msg.textContent = "Microphone access is blocked. Allow the microphone for this app in your phone's settings, then try again."; return; }
      btn.disabled = true; msg.textContent = "Getting ready…";
      try { await preloadProject(S.project); } catch (e) { }
      rec = new Recorder();
      await rec.start(pk => { meter.style.width = Math.min(100, pk * 140) + "%"; meter.classList.toggle("hot", pk > 0.95); });
      const proj = { ...S.project, loop: false, tracks: playAlong ? S.project.tracks : [] };
      const s = await T.start(proj, { fromBeat: 0, countIn: S.settings.countIn, metronome: click, metroVol: S.settings.metroVol });
      recording = true; btn.disabled = false; btn.classList.add("on"); btn.setAttribute("aria-label", "Stop recording");
      msg.textContent = S.settings.countIn ? "Get ready…" : "Recording. Hum now.";
      const loop = () => {
        if (!recording) return;
        const b = (getCtx().currentTime - s.t0) / s.spb;
        if (b < 0) count.textContent = String(Math.ceil(-b)); else { count.textContent = `${Math.floor(b / 4) + 1}.${Math.floor(b % 4) + 1}`; msg.textContent = "Recording. Tap to stop."; }
        if (b > 4 * 128) btn.click();
        raf = requestAnimationFrame(loop);
      };
      loop();
      p._t0 = s.t0; p._spb = s.spb;
    } else {
      recording = false; cancelAnimationFrame(raf); btn.classList.remove("on"); btn.disabled = true; count.textContent = "";
      msg.textContent = "Working…";
      const r = await rec.stop(); rec = null; T.stop(true);
      btn.disabled = false;
      const lat = r.latency + S.settings.latencyMs / 1000;
      const zeroSec = p._t0 + lat - r.startTime; // seconds into the recording where beat 1 is
      const dur = r.channels[0].length / r.sampleRate;
      if (dur - Math.max(0, zeroSec) < 0.3) { msg.textContent = "That was too short. Tap and hum again."; return; }
      showResult(p, { channels: r.channels, sr: r.sampleRate, zeroSec, mode, inst, live: true });
    }
  };
}

// Shared result screen for live recordings and imported files.
async function showResult(p, { channels, sr, zeroSec, mode, inst, live }) {
  const body = p.querySelector(".panel-body");
  body.innerHTML = `<div class="note-box" id="resMsg">Listening for notes…<div class="progress" style="margin-top:8px"><i id="resBar"></i></div></div>`;
  const spb = 60 / S.project.bpm;
  if (mode === "voice") return finishVoice();
  const { data, sr: r16 } = toMono16k(channels, sr);
  const raw = await analyzeHum(data, r16, f => { const i = body.querySelector("#resBar"); if (i) i.style.width = Math.round(f * 100) + "%"; });
  let notes = raw.map(o => ({ t: +(o.t - zeroSec).toFixed(4), d: +o.d.toFixed(4), m: +o.m.toFixed(3), v: +o.v.toFixed(2) }));
  if (!live && notes.length) { const t0 = notes[0].t; notes = notes.map(n => ({ ...n, t: +(n.t - t0).toFixed(4) })); zeroSec += t0; }
  notes = notes.filter(n => n.t > -0.15);
  if (!notes.length) {
    body.innerHTML = `<div class="note-box"><b>No clear notes found.</b><br>Hum louder and closer to the phone, one note at a time, with no music in the background.</div>
      <div class="row"><button class="btn primary" id="again">Try again</button><button class="btn" id="asVoice">Keep it as a voice recording</button></div>`;
    body.querySelector("#again").onclick = () => { closePanel(); openRecorder("hum"); };
    body.querySelector("#asVoice").onclick = () => finishVoice();
    return;
  }
  const rawObj = { notes, bpm: S.project.bpm, t0: 0 };
  let keySel = "auto", quant = "8", keepVoice = false;
  const render = () => {
    const res = notesFromRaw(rawObj, keySel, quant), lbl = res.keyLabel.split(" ");
    body.innerHTML = `<div class="note-box">Found <b>${res.notes.length} notes</b>${keySel !== "off" ? ` in <b>${NOTE_NAMES[+lbl[0]] || ""} ${esc(SCALES[lbl[1]]?.name || "")}</b>` : ""}. You can fix single notes later in Edit notes.</div>
      <div class="row"><span class="hint">Play it on</span><button class="btn" id="resInst"><i style="width:12px;height:12px;border-radius:4px;background:${instInfo(inst).color}"></i>${esc(instInfo(inst).name)}</button></div>
      <div class="row"><label class="field grow">Snap to key<select id="resKey">${keyOptions(keySel)}</select></label>
        <label class="field grow">Timing<select id="resQ"><option value="8">Tidy (1/8)</option><option value="16">Fine (1/16)</option><option value="free">As hummed</option></select></label></div>
      <label class="chip"><input type="checkbox" id="resVoice" ${keepVoice ? "checked" : ""}> Also keep my voice as a layer</label>
      <div class="row"><button class="btn primary" id="resAdd">Add to song</button><button class="btn" id="resHear">Hear notes</button><button class="btn" id="resAgain">Record again</button></div>`;
    body.querySelector("#resQ").value = quant;
    body.querySelector("#resKey").onchange = e => { keySel = e.target.value; render(); };
    body.querySelector("#resQ").onchange = e => { quant = e.target.value; render(); };
    body.querySelector("#resVoice").onchange = e => { keepVoice = e.target.checked; };
    body.querySelector("#resInst").onclick = () => openInstrumentPicker(inst, id => { inst = id; S.settings.lastInst = id; saveSettings(); render(); });
    body.querySelector("#resAgain").onclick = () => { closePanel(); live ? openRecorder("hum") : openImport(); };
    body.querySelector("#resHear").onclick = () => {
      const oct = instInfo(inst).oct || 0, c = getCtx(), t0 = c.currentTime;
      res.notes.slice(0, 64).forEach(n => setTimeout(() => previewNote(inst, n.p + 12 * oct, n.d * spb, n.v), n.s * spb * 1000));
    };
    body.querySelector("#resAdd").onclick = async () => {
      const n = S.project.tracks.filter(t => t.type === "notes").length + 1;
      if (keepVoice) await addVoice(" (voice)");
      addTrack(notesTrack(`Hum ${n} · ${instInfo(inst).name}`, inst, res.notes, { oct: instInfo(inst).oct || 0, raw: rawObj, keySel, quant, keyLabel: res.keyLabel }));
      closePanel();
    };
  };
  render();

  async function addVoice(suffix = "") {
    const id = store.uid(); const ch = channels.length > 2 ? channels.slice(0, 2) : channels;
    await store.putBlob(id, encodeWav(ch, sr, 24));
    let start = 0, trimStart = zeroSec;
    if (zeroSec < 0) { start = -zeroSec / spb; trimStart = 0; }
    const dur = channels[0].length / sr - trimStart;
    const n = S.project.tracks.filter(t => t.type === "audio").length + 1;
    addTrack({ type: "audio", name: `Voice ${n}${suffix}`, blobId: id, clips: [{ start: +start.toFixed(4), off: +trimStart.toFixed(4), dur: +dur.toFixed(4), gain: 1 }], rev: 0.15 }, { silent: !!suffix });
  }
  async function finishVoice() {
    if (!live) { // imported audio: start at the first sound
      const d = channels[0]; let pk = 0; for (let i = 0; i < d.length; i += 4) pk = Math.max(pk, Math.abs(d[i]));
      let i0 = 0; while (i0 < d.length && Math.abs(d[i0]) < pk * 0.05) i0++;
      zeroSec = Math.max(0, i0 / sr - 0.02);
    }
    await addVoice(); closePanel();
  }
}

// ======================= import a file =======================
export function openImport() {
  stopPlay();
  let inst = S.settings.lastInst;
  const p = openPanel(`<div class="panel-head"><button class="icon-btn" id="iClose" aria-label="Close">${icon("close")}</button><h2>Use a recording</h2></div>
    <div class="panel-body">
      <p class="hint">Pick a voice note, a recording from your voice recorder, or any audio file. It will start on beat 1.</p>
      <div class="seg"><button data-m="hum" aria-pressed="true">Turn into instrument</button><button data-m="voice" aria-pressed="false">Keep as recording</button></div>
      <label class="btn primary big" for="iFile">${icon("file")}Choose audio file</label>
      <input type="file" id="iFile" accept="audio/*,video/*,.ogg,.opus,.m4a,.mp3,.wav,.aac,.amr,.3gp,.webm,.flac" hidden>
      <div id="iMsg" class="hint"></div>
    </div>`);
  let mode = "hum";
  p.querySelector(".seg").onclick = e => { const m = e.target.closest("[data-m]")?.dataset.m; if (!m) return; mode = m; p.querySelectorAll("[data-m]").forEach(b => b.setAttribute("aria-pressed", b.dataset.m === m)); };
  p.querySelector("#iClose").onclick = () => closePanel();
  p.querySelector("#iFile").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    p.querySelector("#iMsg").textContent = "Opening " + f.name + "…";
    let buf; try { buf = await decodeBlob(f); } catch (err) { p.querySelector("#iMsg").textContent = "This phone can't open that audio format. Try an MP3, M4A, WAV or a WhatsApp voice note."; return; }
    if (buf.duration > 600) { p.querySelector("#iMsg").textContent = "That file is over 10 minutes. Trim it first."; return; }
    const channels = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, i) => buf.getChannelData(i));
    showResult(p, { channels, sr: buf.sampleRate, zeroSec: 0, mode, inst, live: false });
  };
}

// ======================= piano roll =======================
export function openRoll(t) {
  stopPlay();
  const st = { px: 56, row: 22, sx: -0.5, sy: 0, grid: 0.5, mode: "draw", sel: new Set(), keyW: 46 };
  const ps = t.notes.map(n => n.p); const mid = ps.length ? Math.round((Math.min(...ps) + Math.max(...ps)) / 2) : 60;
  const p = openPanel(`<div class="panel-head"><button class="icon-btn" id="pClose" aria-label="Done">${icon("back")}</button><h2>${esc(t.name)}</h2>
      <button class="btn" id="pInst"><i style="width:12px;height:12px;border-radius:4px;background:${trackColor(t)}"></i>${esc(instInfo(t.inst).name)}</button>
      <button class="icon-btn" id="pPlay" aria-label="Play">${icon("play")}</button></div>
    <div class="roll-area" id="pArea"><canvas id="pCv"></canvas></div>
    <div class="roll-tools">
      <div class="seg" style="min-width:150px"><button data-mode="draw" aria-pressed="true">Draw</button><button data-mode="select" aria-pressed="false">Move</button></div>
      <select id="pGrid" aria-label="Note length"><option value="1">1/4</option><option value="0.5" selected>1/8</option><option value="0.25">1/16</option><option value="0.3333">1/8 triplet</option></select>
      <button class="mini" id="pZo" aria-label="Zoom out">−</button><button class="mini" id="pZi" aria-label="Zoom in">+</button>
      <button class="btn" id="pDel" disabled>${icon("trash")}</button>
      <button class="btn" id="pUp" disabled>↑</button><button class="btn" id="pDn" disabled>↓</button>
    </div>`, () => { window.removeEventListener("hs-frame", onFrame); ro.disconnect(); changed({ structure: true }); });
  const area = p.querySelector("#pArea"), cv = p.querySelector("#pCv"); let playB = -1;
  var ro = new ResizeObserver(() => draw());
  const oct = () => 12 * (t.oct || 0);
  const H = () => area.clientHeight;
  st.sy = (108 - (mid + oct()) ) * st.row - H() / 2;
  const beatX = b => st.keyW + (b - st.sx) * st.px;
  const xBeat = x => (x - st.keyW) / st.px + st.sx;
  const pitchY = pp => (108 - pp) * st.row - st.sy;
  const yPitch = y => 108 - Math.floor((y + st.sy) / st.row);
  function draw() {
    if (!area.isConnected) return;
    const { g, w, h } = fitCanvas(cv);
    const bg = cssVar("--bg"), s2 = cssVar("--surface-2"), line = cssVar("--line"), muted = cssVar("--muted"), ink = cssVar("--ink"), col = trackColor(t), acc = cssVar("--accent");
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    const p0 = yPitch(h), p1 = yPitch(0), len = S.project.bars * 4;
    for (let q = p0; q <= p1; q++) { const y = pitchY(q); const black = [1, 3, 6, 8, 10].includes(((q % 12) + 12) % 12); g.fillStyle = black ? s2 : bg; g.fillRect(st.keyW, y, w, st.row); }
    const b0 = Math.floor(st.sx), b1 = Math.ceil(xBeat(w));
    for (let b = b0; b <= b1; b += st.grid) { const x = beatX(b); if (x < st.keyW) continue; const whole = Math.abs(b - Math.round(b)) < 1e-6; g.strokeStyle = line; g.globalAlpha = whole ? (Math.round(b) % 4 === 0 ? 1 : 0.6) : 0.25; g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); g.stroke(); }
    g.globalAlpha = 1;
    const endX = beatX(len); if (endX < w) { g.fillStyle = "rgba(0,0,0,0.35)"; g.fillRect(Math.max(st.keyW, endX), 0, w, h); }
    t.notes.forEach((n, i) => {
      const x = beatX(n.s), y = pitchY(n.p + oct()), nw = Math.max(4, n.d * st.px - 2);
      if (x + nw < st.keyW || x > w || y + st.row < 0 || y > h) return;
      g.fillStyle = col; g.globalAlpha = 0.45 + 0.55 * (n.v ?? 0.8); g.fillRect(x + 1, y + 1, nw, st.row - 2); g.globalAlpha = 1;
      if (st.sel.has(i)) { g.strokeStyle = ink; g.lineWidth = 2; g.strokeRect(x + 1, y + 1, nw, st.row - 2); g.lineWidth = 1; }
      if (nw > 30) { g.fillStyle = "rgba(0,0,0,.55)"; g.font = "10px " + cssVar("--mono"); g.fillText(noteName(n.p + oct()), x + 4, y + st.row - 6); }
    });
    if (playB >= 0) { const x = beatX(playB); g.fillStyle = acc; g.fillRect(x, 0, 2, h); }
    // keyboard
    for (let q = p0; q <= p1; q++) { const y = pitchY(q), pc = ((q % 12) + 12) % 12, black = [1, 3, 6, 8, 10].includes(pc); g.fillStyle = black ? "#2a2a33" : "#ececf2"; g.fillRect(0, y, st.keyW, st.row - 1); if (pc === 0) { g.fillStyle = "#555"; g.font = "10px " + cssVar("--mono"); g.fillText(noteName(q), 4, y + st.row - 6); } }
    // bar numbers
    g.fillStyle = muted; g.font = "10px " + cssVar("--mono");
    for (let b = Math.ceil(st.sx / 4) * 4; b <= b1; b += 4) { const x = beatX(b); if (x > st.keyW) g.fillText(String(b / 4 + 1), x + 3, 11); }
    const any = st.sel.size > 0; ["#pDel", "#pUp", "#pDn"].forEach(id => (p.querySelector(id).disabled = !any));
  }
  const hit = (x, y) => {
    const b = xBeat(x), q = yPitch(y) - oct();
    for (let i = t.notes.length - 1; i >= 0; i--) { const n = t.notes[i]; if (n.p === q && b >= n.s && b <= n.s + n.d) { const edge = beatX(n.s + n.d) - x < Math.min(18, n.d * st.px / 3); return { i, edge }; } }
    return null;
  };
  const snap = b => Math.round(b / st.grid) * st.grid;
  const ptrs = new Map(); let drag = null, lastTap = { t: 0, i: -1 };
  area.addEventListener("pointerdown", e => {
    area.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = area.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (ptrs.size === 2) { drag = { kind: "pan", x: e.clientX, y: e.clientY, sx: st.sx, sy: st.sy }; return; }
    if (x < st.keyW) { previewNote(t.inst, yPitch(y), 0.5); drag = { kind: "pan", x: e.clientX, y: e.clientY, sx: st.sx, sy: st.sy, keys: true }; return; }
    const h = hit(x, y);
    if (h) {
      const now = Date.now();
      if (lastTap.i === h.i && now - lastTap.t < 320) { snapshot(); t.notes.splice(h.i, 1); st.sel.clear(); drag = null; draw(); changed(); return; }
      lastTap = { t: now, i: h.i };
      if (!st.sel.has(h.i)) { st.sel.clear(); st.sel.add(h.i); }
      snapshot();
      const n = t.notes[h.i]; previewNote(t.inst, n.p + oct(), 0.35, n.v);
      drag = { kind: h.edge ? "resize" : "move", x, y, orig: [...st.sel].map(i => ({ i, s: t.notes[i].s, p: t.notes[i].p, d: t.notes[i].d })) };
    } else if (st.mode === "draw") {
      snapshot();
      const n = { p: yPitch(y) - oct(), s: Math.max(0, Math.floor(xBeat(x) / st.grid) * st.grid), d: st.grid, v: 0.8 };
      t.notes.push(n); st.sel.clear(); st.sel.add(t.notes.length - 1); previewNote(t.inst, n.p + oct(), 0.35);
      drag = { kind: "resize", x, y, orig: [{ i: t.notes.length - 1, s: n.s, p: n.p, d: n.d }] };
    } else { st.sel.clear(); drag = { kind: "pan", x: e.clientX, y: e.clientY, sx: st.sx, sy: st.sy }; }
    draw();
  });
  area.addEventListener("pointermove", e => {
    if (!ptrs.has(e.pointerId) || !drag) return; ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = area.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (drag.kind === "pan") { st.sx = Math.max(-0.5, drag.sx - (e.clientX - drag.x) / st.px); st.sy = Math.max(0, Math.min(84 * st.row - H() + 108 * 0, drag.sy - (e.clientY - drag.y))); st.sy = Math.max(0, Math.min((108 - 12) * st.row - H(), st.sy)); draw(); return; }
    const db = (x - drag.x) / st.px, dp = -Math.round((y - drag.y) / st.row);
    for (const o of drag.orig) {
      const n = t.notes[o.i]; if (!n) continue;
      if (drag.kind === "move") { const ns = Math.max(0, snap(o.s + db)); const np = o.p + dp; if (np !== n.p) previewNote(t.inst, np + oct(), 0.25, n.v); n.s = +ns.toFixed(4); n.p = np; }
      else n.d = +Math.max(st.grid, snap(o.d + db)).toFixed(4);
    }
    draw();
  });
  const up = e => {
    ptrs.delete(e.pointerId); if (ptrs.size) return;
    if (drag && drag.kind !== "pan") { t.notes.sort((a, b) => a.s - b.s); st.sel = new Set(); changed(); }
    drag = null; draw();
  };
  area.addEventListener("pointerup", up); area.addEventListener("pointercancel", up);
  area.addEventListener("wheel", e => { e.preventDefault(); st.sx = Math.max(-0.5, st.sx + e.deltaX / st.px); st.sy = Math.max(0, st.sy + e.deltaY); draw(); }, { passive: false });
  p.querySelector(".seg").onclick = e => { const m = e.target.closest("[data-mode]")?.dataset.mode; if (!m) return; st.mode = m; p.querySelectorAll("[data-mode]").forEach(b => b.setAttribute("aria-pressed", b.dataset.mode === m)); };
  p.querySelector("#pGrid").onchange = e => { st.grid = +e.target.value; draw(); };
  p.querySelector("#pZi").onclick = () => { st.px = Math.min(200, st.px * 1.3); draw(); };
  p.querySelector("#pZo").onclick = () => { st.px = Math.max(10, st.px / 1.3); draw(); };
  const selected = () => [...st.sel].map(i => t.notes[i]).filter(Boolean);
  p.querySelector("#pDel").onclick = () => { snapshot(); t.notes = t.notes.filter((_, i) => !st.sel.has(i)); st.sel.clear(); draw(); changed(); };
  p.querySelector("#pUp").onclick = () => { snapshot(); selected().forEach(n => n.p++); const n = selected()[0]; if (n) previewNote(t.inst, n.p + oct(), 0.3); draw(); changed(); };
  p.querySelector("#pDn").onclick = () => { snapshot(); selected().forEach(n => n.p--); const n = selected()[0]; if (n) previewNote(t.inst, n.p + oct(), 0.3); draw(); changed(); };
  p.querySelector("#pClose").onclick = () => closePanel();
  p.querySelector("#pInst").onclick = () => openInstrumentPicker(t.inst, id => { snapshot(); t.inst = id; S.settings.lastInst = id; saveSettings(); changed(); p.querySelector("#pInst").lastChild.textContent = instInfo(id).name; p.querySelector("#pInst i").style.background = trackColor(t); draw(); });
  p.querySelector("#pPlay").onclick = async () => {
    if (T.playing) { stopPlay(); playB = -1; p.querySelector("#pPlay").innerHTML = icon("play"); draw(); return; }
    await startPlay(); p.querySelector("#pPlay").innerHTML = icon("stop");
  };
  function onFrame(ev) { if (!p.isConnected) return; playB = T.playing ? Math.max(0, ev.detail) : -1; if (playB > xBeat(area.clientWidth) - 1 || playB < st.sx) st.sx = Math.max(-0.5, playB - 1); draw(); }
  window.addEventListener("hs-frame", onFrame);
  ro.observe(area);
  requestAnimationFrame(draw);
}

// ======================= instrument from a song clip =======================
export function openSampleMaker(onDone) {
  let buf = null, start = 0, len = 1.0, root = null, hold = true;
  const regions = [];
  const p = openPanel(`<div class="panel-head"><button class="icon-btn" id="mClose" aria-label="Close">${icon("close")}</button><h2>New instrument from a song</h2></div>
    <div class="panel-body">
      <p class="hint">Pick a song or recording, then find a spot where the instrument plays one note on its own (an intro or a solo works best). Even one note is enough; add a few notes at different pitches for a more natural sound.</p>
      <label class="btn primary" for="mFile">${icon("file")}Choose song or audio file</label>
      <input type="file" id="mFile" accept="audio/*,video/*" hidden>
      <div id="mEd" hidden>
        <canvas class="wave" id="mAll" aria-label="Whole song. Tap to jump."></canvas>
        <canvas class="wave" id="mSel" style="height:110px;margin-top:8px" aria-label="Selected sound"></canvas>
        <div class="row between" style="margin-top:8px">
          <div class="stepper">Start <button class="mini" id="sB">−</button><b id="sV">0.00s</b><button class="mini" id="sF">+</button></div>
          <div class="stepper">Length <button class="mini" id="lB">−</button><b id="lV">1.0s</b><button class="mini" id="lF">+</button></div>
        </div>
        <div class="row"><button class="btn" id="mPlay">${icon("play")}Play this part</button>
          <div class="stepper">Note <button class="mini" id="nB">−</button><b id="nV">–</b><button class="mini" id="nF">+</button></div></div>
        <button class="btn" id="mAdd">＋ Use this note</button>
        <div class="chips" id="mList"></div>
        <label class="field">Name<input type="text" id="mName" placeholder="e.g. Nadaswaram from my song"></label>
        <div class="seg"><button data-h="1" aria-pressed="true">Held notes (voice, flute, strings)</button><button data-h="0" aria-pressed="false">Plucked or struck (guitar, veena, piano)</button></div>
        <button class="btn primary big" id="mSave" disabled>Save instrument</button>
      </div>
    </div>`);
  p.querySelector("#mClose").onclick = () => closePanel();
  const ed = p.querySelector("#mEd");
  p.querySelector("#mFile").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { buf = await decodeBlob(f); } catch (err) { toast("This phone can't open that file. Try an MP3, M4A or WAV."); return; }
    ed.hidden = false; start = Math.min(buf.duration / 3, Math.max(0, buf.duration - len)); detect(); draw();
    if (!p.querySelector("#mName").value) p.querySelector("#mName").value = f.name.replace(/\.[^.]+$/, "").slice(0, 40);
  };
  const ch0 = () => buf.getChannelData(0);
  function drawWave(cv, from, to, hl) {
    const { g, w, h } = fitCanvas(cv); const d = ch0(), sr = buf.sampleRate, i0 = Math.floor(from * sr), i1 = Math.floor(to * sr), step = Math.max(1, Math.floor((i1 - i0) / w));
    g.clearRect(0, 0, w, h); g.fillStyle = cssVar("--muted");
    for (let x = 0; x < w; x++) { let m = 0; const a = i0 + x * step; for (let j = a; j < a + step && j < d.length; j += Math.max(1, step >> 4)) m = Math.max(m, Math.abs(d[j])); const hh = Math.max(1, m * h); g.fillRect(x, h / 2 - hh / 2, 1, hh); }
    if (hl) { g.fillStyle = cssVar("--accent"); g.globalAlpha = 0.35; g.fillRect((start - from) / (to - from) * w, 0, len / (to - from) * w, h); g.globalAlpha = 1; }
  }
  function draw() {
    drawWave(p.querySelector("#mAll"), 0, buf.duration, true);
    drawWave(p.querySelector("#mSel"), start, Math.min(buf.duration, start + len), false);
    p.querySelector("#sV").textContent = fmtTime(start); p.querySelector("#lV").textContent = len.toFixed(1) + "s";
    p.querySelector("#nV").textContent = root == null ? "?" : noteName(root);
    p.querySelector("#mList").innerHTML = regions.map((r, i) => `<button class="chip" data-i="${i}">${noteName(r.root)} ✕</button>`).join("");
    p.querySelector("#mSave").disabled = !regions.length;
  }
  const fmtTime = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
  function slice() {
    const sr = buf.sampleRate, i0 = Math.floor(start * sr), n = Math.floor(Math.min(len, buf.duration - start) * sr), fade = Math.floor(sr * 0.008);
    return Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => { const a = buf.getChannelData(c).slice(i0, i0 + n); for (let i = 0; i < fade && i < n; i++) { a[i] *= i / fade; a[n - 1 - i] *= i / fade; } return a; });
  }
  function detect() { const m = clipPitch(slice(), buf.sampleRate); root = m == null ? null : Math.round(m); }
  let dt; const moved = () => { clearTimeout(dt); draw(); dt = setTimeout(() => { detect(); draw(); }, 200); };
  p.querySelector("#mAll").addEventListener("pointerdown", e => { const r = e.currentTarget.getBoundingClientRect(); start = Math.max(0, Math.min(buf.duration - 0.1, (e.clientX - r.left) / r.width * buf.duration - len / 2)); moved(); });
  p.querySelector("#sB").onclick = () => { start = Math.max(0, start - 0.05); moved(); };
  p.querySelector("#sF").onclick = () => { start = Math.min(buf.duration - 0.1, start + 0.05); moved(); };
  p.querySelector("#lB").onclick = () => { len = Math.max(0.2, +(len - 0.1).toFixed(1)); moved(); };
  p.querySelector("#lF").onclick = () => { len = Math.min(6, +(len + 0.1).toFixed(1)); moved(); };
  p.querySelector("#nB").onclick = () => { root = (root ?? 60) - 1; draw(); };
  p.querySelector("#nF").onclick = () => { root = (root ?? 60) + 1; draw(); };
  p.querySelector("#mPlay").onclick = () => { const c = getCtx(), s = c.createBufferSource(); s.buffer = buf; s.connect(c.destination); s.start(c.currentTime + 0.02, start, len); };
  p.querySelector("#mAdd").onclick = () => {
    if (root == null) { toast("No clear note here. Pick a spot where one note plays, or set the note with − and +."); root = 60; draw(); return; }
    regions.push({ root, channels: slice(), sr: buf.sampleRate }); toast(`Added ${noteName(root)}.`); draw();
  };
  p.querySelector("#mList").onclick = e => { const c = e.target.closest("[data-i]"); if (!c) return; regions.splice(+c.dataset.i, 1); draw(); };
  p.querySelector(".seg").onclick = e => { const b = e.target.closest("[data-h]"); if (!b) return; hold = b.dataset.h === "1"; p.querySelectorAll("[data-h]").forEach(x => x.setAttribute("aria-pressed", x === b)); };
  p.querySelector("#mSave").onclick = async () => {
    const id = store.uid(), samples = [];
    for (const r of regions) { const bid = store.uid(); await store.putBlob(bid, encodeWav(r.channels, r.sr, 24)); samples.push({ blobId: bid, root: r.root }); }
    const name = p.querySelector("#mName").value.trim() || "My instrument";
    const colors = ["#D46A8A", "#5CA8A0", "#B8862E", "#7C78D8", "#C2573B"];
    const rec = { id, name, samples, sustain: hold, release: hold ? 0.2 : 0.3, color: colors[Math.floor(Math.random() * colors.length)] };
    await store.saveInstrument(rec); await loadCustom(rec);
    toast(`Saved "${name}".`); closePanel(); onDone && onDone("custom:" + id);
  };
}

// ======================= section editor: crop, cut, copy, fades =======================
let clipboard = null;
export async function openSection(t) {
  stopPlay();
  const len = () => S.project.bars * 4, spb = () => 60 / S.project.bpm;
  let fullDur = 0;
  if (t.type === "audio") { try { fullDur = (await clipBuffer(t.blobId)).duration; } catch (e) { toast("This recording is missing."); return; } }
  const ctx = () => ({ spb: spb(), fullDur });
  if (t.type === "audio" && !t.clips) { E.prepare(t, ctx()); changed(); }
  const structural = E.canCopy(t);
  const st = { a: 0, b: Math.min(len(), 8), snap: 1, v0: 0, v1: len() }, cursorBefore = S.cursor;
  if (S.cursor > 0) { st.a = Math.min(S.cursor, len() - 1); st.b = Math.min(len(), st.a + 4); }
  const p = openPanel(`<div class="panel-head"><button class="icon-btn" id="xClose" aria-label="Done">${icon("back")}</button><h2>${esc(t.name)}</h2>
      <button class="icon-btn" id="xUndo" aria-label="Undo">${icon("undo")}</button><button class="icon-btn" id="xPlay" aria-label="Play selection">${icon("play")}</button></div>
    <div class="panel-body sec-body">
      <div class="sec-top"><div><canvas class="wave" id="xCv" style="height:150px" aria-label="Layer. Drag across it to choose a part."></canvas>
        <div class="row between" style="margin-top:6px"><div class="row" style="gap:6px"><button class="mini" id="zOut" aria-label="Zoom out">−</button><button class="mini" id="zIn" aria-label="Zoom in">+</button><span class="hint" id="xView"></span></div>
        <label class="field" style="flex-direction:row;align-items:center;gap:6px">Snap<select id="xSnap" style="width:auto"><option value="4">Bar</option><option value="1" selected>Beat</option><option value="0.5">½ beat</option><option value="0.25">¼ beat</option><option value="0.0625">Fine</option></select></label></div></div>
      <div class="row between">
        <div class="stepper">From <button class="mini" data-m="a-">−</button><b id="xA"></b><button class="mini" data-m="a+">+</button></div>
        <div class="stepper">To <button class="mini" data-m="b-">−</button><b id="xB"></b><button class="mini" data-m="b+">+</button></div>
      </div></div>
      <p class="hint">Drag across the layer to choose a part, or drag the orange edges.</p>
      <div class="chips"><button class="chip" data-sel="bar">This bar</button><button class="chip" data-sel="all">Whole song</button>${structural ? `<button class="chip" data-sel="content">All of this layer</button>` : ""}</div>
      <h3>Cut</h3>
      <div class="chips">
        <button class="chip" data-x="crop">✂ Keep only this part</button>
        <button class="chip" data-x="del">🗑 Delete this part</button>
        ${structural ? "" : `<button class="chip" data-x="restore">Bring this part back</button>`}
      </div>
      ${structural ? `<h3>Copy</h3><div class="chips">
        <button class="chip" data-x="copy">Copy</button>
        <button class="chip" data-x="paste" id="xPaste">Paste here</button>
        <button class="chip" data-x="repeat">Repeat after it</button>
        <button class="chip" data-x="cut">Cut</button>
      </div>
      <h3>Move</h3><div class="chips"><button class="chip" data-x="left">← Earlier</button><button class="chip" data-x="right">Later →</button></div>
      <h3>Volume</h3><div class="chips"><button class="chip" data-x="soft">Softer</button><button class="chip" data-x="loud">Louder</button></div>` : ""}
      <h3>Fade</h3>
      <div class="chips"><button class="chip" data-x="fin">Fade in</button><button class="chip" data-x="fout">Fade out</button><button class="chip" data-x="fclear">Remove fades here</button></div>
      <p class="hint" id="xNote">${t.type === "drums" ? "The beat repeats through the song, so Delete makes this part silent. Bring it back any time." : t.type === "drone" ? "Delete makes the drone silent in this part." : t.type === "notes" && t.raw ? "After editing here, Snap to key and Timing no longer re-shape this layer." : ""}</p>
    </div>`, () => { window.removeEventListener("hs-frame", onFrame); ro.disconnect(); if (T().playing) stopPlay(); S.cursor = cursorBefore; changed(); });
  const T = () => S.transport, cv = p.querySelector("#xCv");
  const fmtPos = b => { const bar = Math.floor(b / 4) + 1, beat = Math.floor(b % 4) + 1, fr = +(b % 1).toFixed(4); return `${bar}.${beat}${fr ? ({ 0.5: "½", 0.25: "¼", 0.75: "¾" }[fr] ?? "+" + fr.toFixed(2).slice(1)) : ""}`; };
  const snapB = b => Math.max(0, Math.min(len(), Math.round(b / st.snap) * st.snap));
  let playB = -1;
  async function draw() {
    if (!cv.isConnected) return;
    const { g, w, h } = fitCanvas(cv), span = st.v1 - st.v0, X = b => (b - st.v0) / span * w;
    await paintLane(g, w, h, t, st.v0, st.v1);
    const acc = cssVar("--accent"), xa = X(st.a), xb = X(st.b);
    g.fillStyle = acc; g.globalAlpha = 0.22; g.fillRect(xa, 0, xb - xa, h); g.globalAlpha = 1;
    for (const x of [xa, xb]) { g.fillRect(x - 1.5, 0, 3, h); g.beginPath(); g.arc(x, h / 2, 9, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = cssVar("--muted"); g.font = "10px " + cssVar("--mono");
    const every = span > 128 ? 8 : span > 64 ? 4 : span > 32 ? 2 : 1;
    for (let bar = Math.ceil(st.v0 / 4); bar * 4 <= st.v1; bar++) if (bar % every === 0) g.fillText(String(bar + 1), X(bar * 4) + 3, 11);
    if (playB >= 0) { g.fillStyle = cssVar("--ink"); g.fillRect(X(playB), 0, 2, h); }
    p.querySelector("#xA").textContent = fmtPos(st.a); p.querySelector("#xB").textContent = fmtPos(st.b);
    p.querySelector("#xView").textContent = `Bars ${Math.floor(st.v0 / 4) + 1}–${Math.ceil(st.v1 / 4)}`;
    const pb = p.querySelector("#xPaste"); if (pb) { pb.disabled = !E.canPaste(t, clipboard); pb.style.opacity = pb.disabled ? 0.45 : 1; pb.textContent = clipboard && E.canPaste(t, clipboard) ? `Paste here (${fmtLen(clipboard.len)})` : "Paste here"; }
  }
  const fmtLen = b => b % 4 === 0 ? `${b / 4} bar${b === 4 ? "" : "s"}` : `${+b.toFixed(2)} beats`;
  var ro = new ResizeObserver(() => draw()); ro.observe(cv);
  // dragging the selection
  let drag = null;
  cv.addEventListener("pointerdown", e => {
    cv.setPointerCapture(e.pointerId);
    const r = cv.getBoundingClientRect(), span = st.v1 - st.v0, beat = st.v0 + (e.clientX - r.left) / r.width * span;
    const px = b => r.left + (b - st.v0) / span * r.width;
    if (Math.abs(e.clientX - px(st.a)) < 22) drag = "a"; else if (Math.abs(e.clientX - px(st.b)) < 22) drag = "b";
    else { drag = "new"; st.anchor = snapB(beat); st.a = st.anchor; st.b = Math.min(len(), st.anchor + st.snap); }
    draw();
  });
  cv.addEventListener("pointermove", e => {
    if (!drag) return;
    const r = cv.getBoundingClientRect(), beat = snapB(st.v0 + (e.clientX - r.left) / r.width * (st.v1 - st.v0));
    if (drag === "a") st.a = Math.min(beat, st.b - st.snap); else if (drag === "b") st.b = Math.max(beat, st.a + st.snap);
    else { st.a = Math.min(st.anchor, beat); st.b = Math.max(st.anchor, beat); if (st.b - st.a < st.snap) st.b = st.a + st.snap; }
    st.a = Math.max(0, st.a); st.b = Math.min(len(), st.b); draw();
  });
  const endDrag = () => { drag = null; };
  cv.addEventListener("pointerup", endDrag); cv.addEventListener("pointercancel", endDrag);
  p.querySelector("#xSnap").onchange = e => { st.snap = +e.target.value; };
  const zoom = f => { const mid = (st.a + st.b) / 2, span = Math.max(2, Math.min(len(), (st.v1 - st.v0) * f)); st.v0 = Math.max(0, Math.min(len() - span, mid - span / 2)); st.v1 = st.v0 + span; draw(); };
  p.querySelector("#zIn").onclick = () => zoom(0.5); p.querySelector("#zOut").onclick = () => zoom(2);
  p.querySelector(".panel-body").addEventListener("click", e => {
    const m = e.target.closest("[data-m]")?.dataset.m;
    if (m) { const d = m.endsWith("+") ? st.snap : -st.snap; if (m[0] === "a") st.a = Math.max(0, Math.min(st.b - st.snap, st.a + d)); else st.b = Math.min(len(), Math.max(st.a + st.snap, st.b + d)); draw(); return; }
    const sel = e.target.closest("[data-sel]")?.dataset.sel;
    if (sel === "bar") { const bar = Math.floor(st.a / 4) * 4; st.a = bar; st.b = Math.min(len(), bar + 4); }
    if (sel === "all") { st.a = 0; st.b = len(); st.v0 = 0; st.v1 = len(); }
    if (sel === "content") { const end = E.contentEnd(t, spb()); st.a = 0; st.b = Math.min(len(), Math.max(st.snap, Math.ceil(end / st.snap) * st.snap)); }
    if (sel) { draw(); return; }
    const x = e.target.closest("[data-x]")?.dataset.x; if (x) act(x);
  });
  function grow(endBeat) { if (endBeat > len()) { S.project.bars = Math.min(128, Math.ceil(endBeat / 4)); st.v1 = len(); } }
  function act(x) {
    const { a, b } = st, c = ctx();
    if (x === "copy") { clipboard = E.copyRange(t, a, b, c); toast(`Copied ${fmtLen(b - a)}.`); draw(); return; }
    if (x === "paste" && !E.canPaste(t, clipboard)) { toast(clipboard ? "That was copied from a different kind of layer." : "Copy a part first."); return; }
    snapshot();
    let msg = "";
    if (x === "crop") { E.cropTo(t, a, b, c); msg = "Kept only the chosen part."; }
    if (x === "del") { E.deleteRange(t, a, b, c); msg = "Part deleted."; }
    if (x === "cut") { clipboard = E.copyRange(t, a, b, c); E.deleteRange(t, a, b, c); msg = `Cut ${fmtLen(b - a)}. Choose a spot and tap Paste.`; }
    if (x === "restore") { E.restoreRange(t, a, b); msg = "This part plays again."; }
    if (x === "paste") { grow(a + clipboard.len); E.pasteAt(t, clipboard, a, c); st.b = Math.min(len(), a + clipboard.len); msg = "Pasted."; }
    if (x === "repeat") { const clip = E.copyRange(t, a, b, c); grow(b + clip.len); E.pasteAt(t, clip, b, c); st.a = b; st.b = Math.min(len(), b + clip.len); msg = "Repeated. Tap again to repeat once more."; }
    if (x === "left" || x === "right") { const d = E.moveRange(t, a, b, x === "left" ? -st.snap : st.snap, c); grow(b + d); st.a = a + d; st.b = b + d; }
    if (x === "soft") { E.scaleVolume(t, a, b, 0.7, c); msg = "Softer."; }
    if (x === "loud") { E.scaleVolume(t, a, b, 1.4, c); msg = "Louder."; }
    if (x === "fin") { E.addFade(t, a, b, "in"); msg = "Fades in across the chosen part."; }
    if (x === "fout") { E.addFade(t, a, b, "out"); msg = "Fades out across the chosen part."; }
    if (x === "fclear") { E.clearFades(t, a, b); msg = "Fades removed."; }
    changed({ structure: true }); if (msg) toast(msg); draw();
  }
  p.querySelector("#xUndo").onclick = () => {
    if (!undo()) return toast("Nothing to undo.");
    toast("Undone."); const nt = S.project.tracks.find(x => x.id === t.id);
    if (!nt) closePanel(); else if (nt !== t) { const keep = { a: st.a, b: st.b }; closePanel(); openSection(nt).then(() => {}); } else draw();
  };
  p.querySelector("#xClose").onclick = () => closePanel();
  p.querySelector("#xPlay").onclick = async () => {
    if (T().playing) { stopPlay(); playB = -1; p.querySelector("#xPlay").innerHTML = icon("play"); draw(); return; }
    S.cursor = st.a; started = false; await startPlay(); p.querySelector("#xPlay").innerHTML = icon("stop");
  };
  let started = false;
  function onFrame(ev) {
    if (!cv.isConnected) return; const beat = ev.detail;
    if (beat >= st.a) started = true;
    if (beat >= st.b - 0.02 || (started && beat < st.a - 0.05)) { stopPlay(); playB = -1; p.querySelector("#xPlay").innerHTML = icon("play"); draw(); return; }
    playB = Math.max(0, beat); draw();
  }
  window.addEventListener("hs-frame", onFrame);
  requestAnimationFrame(draw);
}
