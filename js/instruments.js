// Instrument catalogue. Each sampled instrument points at a folder in /samples.
// To add a new built-in instrument: put samples in samples/<dir>/<midi>.<fmt>,
// add the note list to samples/manifest.json, and add an entry below.

export const GROUPS = [
  { id: "orchestra", name: "Orchestra" },
  { id: "guitars", name: "Guitars & bass" },
  { id: "indian", name: "Indian" },
  { id: "keys", name: "Keys & mallets" },
  { id: "voice", name: "Voices & synths" },
  { id: "custom", name: "My instruments" },
];

// sustain: notes hold for their length (strings, winds). false: one-shot (plucked, struck).
// oct: default octave move from a hummed voice. gm: General MIDI program for MIDI export.
export const INSTRUMENTS = {
  symphony:    { name: "Symphony strings", group: "orchestra", sustain: true, oct: 1, gm: 48, color: "#E07A3F",
                 parts: [ { id: "violins", t: 0, g: 1 }, { id: "violas", t: 0, g: 0.65 }, { id: "cellos", t: -12, g: 0.8 }, { id: "contrabass", t: -24, g: 0.55 } ] },
  violin:      { name: "Solo violin", group: "orchestra", sustain: true, oct: 1, gm: 40, color: "#D2603A" },
  violins:     { name: "Violin section", group: "orchestra", sustain: true, oct: 1, gm: 48, color: "#C9502F" },
  violas:      { name: "Viola section", group: "orchestra", sustain: true, oct: 0, gm: 41, color: "#B5577A" },
  cellos:      { name: "Cello section", group: "orchestra", sustain: true, oct: 0, gm: 42, color: "#9C4E8E" },
  contrabass:  { name: "Double bass", group: "orchestra", sustain: true, oct: -1, gm: 43, color: "#7E4C9E" },
  pizz:        { name: "Pizzicato strings", group: "orchestra", sustain: false, oct: 1, gm: 45, color: "#D98B3A" },
  harp:        { name: "Harp", group: "orchestra", sustain: false, oct: 1, gm: 46, color: "#C59B2E" },
  flute:       { name: "Flute", group: "orchestra", sustain: true, oct: 1, gm: 73, color: "#1E9E83" },
  clarinet:    { name: "Clarinet", group: "orchestra", sustain: true, oct: 0, gm: 71, color: "#2F8C9E" },
  horn:        { name: "French horn", group: "orchestra", sustain: true, oct: 0, gm: 60, color: "#B07A1E" },
  trumpet:     { name: "Trumpet", group: "orchestra", sustain: true, oct: 1, gm: 56, color: "#C88A16" },

  guitar_nylon:{ name: "Nylon guitar", group: "guitars", sustain: false, oct: 0, gm: 24, color: "#A9762F" },
  guitar_steel:{ name: "Steel guitar", group: "guitars", sustain: false, oct: 0, gm: 25, color: "#8F6A2A" },
  guitar_clean:{ name: "Clean electric", group: "guitars", sustain: false, oct: 0, gm: 27, color: "#4C6FD8" },
  guitar_dist: { name: "Distortion guitar", group: "guitars", sustain: true, oct: 0, gm: 30, color: "#C2384B" },
  bass:        { name: "Bass guitar", group: "guitars", sustain: false, oct: -1, gm: 33, color: "#6A55C9" },

  sitar:       { name: "Sitar", group: "indian", sustain: false, oct: 0, gm: 104, color: "#C46A1C" },
  shehnai:     { name: "Shehnai", group: "indian", sustain: true, oct: 1, gm: 111, color: "#9A8A12" },
  panflute:    { name: "Bansuri-style flute", group: "indian", sustain: true, oct: 1, gm: 75, color: "#2BA58C" },

  piano:       { name: "Grand piano", group: "keys", sustain: false, oct: 0, gm: 0, color: "#3E63F0" },
  epiano:      { name: "Electric piano", group: "keys", sustain: false, oct: 0, gm: 4, color: "#5B7CF5" },
  marimba:     { name: "Marimba", group: "keys", sustain: false, oct: 1, gm: 12, color: "#1F8CC6" },

  choir:       { name: "Choir aahs", group: "voice", sustain: true, oct: 0, gm: 52, color: "#8C6BD1" },
  synth:       { name: "Synth lead", group: "voice", sustain: true, oct: 0, gm: 81, color: "#D4A00F" },
  pad:         { name: "Warm pad", group: "voice", sustain: true, oct: 0, gm: 89, color: "#7A86B8" },
};

// Drum kits: rows shown in the beat grid, top to bottom.
export const KITS = {
  kit: {
    name: "Drum kit",
    rows: [
      ["crash", "Crash"], ["ride", "Ride"], ["hatopen", "Open hat"], ["hat", "Hi-hat"],
      ["tomhi", "Tom high"], ["tommid", "Tom mid"], ["tomlo", "Tom low"],
      ["snare", "Snare"], ["sidestick", "Side stick"], ["kick", "Kick"],
    ],
    gmNote: { kick: 36, snare: 38, sidestick: 37, rim: 40, hat: 42, hatfoot: 44, hatopen: 46, crash: 49, ride: 51, ridebell: 53, tomhi: 50, tommid: 47, tomlo: 43 },
  },
  tabla: {
    name: "Tabla",
    rows: [
      ["na", "Na"], ["tin", "Tin"], ["ta", "Ta"], ["ti", "Ti"], ["tun", "Tun"],
      ["dha", "Dha"], ["dhin", "Dhin"], ["dhit", "Dhit"], ["dhun", "Dhun"],
      ["ge", "Ge"], ["ga", "Ga"], ["ke", "Ke"],
    ],
    // No tabla in General MIDI; mapped to hand drums so the rhythm survives export.
    gmNote: { na: 63, tin: 62, ta: 64, ti: 65, tun: 60, dha: 61, dhin: 61, dhit: 66, dhun: 60, ge: 64, ga: 64, ke: 68 },
  },
};

export const DRUM_PRESETS = {
  kit: {
    rock:   { name: "Rock", steps: 16, stepBeats: 0.25, rows: { kick: "3.......3.3.....", snare: "....3.......3...", hat: "2.2.2.2.2.2.2.2." } },
    pop:    { name: "Pop", steps: 16, stepBeats: 0.25, rows: { kick: "3......2..3.....", snare: "....3.......3...", hat: "2.1.2.1.2.1.2.1." } },
    four:   { name: "Four on the floor", steps: 16, stepBeats: 0.25, rows: { kick: "3...3...3...3...", snare: "....3.......3...", hatopen: "..2...2...2...2." } },
    ballad: { name: "Ballad", steps: 16, stepBeats: 0.25, rows: { kick: "3.........2.....", sidestick: "....2.......2...", ride: "2...2...2...2..." } },
    half:   { name: "Half-time", steps: 16, stepBeats: 0.25, rows: { kick: "3.........3.....", snare: "........3.......", hat: "2.2.2.2.2.2.2.2." } },
    kuthu:  { name: "Folk / kuthu", steps: 16, stepBeats: 0.25, rows: { kick: "3..2..3...3..2..", snare: "...3.....3....3.", hat: "2.22.22.2.22.22." } },
  },
  tabla: {
    teentaal: { name: "Teentaal (16)", steps: 16, stepBeats: 0.5,
      bols: "dha dhin dhin dha dha dhin dhin dha dha tin tin ta ta dhin dhin dha" },
    keherwa:  { name: "Keherwa (8)", steps: 8, stepBeats: 0.5, bols: "dha ge na ti na ke dhin na" },
    dadra:    { name: "Dadra (6)", steps: 6, stepBeats: 0.5, bols: "dha dhin na dha tin na" },
    rupak:    { name: "Rupak (7)", steps: 7, stepBeats: 0.5, bols: "tin tin na dhin na dhin na" },
    jhaptaal: { name: "Jhaptaal (10)", steps: 10, stepBeats: 0.5, bols: "dhin na dhin dhin na tin na dhin dhin na" },
  },
};

export function presetRows(kitId, presetId) {
  const p = DRUM_PRESETS[kitId][presetId];
  const rows = {};
  for (const [id] of KITS[kitId].rows) rows[id] = new Array(p.steps).fill(0);
  if (p.rows) {
    for (const [id, s] of Object.entries(p.rows)) rows[id] = s.split("").map(c => (c === "." ? 0 : +c));
  } else if (p.bols) {
    p.bols.split(" ").forEach((b, i) => { if (rows[b]) rows[b][i] = i === 0 ? 3 : 2; });
  }
  return { steps: p.steps, stepBeats: p.stepBeats, rows };
}

// Scales used for key snapping and the tune helper. Carnatic / Hindustani names included.
export const SCALES = {
  major:        { name: "Major (Shankarabharanam)", iv: [0, 2, 4, 5, 7, 9, 11] },
  minor:        { name: "Minor (Natabhairavi)", iv: [0, 2, 3, 5, 7, 8, 10] },
  mohanam:      { name: "Mohanam / Bhupali", iv: [0, 2, 4, 7, 9] },
  hindolam:     { name: "Hindolam / Malkauns", iv: [0, 3, 5, 8, 10] },
  kalyani:      { name: "Kalyani / Yaman", iv: [0, 2, 4, 6, 7, 9, 11] },
  kharaharapriya:{ name: "Kharaharapriya / Kafi", iv: [0, 2, 3, 5, 7, 9, 10] },
  mayamalavagowla:{ name: "Mayamalavagowla / Bhairav", iv: [0, 1, 4, 5, 7, 8, 11] },
  harikambhoji: { name: "Harikambhoji / Khamaj", iv: [0, 2, 4, 5, 7, 9, 10] },
  shivaranjani: { name: "Shivaranjani", iv: [0, 2, 3, 7, 9] },
};

export const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
export const noteName = p => NOTE_NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
export function parseNote(s) {
  const m = /^([A-Ga-g])([#b♯♭]?)(-?\d)$/.exec(s.trim());
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
  const acc = m[2] === "#" || m[2] === "♯" ? 1 : m[2] === "b" || m[2] === "♭" ? -1 : 0;
  return 12 * (+m[3] + 1) + base + acc;
}
