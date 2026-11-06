// Hum Studio — main screens: song list, studio timeline, layer settings, tune helper, export.
import { $, esc, icon, S, snapshot, undo, changed, onChange, track, toast, openSheet, closeSheet, sheetOpen, panelOpen, closePanel,
  slider, bindSlider, fmtBeats, cssVar, fitCanvas, copyText, nav } from "./ui.js";
import { INSTRUMENTS, GROUPS, KITS, DRUM_PRESETS, presetRows, SCALES, NOTE_NAMES, noteName } from "./instruments.js";
import { getCtx, loadInstrument, loadKit, previewNote, previewDrum, instInfo, registerCustom, customList, clipBuffer, decodeBlob, preloadProject } from "./engine.js";
import * as store from "./store.js";
import { notesFromRaw, detectKey } from "./pitch.js";
import { suggestChords, chordName, chordLayer, bassLayer, harmonyLayer, continueMelody, newMelody, songToText, textToNotes, keyLabel } from "./tunes.js";
import { exportWav, exportMp3, exportStems, exportMidi, exportProject, saveFile, shareFile } from "./export.js";
import { openRecorder, openRoll, openImport, openSampleMaker, openSection } from "./panels.js";
import { inCuts, clipsOf, contentEnd, prepare as prepareEdit } from "./edit.js";

const uid = store.uid;
const T = S.transport;

// ======================= boot =======================
async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { });
  store.requestPersist();
  const st = await store.kvGet("settings"); if (st) Object.assign(S.settings, st);
  for (const ci of await store.listInstruments()) await loadCustom(ci);
  await renderHome();
  setupInstallHint();
  const last = await store.kvGet("lastProject");
  if (last && location.hash === "#studio") { const p = await store.getProject(last); if (p) openProject(p); }
}
export async function loadCustom(ci) {
  try {
    const samples = [];
    for (const s of ci.samples) { const b = await store.getBlob(s.blobId); if (b) samples.push({ root: s.root, buffer: await decodeBlob(b) }); }
    registerCustom("custom:" + ci.id, { name: ci.name, group: "custom", sustain: ci.sustain, release: ci.release ?? 0.2, oct: 0, gm: 0, color: ci.color || "#8E8BA8", samples });
  } catch (e) { console.warn(e); }
}
export const saveSettings = () => store.kvSet("settings", S.settings);

let deferredInstall = null;
function setupInstallHint() {
  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault(); deferredInstall = e;
    const h = $("installHint"); h.hidden = false;
    h.innerHTML = `<button class="btn primary wide" id="installBtn">Install Janice Seelan Music Studio</button>`;
    $("installBtn").onclick = async () => { deferredInstall.prompt(); await deferredInstall.userChoice; h.hidden = true; };
  });
}

// ======================= home =======================
async function renderHome() {
  const list = await store.listProjects();
  const ul = $("songList");
  if (!list.length) { ul.innerHTML = `<li><span class="hint">No songs yet. Tap New song and hum your first idea.</span></li>`; return; }
  ul.innerHTML = list.map(p => `<li data-id="${p.id}"><button class="open"><b>${esc(p.name)}</b><small>${p.tracks.length} layer${p.tracks.length === 1 ? "" : "s"} · ${p.bpm} BPM · ${new Date(p.updatedAt).toLocaleDateString()}</small></button>
    <button class="icon-btn" data-del aria-label="Delete ${esc(p.name)}">${icon("trash")}</button></li>`).join("");
}
$("songList").addEventListener("click", async e => {
  const li = e.target.closest("li[data-id]"); if (!li) return;
  if (e.target.closest("[data-del]")) {
    const p = await store.getProject(li.dataset.id);
    openSheet(`<h2>Delete "${esc(p.name)}"?</h2><p class="hint">This removes the song and its recordings from this phone. It can't be undone.</p>
      <div class="row"><button class="btn" id="no">Keep it</button><button class="btn primary" id="yes">Delete song</button></div>`);
    $("no").onclick = () => closeSheet();
    $("yes").onclick = async () => { for (const t of p.tracks) if (t.blobId) await store.deleteBlob(t.blobId); await store.deleteProject(p.id); closeSheet(); renderHome(); };
    return;
  }
  openProject(await store.getProject(li.dataset.id));
});
$("newSong").onclick = async () => {
  const n = (await store.listProjects()).length + 1;
  const p = { id: uid(), name: "Song " + n, bpm: 90, bars: 8, loop: true, key: null, masterVol: 0.85, tracks: [], createdAt: Date.now(), updatedAt: Date.now() };
  await store.saveProject(p); openProject(p);
};
$("importSong").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const data = JSON.parse(await f.text()); if (data.app !== "humstudio") throw new Error();
    const p = data.project; p.id = uid(); p.name += " (copy)";
    for (const [id, url] of Object.entries(data.blobs || {})) await store.putBlob(id, await (await fetch(url)).blob());
    await store.saveProject(p); openProject(p); toast("Song opened from backup.");
  } catch (err) { toast("That file isn't a Janice Seelan Music Studio backup."); }
};
$("homeSettings").onclick = () => openSettings();

// ======================= studio =======================
function openProject(p) {
  T.stop(true);
  S.project = p; S.undo = []; S.cursor = 0; $("undo").disabled = true;
  store.kvSet("lastProject", p.id);
  $("home").hidden = true; $("studio").hidden = false; $("transport").hidden = false;
  if (location.hash !== "#studio") history.pushState({ studio: 1 }, "", "#studio");
  renderStudio();
  preloadProject(p).catch(() => { });
}
function goHome() {
  T.stop(); S.project = null; closeSheet(); closePanel();
  $("studio").hidden = true; $("transport").hidden = true; $("home").hidden = false;
  if (location.hash) history.replaceState(null, "", location.pathname);
  renderHome();
}
window.addEventListener("popstate", () => { setTimeout(() => { if (!nav.handled && !sheetOpen() && !panelOpen() && S.project && location.hash !== "#studio") goHome(); nav.handled = false; }, 0); });
$("back").onclick = () => goHome();
$("songName").addEventListener("change", e => { snapshot(); S.project.name = e.target.value.trim() || S.project.name; changed(); });
$("undo").onclick = () => { if (undo()) toast("Undone."); };
$("openHelper").onclick = () => openHelper();
$("openExport").onclick = () => openExport();
$("openSettings").onclick = () => openSettings();
$("addLayer").onclick = () => openAddLayer();
$("sheetBack").onclick = () => closeSheet();

onChange(opts => { if (!S.project) return; if (opts.structure) renderTracks(); else drawAllLanes(); renderTransport(); });

function renderStudio() { $("songName").value = S.project.name; renderTransport(); renderTracks(); }
function renderTransport() {
  const p = S.project; $("bpm").textContent = p.bpm; $("bars").textContent = p.bars;
  $("loop").setAttribute("aria-pressed", p.loop); $("metro").setAttribute("aria-pressed", !!p.metronome);
  drawRuler();
}

export function trackColor(t) {
  if (t.type === "notes") return instInfo(t.inst).color || "#888";
  return { drums: t.kit === "tabla" ? "#C46A1C" : "#8E8BA8", audio: "#3CCB8F", drone: "#B79A3A" }[t.type];
}
function trackSub(t) {
  if (t.type === "notes") return `${instInfo(t.inst).name} · ${t.notes.length} notes`;
  if (t.type === "drums") return `${KITS[t.kit].name} · ${t.steps} steps`;
  if (t.type === "audio") return "Recording";
  if (t.type === "drone") return `Tanpura · Sa = ${NOTE_NAMES[t.root]}`;
}
function renderTracks() {
  const box = $("tracks"), p = S.project;
  if (!p.tracks.length) {
    box.innerHTML = `<div class="empty"><h2>Start with a hum</h2><p>Tap the red button, hum your tune, and pick the instrument it should become. Use headphones if other layers are playing.</p>
      <div class="row"><button class="btn primary" id="emptyRec">${icon("mic")}Record a hum</button><button class="btn" id="emptyHelp">${icon("wand")}Make a tune for me</button></div></div>`;
    $("emptyRec").onclick = () => openRecorder();
    $("emptyHelp").onclick = () => openHelper();
    return;
  }
  box.innerHTML = p.tracks.map(t => `<div class="track" data-id="${t.id}">
    <div class="track-top"><span class="dot" style="background:${trackColor(t)}"></span>
      <button class="nm" data-open><b>${esc(t.name)}</b><small>${esc(trackSub(t))}</small></button>
      <button class="ms m" data-mute aria-pressed="${!!t.mute}" aria-label="Mute">M</button>
      <button class="ms s" data-solo aria-pressed="${!!t.solo}" aria-label="Solo">S</button></div>
    <div class="lane" data-open><canvas></canvas><div class="cursor"></div><div class="ph"></div></div></div>`).join("");
  requestAnimationFrame(drawAllLanes);
}
$("tracks").addEventListener("click", e => {
  const card = e.target.closest(".track"); if (!card) return; const t = track(card.dataset.id);
  if (e.target.closest("[data-mute]")) { t.mute = !t.mute; e.target.closest("[data-mute]").setAttribute("aria-pressed", t.mute); T.setStripGain(S.project); changed(); return; }
  if (e.target.closest("[data-solo]")) { t.solo = !t.solo; e.target.closest("[data-solo]").setAttribute("aria-pressed", t.solo); T.setStripGain(S.project); changed(); return; }
  if (e.target.closest("[data-open]")) openTrack(t);
});

const waveCache = new Map();
async function waveOf(blobId) {
  if (waveCache.has(blobId)) return waveCache.get(blobId);
  const buf = await clipBuffer(blobId); const d = buf.getChannelData(0), n = 600, out = new Float32Array(n), step = Math.floor(d.length / n) || 1;
  for (let i = 0; i < n; i++) { let m = 0; for (let j = i * step; j < (i + 1) * step && j < d.length; j += 8) m = Math.max(m, Math.abs(d[j])); out[i] = m; }
  const r = { peaks: out, dur: buf.duration }; waveCache.set(blobId, r); return r;
}
export function drawAllLanes() {
  if (!S.project) return;
  document.querySelectorAll("#tracks .track").forEach(card => { const t = track(card.dataset.id); if (t) drawLane(card, t); });
  drawRuler();
}
async function drawLane(card, t) {
  const cv = card.querySelector("canvas"); const { g, w, h } = fitCanvas(cv);
  const len = S.project.bars * 4;
  await paintLane(g, w, h, t, 0, len);
  const cur = card.querySelector(".cursor"); cur.style.transform = `translateX(${S.cursor / len * w}px)`; cur.hidden = !S.cursor;
}
// Draws one layer's content between beats `from` and `to` (also used by the section editor).
export async function paintLane(g, w, h, t, from, to) {
  const span = to - from, X = b => (b - from) / span * w, col = trackColor(t), line = cssVar("--line"), spb = 60 / S.project.bpm, len = S.project.bars * 4;
  g.clearRect(0, 0, w, h);
  const step = span > 64 ? 4 : 1;
  for (let b = Math.ceil(from / step) * step; b <= to; b += step) { const x = Math.round(X(b)) + 0.5; g.globalAlpha = b % 4 === 0 ? 0.9 : 0.25; g.strokeStyle = line; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  g.globalAlpha = t.mute ? 0.3 : 0.95; g.fillStyle = col;
  if (t.type === "notes" && t.notes.length) {
    const ps = t.notes.map(n => n.p); let lo = Math.min(...ps), hi = Math.max(...ps); if (hi - lo < 8) { const m = (hi + lo) / 2; lo = m - 4; hi = m + 4; }
    const rh = Math.max(2, Math.min(10, (h - 8) / (hi - lo + 1)));
    for (const n of t.notes) { const b = n.s + (t.shift || 0); if (b > to || b + n.d < from) continue; g.globalAlpha = (t.mute ? 0.3 : 1) * (0.45 + 0.55 * (n.v ?? 0.8)); const y = 4 + (hi - n.p) * ((h - 8 - rh) / Math.max(1, hi - lo)); g.fillRect(X(b), y, Math.max(2, n.d / span * w - 1), rh); }
  } else if (t.type === "drums") {
    const rows = Object.entries(t.rows).filter(([, a]) => a.some(Boolean)); const rh = (h - 8) / Math.max(1, rows.length);
    const plen = t.steps * t.stepBeats;
    rows.forEach(([, a], ri) => { for (let st = 0; st < len; st += plen) a.forEach((v, i) => { if (!v) return; const b = st + i * t.stepBeats; if (b >= len || b < from || b > to || inCuts(t.cuts, b)) return; g.globalAlpha = (t.mute ? 0.3 : 1) * [0, 0.45, 0.75, 1][v]; g.fillRect(X(b), 4 + ri * rh, Math.max(2, t.stepBeats / span * w - 1), Math.max(2, rh - 2)); }); });
  } else if (t.type === "audio") {
    try {
      const wv = await waveOf(t.blobId), n = wv.peaks.length;
      for (const c of clipsOf(t, wv.dur)) {
        const x0 = X(c.start), pxW = c.dur / spb / span * w, gain = c.gain ?? 1;
        g.globalAlpha = t.mute ? 0.15 : 0.18; g.fillRect(x0, 2, pxW, h - 4); g.globalAlpha = t.mute ? 0.3 : 0.95;
        for (let x = Math.max(0, -x0); x < pxW && x0 + x < w; x++) {
          const sec = c.off + x / pxW * c.dur, i = Math.floor(sec / wv.dur * n);
          const a = Math.min(1, (wv.peaks[Math.min(n - 1, i)] || 0) * gain), hh = Math.max(1, a * (h - 6)); g.fillRect(x0 + x, h / 2 - hh / 2, 1, hh);
        }
      }
    } catch (e) { g.fillStyle = cssVar("--muted"); g.font = "12px sans-serif"; g.fillText("Recording missing", 8, h / 2); }
  } else if (t.type === "drone") {
    g.globalAlpha = t.mute ? 0.15 : 0.35; g.fillRect(0, h / 2 - 8, w, 16);
  } else { g.fillStyle = cssVar("--muted"); g.font = "12px sans-serif"; g.fillText("Empty — tap to add notes", 8, h / 2 + 4); }
  // silent parts and fades
  const bg = cssVar("--surface-2");
  g.globalAlpha = 0.85; g.fillStyle = bg;
  if (t.type === "drone") for (const [a, b] of t.cuts || []) g.fillRect(X(a), 0, X(Math.min(b, len)) - X(a), h);
  for (const f of t.fades || []) {
    const x0 = X(f.a), x1 = X(f.b); g.beginPath();
    if (f.type === "in") { g.moveTo(x0, 0); g.lineTo(x1, 0); g.lineTo(x0, h); } else { g.moveTo(x0, 0); g.lineTo(x1, 0); g.lineTo(x1, h); }
    g.closePath(); g.globalAlpha = 0.7; g.fill();
    g.globalAlpha = 1; g.strokeStyle = cssVar("--ink"); g.beginPath(); if (f.type === "in") { g.moveTo(x0, h); g.lineTo(x1, 0); } else { g.moveTo(x0, 0); g.lineTo(x1, h); } g.stroke();
  }
  g.globalAlpha = 1;
}
function drawRuler() {
  const cv = $("ruler"); if (!cv || !S.project) return; const { g, w, h } = fitCanvas(cv);
  const len = S.project.bars * 4, muted = cssVar("--muted"), acc = cssVar("--accent");
  g.clearRect(0, 0, w, h); g.font = "10px " + cssVar("--mono"); g.fillStyle = muted;
  const every = S.project.bars > 32 ? 8 : S.project.bars > 16 ? 4 : S.project.bars > 8 ? 2 : 1;
  for (let b = 0; b < S.project.bars; b++) { const x = b * 4 / len * w; g.fillRect(x, h - 8, 1, 8); if (b % every === 0) g.fillText(String(b + 1), x + 3, 13); }
  g.fillStyle = acc; const cx = S.cursor / len * w; g.beginPath(); g.moveTo(cx - 5, 0); g.lineTo(cx + 5, 0); g.lineTo(cx, 7); g.fill();
}
$("ruler").addEventListener("pointerdown", e => {
  const r = $("ruler").getBoundingClientRect(), len = S.project.bars * 4;
  const b = Math.max(0, Math.min(len - 1, Math.round((e.clientX - r.left) / r.width * len)));
  S.cursor = b < 1 ? 0 : b; $("pos").textContent = posLabel(S.cursor); drawAllLanes();
  if (T.playing) startPlay();
});
const posLabel = b => `${Math.floor(b / 4) + 1}.${Math.floor(b % 4) + 1}`;

// ---------- transport ----------
export async function startPlay() {
  if (!S.project.tracks.length) { toast("Add a layer first."); return; }
  getCtx();
  $("play").innerHTML = icon("stop"); $("play").setAttribute("aria-label", "Stop");
  try { await T.start(S.project, { fromBeat: S.cursor, metronome: !!S.project.metronome, metroVol: S.settings.metroVol }); }
  catch (e) { console.error(e); toast("Couldn't load some sounds. Check your connection and try again."); stopPlay(); return; }
  document.body.classList.add("playing"); requestAnimationFrame(frame);
}
export function stopPlay() { T.stop(true); playStopped(); }
function playStopped() {
  document.body.classList.remove("playing"); $("play").innerHTML = icon("play"); $("play").setAttribute("aria-label", "Play");
  $("pos").textContent = posLabel(S.cursor); document.querySelectorAll(".cell.now").forEach(c => c.classList.remove("now"));
}
T.onStop = playStopped;
function frame() {
  if (!T.playing) return;
  const b = T.beat(), len = S.project.bars * 4, f = Math.max(0, b) / len;
  $("pos").textContent = b < 0 ? String(Math.ceil(-b)) : posLabel(b);
  document.querySelectorAll(".lane").forEach(l => { l.querySelector(".ph").style.transform = `translateX(${f * l.clientWidth}px)`; });
  window.dispatchEvent(new CustomEvent("hs-frame", { detail: b }));
  requestAnimationFrame(frame);
}
$("play").onclick = () => (T.playing ? stopPlay() : startPlay());
$("rec").onclick = () => { stopPlay(); openRecorder(); };
$("loop").onclick = () => { S.project.loop = !S.project.loop; changed(); };
$("metro").onclick = () => { S.project.metronome = !S.project.metronome; changed(); if (T.playing) startPlay(); };
function tempo(d) { snapshot(); if (!d) return; S.project.bpm = Math.max(40, Math.min(220, S.project.bpm + d)); changed(); if (T.playing) startPlay(); }
function bars(d) { snapshot(); S.project.bars = Math.max(1, Math.min(128, S.project.bars + d)); S.cursor = Math.min(S.cursor, S.project.bars * 4 - 1); changed({ structure: true }); if (T.playing) startPlay(); }
$("songBtn").onclick = () => {
  const b = openSheet(`<h2>Tempo and length</h2>
    <div class="row between"><div class="stepper">Tempo <button class="mini" data-t="-5">−5</button><button class="mini" data-t="-1">−</button><b id="stBpm">${S.project.bpm}</b><button class="mini" data-t="1">+</button><button class="mini" data-t="5">+5</button></div></div>
    <button class="btn" id="tapT">Tap the beat to set tempo</button>
    <div class="row between"><div class="stepper">Length <button class="mini" data-b="-4">−4</button><button class="mini" data-b="-1">−</button><b id="stBars">${S.project.bars}</b><button class="mini" data-b="1">+</button><button class="mini" data-b="4">+4</button> bars</div></div>
    <p class="hint">Changing the tempo keeps your notes on the same beats. Voice recordings keep their own speed.</p>`);
  b.addEventListener("click", e => {
    const t = e.target.closest("[data-t]"), br = e.target.closest("[data-b]");
    if (t) { tempo(+t.dataset.t); b.querySelector("#stBpm").textContent = S.project.bpm; }
    if (br) { bars(+br.dataset.b); b.querySelector("#stBars").textContent = S.project.bars; }
  });
  let taps = [];
  b.querySelector("#tapT").onclick = () => {
    const now = performance.now(); taps = taps.filter(x => now - x < 3000); taps.push(now);
    if (taps.length >= 3) { const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1); const bpm = Math.round(60000 / iv); tempo(Math.max(40, Math.min(220, bpm)) - S.project.bpm); b.querySelector("#stBpm").textContent = S.project.bpm; }
  };
};
window.addEventListener("resize", () => { clearTimeout(window._rz); window._rz = setTimeout(drawAllLanes, 120); });

// ======================= adding layers =======================
export function addTrack(t, { open = false, silent = false } = {}) {
  snapshot();
  const base = { id: uid(), vol: 0.8, pan: 0, rev: 0.2, mute: false, solo: false };
  const tr = Object.assign(base, t);
  S.project.tracks.push(tr);
  const end = trackEnd(tr); if (end > S.project.bars * 4) S.project.bars = Math.min(128, Math.ceil(end / 4));
  changed({ structure: true }); T.refreshResources();
  if (!silent) toast(`Added "${tr.name}".`);
  if (open) openTrack(tr);
  setTimeout(() => document.querySelector(`.track[data-id="${tr.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 60);
  return tr;
}
function trackEnd(t) {
  if (t.type === "notes") return Math.max(0, ...t.notes.map(n => n.s + n.d + (t.shift || 0)));
  if (t.type === "audio") return t.clips ? contentEnd(t, 60 / S.project.bpm) : (t.start || 0) + (t.trimDur || 0) * S.project.bpm / 60;
  return 0;
}
export function notesTrack(name, inst, notes, extra = {}) {
  return { type: "notes", name, inst, oct: 0, shift: 0, notes, ...extra };
}
function openAddLayer() {
  const b = openSheet(`<h2>Add a layer</h2>
    <div class="menu">
      <button data-a="hum">${icon("mic")}<b>Hum a tune</b><small>Record in the app. Your hum becomes the instrument you pick.</small></button>
      <button data-a="voice">${icon("wave")}<b>Record voice</b><small>Keep your singing as a real recording.</small></button>
      <button data-a="import">${icon("file")}<b>Use a recording</b><small>Pick a voice note or audio file from the phone.</small></button>
      <button data-a="kit">${icon("drum")}<b>Drum beat</b><small>Real drum kit with rock, pop, folk and more.</small></button>
      <button data-a="tabla">${icon("drum")}<b>Tabla</b><small>Teentaal, Keherwa, Dadra, Rupak, Jhaptaal.</small></button>
      <button data-a="drone">${icon("drone")}<b>Tanpura drone</b><small>Sa–Pa drone in your key.</small></button>
      <button data-a="draw">${icon("note")}<b>Write notes</b><small>Tap notes onto a piano roll.</small></button>
      <button data-a="helper">${icon("wand")}<b>Tune helper</b><small>Chords, bass, harmony, or a new melody.</small></button>
      <button data-a="claude">${icon("chat")}<b>Paste from Claude</b><small>Paste notes Claude wrote for you.</small></button>
    </div>`);
  b.querySelector(".menu").onclick = e => {
    const a = e.target.closest("[data-a]")?.dataset.a; if (!a) return;
    if (a === "hum") openRecorder("hum");
    if (a === "voice") openRecorder("voice");
    if (a === "import") openImport();
    if (a === "kit" || a === "tabla") { closeSheet(); const pr = presetRows(a, a === "kit" ? "rock" : "teentaal"); openTrack(addTrack({ type: "drums", kit: a, name: a === "kit" ? "Drums" : "Tabla", ...pr, preset: a === "kit" ? "rock" : "teentaal", rev: 0.12 })); }
    if (a === "drone") { closeSheet(); const k = currentKey(); openTrack(addTrack({ type: "drone", name: "Tanpura", root: k.root, vol: 0.5, rev: 0.3 })); }
    if (a === "draw") { closeSheet(); const t = addTrack(notesTrack("Melody", S.settings.lastInst, []), { silent: true }); openRoll(t); }
    if (a === "helper") openHelper();
    if (a === "claude") openClaudeImport();
  };
}

// ======================= layer settings =======================
export function openTrack(t) {
  const isNotes = t.type === "notes";
  let html = `<div class="sheet-head"><input type="text" id="tName" value="${esc(t.name)}" aria-label="Layer name"></div>
    <button class="btn wide" id="tSection">${icon("scissors")}Crop, cut, copy &amp; fade</button>`;
  if (isNotes) {
    html += `<div class="row"><button class="btn" id="tInst"><i style="width:12px;height:12px;border-radius:4px;background:${trackColor(t)}"></i>${esc(instInfo(t.inst).name)}</button>
      <button class="btn primary" id="tEdit">${icon("note")}Edit notes</button></div>
      <div class="row between"><div class="stepper">Octave <button class="mini" id="oDn">−</button><b id="oV">${t.oct > 0 ? "+" : ""}${t.oct || 0}</b><button class="mini" id="oUp">+</button></div>
      <div class="stepper">Move <button class="mini" id="sDn" aria-label="Earlier">−</button><b id="sV">${fmtBeats(t.shift || 0)}</b><button class="mini" id="sUp" aria-label="Later">+</button></div></div>`;
    if (t.raw) html += `<div class="row"><label class="field grow">Snap to key<select id="tKey">${keyOptions(t.keySel)}</select></label>
      <label class="field grow">Timing<select id="tQ"><option value="8">Tidy (1/8)</option><option value="16">Fine (1/16)</option><option value="free">As hummed</option></select></label></div>`;
    html += `<h3>Tune helper</h3><div class="chips">
      <button class="chip" data-h="chords">Add chords</button><button class="chip" data-h="bass">Add bass line</button>
      <button class="chip" data-h="harm">Add harmony</button><button class="chip" data-h="cont">Continue 2 bars</button>
      ${t.gen ? `<button class="chip" data-h="regen">Try another version</button>` : ""}</div>`;
  } else if (t.type === "drums") {
    html += drumEditorHtml(t);
  } else if (t.type === "audio") {
    html += `<div class="row between"><div class="stepper">Move all <button class="mini" id="aDn" aria-label="Earlier by a quarter beat">−</button><button class="mini" id="aUp" aria-label="Later by a quarter beat">+</button></div>
      <div class="stepper">Nudge <button class="mini" id="nDn" aria-label="Earlier by 10 ms">−</button><b id="nV">10 ms</b><button class="mini" id="nUp" aria-label="Later by 10 ms">+</button></div></div>
      <p class="hint">Use Nudge if the recording is slightly ahead of or behind the beat. Recordings keep their speed when you change the tempo.</p>`;
  } else if (t.type === "drone") {
    html += `<label class="field">Sa (key note)<select id="dRoot">${NOTE_NAMES.map((n, i) => `<option value="${i}"${i === t.root ? " selected" : ""}>${n}</option>`).join("")}</select></label>`;
  }
  html += `<h3>Mix</h3>${slider("tVol", "Volume", t.vol, 0, 1.2, 0.01, v => Math.round(v * 100))}${slider("tPan", "Left/right", t.pan || 0, -1, 1, 0.05, v => v === 0 ? "C" : (v < 0 ? "L" : "R") + Math.round(Math.abs(v) * 100))}${slider("tRev", "Reverb", t.rev ?? 0.2, 0, 1, 0.01, v => Math.round(v * 100))}
    <div class="row"><button class="btn" id="tDup">Duplicate</button><button class="btn danger" id="tDel">${icon("trash")}Delete layer</button></div>`;
  const b = openSheet(html, () => renderTracks());
  b.querySelector("#tName").onchange = e => { snapshot(); t.name = e.target.value.trim() || t.name; changed({ structure: true }); };
  const mixUpd = (k, scale = 1) => (v, done) => { if (done) snapshot(); t[k] = v * scale; T.setStripGain(S.project); if (done) changed(); };
  bindSlider(b, "tVol", v => Math.round(v * 100), mixUpd("vol"));
  bindSlider(b, "tPan", v => v === 0 ? "C" : (v < 0 ? "L" : "R") + Math.round(Math.abs(v) * 100), mixUpd("pan"));
  bindSlider(b, "tRev", v => Math.round(v * 100), mixUpd("rev"));
  b.querySelector("#tDel").onclick = () => { snapshot(); S.project.tracks = S.project.tracks.filter(x => x !== t); closeSheet(); changed({ structure: true }); toast("Layer deleted. Tap undo to bring it back."); };
  b.querySelector("#tSection").onclick = () => openSection(t);
  b.querySelector("#tDup").onclick = () => { const c = structuredClone(t); delete c.id; c.name += " copy"; closeSheet(); addTrack(c); };
  if (isNotes) {
    b.querySelector("#tInst").onclick = () => openInstrumentPicker(t.inst, id => { snapshot(); t.inst = id; t.oct = instInfo(id).oct || 0; S.settings.lastInst = id; saveSettings(); changed({ structure: true }); T.refreshResources(); openTrack(t); });
    b.querySelector("#tEdit").onclick = () => { closeSheet(); openRoll(t); };
    const oct = d => { snapshot(); t.oct = Math.max(-3, Math.min(3, (t.oct || 0) + d)); b.querySelector("#oV").textContent = (t.oct > 0 ? "+" : "") + t.oct; changed(); };
    const sh = d => { snapshot(); t.shift = +((t.shift || 0) + d).toFixed(3); b.querySelector("#sV").textContent = fmtBeats(t.shift); changed(); };
    b.querySelector("#oUp").onclick = () => oct(1); b.querySelector("#oDn").onclick = () => oct(-1);
    b.querySelector("#sUp").onclick = () => sh(0.25); b.querySelector("#sDn").onclick = () => sh(-0.25);
    if (t.raw) {
      b.querySelector("#tQ").value = t.quant || "8";
      const re = () => { snapshot(); const r = notesFromRaw(t.raw, t.keySel, t.quant); t.notes = r.notes; t.keyLabel = r.keyLabel; changed(); };
      b.querySelector("#tKey").onchange = e => { t.keySel = e.target.value; re(); };
      b.querySelector("#tQ").onchange = e => { t.quant = e.target.value; re(); };
    }
    b.querySelector(".chips").onclick = e => { const h = e.target.closest("[data-h]")?.dataset.h; if (h) helperAction(h, t); };
  } else if (t.type === "drums") bindDrumEditor(b, t);
  else if (t.type === "audio") {
    // Shift every piece of the recording; beats for "Move all", seconds for "Nudge".
    const shiftAll = async beats => {
      try { prepareEdit(t, { fullDur: (await clipBuffer(t.blobId)).duration }); } catch (e) { return toast("This recording is missing."); }
      const minStart = Math.min(...t.clips.map(c => c.start)); if (minStart + beats < 0) beats = -minStart;
      snapshot(); t.clips = t.clips.map(c => ({ ...c, start: +(c.start + beats).toFixed(4) })); changed();
    };
    b.querySelector("#aUp").onclick = () => shiftAll(0.25); b.querySelector("#aDn").onclick = () => shiftAll(-0.25);
    b.querySelector("#nUp").onclick = () => shiftAll(0.01 / (60 / S.project.bpm)); b.querySelector("#nDn").onclick = () => shiftAll(-0.01 / (60 / S.project.bpm));
  } else if (t.type === "drone") b.querySelector("#dRoot").onchange = e => { snapshot(); t.root = +e.target.value; changed({ structure: true }); };
}
export function keyOptions(sel) {
  let h = `<option value="auto"${sel === "auto" ? " selected" : ""}>Auto-detect</option><option value="off"${sel === "off" ? " selected" : ""}>Off (exact notes)</option>`;
  for (const [sid, sc] of Object.entries(SCALES)) for (let r = 0; r < 12; r++) { const v = r + " " + sid; h += `<option value="${v}"${sel === v ? " selected" : ""}>${NOTE_NAMES[r]} ${sc.name}</option>`; }
  return h;
}

// ---------- drum editor ----------
function drumEditorHtml(t) {
  const kit = KITS[t.kit], presets = DRUM_PRESETS[t.kit];
  const used = kit.rows.filter(([id]) => t.showAll || t.rows[id]?.some(Boolean) || ["kick", "snare", "hat", "dha", "dhin", "na", "tin", "ta", "ge"].includes(id));
  const cols = `minmax(64px,auto) repeat(${t.steps}, minmax(26px,1fr))`;
  const grp = t.kit === "kit" ? 4 : t.steps === 16 ? 4 : t.steps === 8 ? 4 : t.steps === 6 ? 3 : t.steps === 7 ? 3 : t.steps === 10 ? 2 : 4;
  return `<div class="row"><label class="field grow">Pattern<select id="dPre"><option value="">Choose a pattern…</option>${Object.entries(presets).map(([k, v]) => `<option value="${k}"${t.preset === k ? " selected" : ""}>${v.name}</option>`).join("")}<option value="clear">Clear all</option></select></label>
    <label class="field">Steps<select id="dSteps">${[6, 7, 8, 10, 12, 16, 32].map(n => `<option${n === t.steps ? " selected" : ""}>${n}</option>`).join("")}</select></label>
    <label class="field">Step<select id="dStep"><option value="0.25"${t.stepBeats === 0.25 ? " selected" : ""}>1/16</option><option value="0.5"${t.stepBeats === 0.5 ? " selected" : ""}>1/8</option><option value="0.3333"${Math.abs(t.stepBeats - 1 / 3) < 0.01 ? " selected" : ""}>1/8 triplet</option><option value="1"${t.stepBeats === 1 ? " selected" : ""}>1/4</option></select></label></div>
    <p class="hint">Tap a square to add a hit; tap again for louder, softer, then off. Tap a name to hear it.</p>
    <div class="grid-wrap"><div class="dgrid" style="grid-template-columns:${cols}">${used.map(([id, label]) => `<button class="rl" data-row="${id}">${label}</button>${Array.from({ length: t.steps }, (_, i) => `<button class="cell${Math.floor(i / grp) % 2 ? " grp" : ""}" data-r="${id}" data-i="${i}" data-l="${t.rows[id]?.[i] || 0}" aria-label="${label} step ${i + 1}"></button>`).join("")}`).join("")}</div></div>
    <button class="btn" id="dAll">${t.showAll ? "Show fewer sounds" : "Show all " + kit.rows.length + " sounds"}</button>`;
}
function bindDrumEditor(b, t) {
  const rerender = () => openTrack(t);
  b.querySelector(".dgrid").onclick = e => {
    const rl = e.target.closest(".rl"); if (rl) { previewDrum(t.kit, rl.dataset.row); return; }
    const c = e.target.closest(".cell"); if (!c) return;
    snapshot(); const r = c.dataset.r, i = +c.dataset.i; t.rows[r] ||= new Array(t.steps).fill(0);
    const next = { 0: 2, 2: 3, 3: 1, 1: 0 }[t.rows[r][i] || 0]; t.rows[r][i] = next; c.dataset.l = next;
    if (next) previewDrum(t.kit, r); changed();
  };
  b.querySelector("#dPre").onchange = e => {
    const v = e.target.value; if (!v) return; snapshot();
    if (v === "clear") for (const k in t.rows) t.rows[k] = new Array(t.steps).fill(0);
    else Object.assign(t, presetRows(t.kit, v), { preset: v });
    changed({ structure: true }); rerender();
  };
  b.querySelector("#dSteps").onchange = e => { snapshot(); const n = +e.target.value; for (const k in t.rows) { const a = t.rows[k]; t.rows[k] = Array.from({ length: n }, (_, i) => a[i] || 0); } t.steps = n; changed({ structure: true }); rerender(); };
  b.querySelector("#dStep").onchange = e => { snapshot(); t.stepBeats = +e.target.value; changed({ structure: true }); };
  b.querySelector("#dAll").onclick = () => { t.showAll = !t.showAll; rerender(); };
  const onFrame = ev => {
    if (!b.isConnected) { window.removeEventListener("hs-frame", onFrame); return; }
    const beat = ev.detail; if (beat < 0) return; const plen = t.steps * t.stepBeats, i = Math.floor((beat % plen) / t.stepBeats);
    b.querySelectorAll(".cell").forEach(c => c.classList.toggle("now", +c.dataset.i === i));
  };
  window.addEventListener("hs-frame", onFrame);
}

// ---------- instrument picker ----------
export function openInstrumentPicker(current, onPick, title = "Choose an instrument") {
  const customs = customList();
  let html = `<h2>${title}</h2><p class="hint">Tap to hear it. Tap Use to choose it.</p>`;
  for (const g of GROUPS) {
    const items = g.id === "custom" ? customs.map(c => [c.id, c]) : Object.entries(INSTRUMENTS).filter(([, v]) => v.group === g.id);
    if (g.id === "custom") html += `<h3>${g.name}</h3><div class="chips">${items.map(([id, v]) => chip(id, v)).join("")}<button class="chip" id="mkInst">＋ From a song clip</button></div>`;
    else html += `<h3>${g.name}</h3><div class="chips">${items.map(([id, v]) => chip(id, v)).join("")}</div>`;
  }
  html += `<button class="btn primary wide sticky-use" id="useInst">Use ${esc(instInfo(current).name)}</button>`;
  function chip(id, v) { return `<button class="chip" data-inst="${id}" aria-pressed="${id === current}"><i style="background:${v.color || "#888"}"></i>${esc(v.name)}</button>`; }
  const b = openSheet(html);
  let sel = current;
  b.addEventListener("click", e => {
    const c = e.target.closest("[data-inst]");
    if (c) {
      sel = c.dataset.inst; b.querySelectorAll("[data-inst]").forEach(x => x.setAttribute("aria-pressed", x === c));
      b.querySelector("#useInst").textContent = "Use " + instInfo(sel).name;
      const info = instInfo(sel); const base = 60 + 12 * Math.max(-1, Math.min(1, (info.oct || 0)));
      previewNote(sel, base, 0.5).then(() => setTimeout(() => previewNote(sel, base + 4, 0.5), 280)).then(() => setTimeout(() => previewNote(sel, base + 7, 0.9), 560)).catch(() => toast("Couldn't load that instrument. Check your connection."));
    }
    if (e.target.closest("#mkInst")) openSampleMaker(id => { closeSheet(); onPick(id); });
    if (e.target.closest("#useInst")) { closeSheet(); onPick(sel); }
  });
}

// ======================= tune helper =======================
export function currentKey() {
  const p = S.project; if (p.key && p.key.root != null) return p.key;
  const all = p.tracks.filter(t => t.type === "notes").flatMap(t => t.notes.map(n => ({ ...n, p: n.p + 12 * (t.oct || 0) })));
  if (all.length) { const k = detectKey(all, Object.keys(SCALES)); return { root: k.root, scale: k.scale, auto: true }; }
  return { root: 0, scale: "major", auto: true };
}
function melodyTracks() { return S.project.tracks.filter(t => t.type === "notes" && t.notes.length && !t.helper); }
function openHelper() {
  const k = currentKey(), mels = melodyTracks();
  const b = openSheet(`<h2>Tune helper</h2>
    <div class="row"><label class="field grow">Song key<select id="hKey"><option value="auto">Auto${k.auto ? ` (${esc(keyLabel(k))})` : ""}</option>${Object.entries(SCALES).flatMap(([sid, sc]) => NOTE_NAMES.map((n, r) => `<option value="${r} ${sid}"${!k.auto && k.root === r && k.scale === sid ? " selected" : ""}>${n} ${sc.name}</option>`)).join("")}</select></label></div>
    ${mels.length ? `<h3>Build on a melody</h3><label class="field">Melody<select id="hSrc">${mels.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label>
    <div class="row"><label class="field grow">Chord style<select id="hStyle"><option value="pad">Held (strings)</option><option value="pulse">Beats (piano)</option><option value="arp">Broken (harp)</option><option value="strum">Strum (guitar)</option></select></label></div>
    <div class="chips"><button class="chip" data-h="chords">Add chords</button><button class="chip" data-h="bass">Add bass line</button><button class="chip" data-h="harm">Add harmony</button><button class="chip" data-h="cont">Continue 2 bars</button><button class="chip" data-h="full">Full backing (chords + bass + drums)</button></div>` : `<p class="note-box">Hum a melody first and I can add chords, a bass line and harmony to it. Or make a new melody below.</p>`}
    <h3>New melody</h3>
    <div class="row"><label class="field grow">Mood<select id="hMood"><option value="happy">Happy</option><option value="calm">Calm</option><option value="sad">Sad</option><option value="devotional">Devotional</option><option value="energetic">Energetic</option></select></label>
      <label class="field">Bars<select id="hBars"><option>2</option><option selected>4</option><option>8</option></select></label></div>
    <button class="btn primary" id="hNew">${icon("wand")}Make a melody</button>
    <h3>Ask Claude</h3>
    <p class="hint">For bigger ideas, copy your song as text, paste it into a Claude chat and ask for changes. Then paste Claude's notes back here.</p>
    <div class="row"><button class="btn" id="hCopy">${icon("copy")}Copy song for Claude</button><button class="btn" id="hPaste">${icon("chat")}Paste from Claude</button></div>`);
  b.querySelector("#hKey").onchange = e => { snapshot(); const v = e.target.value; S.project.key = v === "auto" ? null : { root: +v.split(" ")[0], scale: v.split(" ")[1] }; changed(); };
  b.querySelector(".chips")?.addEventListener("click", e => { const h = e.target.closest("[data-h]")?.dataset.h; if (h) helperAction(h, track(b.querySelector("#hSrc").value), b.querySelector("#hStyle").value); });
  b.querySelector("#hNew").onclick = () => {
    const mood = b.querySelector("#hMood").value, nb = +b.querySelector("#hBars").value, key = keyForMood(mood), seed = Date.now();
    const notes = newMelody(key, mood, nb, seed); closeSheet();
    addTrack(notesTrack(`${mood[0].toUpperCase() + mood.slice(1)} melody`, mood === "devotional" ? "panflute" : mood === "sad" ? "violin" : mood === "energetic" ? "synth" : "flute", notes, { oct: 0, gen: { kind: "new", mood, bars: nb, seed, key } }), { open: true });
  };
  b.querySelector("#hCopy").onclick = async () => { const ok = await copyText(songToText(S.project) + "\n\nPlease reply with notes in the same NOTE@BEAT LENGTH format."); toast(ok ? "Copied. Paste it into a Claude chat." : "Couldn't copy on this phone."); };
  b.querySelector("#hPaste").onclick = () => openClaudeImport();
}
function keyForMood(mood) {
  const k = currentKey(); if (!k.auto) return k;
  return { devotional: { root: 2, scale: "mayamalavagowla" }, sad: { root: 9, scale: "minor" }, calm: { root: 7, scale: "mohanam" }, energetic: { root: 4, scale: "minor" }, happy: { root: 0, scale: "major" } }[mood] || { root: 0, scale: "major" };
}
function helperAction(h, src, style = "pad") {
  if (!src || !src.notes.length) { toast("That layer has no notes yet."); return; }
  const mel = src.notes.map(n => ({ ...n, p: n.p + 12 * (src.oct || 0), s: n.s + (src.shift || 0) }));
  const key = currentKey(); closeSheet();
  if (h === "regen") {
    const g = src.gen; snapshot(); g.seed = Date.now();
    if (g.kind === "new") src.notes = newMelody(g.key, g.mood, g.bars, g.seed);
    if (g.kind === "cont") src.notes = continueMelody(S.project, g.base, g.key, 2, g.seed).map(n => ({ ...n }));
    changed({ structure: true }); toast("New version made."); return;
  }
  if (h === "chords" || h === "full") {
    const ch = suggestChords(S.project, mel, key);
    const inst = { pad: "symphony", pulse: "piano", arp: "harp", strum: "guitar_steel" }[style];
    addTrack(notesTrack("Chords · " + ch.slice(0, 4).map(c => chordName(c, key)).join(" "), inst, chordLayer(ch, style), { oct: 0, helper: true, vol: 0.55, rev: 0.3 }), { silent: true });
    if (h === "full") {
      addTrack(notesTrack("Bass line", "bass", bassLayer(ch), { oct: 0, helper: true, vol: 0.7 }), { silent: true });
      if (!S.project.tracks.some(t => t.type === "drums")) addTrack({ type: "drums", kit: "kit", name: "Drums", ...presetRows("kit", "pop"), preset: "pop", rev: 0.12, vol: 0.7 }, { silent: true });
      toast("Added chords, bass and drums. Press play.");
    } else toast("Chords added: " + ch.map(c => chordName(c, key)).join(" "));
  }
  if (h === "bass") { const ch = suggestChords(S.project, mel, key); addTrack(notesTrack("Bass line", "bass", bassLayer(ch), { oct: 0, helper: true, vol: 0.7 })); }
  if (h === "harm") addTrack(notesTrack("Harmony", src.inst === "violin" ? "violas" : src.inst, harmonyLayer(mel, key), { oct: 0, helper: true, vol: 0.55 }));
  if (h === "cont") { const seed = Date.now(); const notes = continueMelody(S.project, mel, key, 2, seed); addTrack(notesTrack(src.name + " · continued", src.inst, notes, { oct: 0, gen: { kind: "cont", base: mel, key, seed } }), { open: true }); }
}
function openClaudeImport() {
  const b = openSheet(`<h2>Paste from Claude</h2>
    <p class="hint">Ask Claude for a tune written like <b>C4@0 1, E4@1 0.5, G4@1.5 0.5</b> (note@beat length). Paste the reply below.</p>
    <textarea id="cText" placeholder="C4@0 1, D4@1 1, E4@2 2"></textarea>
    <button class="btn" id="cTry">Hear it</button>
    <button class="btn primary" id="cAdd">Add as a layer</button>`);
  const read = () => textToNotes(b.querySelector("#cText").value);
  b.querySelector("#cTry").onclick = async () => { const n = read(); if (!n.length) return toast("No notes found in that text."); const c = getCtx(); for (const x of n.slice(0, 32)) setTimeout(() => previewNote("piano", x.p, x.d * 0.6), x.s * 600); };
  b.querySelector("#cAdd").onclick = () => { const n = read(); if (!n.length) return toast("No notes found in that text."); closeSheet(); addTrack(notesTrack("From Claude", S.settings.lastInst, n, { oct: 0 }), { open: true }); };
}

// ======================= export =======================
function openExport() {
  stopPlay();
  const b = openSheet(`<h2>Export</h2>
    <div class="menu">
      <button data-x="wav24">${icon("wave")}<b>WAV · studio</b><small>24-bit, 48 kHz. Best quality.</small></button>
      <button data-x="wav32">${icon("wave")}<b>WAV · 32-bit float</b><small>For further mixing in a studio app.</small></button>
      <button data-x="wav16">${icon("wave")}<b>WAV · CD</b><small>16-bit, 44.1 kHz.</small></button>
      <button data-x="mp3">${icon("export")}<b>MP3 · 320 kbps</b><small>Small file, great for WhatsApp and sharing.</small></button>
      <button data-x="stems">${icon("open")}<b>Stems (zip)</b><small>Every layer as its own WAV, plus MIDI.</small></button>
      <button data-x="midi">${icon("note")}<b>MIDI</b><small>Notes and drums for any music app (FL Studio, GarageBand…).</small></button>
      <button data-x="backup">${icon("file")}<b>Song backup</b><small>Everything, including recordings. Open it again later.</small></button>
    </div>
    <div id="xStatus" class="note-box" hidden></div>`);
  b.querySelector(".menu").onclick = async e => {
    const x = e.target.closest("[data-x]")?.dataset.x; if (!x) return;
    const st = b.querySelector("#xStatus"); st.hidden = false; st.innerHTML = `Preparing… <div class="progress"><i style="width:15%"></i></div>`;
    b.querySelectorAll(".menu button").forEach(bt => (bt.disabled = true));
    const prog = f => { const i = st.querySelector("i"); if (i) i.style.width = Math.round(15 + f * 85) + "%"; };
    try {
      const p = S.project; let file;
      if (x === "wav24") file = await exportWav(p, { sampleRate: 48000, bits: 24 });
      if (x === "wav32") file = await exportWav(p, { sampleRate: 48000, bits: 32 });
      if (x === "wav16") file = await exportWav(p, { sampleRate: 44100, bits: 16 });
      if (x === "mp3") file = await exportMp3(p, { kbps: 320, onProgress: prog });
      if (x === "stems") file = await exportStems(p, { onProgress: prog });
      if (x === "midi") file = exportMidi(p);
      if (x === "backup") file = await exportProject(p);
      const mb = (file.blob.size / 1048576).toFixed(1);
      st.innerHTML = `<b>${esc(file.name)}</b> is ready (${mb} MB).<div class="row" style="margin-top:10px"><button class="btn primary" id="xSave">Save to phone</button><button class="btn" id="xShare">Share…</button></div>`;
      st.querySelector("#xSave").onclick = () => { saveFile(file); toast("Saved to your Downloads folder."); };
      st.querySelector("#xShare").onclick = async () => { try { if (!(await shareFile(file))) toast("Sharing isn't available here. Use Save instead."); } catch (err) { } };
    } catch (err) { console.error(err); st.innerHTML = `Export failed: ${esc(err.message || "unknown error")}. Try again, or export fewer bars.`; }
    b.querySelectorAll(".menu button").forEach(bt => (bt.disabled = false));
  };
}

// ======================= settings =======================
function openSettings() {
  const s = S.settings;
  const b = openSheet(`<h2>Settings</h2>
    <h3>Recording</h3>
    ${slider("sLat", "Timing fix", s.latencyMs, -250, 250, 5, v => v + " ms")}
    <p class="hint">If your hums land late on the beat, move this right. If they land early, move it left. Wired headphones need the least correction.</p>
    <label class="field">Count-in before recording<select id="sCount"><option value="0">None</option><option value="1">1 bar</option><option value="2">2 bars</option></select></label>
    ${slider("sMet", "Click volume", s.metroVol, 0, 1, 0.05, v => Math.round(v * 100))}
    ${S.project ? `<h3>This song</h3>${slider("sMaster", "Master volume", S.project.masterVol ?? 0.85, 0.2, 1.2, 0.01, v => Math.round(v * 100))}` : ""}
    <h3>Offline</h3>
    <button class="btn" id="sAll">Download all instruments for offline use</button>
    <div id="sProg" class="progress" hidden><i></i></div>
    <h3>About</h3>
    <p class="hint">Janice Seelan Music Studio 1.0. Orchestra samples: VSCO 2 Community Edition (CC0). Drums: SM Drums (public domain). Tabla and tanpura: Naad by Oormi Creations (MIT). Guitars, keys, sitar, shehnai and choir: MusyngKite soundfont (CC BY-SA 3.0). MP3 encoder: lamejs (LGPL).</p>`);
  b.querySelector("#sCount").value = String(s.countIn);
  bindSlider(b, "sLat", v => v + " ms", (v, d) => { s.latencyMs = v; if (d) saveSettings(); });
  bindSlider(b, "sMet", v => Math.round(v * 100), (v, d) => { s.metroVol = v; if (d) saveSettings(); });
  if (S.project) bindSlider(b, "sMaster", v => Math.round(v * 100), (v, d) => { S.project.masterVol = v; T.setStripGain(S.project); if (d) changed(); });
  b.querySelector("#sCount").onchange = e => { s.countIn = +e.target.value; saveSettings(); };
  b.querySelector("#sAll").onclick = async () => {
    const pr = b.querySelector("#sProg"), bar = pr.querySelector("i"); pr.hidden = false;
    const ids = Object.keys(INSTRUMENTS).filter(k => !INSTRUMENTS[k].parts); let i = 0;
    for (const id of ids) { try { await loadInstrument(id); } catch (e) { } bar.style.width = Math.round(++i / (ids.length + 2) * 100) + "%"; }
    await loadKit("kit"); await loadKit("tabla"); bar.style.width = "100%"; toast("All instruments are on this phone now.");
  };
}

boot();
