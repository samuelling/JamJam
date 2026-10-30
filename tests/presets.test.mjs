// The song presets, no browser: enough of them, and every one builds a song that's sound. Every chord on the chart
// reads back, every note lies inside its section, no note overlaps itself, and each part names a real instrument patch.
//   node tests/presets.test.mjs
import { GENRES, presetSong, parseKey } from '../src/presets.js';
import { parseChord, songToMidi, readMidi } from '../src/song.js';
import { fileURLToPath } from 'node:url';
let fail = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fail++; };
const defs = {};
for (const i of ['juniper', 'monolith', 'machina', 'studio', 'poly', 'tine', 'tonewheel', 'hammerwork', 'analog']) defs[i] = (await import(fileURLToPath(new URL(`../instruments/${i}.js`, import.meta.url)))).default;

const names = GENRES.map((g) => g.name);
check(names.length >= 19, `${names.length} genres`);
for (const n of ['Rock', 'Pop', 'Jazz', 'Hip Hop']) check(names.includes(n), `${n} is there`);
check(GENRES.every((g) => g.songs.length === 5), 'five presets in each');
const titles = GENRES.flatMap((g) => g.songs.map((s) => s[0]));
check(new Set(titles).size === titles.length, `${titles.length} presets, every title its own`);
const problems = [];
GENRES.forEach((g, gi) => g.songs.forEach((p, si) => {
  const at = `${g.name}: ${p[0]}`;
  try {
    if (!parseKey(p[1])) problems.push(`${at}: key ${p[1]}`);
    for (const L of p[3]) if (!p[4][L]) problems.push(`${at}: no section ${L}`);
    for (const L of Object.keys(p[4])) if (!p[3].includes(L)) problems.push(`${at}: ${L} is never played`);
    const song = presetSong(gi, si);
    for (const id of new Set(song.order)) {
      const s = song.sections[id], beats = s.bars * 4;
      if (s.chords.length !== s.bars) problems.push(`${at}: ${s.name} chart`);
      for (const c of s.chords) if (!parseChord(c)) problems.push(`${at}: chord ${c}`);
      if (Object.keys(s.parts).length !== 3) problems.push(`${at}: ${s.name} parts`);
      for (const q of Object.values(s.parts)) {
        const d = defs[q.inst];
        if (!d || !d.presets[q.patch]) problems.push(`${at}: ${q.inst}/${q.patch}`);
        if (!!d?.drums !== q.drums) problems.push(`${at}: ${q.name} drum flag`);
        const ev = q.takes[0].events, on = new Set();
        if (!ev.some((e) => e.type === 'on')) problems.push(`${at}: ${s.name} ${q.name} is empty`);
        for (const e of ev) {
          if (!(e.b >= 0 && e.b < beats) || !Number.isFinite(e.b)) problems.push(`${at}: ${q.name} beat ${e.b} of ${beats}`);
          if (e.note < 0 || e.note > 127 || !Number.isInteger(e.note)) problems.push(`${at}: note ${e.note}`);
          if (e.type === 'on') { if (on.has(e.note)) problems.push(`${at}: ${s.name} ${q.name} ${e.note} overlaps at ${e.b}`); on.add(e.note); if (!(e.vel >= 1 && e.vel <= 127)) problems.push(`${at}: vel ${e.vel}`); } else on.delete(e.note);
        }
        if (on.size) problems.push(`${at}: ${q.name} left notes on`);
      }
    }
    readMidi(songToMidi(song));
  } catch (e) { problems.push(`${at}: ${e.message}`); }
}));
check(!problems.length, `every preset builds clean (${problems.length} problems)`);
for (const x of [...new Set(problems)].slice(0, 30)) console.log('  ' + x);
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);
