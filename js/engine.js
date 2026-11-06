// Audio engine: sample loading, playback, mixer, scheduler and offline rendering.
import { INSTRUMENTS, KITS } from "./instruments.js";
import { getBlob } from "./store.js";
import { inCuts, levelSegments, levelAt, clipsOf } from "./edit.js";

export let ctx = null;
let manifest = null;
const bufCache = new Map();      // url -> Promise<AudioBuffer>
const customInst = new Map();    // "custom:<id>" -> {name, samples:[{root, buffer}], sustain, release, color}
const clipCache = new Map();     // blobId -> Promise<AudioBuffer>
let reverbIR = null;

export function getCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive", sampleRate: 48000 });
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export async function loadManifest() {
  if (!manifest) manifest = await (await fetch("samples/manifest.json")).json();
  return manifest;
}

function decode(ab) {
  const c = getCtx();
  return new Promise((res, rej) => { const p = c.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
}
function loadBuffer(url) {
  if (!bufCache.has(url)) bufCache.set(url, fetch(url).then(r => { if (!r.ok) throw new Error("Missing sample " + url); return r.arrayBuffer(); }).then(decode));
  return bufCache.get(url);
}
export function decodeBlob(blob) { return blob.arrayBuffer().then(decode); }
export function clipBuffer(blobId) {
  if (!clipCache.has(blobId)) clipCache.set(blobId, getBlob(blobId).then(b => { if (!b) throw new Error("Recording missing"); return decodeBlob(b); }));
  return clipCache.get(blobId);
}

export function registerCustom(id, def) { customInst.set(id, def); }
export function customList() { return [...customInst.entries()].map(([id, d]) => ({ id, ...d })); }
export function instInfo(id) { return INSTRUMENTS[id] || customInst.get(id) || INSTRUMENTS.piano; }

// Returns {dir, notes:[midi], fmt, buffers: Map<midi, AudioBuffer>}
const instLoad = new Map();
export function loadInstrument(id) {
  if (customInst.has(id)) return Promise.resolve(customInst.get(id));
  const def = INSTRUMENTS[id];
  if (!def) return Promise.resolve(null);
  if (def.parts) return Promise.all(def.parts.map(p => loadInstrument(p.id)));
  if (!instLoad.has(id)) {
    instLoad.set(id, loadManifest().then(async m => {
      const info = m[id], buffers = new Map();
      await Promise.all(info.notes.map(async n => buffers.set(n, await loadBuffer(`samples/${id}/${n}.${info.fmt}`))));
      // Even out loudness between instruments from different sample libraries.
      let pk = 0; for (const b of buffers.values()) { const d = b.getChannelData(0); for (let i = 0; i < d.length; i += 7) { const v = Math.abs(d[i]); if (v > pk) pk = v; } }
      const norm = pk > 0 ? Math.min(4, 0.85 / pk) : 1;
      return { notes: info.notes, buffers, norm };
    }));
  }
  return instLoad.get(id);
}
const kitLoad = new Map();
export function loadKit(kitId) {
  if (!kitLoad.has(kitId)) {
    kitLoad.set(kitId, loadManifest().then(async () => {
      const map = new Map();
      if (kitId === "kit") {
        await Promise.all(KITS.kit.rows.map(async ([id]) => map.set(id, await Promise.all([0, 1, 2].map(i => loadBuffer(`samples/drums/${id}${i}.ogg`))))));
      } else {
        await Promise.all(KITS.tabla.rows.map(async ([id]) => map.set(id, await Promise.all([0, 1].map(i => loadBuffer(`samples/tabla/${id}${i}.ogg`))))));
      }
      return map;
    }));
  }
  return kitLoad.get(kitId);
}
export function loadDrone() { return loadBuffer("samples/tabla/tanpura.ogg"); }

export async function preloadProject(project) {
  const jobs = [];
  for (const t of project.tracks) {
    if (t.type === "notes") jobs.push(loadInstrument(t.inst));
    if (t.type === "drums") jobs.push(loadKit(t.kit));
    if (t.type === "drone") jobs.push(loadDrone());
    if (t.type === "audio") jobs.push(clipBuffer(t.blobId).catch(() => null));
  }
  await Promise.all(jobs);
}

// ---------- reverb ----------
function makeIR(c) {
  const sr = c.sampleRate, len = Math.floor(sr * 2.6), ir = c.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch); let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr, env = Math.pow(1 - i / len, 2.2) * (t < 0.012 ? t / 0.012 : 1);
      lp = lp * 0.55 + (Math.random() * 2 - 1) * 0.45;
      d[i] = lp * env * 0.5;
    }
  }
  return ir;
}

// ---------- mixer graph ----------
// Builds per-track strips feeding a master bus with a shared reverb and a gentle limiter.
export function buildMix(c, project) {
  const master = c.createGain(); master.gain.value = project.masterVol ?? 0.85;
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -6; comp.knee.value = 6; comp.ratio.value = 8; comp.attack.value = 0.003; comp.release.value = 0.15;
  master.connect(comp); comp.connect(c.destination);
  const rev = c.createConvolver(); rev.buffer = c === ctx ? (reverbIR ||= makeIR(c)) : makeIR(c);
  const revGain = c.createGain(); revGain.gain.value = 0.9; rev.connect(revGain); revGain.connect(master);
  const strips = {};
  const anySolo = project.tracks.some(t => t.solo);
  for (const t of project.tracks) {
    const g = c.createGain(), auto = c.createGain(), pan = c.createStereoPanner ? c.createStereoPanner() : null, send = c.createGain();
    g.gain.value = trackGain(t, anySolo); g.connect(auto); // auto: fades and silent parts
    if (pan) { pan.pan.value = t.pan || 0; auto.connect(pan); pan.connect(master); pan.connect(send); } else { auto.connect(master); auto.connect(send); }
    send.gain.value = t.rev ?? 0.2; send.connect(rev);
    strips[t.id] = { in: g, auto, pan, send };
  }
  return { master, comp, rev, strips, nodes: [master, comp, rev, revGain] };
}
// Schedules each layer's fades / silent parts for one pass of the song that starts at loopStart.
export function scheduleLevels(c, mix, project, loopStart, spb, fromBeat = 0) {
  const now = c.currentTime;
  for (const t of project.tracks) {
    const st = mix.strips[t.id]; if (!st) continue;
    const segs = levelSegments(t), ag = st.auto.gain;
    ag.setValueAtTime(levelAt(segs, fromBeat), Math.max(now, loopStart + fromBeat * spb));
    for (const sg of segs) {
      if (sg.b <= fromBeat) continue;
      const a = Math.max(sg.a, fromBeat), Ta = Math.max(now, loopStart + a * spb), Tb = loopStart + sg.b * spb;
      if (a > fromBeat) { ag.setValueAtTime(1, Ta); ag.linearRampToValueAtTime(sg.from, Ta + 0.008); }
      ag.linearRampToValueAtTime(sg.to, Math.max(Ta + 0.01, Tb));
      ag.linearRampToValueAtTime(1, Math.max(Ta + 0.02, Tb + 0.008));
    }
  }
}
export function trackGain(t, anySolo) { if (t.mute) return 0; if (anySolo && !t.solo) return 0; return t.vol ?? 0.8; }

// ---------- voices ----------
function nearest(notes, m) { let best = notes[0]; for (const n of notes) if (Math.abs(n - m) < Math.abs(best - m)) best = n; return best; }

function playSample(c, out, buffer, rate, t, dur, vel, sustain, release, norm = 1) {
  const src = c.createBufferSource(); src.buffer = buffer; src.playbackRate.value = rate;
  const g = c.createGain();
  const peak = 0.75 * norm * Math.pow(vel, 1.3);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + 0.004);
  const natural = buffer.duration / rate;
  let end;
  if (sustain) end = t + Math.max(0.05, Math.min(dur, natural - 0.05));
  else end = t + Math.min(natural, Math.max(dur, 0.12) + 0.6);
  const rel = sustain ? release : Math.max(0.08, release);
  g.gain.setTargetAtTime(0, end, rel / 3);
  src.connect(g); g.connect(out);
  src.start(t); src.stop(end + rel * 2 + 0.05);
}

export function playNote(c, out, instId, inst, m, t, durSec, vel = 0.8) {
  const def = instInfo(instId);
  if (def.parts) { def.parts.forEach((p, i) => { const pi = inst[i]; if (pi) playNote(c, out, p.id, pi, m + p.t, t, durSec, vel * p.g); }); return; }
  if (!inst) return;
  if (inst.samples) { // custom
    const s = inst.samples.reduce((a, b) => Math.abs(b.root - m) < Math.abs(a.root - m) ? b : a);
    playSample(c, out, s.buffer, Math.pow(2, (m - s.root) / 12), t, durSec, vel, inst.sustain, inst.release ?? 0.15);
    return;
  }
  const n = nearest(inst.notes, m);
  playSample(c, out, inst.buffers.get(n), Math.pow(2, (m - n) / 12), t, durSec, vel, def.sustain, def.sustain ? 0.18 : 0.25, inst.norm || 1);
}

export function playDrum(c, out, kitMap, kitId, piece, t, level) {
  const bufs = kitMap.get(piece); if (!bufs) return;
  const idx = kitId === "kit" ? Math.min(2, Math.max(0, level - 1)) : (Math.random() < 0.5 ? 0 : 1);
  const src = c.createBufferSource(); src.buffer = bufs[idx];
  const g = c.createGain(); g.gain.value = kitId === "kit" ? 1 : [0, 0.55, 0.8, 1][level];
  src.connect(g); g.connect(out); src.start(t);
}

// ---------- events ----------
// Flattens the project into timed events (beats) within one pass of the song.
export function buildEvents(project, includeMuted = true) {
  const ev = [], len = project.bars * 4;
  for (const t of project.tracks) {
    if (!includeMuted && t.mute) continue;
    if (t.type === "notes") {
      for (const n of t.notes) { const b = n.s + (t.shift || 0); if (b < 0 || b >= len) continue; ev.push({ tid: t.id, k: "n", inst: t.inst, p: n.p + 12 * (t.oct || 0), b, d: n.d, v: n.v ?? 0.8 }); }
    } else if (t.type === "drums") {
      const plen = t.steps * t.stepBeats;
      for (let start = 0; start < len; start += plen) for (let i = 0; i < t.steps; i++) {
        const b = start + i * t.stepBeats; if (b >= len) break;
        if (inCuts(t.cuts, b)) continue;
        for (const [piece, arr] of Object.entries(t.rows)) if (arr[i]) ev.push({ tid: t.id, k: "d", kit: t.kit, piece, b, lv: arr[i] });
      }
    } else if (t.type === "audio") {
      for (const c of clipsOf(t)) if (c.start < len && c.dur > 0.005) ev.push({ tid: t.id, k: "a", blobId: t.blobId, b: c.start, off: c.off, dur: t.clips || t.trimDur != null ? c.dur : undefined, gain: c.gain ?? 1 });
    } else if (t.type === "drone") {
      ev.push({ tid: t.id, k: "drone", root: t.root ?? 0, b: 0 });
    }
  }
  return ev.sort((a, b) => a.b - b.b);
}

// Resolves loaded resources for events synchronously (everything must be preloaded).
export async function resources(project) {
  const r = { inst: new Map(), kit: new Map(), clip: new Map(), drone: null };
  for (const t of project.tracks) {
    if (t.type === "notes" && !r.inst.has(t.inst)) r.inst.set(t.inst, await loadInstrument(t.inst));
    if (t.type === "drums" && !r.kit.has(t.kit)) r.kit.set(t.kit, await loadKit(t.kit));
    if (t.type === "audio") { try { r.clip.set(t.blobId, await clipBuffer(t.blobId)); } catch (e) { } }
    if (t.type === "drone") r.drone = await loadDrone();
  }
  return r;
}

export function fireEvent(c, mix, res, e, t, spb, loopEndTime) {
  const strip = mix.strips[e.tid]; if (!strip) return;
  const out = strip.in;
  if (e.k === "n") playNote(c, out, e.inst, res.inst.get(e.inst), e.p, t, e.d * spb, e.v);
  else if (e.k === "d") playDrum(c, out, res.kit.get(e.kit), e.kit, e.piece, t, e.lv);
  else if (e.k === "a") {
    const buf = res.clip.get(e.blobId); if (!buf) return;
    const src = c.createBufferSource(); src.buffer = buf;
    const g = c.createGain(); src.connect(g); g.connect(out);
    const dur = Math.min(e.dur ?? buf.duration - e.off, buf.duration - e.off, Math.max(0.01, loopEndTime - t));
    if (dur <= 0.005) return;
    const gv = e.gain ?? 1, edge = Math.min(0.005, dur / 4);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gv, t + edge); g.gain.setValueAtTime(gv, t + Math.max(edge, dur - edge)); g.gain.linearRampToValueAtTime(0, t + dur);
    src.start(t, e.off, dur + 0.01);
  } else if (e.k === "drone" && res.drone) {
    // Tanpura sample is tuned to G (Sa = G). Shift to the chosen Sa, staying close.
    let semis = ((e.root - 7) % 12 + 12) % 12; if (semis > 6) semis -= 12;
    const total = Math.max(0.1, loopEndTime - t);
    let at = t;
    while (at < t + total - 0.05) {
      const src = c.createBufferSource(); src.buffer = res.drone; src.playbackRate.value = Math.pow(2, semis / 12);
      const g = c.createGain(); src.connect(g); g.connect(out);
      const seg = Math.min(res.drone.duration / src.playbackRate.value - 1.5, t + total - at);
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.7, at + 0.8);
      g.gain.setValueAtTime(0.7, at + Math.max(0.8, seg - 0.8)); g.gain.linearRampToValueAtTime(0, at + seg + 0.7);
      src.start(at); src.stop(at + seg + 0.8);
      at += seg;
    }
  }
}

// ---------- live transport ----------
export class Transport {
  constructor() { this.s = null; this.onStop = null; }
  get playing() { return !!this.s; }
  async start(project, { fromBeat = 0, countIn = 0, metronome = false, metroVol = 0.5 } = {}) {
    const c = getCtx(); this.stop(true);
    await preloadProject(project);
    const res = await resources(project);
    const mix = buildMix(c, project);
    const spb = 60 / project.bpm, len = project.bars * 4;
    const t0 = c.currentTime + 0.12 + countIn * 4 * spb - fromBeat * spb; // time of beat 0
    const s = this.s = { project, mix, res, spb, len, t0, sched: fromBeat, events: buildEvents(project, false), dirty: false, metronome, metroVol, countIn, startT: c.currentTime + 0.12, fromBeat };
    // count-in clicks
    for (let i = 0; i < countIn * 4; i++) this.click(c, s.startT + i * spb, i % 4 === 0, metroVol || 0.5);
    // Long sounds (recordings, drone) that began before the play position start mid-way.
    if (fromBeat > 0) {
      const at = s.t0 + fromBeat * spb, loopEnd = s.t0 + len * spb;
      for (const e of s.events) {
        if (e.b >= fromBeat) continue;
        if (e.k === "drone") fireEvent(c, mix, res, e, at, spb, loopEnd);
        if (e.k === "a") {
          const skip = (fromBeat - e.b) * spb, buf = res.clip.get(e.blobId);
          const full = e.dur ?? (buf ? buf.duration - e.off : 0);
          if (buf && skip < full) fireEvent(c, mix, res, { ...e, off: e.off + skip, dur: full - skip }, at, spb, loopEnd);
        }
      }
    }
    s.levelDone = new Set();
    s.timer = setInterval(() => this.tick(), 25); this.tick();
    return s;
  }
  click(c, t, accent, vol) {
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = accent ? 1760 : 1175; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5 * vol, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g); g.connect(this.s.mix.master); o.start(t); o.stop(t + 0.06);
  }
  tick() {
    const s = this.s; if (!s) return; const c = ctx;
    const now = (c.currentTime - s.t0) / s.spb, target = now + 0.3 / s.spb;
    if (s.dirty) {
      s.events = buildEvents(s.project, false); s.dirty = false;
      // Re-plan fades / silent parts from the current position.
      if (now >= 0) {
        const k = Math.floor(now / s.len); for (const st of Object.values(s.mix.strips)) st.auto.gain.cancelScheduledValues(c.currentTime);
        s.levelDone = new Set([k]); scheduleLevels(c, s.mix, s.project, s.t0 + k * s.len * s.spb, s.spb, now - k * s.len);
      }
    }
    if (!s.project.loop && now > s.len + 1) { this.stop(); return; }
    if (s.sched < target) {
      const k0 = Math.floor(s.sched / s.len), k1 = Math.floor(target / s.len);
      for (let k = Math.max(0, k0); k <= k1; k++) {
        if (!s.project.loop && k > 0) break;
        const loopEnd = s.t0 + (k + 1) * s.len * s.spb;
        if (!s.levelDone.has(k)) { s.levelDone.add(k); const from = k === Math.floor(s.fromBeat / s.len) ? s.fromBeat - k * s.len : 0; scheduleLevels(c, s.mix, s.project, s.t0 + k * s.len * s.spb, s.spb, from); }
        for (const e of s.events) {
          const abs = k * s.len + e.b;
          if (abs >= s.sched && abs < target) {
            const t = s.t0 + abs * s.spb;
            if (t >= c.currentTime - 0.02) fireEvent(c, s.mix, s.res, e, Math.max(t, c.currentTime), s.spb, loopEnd);
          }
        }
        if (s.metronome) {
          for (let b = Math.ceil(Math.max(s.sched, k * s.len)); b < Math.min(target, (k + 1) * s.len); b++) {
            const t = s.t0 + b * s.spb; if (t >= c.currentTime - 0.01) this.click(c, t, (b % 4) === 0, s.metroVol);
          }
        }
      }
      s.sched = target;
    }
  }
  beat() { const s = this.s; if (!s) return 0; const b = (ctx.currentTime - s.t0) / s.spb; return b < 0 ? b : s.project.loop ? b % s.len : Math.min(b, s.len); }
  rawBeat() { const s = this.s; return s ? (ctx.currentTime - s.t0) / s.spb : 0; }
  markDirty() { if (this.s) this.s.dirty = true; }
  async refreshResources() { if (!this.s) return; await preloadProject(this.s.project); this.s.res = await resources(this.s.project); }
  setStripGain(project) {
    if (!this.s) return; const anySolo = project.tracks.some(t => t.solo);
    for (const t of project.tracks) { const st = this.s.mix.strips[t.id]; if (!st) continue; st.in.gain.setTargetAtTime(trackGain(t, anySolo), ctx.currentTime, 0.02); if (st.pan) st.pan.pan.setTargetAtTime(t.pan || 0, ctx.currentTime, 0.02); st.send.gain.setTargetAtTime(t.rev ?? 0.2, ctx.currentTime, 0.02); }
    this.s.mix.master.gain.setTargetAtTime(project.masterVol ?? 0.85, ctx.currentTime, 0.02);
  }
  stop(silent) {
    const s = this.s; if (!s) return; this.s = null; clearInterval(s.timer);
    const t = ctx.currentTime; s.mix.master.gain.setTargetAtTime(0, t, 0.015);
    setTimeout(() => { for (const n of s.mix.nodes) try { n.disconnect(); } catch (e) { } }, 400);
    if (!silent && this.onStop) this.onStop();
  }
}

// Preview one note immediately (tapping notes, instrument picker).
export async function previewNote(instId, m, durSec = 0.6, vel = 0.8) {
  const c = getCtx(); const inst = await loadInstrument(instId);
  const g = c.createGain(); g.gain.value = 0.8; g.connect(c.destination);
  playNote(c, g, instId, inst, m, c.currentTime + 0.02, durSec, vel);
  setTimeout(() => g.disconnect(), (durSec + 3) * 1000);
}
export async function previewDrum(kitId, piece) {
  const c = getCtx(); const map = await loadKit(kitId); playDrum(c, c.destination, map, kitId, piece, c.currentTime + 0.01, 2);
}

// ---------- offline render ----------
// Renders the whole song (or only some tracks) at the requested sample rate.
export async function renderSong(project, { sampleRate = 48000, onlyTrack = null, tail = 3 } = {}) {
  await preloadProject(project);
  const res = await resources(project);
  const spb = 60 / project.bpm, len = project.bars * 4, dur = len * spb + tail;
  const oc = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, Math.ceil(dur * sampleRate), sampleRate);
  const p = onlyTrack ? { ...project, tracks: project.tracks.map(t => t.id === onlyTrack ? { ...t, mute: false, solo: false } : { ...t, mute: true, solo: false }) } : project;
  const mix = buildMix(oc, p);
  if (onlyTrack) { mix.comp.threshold.value = 0; mix.comp.ratio.value = 1; }
  const offset = 0.02, loopEnd = offset + len * spb;
  scheduleLevels(oc, mix, p, offset, spb, 0);
  for (const e of buildEvents(p, false)) fireEvent(oc, mix, res, e, offset + e.b * spb, spb, loopEnd + (e.k === "drone" ? 1.5 : 0));
  return oc.startRendering();
}
