// Tune helper: chords, bass lines, harmonies, melody continuation and new melodies.
// Also the plain-text note format used to swap tunes with Claude.
import { SCALES, noteName, parseNote, NOTE_NAMES } from "./instruments.js";
import { detectKey, snapToScale } from "./pitch.js";

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; }; }
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
function weighted(r, items) { const tot = items.reduce((a, b) => a + b[1], 0); let x = r() * tot; for (const [v, w] of items) { if ((x -= w) <= 0) return v; } return items[items.length - 1][0]; }

export function songKey(project, notes) {
  if (project.key && project.key.root != null) return project.key;
  if (notes && notes.length) { const k = detectKey(notes); return { root: k.root, scale: k.scale }; }
  return { root: 0, scale: "major" };
}
export const keyLabel = k => NOTE_NAMES[k.root] + " " + (SCALES[k.scale]?.name || k.scale);

// Diatonic triads for a 7-note scale; for 5-note ragas use the closest 7-note parent.
function parent(scale) { const iv = SCALES[scale].iv; if (iv.length === 7) return iv; return iv.includes(3) || iv.includes(8) ? SCALES.minor.iv : SCALES.major.iv; }
function triads(root, scale) {
  const iv = parent(scale);
  return iv.map((_, d) => [0, 2, 4].map(k => { const idx = d + k; return root + iv[idx % 7] + 12 * Math.floor(idx / 7); }));
}

// Pick one chord per bar (or per 2 beats when the melody moves a lot).
export function suggestChords(project, melody, key) {
  const tri = triads(key.root, key.scale), bars = project.bars, out = [];
  let prev = 0;
  for (let b = 0; b < bars; b++) {
    const inBar = melody.filter(n => n.s < (b + 1) * 4 && n.s + n.d > b * 4);
    let best = 0, bs = -1e9;
    tri.forEach((ch, deg) => {
      const pcs = ch.map(p => ((p % 12) + 12) % 12);
      let s = 0;
      for (const n of inBar) {
        const ov = Math.min(n.s + n.d, (b + 1) * 4) - Math.max(n.s, b * 4);
        const pc = ((n.p % 12) + 12) % 12;
        if (pcs.includes(pc)) s += ov * (n.s % 1 === 0 ? 1.4 : 1); else s -= ov * 0.4;
        if (n.s === b * 4 && pc === pcs[0]) s += 0.6;
      }
      if (deg === 0) s += 0.35; if (deg === 3 || deg === 4) s += 0.25; if (deg === 6) s -= 0.6;
      if (deg === prev && b > 0) s -= 0.15;
      if ((b === 0 || b === bars - 1) && deg === 0) s += 0.8;
      if (b === bars - 2 && deg === 4) s += 0.3;
      if (s > bs) { bs = s; best = deg; }
    });
    if (!inBar.length) best = b === 0 ? 0 : [0, 3, 4, 0][b % 4];
    out.push({ bar: b, deg: best, notes: tri[best] });
    prev = best;
  }
  return out;
}
export function chordName(ch, key) {
  const root = ch.notes[0], third = ch.notes[1] - root, fifth = ch.notes[2] - root;
  return NOTE_NAMES[((root % 12) + 12) % 12] + (third === 3 ? (fifth === 6 ? "dim" : "m") : fifth === 8 ? "aug" : "");
}

// Voice chords around middle C. style: "pad" | "pulse" | "arp" | "strum"
export function chordLayer(chords, style) {
  const notes = [];
  for (const ch of chords) {
    let v = ch.notes.map(p => { let x = p; while (x < 55) x += 12; while (x > 67) x -= 12; return x; }).sort((a, b) => a - b);
    const s0 = ch.bar * 4;
    if (style === "pad") v.forEach(p => notes.push({ p, s: s0, d: 4, v: 0.6 }));
    else if (style === "pulse") for (let i = 0; i < 4; i++) v.forEach(p => notes.push({ p, s: s0 + i, d: 0.9, v: i === 0 ? 0.75 : 0.6 }));
    else if (style === "arp") { const seq = [v[0] - 12, v[0], v[1], v[2], v[0] + 12, v[2], v[1], v[0]]; seq.forEach((p, i) => notes.push({ p, s: s0 + i * 0.5, d: 0.5, v: i % 2 ? 0.55 : 0.7 })); }
    else { // strum: D . D U . U D U
      const hits = [[0, 1], [1, 1], [1.5, -1], [2.5, -1], [3, 1], [3.5, -1]];
      const voic = [v[0] - 12, v[0], v[1], v[2], v[0] + 12];
      for (const [beat, dir] of hits) { const seq = dir > 0 ? voic : [...voic].reverse(); seq.forEach((p, i) => notes.push({ p, s: +(s0 + beat + i * 0.02).toFixed(3), d: 0.5, v: dir > 0 ? 0.7 : 0.5 })); }
    }
  }
  return notes;
}
export function bassLayer(chords, style = "root5") {
  const notes = [];
  for (const ch of chords) {
    let r = ch.notes[0]; while (r >= 48) r -= 12; while (r < 36) r += 12;
    const f = r + 7, s0 = ch.bar * 4;
    if (style === "long") notes.push({ p: r, s: s0, d: 4, v: 0.8 });
    else { notes.push({ p: r, s: s0, d: 1.5, v: 0.85 }, { p: r, s: s0 + 1.5, d: 0.5, v: 0.6 }, { p: f, s: s0 + 2, d: 1.5, v: 0.75 }, { p: r, s: s0 + 3.5, d: 0.5, v: 0.6 }); }
  }
  return notes;
}
// A third (two scale steps) above, or a sixth below.
export function harmonyLayer(melody, key, below = false) {
  const iv = SCALES[key.scale].iv, all = [];
  for (let p = 12; p < 120; p++) if (iv.includes(((p - key.root) % 12 + 12) % 12)) all.push(p);
  const step = below ? -(iv.length === 7 ? 5 : 3) : 2;
  return melody.map(n => {
    const p = snapToScale(n.p, key.root, iv), idx = all.indexOf(p);
    const h = all[idx + step] ?? p;
    return { ...n, p: h, v: (n.v ?? 0.8) * 0.8 };
  });
}

// Continue a melody for `bars` bars, learning its rhythm and step sizes.
export function continueMelody(project, melody, key, bars = 2, seed = Date.now()) {
  const r = rng(seed), iv = SCALES[key.scale].iv;
  const scaleNotes = []; for (let o = 3; o <= 6; o++) for (const i of iv) scaleNotes.push(12 * o + key.root + i);
  const deg = p => { let best = 0; scaleNotes.forEach((q, i) => { if (Math.abs(q - p) < Math.abs(scaleNotes[best] - p)) best = i; }); return best; };
  const src = melody.length ? melody : [{ p: 60 + key.root, s: 0, d: 1 }];
  // rhythm patterns per bar from source
  const pats = [];
  const srcBars = Math.ceil(Math.max(...src.map(n => n.s + n.d)) / 4);
  for (let b = 0; b < srcBars; b++) { const p = src.filter(n => n.s >= b * 4 && n.s < b * 4 + 4).map(n => [+(n.s - b * 4).toFixed(3), n.d]); if (p.length) pats.push(p); }
  if (!pats.length) pats.push([[0, 1], [1, 1], [2, 1], [3, 1]]);
  // step distribution
  const steps = new Map(); for (let i = 1; i < src.length; i++) { const s = Math.max(-5, Math.min(5, deg(src[i].p) - deg(src[i - 1].p))); steps.set(s, (steps.get(s) || 0) + 1); }
  const stepItems = steps.size ? [...steps.entries()].map(([s, w]) => [s, w + (Math.abs(s) <= 1 ? 1 : 0)]) : [[-1, 3], [1, 3], [0, 1], [2, 1], [-2, 1]];
  const lo = Math.min(...src.map(n => n.p)) - 3, hi = Math.max(...src.map(n => n.p)) + 3;
  const start = Math.ceil(Math.max(...src.map(n => n.s + n.d)) / 4) * 4;
  let d0 = deg(src[src.length - 1].p); const out = [];
  for (let b = 0; b < bars; b++) {
    const pat = pick(r, pats);
    pat.forEach(([o, dur], i) => {
      let step = weighted(r, stepItems); let nd = d0 + step; let p = scaleNotes[Math.max(0, Math.min(scaleNotes.length - 1, nd))];
      if (p < lo || p > hi) { nd = d0 - step; p = scaleNotes[Math.max(0, Math.min(scaleNotes.length - 1, nd))]; }
      const last = b === bars - 1 && i === pat.length - 1;
      if (last) { const tonics = scaleNotes.filter(q => ((q - key.root) % 12 + 12) % 12 === 0); p = tonics.reduce((a, q) => Math.abs(q - p) < Math.abs(a - p) ? q : a); }
      d0 = deg(p);
      out.push({ p, s: +(start + b * 4 + o).toFixed(3), d: last ? Math.max(dur, 4 - o) : dur, v: 0.8 });
    });
  }
  return out;
}

// A new melody from scratch. mood: happy | calm | sad | devotional | energetic
export function newMelody(key, mood, bars = 4, seed = Date.now()) {
  const r = rng(seed);
  const rhythms = {
    calm: [[[0, 2], [2, 1], [3, 1]], [[0, 1.5], [1.5, 0.5], [2, 2]], [[0, 4]], [[0, 1], [1, 1], [2, 2]]],
    happy: [[[0, 1], [1, 0.5], [1.5, 0.5], [2, 1], [3, 1]], [[0, 0.5], [0.5, 0.5], [1, 1], [2, 0.5], [2.5, 0.5], [3, 1]], [[0, 1.5], [1.5, 0.5], [2, 2]]],
    sad: [[[0, 2], [2, 1.5], [3.5, 0.5]], [[0, 1], [1, 1], [2, 2]], [[0, 3], [3, 1]]],
    devotional: [[[0, 1], [1, 1], [2, 1], [3, 1]], [[0, 2], [2, 2]], [[0, 1.5], [1.5, 0.5], [2, 1], [3, 1]]],
    energetic: [[[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 1], [3, 0.5], [3.5, 0.5]], [[0, 0.75], [0.75, 0.75], [1.5, 0.5], [2, 1], [3, 1]]],
  }[mood] || [[[0, 1], [1, 1], [2, 1], [3, 1]]];
  const motif = pick(r, rhythms), motif2 = pick(r, rhythms);
  const seedMel = []; let s = 0;
  const iv = SCALES[key.scale].iv; let deg = 0; const base = 60 + key.root;
  const sn = d => base + iv[((d % iv.length) + iv.length) % iv.length] + 12 * Math.floor(d / iv.length);
  for (let b = 0; b < Math.min(2, bars); b++) {
    const pat = b === 0 ? motif : motif2;
    for (const [o, dur] of pat) { seedMel.push({ p: sn(deg), s: b * 4 + o, d: dur, v: 0.8 }); deg += weighted(r, [[1, 3], [-1, 3], [2, 1.5], [-2, 1], [0, 1], [3, 0.5]]); deg = Math.max(-3, Math.min(9, deg)); }
    s = (b + 1) * 4;
  }
  if (bars <= 2) return seedMel;
  // phrase answer: repeat motif with variation, then continue and resolve
  const rest = continueMelody({ bars }, seedMel, key, bars - 2, seed + 7);
  return [...seedMel, ...rest];
}

// ---------- text format shared with Claude ----------
// One note per item: <Note><Octave>@<start beat> <length beats> e.g. "C4@0 1, E4@1 0.5"
export function songToText(project) {
  const lines = [`Janice Seelan Music Studio song "${project.name}"`, `Tempo ${project.bpm} BPM, ${project.bars} bars of 4/4. Notes are written NOTE@BEAT LENGTH (beats start at 0).`];
  for (const t of project.tracks) {
    if (t.type === "notes") lines.push(`\nLayer "${t.name}" (${t.inst}, octave ${t.oct >= 0 ? "+" : ""}${t.oct || 0}):\n` + t.notes.map(n => `${noteName(n.p + 12 * (t.oct || 0))}@${+(n.s + (t.shift || 0)).toFixed(3)} ${+n.d.toFixed(3)}`).join(", "));
    else if (t.type === "drums") lines.push(`\nLayer "${t.name}" (${t.kit} beat, ${t.steps} steps of ${t.stepBeats} beat): ` + Object.entries(t.rows).filter(([, a]) => a.some(Boolean)).map(([k, a]) => `${k} ${a.map(x => x ? x : ".").join("")}`).join(" | "));
    else lines.push(`\nLayer "${t.name}" (${t.type})`);
  }
  return lines.join("\n");
}
export function textToNotes(text) {
  const notes = [];
  const re = /([A-Ga-g][#b♯♭]?-?\d)\s*@\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/g; let m;
  while ((m = re.exec(text))) { const p = parseNote(m[1]); if (p != null) notes.push({ p, s: +m[2], d: +m[3], v: 0.8 }); }
  if (notes.length) return notes.sort((a, b) => a.s - b.s);
  // Fallback: sequence "C4 1, D4 0.5" (or just "C4 D4 E4" = one beat each)
  let s = 0; const re2 = /([A-Ga-g][#b♯♭]?-?\d)(?:\s+(\d+(?:\.\d+)?))?/g;
  while ((m = re2.exec(text))) { const p = parseNote(m[1]); if (p == null) continue; const d = m[2] ? +m[2] : 1; notes.push({ p, s, d, v: 0.8 }); s += d; }
  return notes;
}
