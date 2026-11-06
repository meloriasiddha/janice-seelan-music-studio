// Small UI helpers shared by all screens.
import { saveProject } from "./store.js";
import { Transport } from "./engine.js";

export const $ = id => document.getElementById(id);
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const icon = (id, size) => `<svg viewBox="0 0 24 24"${size ? ` style="width:${size}px;height:${size}px"` : ""}><use href="#i-${id}"/></svg>`;

// ---------- app state ----------
export const S = {
  project: null,
  undo: [],
  cursor: 0,              // play-from position in beats
  settings: { latencyMs: 0, countIn: 1, metroVol: 0.6, playAlong: true, lastInst: "violins" },
  transport: new Transport(),
  listeners: new Set(),
};
let saveT = null;
export function snapshot() {
  if (!S.project) return;
  S.undo.push(JSON.stringify(S.project)); if (S.undo.length > 40) S.undo.shift();
  const u = $("undo"); if (u) u.disabled = false;
}
export function undo() {
  const s = S.undo.pop(); if (!s) return false;
  S.project = JSON.parse(s); changed({ structure: true, noSnapshot: true });
  $("undo").disabled = !S.undo.length; return true;
}
// Call after any change to the song. structure=true re-renders the layer list.
export function changed(opts = {}) {
  clearTimeout(saveT); saveT = setTimeout(() => S.project && saveProject(S.project), 400);
  S.transport.markDirty();
  for (const fn of S.listeners) fn(opts);
}
export const onChange = fn => S.listeners.add(fn);
export const track = id => S.project.tracks.find(t => t.id === id);

// ---------- toast ----------
let toastT;
export function toast(msg, ms = 2800) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }

// ---------- overlays (bottom sheet + full-screen panel) ----------
// One history entry stands for "an overlay is open", so the Android back button
// closes the top-most overlay instead of leaving the song.
export const nav = { handled: false };
function ensureEntry() { if (!(history.state && history.state.overlay)) history.pushState({ overlay: 1 }, ""); }
let sheetClose = null;
export function openSheet(html, onClose) {
  closeSheet();
  $("sheetBody").innerHTML = html; $("sheet").hidden = false; $("sheetBack").hidden = false;
  $("sheetBody").scrollTop = 0; sheetClose = onClose || null;
  ensureEntry();
  return $("sheetBody");
}
export function closeSheet() {
  if ($("sheet").hidden) return;
  $("sheet").hidden = true; $("sheetBack").hidden = true; $("sheetBody").innerHTML = "";
  const f = sheetClose; sheetClose = null; if (f) f();
}
export const sheetOpen = () => !$("sheet").hidden;

let panelClose = null;
export function openPanel(html, onClose) {
  closePanel(); closeSheet();
  const p = $("panel"); p.innerHTML = html; p.hidden = false; panelClose = onClose || null;
  ensureEntry();
  return p;
}
export function closePanel() {
  const p = $("panel"); if (p.hidden) return;
  p.hidden = true; p.innerHTML = "";
  const f = panelClose; panelClose = null; if (f) f();
}
export const panelOpen = () => !$("panel").hidden;

window.addEventListener("popstate", () => {
  nav.handled = false;
  if (!$("sheet").hidden) { closeSheet(); nav.handled = true; if (!$("panel").hidden) history.pushState({ overlay: 1 }, ""); return; }
  if (!$("panel").hidden) { closePanel(); nav.handled = true; return; }
});
document.addEventListener("keydown", e => { if (e.key === "Escape") { if (!$("sheet").hidden) closeSheet(); else closePanel(); } });

// ---------- misc ----------
export function slider(id, label, val, min, max, step, fmt) {
  return `<label class="slider" for="${id}"><span>${label}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"><output id="${id}-o">${fmt(val)}</output></label>`;
}
export function bindSlider(root, id, fmt, onInput) {
  const el = root.querySelector("#" + id), out = root.querySelector("#" + id + "-o");
  el.addEventListener("input", () => { out.textContent = fmt(+el.value); onInput(+el.value, false); });
  el.addEventListener("change", () => onInput(+el.value, true));
}
export function fmtBeats(b) {
  if (!b) return "0";
  const s = Math.abs(b), w = Math.floor(s + 1e-6), f = +(s - w).toFixed(3);
  const fr = { 0.25: "¼", 0.5: "½", 0.75: "¾" }[f] ?? (f ? f.toFixed(2).slice(1) : "");
  return (b < 0 ? "−" : "+") + (w || (!fr ? "0" : "")) + fr;
}
export function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
export function fitCanvas(cv) {
  const r = cv.getBoundingClientRect(), dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w: r.width, h: r.height };
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (e2) { } ta.remove(); return ok;
  }
}
