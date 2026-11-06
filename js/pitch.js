// Hum-to-notes: YIN pitch tracking, note segmentation, tuning correction, key detection.
import { SCALES } from "./instruments.js";

const median = a => { const b = [...a].sort((x, y) => x - y), n = b.length; return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2; };

// Mix to mono and resample to 16 kHz (enough for voice pitch, much faster to analyse).
export function toMono16k(channels, sr) {
  const len = channels[0].length, mono = new Float32Array(len);
  for (const d of channels) for (let i = 0; i < len; i++) mono[i] += d[i] / channels.length;
  if (sr <= 16000) return { data: mono, sr };
  const ratio = sr / 16000, k = Math.max(1, Math.floor(ratio)), out = new Float32Array(Math.floor(len / ratio));
  for (let i = 0; i < out.length; i++) { const idx = Math.floor(i * ratio); let s = 0; for (let j = 0; j < k && idx + j < len; j++) s += mono[idx + j]; out[i] = s / k; }
  return { data: out, sr: 16000 };
}

export function yin(data, start, W, sr, tMin, tMax, d, thresh = 0.15) {
  for (let tau = 1; tau <= tMax; tau++) { let s = 0; for (let i = 0; i < W; i++) { const x = data[start + i] - data[start + i + tau]; s += x * x; } d[tau] = s; }
  d[0] = 1; let run = 0;
  for (let tau = 1; tau <= tMax; tau++) { run += d[tau]; d[tau] = run > 0 ? d[tau] * tau / run : 1; }
  let tau = -1;
  for (let t = tMin; t <= tMax; t++) { if (d[t] < thresh) { while (t + 1 <= tMax && d[t + 1] < d[t]) t++; tau = t; break; } }
  if (tau < 0) { let best = tMin; for (let t = tMin; t <= tMax; t++) if (d[t] < d[best]) best = t; if (d[best] < 0.3) tau = best; else return -1; }
  let bt = tau;
  if (tau > 1 && tau < tMax) { const a = d[tau - 1], b = d[tau], c = d[tau + 1], den = a - 2 * b + c; if (Math.abs(den) > 1e-9) bt = tau + (a - c) / (2 * den); }
  return sr / bt;
}

// Returns [{t (sec), d (sec), m (fractional midi)}]
export async function analyzeHum(data, sr, onProgress) {
  const W = 512, hop = Math.round(sr * 0.01), tMin = Math.floor(sr / 1000), tMax = Math.ceil(sr / 65);
  const n = Math.max(0, Math.floor((data.length - W - tMax - 1) / hop));
  const rms = new Float32Array(n), midi = new Array(n).fill(null), d = new Float32Array(tMax + 2);
  for (let f = 0; f < n; f++) { let s = 0; const st = f * hop; for (let i = 0; i < W; i++) { const x = data[st + i]; s += x * x; } rms[f] = Math.sqrt(s / W); }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const p90 = sorted[Math.floor(n * 0.9)] || 0, thr = Math.max(0.004, p90 * 0.12);
  for (let f = 0; f < n; f++) {
    if (rms[f] >= thr) { const hz = yin(data, f * hop, W, sr, tMin, tMax, d); if (hz > 0) midi[f] = 69 + 12 * Math.log2(hz / 440); }
    if (f % 150 === 0) { onProgress && onProgress(f / n); await new Promise(r => setTimeout(r, 0)); }
  }
  const sm = midi.map((m, i) => { if (m == null) return null; const w = []; for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < n && midi[j] != null) w.push(midi[j]); return median(w); });
  const out = []; let cur = null, pend = [];
  const close = () => { if (cur) { const dur = (cur.end - cur.start + 1) * hop / sr; if (dur >= 0.07) out.push({ t: cur.start * hop / sr, d: dur, m: median(cur.ms), a: cur.peak }); } cur = null; pend = []; };
  for (let i = 0; i < n; i++) {
    const m = sm[i], r = rms[i];
    if (m == null) { close(); continue; }
    if (!cur) { cur = { start: i, end: i, ms: [m], peak: r, valley: r }; continue; }
    if (cur.ms.length > 5 && cur.valley < 0.5 * cur.peak && r > cur.valley * 2) { close(); cur = { start: i, end: i, ms: [m], peak: r, valley: r }; continue; }
    if (r > cur.peak) { cur.peak = r; cur.valley = r; } else cur.valley = Math.min(cur.valley, r);
    const ref = median(cur.ms.slice(-6));
    if (Math.abs(m - ref) > 0.75) {
      pend.push(m);
      if (pend.length >= 3) { const p = pend.slice(); close(); cur = { start: i - 2, end: i, ms: p, peak: r, valley: r }; }
      continue;
    }
    pend = []; cur.ms.push(m); cur.end = i;
  }
  close();
  if (out.length) {
    let sx = 0, sy = 0;
    for (const o of out) { const fr = o.m - Math.round(o.m); sx += Math.cos(2 * Math.PI * fr) * o.d; sy += Math.sin(2 * Math.PI * fr) * o.d; }
    const off = Math.atan2(sy, sx) / (2 * Math.PI);
    for (const o of out) o.m -= off;
    const pk = Math.max(...out.map(o => o.a)) || 1;
    for (const o of out) o.v = Math.max(0.45, Math.min(1, 0.4 + 0.6 * o.a / pk));
  }
  onProgress && onProgress(1);
  return out;
}

// Single pitch for a short clip (used for custom instruments from song clips).
export function clipPitch(channels, sr) {
  const { data, sr: r } = toMono16k(channels, sr);
  const W = 1024, tMin = Math.floor(r / 2000), tMax = Math.ceil(r / 40), d = new Float32Array(tMax + 2), hop = 400, ms = [];
  for (let s = 0; s + W + tMax < data.length; s += hop) {
    let e = 0; for (let i = 0; i < W; i++) e += data[s + i] ** 2;
    if (Math.sqrt(e / W) < 0.01) continue;
    const hz = yin(data, s, W, r, tMin, tMax, d, 0.2); if (hz > 0) ms.push(69 + 12 * Math.log2(hz / 440));
  }
  if (ms.length < 2) return null;
  return median(ms);
}

export function detectKey(notes, scaleIds = ["major", "minor"]) {
  let best = { root: 0, scale: "major", score: -1 };
  for (let root = 0; root < 12; root++) for (const sc of scaleIds) {
    const iv = SCALES[sc].iv; let s = 0;
    notes.forEach((n, i) => {
      const p = n.p ?? Math.round(n.m), d = n.d;
      const pc = ((p - root) % 12 + 12) % 12;
      if (iv.includes(pc)) s += d; else s -= d * 0.5;
      if (pc === 0 && (i === 0 || i === notes.length - 1)) s += d * 0.6;
    });
    s -= iv.length * 0.001;
    if (s > best.score + 1e-6) best = { root, scale: sc, score: s };
  }
  return best;
}

export function snapToScale(p, root, iv) {
  const pc = ((p - root) % 12 + 12) % 12; let bd = 99;
  for (const i of iv) for (const k of [-12, 0, 12]) { const dd = i + k - pc; if (Math.abs(dd) < Math.abs(bd) || (Math.abs(dd) === Math.abs(bd) && dd < bd)) bd = dd; }
  return p + bd;
}

// raw: {notes:[{t,d,m,v}], bpm}. keySel: "auto" | "off" | "<root> <scaleId>". quant: "8"|"16"|"free"
export function notesFromRaw(raw, keySel, quant) {
  const sp = 60 / raw.bpm, t0 = raw.t0 ?? 0;
  let key = null, label = "Exact notes";
  if (keySel === "auto") { const k = detectKey(raw.notes); key = { root: k.root, iv: SCALES[k.scale].iv }; label = k.root + " " + k.scale; }
  else if (keySel !== "off") { const [r, s] = keySel.split(" "); key = { root: +r, iv: SCALES[s].iv }; label = keySel; }
  const g = { "8": 0.5, "16": 0.25, "free": 0 }[quant] || 0;
  let notes = raw.notes.map(n => {
    let p = Math.round(n.m); if (key) p = snapToScale(p, key.root, key.iv);
    let s = (n.t - t0) / sp, d = n.d / sp;
    if (g) { const e = Math.round((s + d) / g) * g; s = Math.round(s / g) * g; d = Math.max(g, e - s); }
    return { p, s: +s.toFixed(4), d: +d.toFixed(4), v: n.v ?? 0.8 };
  }).filter(n => n.s >= -0.01).sort((a, b) => a.s - b.s || b.d - a.d);
  const clean = [];
  for (const n of notes) { const last = clean[clean.length - 1]; if (last && Math.abs(last.s - n.s) < 1e-6) continue; if (last && last.s + last.d > n.s) last.d = +(n.s - last.s).toFixed(4); clean.push(n); }
  return { notes: clean.filter(n => n.d > 0.05).map(n => ({ ...n, s: Math.max(0, n.s) })), keyLabel: label };
}
