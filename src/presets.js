// Song presets: a form, chord changes and a basic band (drums, bass, chords) to start from, by genre. Each is a line
// of data, and the notes are generated when someone picks it, as an ordinary megajam.song/1 song the room shares.
//
// A preset: [title, key, bpm, form, sections]. The form spells the song a letter per section, and a section that comes
// back is the same section. A section: letter: [bars, changes]. Changes are Roman numerals from the key's tonic,
// counted from the major scale ("bVI" in A minor is F), upper case major and lower case minor. Each is a bar, ":2"
// holds it for two, "ii7,V7" splits a bar, and the list repeats until the section is full.
//
// A groove is sixteen steps a bar. Drums: k kick, s snare, c clap, x cross-stick, h hat, o open hat, p pedal hat,
// R ride. Bass: 1 3 5 6 8 notes of the chord, b its seventh, or 'walk'. Chords: x plays, - holds, . rests.
import { NOTE_NAMES, newSection, emptySong } from './song.js';

const NAMES = { I: 'Intro', V: 'Verse', P: 'Pre-chorus', C: 'Chorus', B: 'Bridge', S: 'Solo', K: 'Breakdown', D: 'Drop', O: 'Outro', A: 'A section', H: 'Head', T: 'Theme' };
const VOICE = { k: 36, s: 38, c: 39, x: 37, h: 42, o: 46, p: 44, R: 51, C: 49 };
const GAIN = { k: 84, s: 80, c: 78, x: 76, h: 56, o: 60, p: 52, R: 66, C: 76 };
const KIT_TRIM = { analog: 0.6, machina: 0.6 };   // these run hotter than the recorded kit
const TONES = { '': [0, 4, 7], m: [0, 3, 7], 5: [0, 7, 12], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], 9: [0, 4, 10, 14], m9: [0, 3, 10, 14], sus4: [0, 5, 7], '7sus4': [0, 5, 7, 10], dim: [0, 3, 6], dim7: [0, 3, 6, 9], m7b5: [0, 3, 6, 10], '7#9': [0, 4, 10, 15] };
const DEGREE = { i: 0, ii: 2, iii: 4, iv: 5, v: 7, vi: 9, vii: 11 };
const LOWER = { '': 'm', 5: 'm', 6: 'm6', 7: 'm7', 9: 'm9', ø: 'm7b5', '°': 'dim', '°7': 'dim7' };

export function parseKey(s) {
  const m = String(s).match(/^([A-G])([#b]?)(m|dor|mix)?$/); if (!m) return null;
  const root = ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  return { root, mode: { m: 'minor', dor: 'dorian', mix: 'mixolydian' }[m[3]] || 'major' };
}
// a Roman numeral in a key: its name on the chart, its root and its notes
export function chordOf(tok, key) {
  const m = tok.match(/^([b#]?)(VII|III|VI|IV|II|V|I|vii|iii|vi|iv|ii|v|i)(.*)$/); if (!m) return null;
  const lower = m[2] === m[2].toLowerCase(), q = lower ? LOWER[m[3]] : m[3];
  if (q === undefined || !TONES[q]) return null;
  const root = (key.root + DEGREE[m[2].toLowerCase()] + (m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0) + 12) % 12;
  return { name: NOTE_NAMES[root] + q, root, q, tones: TONES[q] };
}
// the section's changes, a list of bars, each a list of tokens
function barsOf(prog, bars) {
  const list = prog.trim().split(/\s+/).flatMap((t) => { const [c, n] = t.split(':'); return Array.from({ length: +n || 1 }, () => c.split(',')); });
  return Array.from({ length: bars }, (_, i) => list[i % list.length]);
}
const hit = (ev, b, n, len, vel) => { ev.push({ b, type: 'on', note: n, vel }, { b: b + len, type: 'off', note: n }); };
const swung = (g, i) => (i % 4 === 2 ? g.swing8 || 0 : 0) + (i % 2 ? g.swing16 || 0 : 0);

function drums(g, L, bars, last) {
  const ev = [], rest = L === 'K', soft = L === 'I', big = L === 'C' || L === 'D' || L === 'S';
  for (let bar = 0; bar < bars; bar++) {
    const at = bar * 4, fin = bar === bars - 1, grid = {};
    for (const [v, p] of Object.entries(g.d)) if (!(soft && 'sc'.includes(v)) && !(rest && !'hpR'.includes(v))) grid[v] = p.split('').map((c) => c === 'x');
    if (last && fin) { hit(ev, at, VOICE.k, 0.2, Math.round(GAIN.k * (KIT_TRIM[g.kit[0]] || 1))); hit(ev, at, VOICE.C, 0.2, Math.round(GAIN.C * (KIT_TRIM[g.kit[0]] || 1))); break; }
    if (big && bar === 0) hit(ev, at, VOICE.C, 0.2, Math.round(GAIN.C * (KIT_TRIM[g.kit[0]] || 1)));
    // the turn into what's next: a run on the snare over the last beat
    if (fin && bars >= 4 && !rest && !soft) { const v = grid.s ? 's' : grid.c ? 'c' : 'x'; grid[v] = grid[v] || Array(16).fill(false); for (const i of [12, 13, 14, 15]) grid[v][i] = true; }
    for (const [v, on] of Object.entries(grid)) on.forEach((yes, i) => {
      if (yes) hit(ev, at + i * 0.25 + swung(g, i), VOICE[v], 0.07, Math.round(Math.max(30, GAIN[v] + (i % 4 ? (i % 2 ? -18 : -8) : 6) + (fin && i > 11 ? i - 12 : 0) * 4) * (KIT_TRIM[g.kit[0]] || 1)));
    });
  }
  return ev;
}
// the chord in force at a step of a bar that may split
const chordAt = (bar, i) => bar[Math.min(bar.length - 1, Math.floor((i / 16) * bar.length))];
const degreeOf = (c, ch) => (ch === '1' ? 0 : ch === '8' ? 12 : ch === '3' ? c.tones.find((t) => t === 3 || t === 4 || t === 5) ?? 4 : ch === '5' ? c.tones.find((t) => t === 6 || t === 7) ?? 7 : ch === '6' ? 9 : c.tones.find((t) => t === 10 || t === 11) ?? 10);
const bassNote = (g, root) => { const low = 28 + 12 * (g.bassUp ?? 1); return low + ((root - low) % 12 + 12) % 12; };

function bass(g, L, bars, key, last) {
  const ev = [];
  bars.forEach((tokens, n) => {
    const at = n * 4, cs = tokens.map((t) => chordOf(t, key)), fin = last && n === bars.length - 1;
    if (fin || L === 'K') { hit(ev, at, bassNote(g, cs[0].root), 3.9, 92); return; }
    if (g.b === 'walk') {
      const next = chordOf(bars[(n + 1) % bars.length][0], key).root;
      for (let q = 0; q < 4; q++) {
        const c = cs[Math.min(cs.length - 1, Math.floor((q / 4) * cs.length))], lo = bassNote(g, c.root), step = cs.length > 1 ? q % 2 : q;
        const nt = cs.length > 1 ? (step ? lo + degreeOf(c, '5') : lo) : step === 3 ? bassNote(g, next) + (next % 2 ? 1 : -1) : lo + degreeOf(c, ['1', '3', '5'][step]);
        hit(ev, at + q, nt, 0.92, 88 - (q % 2) * 8);
      }
      return;
    }
    const steps = [...g.b].map((ch, i) => [ch, i]).filter(([ch]) => ch !== '.');
    steps.forEach(([ch, i], k) => {
      const end = k + 1 < steps.length ? steps[k + 1][1] : 16, c = cs[Math.min(cs.length - 1, Math.floor((i / 16) * cs.length))];
      hit(ev, at + i * 0.25 + swung(g, i), bassNote(g, c.root) + degreeOf(c, ch), Math.min(g.bassLen || 4, (end - i) * 0.25 - 0.04 - swung(g, i)), i % 4 ? 84 : 96);
    });
  });
  return ev;
}
// the chord's notes in the middle of the keys, moving as little as they can from the last ones
function voice(c, prev, lo, hi) {
  let best = null, cost = 1e9;
  for (let base = lo - 12; base <= hi; base++) {
    if ((base % 12 + 12) % 12 !== c.root) continue;
    const v = c.tones.map((t) => base + t);
    if (v[0] < lo - 8 || v[v.length - 1] > hi) continue;
    const d = prev ? v.reduce((a, n, i) => a + Math.abs(n - prev[Math.min(i, prev.length - 1)]), 0) : Math.abs(v[0] - (lo + hi) / 2);
    if (d < cost) { best = v; cost = d; }
  }
  return best;
}
function comp(g, L, bars, key, last) {
  const ev = [], [lo, hi] = g.range || [55, 79]; let prev = null;
  bars.forEach((tokens, n) => {
    const at = n * 4, cs = tokens.map((t) => chordOf(t, key)), edges = cs.map((_, k) => (k * 16) / cs.length);
    if ((last && n === bars.length - 1) || L === 'K') { const v = voice(cs[0], prev, lo, hi); prev = v; for (const p of v) hit(ev, at, p, 3.9, 62); return; }
    const pat = [...g.c];
    for (let i = 0; i < 16; i++) {
      const held = pat[i] === '-' && edges.includes(i);   // a held chord changes with the change
      if (pat[i] !== 'x' && !held) continue;
      let end = i + 1; while (end < 16 && pat[end] === '-' && !edges.includes(end)) end++;
      const c = cs[Math.min(cs.length - 1, Math.floor((i / 16) * cs.length))], v = voice(c, prev, lo, hi); prev = v;
      for (const p of v) hit(ev, at + i * 0.25 + swung(g, i), p, (end - i) * 0.25 - 0.04 - swung(g, i), g.vel || 72);
    }
  });
  return ev;
}

// the mastering style each genre starts on (see console.js)
const STYLE_OF = { Jazz: 'jazz', 'Bossa Nova': 'jazz', Folk: 'acoustic', House: 'club', Techno: 'club', 'Drum & Bass': 'club', Trap: 'club', Disco: 'electronic', 'Hip Hop': 'electronic' };

export const GENRES = [
  { name: 'Rock', swing8: 0, d: { k: 'x.....x.x.......', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' }, b: '1.1.1.1.1.1.1.1.', c: 'x-----x-x-----x-', kit: ['studio', 'tight'], low: ['monolith', 'bass'], keys: ['tonewheel', 'rock'], songs: [
    ['Arena Anthem', 'A', 126, 'IVCVCBCO', { I: [4, 'I V vi IV'], V: [8, 'I V vi IV'], C: [8, 'IV I V vi'], B: [8, 'vi IV I V'], O: [4, 'I'] }],
    ['Three Chord Drive', 'E', 138, 'IVCVCSCO', { I: [4, 'I IV'], V: [8, 'I IV I V'], C: [8, 'IV V I I'], S: [8, 'I IV V IV'], O: [2, 'I'] }],
    ['Minor Riff Stomp', 'Em', 112, 'IVPCVPCBCO', { I: [4, 'i bVII'], V: [8, 'i bVII i bVI'], P: [4, 'bVI bVII'], C: [8, 'i bVI bIII bVII'], B: [8, 'iv i iv V'], O: [4, 'i'] }],
    ['Open Road AABA', 'G', 118, 'AABAO', { A: [8, 'I bVII IV I'], B: [8, 'IV I IV V'], O: [4, 'I'] }],
    ['Slow Burn Ballad', 'D', 76, 'IVCVCSCO', { I: [4, 'I IV'], V: [8, 'I V vi iii'], C: [8, 'IV V iii vi'], S: [8, 'vi IV I V'], O: [4, 'I'] }],
  ] },
  { name: 'Pop', d: { k: 'x.......x.x.....', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' }, b: '1.....1...1.....', c: 'x---x---x---x---', kit: ['studio', 'tight'], low: ['monolith', 'bass'], keys: ['hammerwork', 'bright'], songs: [
    ['Four Chord Hit', 'C', 120, 'IVPCVPCBCO', { I: [4, 'I V vi IV'], V: [8, 'I V vi IV'], P: [4, 'IV V'], C: [8, 'I V vi IV'], B: [8, 'vi V IV V'], O: [4, 'I'] }],
    ['Sensitive Turnaround', 'G', 100, 'IVCVCBCO', { I: [4, 'vi IV I V'], V: [8, 'vi IV I V'], C: [8, 'I V vi IV'], B: [4, 'ii IV'], O: [4, 'I'] }],
    ['Fifties Sway', 'A', 92, 'VCVCBCO', { V: [8, 'I vi IV V'], C: [8, 'IV V I vi'], B: [8, 'iii vi ii V'], O: [4, 'I'] }],
    ['Dance Floor Lift', 'Bm', 124, 'IVCDVCDO', { I: [4, 'i bVI bIII bVII'], V: [8, 'i bVI bIII bVII'], C: [8, 'bVI bVII i i'], D: [8, 'i bVI bIII bVII'], O: [4, 'i'] }],
    ['Piano Ballad', 'Eb', 72, 'IVCVCBCO', { I: [4, 'I IV'], V: [8, 'I iii IV V'], C: [8, 'vi IV I V'], B: [8, 'ii V iii vi'], O: [4, 'I'] }],
  ] },
  { name: 'Jazz', swing8: 0.16, d: { R: 'x...x.x.x...x.x.', p: '....x.......x...' }, b: 'walk', c: 'x-----x-........', kit: ['studio', 'dark'], low: ['monolith', 'bass'], keys: ['hammerwork', 'mellow'], vel: 64, songs: [
    ['Thirty-Two Bar Standard', 'F', 132, 'AABASO', { A: [8, 'Imaj7 vi7 ii7 V7 iii7 VI7 ii7 V7'], B: [8, 'ii7 V7 Imaj7 Imaj7 #iv° IV6 II7 V7'], S: [8, 'Imaj7 vi7 ii7 V7'], O: [4, 'ii7 V7 Imaj7 Imaj7'] }],
    ['Bebop Changes', 'Bb', 176, 'AABAS', { A: [8, 'Imaj7,vi7 ii7,V7 iii7,VI7 ii7,V7 I7 IV7 iii7,VI7 ii7,V7'], B: [8, 'III7:2 VI7:2 II7:2 V7:2'], S: [8, 'Imaj7,vi7 ii7,V7'] }],
    ['Twelve Bar Jazz Blues', 'Bb', 144, 'HSH', { H: [12, 'I7 IV7 I7 v7,I7 IV7 #iv° I7 VI7 ii7 V7 I7,VI7 ii7,V7'], S: [12, 'I7 IV7 I7 v7,I7 IV7 #iv° I7 VI7 ii7 V7 I7,VI7 ii7,V7'] }],
    ['Modal Vamp', 'Ddor', 150, 'AABAS', { A: [8, 'i7:8'], B: [8, 'bII7:8'], S: [16, 'i7:8 bII7:8'] }],
    ['Minor Ballad', 'Cm', 66, 'AABAO', { A: [8, 'i7 ii°7 iiø V7 i7 iv7 iiø V7'], B: [8, 'bIIImaj7 bVImaj7 iiø V7'], O: [4, 'iiø V7 i6 i6'] }],
  ] },
  { name: 'Hip Hop', swing16: 0.05, d: { k: 'x.....x...x.....', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' }, b: '1.....1...1.....', c: 'x-------........', kit: ['analog', 'boom'], low: ['monolith', 'bass'], keys: ['tine', 'wurly'], songs: [
    ['Boom Bap Cypher', 'Dm', 90, 'IVCVCO', { I: [4, 'i bVI'], V: [16, 'i bVI'], C: [8, 'iv i bVII i'], O: [4, 'i'] }],
    ['Soul Sample Loop', 'Am', 86, 'IVCVCBCO', { I: [4, 'i7 iv7'], V: [16, 'i7 iv7 bVII bIIImaj7'], C: [8, 'bVImaj7 V7 i7 i7'], B: [8, 'iv7 i7 bVImaj7 V7'], O: [4, 'i7'] }],
    ['Jazzy Head Nod', 'Eb', 92, 'VCVCO', { V: [16, 'ii7 V7 Imaj7 vi7'], C: [8, 'IVmaj7 iii7 ii7 V7'], O: [4, 'Imaj7'] }],
    ['West Coast Roller', 'Gm', 96, 'IVCVCO', { I: [4, 'i7'], V: [16, 'i7 IV9'], C: [8, 'bIII bVII i i'], O: [4, 'i7'] }],
    ['Dark Two Chord', 'Fm', 82, 'IVKVCO', { I: [4, 'i bII'], V: [16, 'i bII'], K: [4, 'i'], C: [8, 'bVI V i i'], O: [4, 'i'] }],
  ] },
  { name: 'Blues', swing8: 0.16, d: { k: 'x.......x.......', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' }, b: '1.3.5.6.b.6.5.3.', c: '..x-..x-..x-..x-', kit: ['studio', 'sticks'], low: ['monolith', 'bass'], keys: ['tonewheel', 'rock'], songs: [
    ['Twelve Bar Shuffle', 'A', 112, 'HSSH', { H: [12, 'I7:4 IV7:2 I7:2 V7 IV7 I7 V7'], S: [12, 'I7:4 IV7:2 I7:2 V7 IV7 I7 V7'] }],
    ['Quick Change', 'E', 124, 'HSH', { H: [12, 'I7 IV7 I7:2 IV7:2 I7:2 V7 IV7 I7 V7'], S: [12, 'I7 IV7 I7:2 IV7:2 I7:2 V7 IV7 I7 V7'] }],
    ['Minor Slow Blues', 'Cm', 64, 'HSH', { H: [12, 'i7:4 iv7:2 i7:2 bVI7 V7 i7 V7'], S: [12, 'i7:4 iv7:2 i7:2 bVI7 V7 i7 V7'] }],
    ['Eight Bar Blues', 'G', 96, 'HSHO', { H: [8, 'I7 V7 IV7 IV7 I7 V7 I7 V7'], S: [8, 'I7 V7 IV7 IV7 I7 V7 I7 V7'], O: [2, 'I7'] }],
    ['Sixteen Bar Stomp', 'D', 132, 'HSH', { H: [16, 'I7:8 IV7:4 V7 IV7 I7 V7'], S: [16, 'I7:8 IV7:4 V7 IV7 I7 V7'] }],
  ] },
  { name: 'Country', d: { k: 'x.......x.......', x: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' }, b: '1.......5.......', c: 'x-..x-..x-..x-..', kit: ['studio', 'sticks'], low: ['monolith', 'bass'], keys: ['hammerwork', 'honky'], songs: [
    ['Backroad Two-Step', 'G', 118, 'IVCVCSCO', { I: [4, 'I V'], V: [8, 'I IV I V'], C: [8, 'IV I V I'], S: [8, 'I IV V I'], O: [2, 'I'] }],
    ['Honky Tonk Train', 'A', 140, 'VCVCSCO', { V: [8, 'I:4 V:2 I:2'], C: [8, 'IV:2 I:2 V:2 I:2'], S: [8, 'I:2 IV:2 V:2 I:2'], O: [2, 'I'] }],
    ['Porch Light Sway', 'D', 88, 'VCVCBCO', { V: [8, 'I iii IV I'], C: [8, 'IV I V vi'], B: [8, 'vi IV I V'], O: [4, 'I'] }],
    ['Radio Country', 'E', 104, 'IVPCVPCBCO', { I: [4, 'I V vi IV'], V: [8, 'I V vi IV'], P: [4, 'IV V'], C: [8, 'IV I V vi'], B: [4, 'ii IV V V'], O: [4, 'I'] }],
    ['Sad Steel Ballad', 'C', 72, 'AABAO', { A: [8, 'I I7 IV iv I V7 I I'], B: [8, 'IV I II7 V7'], O: [4, 'I'] }],
  ] },
  { name: 'Folk', d: { k: 'x.......x.......', x: '....x.......x...', p: 'x.x.x.x.x.x.x.x.' }, b: '1.......5.......', c: 'x-x-x-x-x-x-x-x-', kit: ['studio', 'dark'], low: ['monolith', 'soft'], bassUp: 2, keys: ['poly', 'pluck'], vel: 62, songs: [
    ['Campfire Strum', 'G', 104, 'VCVCVCO', { V: [8, 'I IV I V'], C: [8, 'IV I V I'], O: [2, 'I'] }],
    ['Old Road Ballad', 'D', 84, 'VVCVCO', { V: [8, 'I V vi IV'], C: [4, 'IV I V I'], O: [2, 'I'] }],
    ['Modal Reel', 'Ador', 132, 'AABBAO', { A: [8, 'i bVII i V'], B: [8, 'bIII bVII i i'], O: [2, 'i'] }],
    ['Stomp and Holler', 'C', 116, 'IVCVCKCO', { I: [4, 'I'], V: [8, 'I IV'], C: [8, 'vi IV I V'], K: [4, 'vi'], O: [2, 'I'] }],
    ['Minor Verse Song', 'Em', 92, 'VVCVCO', { V: [8, 'i bVII bVI V'], C: [8, 'bIII bVII i i'], O: [4, 'i'] }],
  ] },
  { name: 'R&B', swing16: 0.04, d: { k: 'x.....x..x......', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' }, b: '1.....1.......5.', c: 'x-------x-------', kit: ['analog', 'vintage'], low: ['monolith', 'bass'], keys: ['tine', 'keys'], songs: [
    ['Neo Soul Glide', 'Eb', 78, 'IVCVCBCO', { I: [4, 'ii7 V7 Imaj7 vi7'], V: [8, 'ii7 V7 Imaj7 vi7'], C: [8, 'IVmaj7 iii7 ii7 V7'], B: [8, 'bVImaj7 bVII7 Imaj7 Imaj7'], O: [4, 'Imaj7'] }],
    ['Slow Jam', 'Ab', 66, 'VPCVPCBCO', { V: [8, 'Imaj7 iii7 IVmaj7 V7'], P: [4, 'ii7 V7'], C: [8, 'IVmaj7 V7 iii7 vi7'], B: [8, 'ii7 V7 Imaj7 vi7'], O: [4, 'Imaj7'] }],
    ['Nineties Groove', 'Fm', 92, 'IVCVCBCO', { I: [4, 'i7 iv7'], V: [8, 'i7 iv7 bVIImaj7 bIIImaj7'], C: [8, 'bVImaj7 bVII7 i7 i7'], B: [8, 'iv7 bVII7 bIIImaj7 V7'], O: [4, 'i7'] }],
    ['Motown Bounce', 'C', 112, 'VCVCBCO', { V: [8, 'I vi ii V'], C: [8, 'IV V I vi'], B: [8, 'iii vi ii V'], O: [4, 'I'] }],
    ['Late Night Vamp', 'Bbm', 84, 'IVCVCO', { I: [4, 'i9 IV9'], V: [8, 'i9 IV9'], C: [8, 'bVImaj7 bVII7 i9 i9'], O: [4, 'i9'] }],
  ] },
  { name: 'Funk', d: { k: 'x..x..x...x.....', s: '....x..x.x..x...', h: 'x.x.x.x.x.x.x.x.' }, b: '1..1..8.1.b.5..8', bassLen: 0.22, c: '..x...x...x..x..', kit: ['studio', 'tight'], low: ['monolith', 'bass'], keys: ['tine', 'wurly'], songs: [
    ['One Chord Workout', 'E', 104, 'IAKAO', { I: [4, 'I9'], A: [16, 'I9'], K: [4, 'I9'], O: [2, 'I9'] }],
    ['Two Chord Pocket', 'Gdor', 108, 'AAKAO', { A: [8, 'i7 IV9'], K: [4, 'i7'], O: [2, 'i7'] }],
    ['Horn Line Vamp', 'Bb', 98, 'IVCVCSCO', { I: [4, 'I9'], V: [8, 'I9 IV9'], C: [8, 'iv7 bVII9 bIIImaj7 V7'], S: [8, 'I9 IV9'], O: [2, 'I9'] }],
    ['Clavinet Strut', 'Dm', 112, 'VCVCBCO', { V: [8, 'i7 IV7'], C: [8, 'bVI7 bVII7 i7 i7'], B: [4, 'iv7 V7'], O: [2, 'i7'] }],
    ['Bridge to Nowhere', 'F', 116, 'AABAK', { A: [8, 'I9 bVII9 IV9 I9'], B: [8, 'iii7 VI7 ii7 V7'], K: [4, 'I9'] }],
  ] },
  { name: 'Disco', d: { k: 'x...x...x...x...', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.', o: '..x...x...x...x.' }, b: '1.8.1.8.1.8.1.8.', c: 'x-----x---x-----', kit: ['studio', 'tight'], low: ['monolith', 'bass'], keys: ['juniper', 'strings'], songs: [
    ['Mirror Ball', 'Am', 120, 'IVCVCKCO', { I: [4, 'i iv'], V: [8, 'i iv bVII bIII'], C: [8, 'bVI bVII i i'], K: [8, 'i'], O: [4, 'i'] }],
    ['Strings and Octaves', 'F', 118, 'IVCVCBCO', { I: [4, 'I IV'], V: [8, 'I iii IV V'], C: [8, 'ii7 V7 Imaj7 vi7'], B: [8, 'IV V iii vi'], O: [4, 'I'] }],
    ['Four Chord Floor', 'Cm', 124, 'IVCDVCDO', { I: [4, 'i bVI bIII bVII'], V: [8, 'i bVI bIII bVII'], C: [8, 'bVI bVII i i'], D: [8, 'i bVII'], O: [4, 'i'] }],
    ['Roller Rink', 'D', 126, 'VCVCKCO', { V: [8, 'Imaj7 IVmaj7'], C: [8, 'ii7 iii7 IVmaj7 V7'], K: [8, 'Imaj7'], O: [4, 'Imaj7'] }],
    ['Sunset Boulevard Vamp', 'Em', 116, 'IVCVCO', { I: [4, 'i7 IV7'], V: [8, 'i7 IV7'], C: [8, 'bVImaj7 bVII7 i7 i7'], O: [4, 'i7'] }],
  ] },
  { name: 'House', d: { k: 'x...x...x...x...', c: '....x.......x...', h: 'x.x.x.x.x.x.x.x.', o: '..x...x...x...x.' }, b: '..1...1...1...1.', c: '...x-..x-...x-..', kit: ['machina', '909'], low: ['monolith', 'bass'], keys: ['juniper', 'keys'], songs: [
    ['Deep Garage', 'Fm', 122, 'IDKDO', { I: [8, 'i7 bVI7'], D: [16, 'i7 bVI7 bIIImaj7 bVII7'], K: [8, 'i7'], O: [8, 'i7'] }],
    ['Piano Stabs', 'Bb', 126, 'IDKDO', { I: [8, 'I V vi IV'], D: [16, 'I V vi IV'], K: [8, 'vi IV'], O: [8, 'I'] }],
    ['Minimal Groove', 'Am', 124, 'IDKDO', { I: [8, 'i7'], D: [16, 'i7:4 IV7:4'], K: [8, 'i7'], O: [8, 'i7'] }],
    ['Soulful Lift', 'Eb', 120, 'IVCDVCDO', { I: [8, 'ii7 V7 Imaj7 vi7'], V: [8, 'ii7 V7 Imaj7 vi7'], C: [8, 'IVmaj7 V7 iii7 vi7'], D: [8, 'Imaj7 vi7'], O: [8, 'Imaj7'] }],
    ['Warehouse Chords', 'Gm', 128, 'IDKDO', { I: [8, 'i bVII bVI bVII'], D: [16, 'i bVII bVI bVII'], K: [8, 'bVI'], O: [8, 'i'] }],
  ] },
  { name: 'Techno', d: { k: 'x...x...x...x...', c: '....x.......x...', h: '..x...x...x...x.' }, b: '1.1.1..1.1.1.1..', c: 'x---------------', kit: ['machina', 'hybrid'], low: ['poly', 'acid'], bassUp: 1, keys: ['juniper', 'pad'], vel: 56, songs: [
    ['Peak Hour', 'Am', 132, 'IDKDO', { I: [16, 'i'], D: [32, 'i:4 bVI:4'], K: [16, 'i'], O: [16, 'i'] }],
    ['Acid Line', 'Em', 130, 'IDKDO', { I: [8, 'i'], D: [16, 'i'], K: [8, 'bII'], O: [8, 'i'] }],
    ['Dub Pulse', 'Dm', 124, 'IDKDO', { I: [16, 'i7'], D: [32, 'i7:8 iv7:8'], K: [16, 'i7'], O: [16, 'i7'] }],
    ['Detroit Strings', 'Cm', 128, 'IDKDO', { I: [8, 'i7 bVImaj7'], D: [16, 'i7 bVImaj7 bIIImaj7 bVII7'], K: [8, 'bVImaj7'], O: [8, 'i7'] }],
    ['Industrial Drive', 'Fm', 138, 'IDKDO', { I: [8, 'i5'], D: [16, 'i5:3 bII5'], K: [8, 'i5'], O: [8, 'i5'] }],
  ] },
  { name: 'Drum & Bass', d: { k: 'x.........x.....', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' }, b: '1.........1.....', c: 'x---------------', kit: ['machina', 'hybrid'], low: ['monolith', 'bass'], keys: ['juniper', 'pad'], vel: 58, songs: [
    ['Liquid Roller', 'Dm', 174, 'IDKDO', { I: [16, 'i7 bVImaj7'], D: [32, 'i7 bVImaj7 bIIImaj7 bVII7'], K: [16, 'bVImaj7'], O: [16, 'i7'] }],
    ['Neuro Pressure', 'Fm', 172, 'IDKDO', { I: [16, 'i5'], D: [32, 'i5:3 bII5'], K: [8, 'i5'], O: [8, 'i5'] }],
    ['Jump Up', 'Gm', 176, 'IDKDO', { I: [8, 'i'], D: [16, 'i bVII'], K: [8, 'i'], O: [8, 'i'] }],
    ['Atmospheric', 'Am', 170, 'IDKDO', { I: [16, 'i9 IV9'], D: [32, 'i9 IV9 bVImaj7 bVII7'], K: [16, 'bVImaj7'], O: [16, 'i9'] }],
    ['Jungle Break', 'Ebm', 165, 'IDKDO', { I: [8, 'i7'], D: [16, 'i7 iv7'], K: [8, 'i7'], O: [8, 'i7'] }],
  ] },
  { name: 'Trap', d: { k: 'x.....x...x..x..', c: '........x.......', h: 'xxxxxxxxxxxxxxxx' }, b: '1.....1...1..1..', c: 'x-------x-------', kit: ['machina', '808'], low: ['monolith', 'bass'], keys: ['tine', 'bell'], vel: 62, songs: [
    ['Dark Bells', 'Cm', 140, 'IVCVCO', { I: [4, 'i bVI'], V: [16, 'i bVI'], C: [8, 'i bVI bIII bVII'], O: [4, 'i'] }],
    ['Phrygian Menace', 'Em', 136, 'IVCVCO', { I: [4, 'i bII'], V: [16, 'i bII'], C: [8, 'i bII iv V'], O: [4, 'i'] }],
    ['Melodic Trap', 'Am', 150, 'IVCVCBCO', { I: [4, 'bVI bVII i i'], V: [16, 'bVI bVII i i'], C: [8, 'i bVI bIII bVII'], B: [8, 'iv i'], O: [4, 'i'] }],
    ['Sad Keys', 'Gm', 144, 'IVCVCO', { I: [4, 'i7 bVImaj7'], V: [16, 'i7 bVImaj7 iv7 V7'], C: [8, 'bVImaj7 bVII i i'], O: [4, 'i7'] }],
    ['Two Note Banger', 'Fm', 130, 'IVKVCO', { I: [4, 'i'], V: [16, 'i i i bII'], K: [4, 'i'], C: [8, 'i bII'], O: [4, 'i'] }],
  ] },
  { name: 'Reggae', swing8: 0.06, d: { k: '........x.......', x: '........x.......', h: 'x.x.x.x.x.x.x.x.' }, b: '1...1.5...8.....', c: '....x-......x-..', kit: ['studio', 'dark'], low: ['monolith', 'bass'], keys: ['tonewheel', 'soul'], songs: [
    ['One Drop Roots', 'Am', 76, 'IVCVCO', { I: [4, 'i bVII'], V: [8, 'i bVII'], C: [8, 'iv i bVII i'], O: [4, 'i'] }],
    ['Sunshine Skank', 'G', 84, 'IVCVCBCO', { I: [4, 'I IV'], V: [8, 'I IV V IV'], C: [8, 'I V vi IV'], B: [8, 'ii V I I'], O: [4, 'I'] }],
    ['Dub Plate', 'Em', 72, 'AKAKO', { A: [8, 'i iv'], K: [8, 'i'], O: [4, 'i'] }],
    ['Lovers Rock', 'C', 80, 'VCVCBCO', { V: [8, 'I vi IV V'], C: [8, 'IV V I vi'], B: [4, 'ii V'], O: [4, 'I'] }],
    ['Rockers Steady', 'Dm', 88, 'IVCVCO', { I: [4, 'i bVI'], V: [8, 'i bVI bVII i'], C: [8, 'bIII bVII i i'], O: [4, 'i'] }],
  ] },
  { name: 'Bossa Nova', d: { k: 'x..x....x..x....', x: 'x..x..x...x..x..', h: 'x.x.x.x.x.x.x.x.' }, b: '1.....5.5.....1.', c: 'x--x--x---x--x--', kit: ['studio', 'sticks'], low: ['monolith', 'soft'], bassUp: 2, keys: ['tine', 'keys'], vel: 58, songs: [
    ['Beachfront AABA', 'F', 132, 'AABAO', { A: [8, 'Imaj7:2 ii7 V7 Imaj7 iii7 VI7 ii7,V7'], B: [8, 'IVmaj7:2 iv7 bVII7 iii7 VI7 ii7 V7'], O: [4, 'ii7 V7 Imaj7 Imaj7'] }],
    ['Quiet Corner', 'D', 124, 'AABAO', { A: [8, 'Imaj7 vi7 ii7 V7'], B: [8, 'IVmaj7 iv7 iii7 VI7'], O: [4, 'ii7 V7 Imaj7 Imaj7'] }],
    ['Minor Bossa', 'Am', 136, 'HSH', { H: [16, 'i7:2 iv7:2 iiø V7 i7:2 bVImaj7 V7 i7:2 iiø V7 i7 V7'], S: [16, 'i7:2 iv7:2 iiø V7 i7:2 bVImaj7 V7 i7:2 iiø V7 i7 V7'] }],
    ['Two Chord Samba', 'C', 140, 'AABA', { A: [8, 'Imaj7 II7 ii7 V7'], B: [8, 'iii7 VI7 ii7 V7'] }],
    ['Slow Sand', 'Eb', 112, 'VCVCO', { V: [8, 'Imaj7 bIImaj7'], C: [8, 'ii7 V7 iii7 VI7'], O: [4, 'Imaj7'] }],
  ] },
  { name: 'Salsa', d: { k: '...x...x...x...x', x: 'x..x..x.....x.x.', R: 'x...x...x...x...' }, b: '...1..5....1..5.', c: 'x.x.x..x.x.x.x..', kit: ['studio', 'tight'], low: ['monolith', 'bass'], keys: ['hammerwork', 'bright'], vel: 70, songs: [
    ['Montuno Two Chord', 'Am', 180, 'IVCSCO', { I: [4, 'i V7'], V: [16, 'i V7'], C: [8, 'i iv V7 i'], S: [16, 'i V7'], O: [4, 'i'] }],
    ['Son Vamp', 'C', 176, 'IVCSCO', { I: [4, 'I IV V IV'], V: [8, 'I IV V IV'], C: [8, 'I IV V IV'], S: [16, 'I IV V IV'], O: [2, 'I'] }],
    ['Minor Descarga', 'Dm', 190, 'ASKSAO', { A: [8, 'i iv V7 i'], S: [16, 'i7 IV7'], K: [8, 'i7'], O: [2, 'i'] }],
    ['Romantica', 'G', 160, 'VCVCO', { V: [8, 'I vi ii V7'], C: [8, 'IV V7 iii vi'], O: [4, 'I'] }],
    ['Phrygian Fire', 'Em', 184, 'IVCSCO', { I: [4, 'i bVII bVI V'], V: [8, 'i bVII bVI V'], C: [8, 'iv i V i'], S: [16, 'i bVII bVI V'], O: [2, 'i'] }],
  ] },
  { name: 'Metal', d: { k: 'x.x.x.xxx.x.x.xx', s: '....x.......x...', h: 'x...x...x...x...' }, b: '1.1.1.1.1.1.1.1.', c: 'x-x-x-x-x-x-x-x-', kit: ['studio', 'fat'], low: ['monolith', 'bass'], keys: ['poly', 'lead'], range: [48, 72], songs: [
    ['Power Gallop', 'Em', 168, 'IVCVCSCO', { I: [4, 'i5 bVI5 bVII5 i5'], V: [8, 'i5 bVI5 bVII5 i5'], C: [8, 'bIII5 bVII5 i5 V5'], S: [8, 'i5 bVII5'], O: [2, 'i5'] }],
    ['Doom March', 'Dm', 72, 'IAKAO', { I: [4, 'i5 bII5'], A: [8, 'i5 bII5 i5 bV5'], K: [4, 'i5'], O: [2, 'i5'] }],
    ['Thrash Riff', 'Am', 200, 'VCVCSVCO', { V: [8, 'i5 bII5 i5 bVII5'], C: [8, 'bVI5 bVII5 i5 i5'], S: [16, 'i5 bVII5 bVI5 bVII5'], O: [2, 'i5'] }],
    ['Symphonic Minor', 'Cm', 150, 'IVPCVPCBCO', { I: [4, 'i bVI'], V: [8, 'i bVI bVII i'], P: [4, 'iv V'], C: [8, 'i bVII bVI bVII'], B: [8, 'bIII bVII bVI V'], O: [2, 'i'] }],
    ['Drop Tuned Groove', 'F#m', 110, 'VCVCKCO', { V: [8, 'i5 bII5'], C: [8, 'i5 bVI5 bVII5 i5'], K: [4, 'i5'], O: [2, 'i5'] }],
  ] },
  { name: 'Punk', d: { k: 'x...x.x.x...x.x.', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' }, b: '1.1.1.1.1.1.1.1.', c: 'x-x-x-x-x-x-x-x-', kit: ['studio', 'tight'], low: ['monolith', 'bass'], keys: ['tonewheel', 'rock'], songs: [
    ['Three Chords Fast', 'A', 180, 'IVCVCO', { I: [4, 'I IV'], V: [8, 'I IV V IV'], C: [8, 'I IV V I'], O: [2, 'I'] }],
    ['Garage Shout', 'E', 170, 'VCVCKCO', { V: [8, 'I5 IV5'], C: [8, 'V5 IV5 I5 I5'], K: [4, 'I5'], O: [2, 'I5'] }],
    ['Skate Park Pop Punk', 'D', 190, 'IVCVCBCO', { I: [4, 'I V vi IV'], V: [8, 'I V vi IV'], C: [8, 'IV V I vi'], B: [8, 'vi IV'], O: [2, 'I'] }],
    ['Basement Minor', 'Em', 160, 'VCVCO', { V: [8, 'i bVI bVII i'], C: [8, 'bIII bVII i i'], O: [2, 'i'] }],
    ['Two Minute Riot', 'G', 200, 'VCVCO', { V: [8, 'I bVII IV I'], C: [4, 'IV V'], O: [2, 'I'] }],
  ] },
  { name: 'Gospel', swing8: 0.12, d: { k: 'x.....x.x.......', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' }, b: '1.....5.8.....5.', c: 'x--x--x---x--x--', kit: ['studio', 'sticks'], low: ['monolith', 'bass'], keys: ['tonewheel', 'gospel'], songs: [
    ['Sunday Shout', 'Ab', 132, 'IVCVCKCO', { I: [4, 'I IV'], V: [8, 'I IV I V7'], C: [8, 'IV #iv° I VI7 ii7 V7 I I'], K: [8, 'I IV'], O: [4, 'I'] }],
    ['Choir Ballad', 'Db', 68, 'IVCVCBCO', { I: [4, 'I IV'], V: [8, 'I iii7 IV V7'], C: [8, 'IV V7 iii7 vi7'], B: [8, 'ii7 V7 iii7 VI7'], O: [4, 'I'] }],
    ['Two Five Praise', 'F', 96, 'VCVCO', { V: [8, 'ii7 V7 Imaj7 vi7'], C: [8, 'IVmaj7 #iv° iii7 VI7 ii7 V7 I I'], O: [4, 'I'] }],
    ['Vamp and Build', 'Bb', 112, 'AKAKO', { A: [8, 'I IV'], K: [8, 'vi7 V7'], O: [4, 'I'] }],
    ['Minor Testimony', 'Cm', 84, 'VCVCBCO', { V: [8, 'i7 iv7 V7 i7'], C: [8, 'bVImaj7 bVII7 bIIImaj7 V7'], B: [8, 'iv7 bVII7 bIIImaj7 bVImaj7'], O: [4, 'i7'] }],
  ] },
];

// the song a preset makes; ids are new each time, so it never lands on an earlier copy of itself
export function presetSong(gi, si) {
  const g = GENRES[gi], [title, keyName, bpm, form, secs] = g.songs[si], key = parseKey(keyName), song = emptySong();
  Object.assign(song, { title, bpm, key, meter: 4, master: { style: STYLE_OF[g.name] || 'band' } });
  const made = new Map();
  for (const L of form) {
    if (!made.has(L)) {
      const [n, prog] = secs[L], sec = newSection(NAMES[L], n), bars = barsOf(prog, n), end = L === 'O';
      sec.chords = bars.map((t) => chordOf(t[0], key).name);
      if (bars.some((t) => t.length > 1)) sec.notes = bars.map((t) => t.map((c) => chordOf(c, key).name).join(' ')).join(' | ');
      const part = (id, name, role, [inst, patch], drum, events) => {
        events.sort((a, b) => a.b - b.b || (a.type === 'off' ? -1 : 1));
        const tk = `${sec.id}-${id}`;
        sec.parts[id] = { id, name, lane: name, role, inst, patch, drums: drum, takes: [{ id: tk, events, by: 'import', byName: 'preset', at: 0 }], current: tk, by: 'import' };
      };
      part('l-drums', 'Drums', 'time', g.kit, true, drums(g, L, n, end));
      part('l-bass', 'Bass', 'bass line', g.low, false, bass(g, L, bars, key, end));
      part('l-chords', 'Chords', 'comping', g.keys, false, comp(g, L, bars, key, end));
      song.sections[sec.id] = sec; made.set(L, sec.id);
    }
    song.order.push(made.get(L));
  }
  return song;
}
