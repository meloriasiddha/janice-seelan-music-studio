# Janice Seelan Music Studio (code name: Hum Studio) — notes for Claude

Installable web app (PWA) for Android. Hum a tune → notes → real sampled instruments → layered song → export.
No build step: plain HTML, CSS and ES modules. Hosted on GitHub Pages; pushing to `main` updates the app on the phone
(bump `VERSION` in `sw.js` on every release so phones pick up new files).

## Files
- `index.html` — screens (home, studio, transport), sheet/panel containers, SVG icon set.
- `styles.css` — all colours/fonts are tokens at the top. The owner plans to redesign; keep tokens.
- `js/app.js` — home, studio timeline, layer settings sheet, drum grid, instrument picker, tune helper, export & settings sheets.
- `js/panels.js` — full-screen tools: recorder, file import, piano roll, "instrument from a song clip".
- `js/engine.js` — Web Audio: sample loading, sampler voices, drums, mixer (volume/pan/reverb send, limiter), live `Transport` scheduler, `renderSong` offline render.
- `js/recorder.js` — mic capture via AudioWorklet (no echo cancel / noise suppression / AGC), timestamps for beat alignment, WAV encoder (16/24/32f).
- `js/pitch.js` — YIN pitch tracking, note segmentation, tuning correction, key detection, quantise/snap.
- `js/tunes.js` — tune helper (chords, bass, harmony, continue, new melody) + text format for swapping notes with Claude.
- `js/export.js` — WAV, MP3 (vendor/lame.min.js), stems zip, MIDI, `.humsong` backup.
- `js/store.js` — IndexedDB: projects, recordings (blobs), custom instruments, settings.
- `js/instruments.js` — instrument catalogue, drum kits, drum/tabla presets, scales & ragas.
- `samples/` — instrument samples, `samples/manifest.json` lists the notes for each instrument folder.

## Data model (project)
`{id, name, bpm, bars, loop, metronome, key:{root,scale}|null, masterVol, tracks:[...]}`
Track common: `{id, type, name, vol, pan, rev, mute, solo}`
- `notes`: `inst, oct, shift (beats), notes:[{p midi, s beat, d beats, v 0-1}], raw?` (raw = hummed notes in seconds, re-snapped when key/timing changes)
- `drums`: `kit ("kit"|"tabla"), steps, stepBeats, rows:{piece:[0-3 per step]}`
- `audio`: `blobId, start (beats), trimStart (s), trimDur (s)`
- `drone`: `root (0-11)` — tanpura sample is Sa=G, pitch-shifted.

## Text format for tunes (Claude ⇄ app)
`NOTE@BEAT LENGTH`, e.g. `C4@0 1, E4@1 0.5, G4@1.5 0.5`. Parsed by `textToNotes` in `js/tunes.js`.

## Adding a built-in instrument
1. Put samples in `samples/<id>/<midi>.ogg` (or .mp3); one every 2–4 semitones is enough.
2. Add `"<id>": {"notes":[...], "fmt":"ogg"}` to `samples/manifest.json`.
3. Add an entry in `INSTRUMENTS` (`js/instruments.js`) with name, group, sustain, default octave, GM program, colour.

## Sample credits
- Orchestra (violin, sections, harp, winds, brass, marimba): VSCO 2 Community Edition — CC0.
- Drum kit: SM Drums — public domain.
- Tabla bols and tanpura: Naad by Oormi Creations — MIT.
- Piano, e-piano, guitars, bass, sitar, shehnai, pan flute, choir, synths: MusyngKite soundfont (via gleitz/midi-js-soundfonts) — CC BY-SA 3.0.
- MP3 encoder: lamejs — LGPL.

## Testing
Serve locally (`python3 -m http.server`) and use Chrome with
`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=hum.wav` to test recording.
