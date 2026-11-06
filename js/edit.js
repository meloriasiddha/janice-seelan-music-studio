// Section editing for every layer type: crop, delete, copy/paste, repeat, move, volume, fades.
// All positions are in beats from the start of the song (beat 0 = bar 1).
// Notes and recordings are edited for real; drum beats and the tanpura are looped, so
// their crop/delete is stored as silent ranges ("cuts").
const EPS = 1e-6;
const r4 = x => Math.round(x * 10000) / 10000;

// ---------- interval helpers ----------
export function mergeRanges(list) {
  const s = list.filter(([a, b]) => b - a > EPS).map(r => [...r]).sort((x, y) => x[0] - y[0]); const out = [];
  for (const r of s) { const last = out[out.length - 1]; if (last && r[0] <= last[1] + EPS) last[1] = Math.max(last[1], r[1]); else out.push(r); }
  return out;
}
export function subtractRange(list, a, b) {
  const out = [];
  for (const [x, y] of list) { if (y <= a || x >= b) { out.push([x, y]); continue; } if (x < a) out.push([x, a]); if (y > b) out.push([b, y]); }
  return out;
}
export const inCuts = (cuts, beat) => !!cuts && cuts.some(([a, b]) => beat >= a - EPS && beat < b - EPS);

// ---------- notes ----------
function bakeShift(t) {
  if (t.shift) { t.notes = t.notes.map(n => ({ ...n, s: r4(n.s + t.shift) })).filter(n => n.s + n.d > 0).map(n => n.s < 0 ? { ...n, d: r4(n.d + n.s), s: 0 } : n); t.shift = 0; }
  delete t.raw; // manual edits replace the hummed source; key/timing re-snap no longer applies
}
const notesCopy = (notes, a, b) => notes.filter(n => n.s >= a - EPS && n.s < b - EPS).map(n => ({ ...n, s: r4(n.s - a), d: r4(Math.min(n.d, b - n.s)) }));
function notesDelete(notes, a, b) {
  const out = [];
  for (const n of notes) {
    if (n.s >= a - EPS && n.s < b - EPS) continue;
    if (n.s < a && n.s + n.d > a) out.push({ ...n, d: r4(a - n.s) }); else out.push(n);
  }
  return out;
}
function notesCrop(notes, a, b) {
  return notes.filter(n => n.s < b - EPS && n.s + n.d > a + EPS).map(n => {
    let s = n.s, d = n.d; if (s < a) { d -= a - s; s = a; } if (s + d > b) d = b - s; return { ...n, s: r4(s), d: r4(d) };
  });
}
const notesPaste = (notes, clip, at) => [...notesDelete(notes, at, at + clip.len), ...clip.items.map(n => ({ ...n, s: r4(n.s + at) }))].sort((x, y) => x.s - y.s);

// ---------- recordings (clips) ----------
// clip: {start (beats), off (s into recording), dur (s), gain}
export function clipsOf(t, fullDur) {
  if (t.clips) return t.clips;
  return [{ start: t.start || 0, off: t.trimStart || 0, dur: t.trimDur ?? Math.max(0.05, (fullDur ?? 0) - (t.trimStart || 0)), gain: 1 }];
}
const cEnd = (c, spb) => c.start + c.dur / spb;
function splitAt(clips, x, spb) {
  const out = [];
  for (const c of clips) {
    if (x > c.start + EPS && x < cEnd(c, spb) - EPS) { const d1 = (x - c.start) * spb; out.push({ ...c, dur: r4(d1) }, { ...c, start: r4(x), off: r4(c.off + d1), dur: r4(c.dur - d1) }); }
    else out.push(c);
  }
  return out;
}
const inside = (c, a, b, spb) => c.start >= a - EPS && cEnd(c, spb) <= b + EPS;
const clipsSplit2 = (clips, a, b, spb) => splitAt(splitAt(clips, a, spb), b, spb);
const clipsDelete = (clips, a, b, spb) => clipsSplit2(clips, a, b, spb).filter(c => !inside(c, a, b, spb));
const clipsCrop = (clips, a, b, spb) => clipsSplit2(clips, a, b, spb).filter(c => inside(c, a, b, spb));
const clipsCopy = (clips, a, b, spb) => clipsCrop(clips, a, b, spb).map(c => ({ ...c, start: r4(c.start - a) }));
const clipsPaste = (clips, clip, at, spb) => [...clipsDelete(clips, at, at + clip.len, spb), ...clip.items.map(c => ({ ...c, start: r4(c.start + at) }))].sort((x, y) => x.start - y.start);

// ---------- public operations ----------
// ctx: {spb, fullDur (audio length in s, for old recordings)}. Each returns true if anything changed.
export function prepare(t, ctx) {
  if (t.type === "notes") bakeShift(t);
  if (t.type === "audio" && !t.clips) { t.clips = clipsOf(t, ctx.fullDur); delete t.start; delete t.trimStart; delete t.trimDur; }
  if ((t.type === "drums" || t.type === "drone") && !t.cuts) t.cuts = [];
}
export function cropTo(t, a, b, ctx) {
  prepare(t, ctx);
  if (t.type === "notes") t.notes = notesCrop(t.notes, a, b);
  else if (t.type === "audio") t.clips = clipsCrop(t.clips, a, b, ctx.spb);
  else t.cuts = mergeRanges([...t.cuts, [0, a], [b, 1e6]]);
  t.fades = (t.fades || []).filter(f => f.b > a && f.a < b);
}
export function deleteRange(t, a, b, ctx) {
  prepare(t, ctx);
  if (t.type === "notes") t.notes = notesDelete(t.notes, a, b);
  else if (t.type === "audio") t.clips = clipsDelete(t.clips, a, b, ctx.spb);
  else t.cuts = mergeRanges([...t.cuts, [a, b]]);
}
export function restoreRange(t, a, b) { if (t.cuts) t.cuts = subtractRange(t.cuts, a, b); }
export const canCopy = t => t.type === "notes" || t.type === "audio";
export function copyRange(t, a, b, ctx) {
  prepare(t, ctx);
  if (t.type === "notes") return { kind: "notes", len: b - a, items: notesCopy(t.notes, a, b) };
  if (t.type === "audio") return { kind: "audio", blobId: t.blobId, len: b - a, items: clipsCopy(t.clips, a, b, ctx.spb) };
  return null;
}
// Paste works within the same kind; recordings paste only into the layer they came from.
export function canPaste(t, clip) { return !!clip && clip.kind === (t.type === "notes" ? "notes" : t.type === "audio" ? "audio" : "") && (clip.kind !== "audio" || clip.blobId === t.blobId); }
export function pasteAt(t, clip, at, ctx) {
  prepare(t, ctx);
  if (t.type === "notes") t.notes = notesPaste(t.notes, clip, at);
  else if (t.type === "audio") t.clips = clipsPaste(t.clips, clip, at, ctx.spb);
}
export function moveRange(t, a, b, delta, ctx) {
  if (a + delta < 0) delta = -a;
  const clip = copyRange(t, a, b, ctx); if (!clip) return 0;
  deleteRange(t, a, b, ctx); pasteAt(t, clip, a + delta, ctx);
  return delta;
}
export function scaleVolume(t, a, b, f, ctx) {
  prepare(t, ctx);
  if (t.type === "notes") t.notes = t.notes.map(n => n.s >= a - EPS && n.s < b - EPS ? { ...n, v: r4(Math.max(0.05, Math.min(1, (n.v ?? 0.8) * f))) } : n);
  else if (t.type === "audio") t.clips = clipsSplit2(t.clips, a, b, ctx.spb).map(c => inside(c, a, b, ctx.spb) ? { ...c, gain: r4(Math.max(0.05, Math.min(4, (c.gain ?? 1) * f))) } : c);
}
export function addFade(t, a, b, type) {
  t.fades = [...(t.fades || []).filter(f => f.b <= a + EPS || f.a >= b - EPS), { a, b, type }].sort((x, y) => x.a - y.a);
}
export function clearFades(t, a, b) { t.fades = (t.fades || []).filter(f => f.b <= a + EPS || f.a >= b - EPS); }

// Where the layer has sound, for drawing and for the "select all" button.
export function contentEnd(t, spb) {
  if (t.type === "notes") return Math.max(0, ...t.notes.map(n => n.s + n.d + (t.shift || 0)));
  if (t.type === "audio" && t.clips) return Math.max(0, ...t.clips.map(c => cEnd(c, spb)));
  return 0;
}

// ---------- level automation (fades + cuts) ----------
// Segments of the layer's level over one pass of the song: [{a, b, from, to}] (level 1 elsewhere).
// Drum cuts are applied by skipping hits, so only the drone and fades use level automation for cuts.
export function levelSegments(t) {
  const segs = [];
  for (const f of t.fades || []) segs.push({ a: f.a, b: f.b, from: f.type === "in" ? 0 : 1, to: f.type === "in" ? 1 : 0 });
  if (t.type === "drone") for (const [a, b] of t.cuts || []) segs.push({ a, b, from: 0, to: 0 });
  return segs.sort((x, y) => x.a - y.a);
}
export function levelAt(segs, beat) {
  for (const s of segs) if (beat >= s.a && beat < s.b) return s.from + (s.to - s.from) * (beat - s.a) / Math.max(EPS, s.b - s.a);
  return 1;
}
