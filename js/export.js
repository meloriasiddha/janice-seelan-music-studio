// Exports: WAV (16/24/32-bit float), MP3, stems, MIDI, project backup.
import { renderSong, instInfo } from "./engine.js";
import { INSTRUMENTS, KITS } from "./instruments.js";
import { encodeWav } from "./recorder.js";
import { getBlob } from "./store.js";
import { inCuts } from "./edit.js";

const chans = buf => Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
const safe = s => (s || "song").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "song";

// Trim the silent tail after the reverb dies away.
function trimTail(buf) {
  const cs = chans(buf); let end = buf.length;
  while (end > buf.sampleRate && cs.every(c => Math.abs(c[end - 1]) < 1e-4)) end--;
  return cs.map(c => c.subarray(0, Math.min(buf.length, end + Math.floor(buf.sampleRate * 0.1))));
}

export async function exportWav(project, { sampleRate = 48000, bits = 24 } = {}) {
  const buf = await renderSong(project, { sampleRate });
  return { name: safe(project.name) + ".wav", blob: encodeWav(trimTail(buf), sampleRate, bits) };
}

export async function exportMp3(project, { sampleRate = 48000, kbps = 320, onProgress } = {}) {
  const buf = await renderSong(project, { sampleRate: sampleRate === 48000 ? 48000 : 44100 });
  const cs = trimTail(buf), sr = buf.sampleRate;
  const lame = window.lamejs; if (!lame) throw new Error("MP3 encoder not loaded");
  const enc = new lame.Mp3Encoder(2, sr, kbps), block = 1152, out = [];
  const L = toInt16(cs[0]), R = toInt16(cs[1] || cs[0]);
  for (let i = 0; i < L.length; i += block) {
    const m = enc.encodeBuffer(L.subarray(i, i + block), R.subarray(i, i + block)); if (m.length) out.push(new Uint8Array(m));
    if (i % (block * 400) === 0) { onProgress && onProgress(i / L.length); await new Promise(r => setTimeout(r, 0)); }
  }
  const f = enc.flush(); if (f.length) out.push(new Uint8Array(f));
  return { name: safe(project.name) + ".mp3", blob: new Blob(out, { type: "audio/mpeg" }) };
}
function toInt16(f) { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); o[i] = s < 0 ? s * 0x8000 : s * 0x7fff; } return o; }

export async function exportStems(project, { sampleRate = 48000, bits = 24, onProgress } = {}) {
  const files = []; let i = 0;
  const live = project.tracks.filter(t => !t.mute);
  for (const t of live) {
    onProgress && onProgress(i++ / live.length);
    const buf = await renderSong(project, { sampleRate, onlyTrack: t.id });
    files.push({ name: `${String(i).padStart(2, "0")}-${safe(t.name)}.wav`, data: new Uint8Array(await encodeWav(chans(buf), sampleRate, bits).arrayBuffer()) });
  }
  files.push({ name: "song.mid", data: midiBytes(project) });
  return { name: safe(project.name) + "-stems.zip", blob: zip(files) };
}

// ---------- MIDI ----------
function vlq(n) { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; }
export function midiBytes(project) {
  const TPQ = 480, tracks = [], enc = new TextEncoder(), str = s => Array.from(enc.encode(s));
  const tempo = Math.round(60e6 / project.bpm);
  tracks.push([0, 0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255, 0, 0xff, 0x58, 4, 4, 2, 24, 8, 0, 0xff, 0x2f, 0]);
  let ch = 0; const len = project.bars * 4;
  for (const t of project.tracks) {
    if (t.mute || (t.type !== "notes" && t.type !== "drums")) continue;
    const evs = []; let c;
    if (t.type === "drums") {
      c = 9; const map = KITS[t.kit].gmNote, plen = t.steps * t.stepBeats;
      for (let st = 0; st < len; st += plen) for (let i = 0; i < t.steps; i++) {
        const b = st + i * t.stepBeats; if (b >= len) break;
        if (inCuts(t.cuts, b)) continue;
        for (const [piece, arr] of Object.entries(t.rows)) if (arr[i] && map[piece]) { const tk = Math.round(b * TPQ), v = [0, 60, 90, 120][arr[i]]; evs.push([tk, 1, [0x99, map[piece], v]], [tk + 60, 0, [0x89, map[piece], 0]]); }
      }
    } else {
      c = ch++; if (ch === 9) ch++; if (c > 15) continue;
      for (const n of t.notes) {
        const b = n.s + (t.shift || 0); if (b < 0 || b >= len) continue;
        const p = Math.max(0, Math.min(127, n.p + 12 * (t.oct || 0))), t0 = Math.round(b * TPQ), t1 = Math.max(t0 + 1, Math.round((b + n.d) * TPQ) - 1);
        const v = Math.round(127 * Math.max(0.2, Math.min(1, (n.v ?? 0.8) * Math.min(1.2, t.vol ?? 0.8) / 0.8 * 0.8)));
        evs.push([t0, 1, [0x90 | c, p, v]], [t1, 0, [0x80 | c, p, 0]]);
      }
    }
    evs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const name = str(t.name).slice(0, 80), d = [0, 0xff, 0x03, name.length, ...name];
    if (c !== 9) { const gm = (INSTRUMENTS[t.inst] || {}).gm ?? 0; d.push(0, 0xc0 | c, gm); }
    const pan = Math.round(64 + (t.pan || 0) * 63); d.push(0, 0xb0 | c, 10, Math.max(0, Math.min(127, pan)));
    let last = 0; for (const [tk, , bytes] of evs) { d.push(...vlq(tk - last), ...bytes); last = tk; }
    d.push(0, 0xff, 0x2f, 0); tracks.push(d);
  }
  const out = [...str("MThd"), 0, 0, 0, 6, 0, 1, 0, tracks.length, (TPQ >> 8) & 255, TPQ & 255];
  for (const t of tracks) { const L = t.length; out.push(...str("MTrk"), (L >>> 24) & 255, (L >> 16) & 255, (L >> 8) & 255, L & 255, ...t); }
  return new Uint8Array(out);
}
export function exportMidi(project) { return { name: safe(project.name) + ".mid", blob: new Blob([midiBytes(project)], { type: "audio/midi" }) }; }

// ---------- project backup (includes recordings) ----------
export async function exportProject(project) {
  const blobs = {};
  for (const t of project.tracks) if (t.type === "audio" && t.blobId) { const b = await getBlob(t.blobId); if (b) blobs[t.blobId] = await toB64(b); }
  const data = JSON.stringify({ app: "humstudio", version: 1, project, blobs });
  return { name: safe(project.name) + ".humsong", blob: new Blob([data], { type: "application/json" }) };
}
function toB64(blob) { return new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); }); }

// ---------- zip (store, no compression; audio is already dense) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
function crc32(u) { let c = 0xffffffff; for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function zip(files) {
  const parts = [], central = []; let off = 0; const enc = new TextEncoder();
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const h = new DataView(new ArrayBuffer(30)); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(12, 0x5921, true);
    h.setUint32(14, crc, true); h.setUint32(18, sz, true); h.setUint32(22, sz, true); h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, f.data);
    const c = new DataView(new ArrayBuffer(46)); c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(14, 0x5921, true);
    c.setUint32(16, crc, true); c.setUint32(20, sz, true); c.setUint32(24, sz, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), name); off += 30 + name.length + sz;
  }
  const cd = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22)); e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cd, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: "application/zip" });
}

// Save to phone (Downloads) or share to WhatsApp etc.
export function saveFile({ name, blob }) {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export async function shareFile({ name, blob }) {
  const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return true; }
  return false;
}
