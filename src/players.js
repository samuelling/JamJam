// Virtual players: bandmates the room generates. Every browser runs the same generator on the same settings, seed and
// song position, so a virtual player sounds identical everywhere and sends nothing over the network but its settings.
//
// The first one is a jazz drummer, built as layers from slow to fast, all seeded:
//   form       where the bar sits: the section (intro, head, solo, trading, head out, ending), phrase ends, bridges
//   intensity  builds through a solo, resets for the next, lifts at bridges, wanders a little, and (optionally)
//              rises and falls with how much the band has been playing
//   time       the style's ride, hi-hat and bass-drum pattern, varied bar to bar
//   comping    snare and bass-drum figures from a small cell library, reused as motifs, with rests as real choices
//   fills      at phrase and section ends, sized by intensity, landing on a crash; or deliberately not
//   feel       swing that straightens as the tempo rises, the hi-hat a touch ahead of the ride, timing drift with
//              the slow (1/f) wander real drummers have rather than white jitter
// Nothing here touches audio: drummerBar() returns the notes for one bar.

// ---------- seeded randomness ----------
function hash(...xs) {
  let h = 2166136261 >>> 0;
  for (const x of xs) { const s = String(x); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } h ^= 0x5f; h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function rng(...xs) {
  let a = hash(...xs);
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd1 = (...xs) => rng(...xs)();
// smooth value noise in -1..1 (cosine between seeded points)
function vnoise(seed, tag, x) {
  const i = Math.floor(x), f = x - i, a = rnd1(seed, tag, i) * 2 - 1, b = rnd1(seed, tag, i + 1) * 2 - 1, w = (1 - Math.cos(Math.PI * f)) / 2;
  return a + (b - a) * w;
}
// 1/f-ish: octaves of value noise, each half as strong and twice as slow
function pink(seed, tag, x) { let s = 0, n = 0, amp = 1; for (let o = 0; o < 5; o++) { s += vnoise(seed, tag + o, x / (1 << o)) * amp; n += amp; amp *= 1.25; } return s / n; }
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

// ---------- the kit (General MIDI numbers, as every drum instrument here reads them) ----------
export const KIT = { kick: 36, snare: 38, xstick: 37, hhFoot: 44, hhClosed: 42, ride: 51, bell: 53, crash: 49, tomHi: 48, tomMid: 47, tomLo: 45, floor: 43 };

// styles, grouped by genre. Jazz styles run the jazz drummer below; the others run the groove drummer (grooveBar),
// which shares its form, intensity, fill and feel layers and swaps in a genre's patterns.
export const STYLES = [
  { id: 'medium', name: 'Medium swing', genre: 'Jazz', kit: 'studio' },
  { id: 'two', name: 'Two-feel', genre: 'Jazz', kit: 'studio' },
  { id: 'up', name: 'Up-tempo', genre: 'Jazz', kit: 'studio' },
  { id: 'brushes', name: 'Ballad, soft', genre: 'Jazz', kit: 'studio-dark' },
  { id: 'waltz', name: 'Jazz waltz', genre: 'Jazz', kit: 'studio' },
  { id: 'bossa', name: 'Bossa nova', genre: 'Latin', kit: 'studio' },
  { id: 'rock', name: 'Rock', genre: 'Rock', kit: 'studio' },
  { id: 'halftime', name: 'Half-time rock', genre: 'Rock', kit: 'studio-fat' },
  { id: 'funk', name: 'Funk', genre: 'Funk', kit: 'studio-tight' },
  { id: 'hiphop', name: 'Boom bap', genre: 'Hip-hop', kit: 'lofi' },
  { id: 'trap', name: 'Trap', genre: 'Hip-hop', kit: '808' },
  { id: 'house', name: 'House', genre: 'Electronic', kit: '909' },
  { id: 'dnb', name: 'Drum & bass', genre: 'Electronic', kit: 'hybrid' },
  { id: 'reggae', name: 'Reggae one-drop', genre: 'Reggae', kit: 'studio-dark' },
  { id: 'afro', name: 'Afrobeat', genre: 'Afro', kit: 'studio-tight' },
];
export const GENRES = [...new Set(STYLES.map((s) => s.genre))];
// the kit a drummer plays: recorded acoustic drums, or one of Machina's synthesised kits
export const KITS = [
  { id: 'studio', name: 'Studio kit (recorded)', inst: 'studio', patch: 'sticks', gain: 1.3 },
  { id: 'studio-dark', name: 'Studio kit, dark', inst: 'studio', patch: 'dark', gain: 1.3 },
  { id: 'studio-tight', name: 'Studio kit, tight', inst: 'studio', patch: 'tight', gain: 1.3 },
  { id: 'studio-fat', name: 'Studio kit, fat', inst: 'studio', patch: 'fat', gain: 1.3 },
  { id: '909', name: 'Machina 909', inst: 'machina', patch: '909', gain: 0.5 },
  { id: '808', name: 'Machina 808', inst: 'machina', patch: '808', gain: 0.5 },
  { id: 'lofi', name: 'Machina lo-fi', inst: 'machina', patch: 'lofi', gain: 0.5 },
  { id: 'hybrid', name: 'Machina hybrid', inst: 'machina', patch: 'hybrid', gain: 0.5 },
  { id: 'efm', name: 'Machina FM', inst: 'machina', patch: 'efm', gain: 0.5 },
  { id: 'synth-jazz', name: 'Machina jazz (synth)', inst: 'machina', patch: 'jazz', gain: 0.5 },
];
// 'auto' (or nothing): the kit that suits the style
export function kitOf(o) { const id = o.kit && o.kit !== 'auto' ? o.kit : styleOf(o.style).kit; return KITS.find((k) => k.id === id) || KITS[0]; }
export const styleOf = (id) => STYLES.find((s) => s.id === id) || STYLES[0];
export const drummerName = (style) => { const st = styleOf(style); return st.genre === 'Jazz' ? 'Jazz drummer' : `${st.name} drummer`; };
export const VIRTUAL = {
  drums: { name: 'Drummer', inst: 'machina', blurb: 'Keeps time in its genre, builds through the song and fills into the next section. Follows the song.', styles: STYLES },
};
VIRTUAL['jazz-drums'] = VIRTUAL.drums;
export function newVirtual(kind, by, byName, style = 'medium') {
  return { id: Math.random().toString(36).slice(2, 7), kind: 'drums', name: drummerName(style), inst: kitOf({ style }).inst, kit: 'auto', style, feel: 'auto',
    intensity: 0.5, busy: 0.5, fills: 0.6, listen: true, seed: Math.floor(Math.random() * 1e9), level: 0.8, on: false, start: 0, by, byName };
}

// ---------- form: what kind of section a name (or road-map label) means ----------
export function sectionKind(name = '', label = '') {
  const s = `${label} ${name}`.toLowerCase();
  if (/trad|4s|8s|fours|eights/.test(s)) return 'trade';
  if (/end|tag|coda|outro/.test(s)) return /outro/.test(s) && !/end|tag|coda/.test(s) ? 'out' : 'ending';
  if (/head out|out head|\bout\b|last head|recap/.test(s)) return 'out';
  if (/intro|count/.test(s)) return 'intro';
  if (/bass solo|drum solo/.test(s)) return /drum/.test(s) ? 'drumsolo' : 'basssolo';
  if (/solo|blow|improv|trumpet|alto|tenor|sax|piano|guitar|horn|trombone|vibes|keys|organ/.test(s)) return 'solo';
  if (/bridge|^b\b| b$|middle/.test(s)) return 'bridge';
  if (/breakdown/.test(s)) return 'breakdown';
  if (/break|stop/.test(s)) return 'break';
  if (/pre.?chorus|build|lift|riser/.test(s)) return 'pre';
  if (/chorus|hook|drop|refrain/.test(s)) return 'chorus';
  if (/verse/.test(s)) return 'verse';
  return 'head';
}
// with no song playing, the drummer plays an endless 32-bar AABA: a head, then choruses of solo
export function vampForm(n) {
  const chorus = Math.floor(n / 32), barIn = n % 32, bridge = barIn >= 16 && barIn < 24;
  return { kind: bridge ? 'bridge' : chorus === 0 ? 'head' : 'solo', sectionBar: barIn, bars: 32, pass: chorus, last: barIn === 31, phraseEnd: barIn % 8 === 7, final: false };
}

// ---------- the drummer ----------
const swingRatio = (bpm, style) => {
  if (style === 'bossa') return 1;
  const r = 3 - (clamp(bpm, 60, 340) - 60) * (1.85 / 280) + (style === 'two' ? 0.15 : style === 'brushes' ? 0.25 : style === 'up' ? -0.1 : 0);
  return Math.max(1.05, r);
};
// comping cells: [beat, where in the beat ('' on it, '&' the swung upbeat, 't1'/'t2' triplet partials), limb]
const CELLS = [
  { id: 'charleston', hits: [[0, '', 's'], [1, '&', 's']] },
  { id: 'and4', hits: [[3, '&', 's']] },
  { id: 'and2', hits: [[1, '&', 's']] },
  { id: 'bomb', hits: [[3, '&', 'k']] },
  { id: 'push', hits: [[2, '&', 's'], [3, '&', 'k']] },
  { id: 'reply', hits: [[0, '&', 's'], [2, '', 's']] },
  { id: 'middles', hits: [[1, 't1', 's'], [2, 't1', 's'], [3, 't1', 's']] },
  { id: 'kickdrop', hits: [[1, '&', 'k'], [3, '', 's']] },
  { id: 'stab', hits: [[2, '&', 's']] },
  { id: 'answer', hits: [[0, '&', 'k'], [1, '&', 's'], [3, '&', 's']] },
];

// fills: decided per bar on their own, so the bar after knows whether to land on a crash
export function planFill(o, fm, m) {
  if (!fm || fm.final) return null;
  const seed = o.seed | 0, end = fm.last, phrase = fm.phraseEnd, four = fm.sectionBar % 4 === 3, Im = intensityAt(o, fm, m);
  let p = (o.fills ?? 0.6) * (end ? 0.55 + 0.6 * Im : phrase ? 0.3 + 0.6 * Im : four ? 0.12 * Im : 0);
  if (fm.kind === 'ending' && end) p = 0;
  if (fm.kind === 'break') p = 0;
  if (fm.kind === 'trade' && Math.floor(fm.sectionBar / 4) % 2 === 1) p = 0;   // the drummer's own four: no fill on top
  if (rnd1(seed, 'fill?', m) >= p) return null;
  return { beats: end && Im > 0.4 ? 2 : Im > 0.75 && phrase ? 2 : 1, kind: Math.floor(rnd1(seed, 'fillkind', m) * 4), I: Im };
}
export function intensityAt(o, form, n) {
  let I = o.intensity ?? 0.5;
  const prog = form.bars > 1 ? form.sectionBar / (form.bars - 1) : 0;
  if (form.kind === 'intro') I -= 0.15;
  else if (form.kind === 'solo' || form.kind === 'drumsolo') I += -0.12 + 0.38 * prog + Math.min(0.12, (form.pass || 0) * 0.06);
  else if (form.kind === 'basssolo') I -= 0.3;
  else if (form.kind === 'bridge') I += 0.08;
  else if (form.kind === 'trade') I += 0.18;
  else if (form.kind === 'out') I += 0.06;
  else if (form.kind === 'ending') I += 0.1;
  else if (form.kind === 'chorus') I += 0.16;
  else if (form.kind === 'pre') I += -0.05 + 0.3 * prog;
  else if (form.kind === 'verse') I -= 0.06;
  else if (form.kind === 'breakdown') I -= 0.35;
  I += vnoise(o.seed, 'wander', n / 8) * 0.1;
  if (form.band != null) I += (form.band - 1.2) * 0.07;   // listens: more when the band plays more
  return clamp(I);
}

// The notes of one bar. o: the player's settings; form: where the bar sits; n: the bar's number in the performance
// (the seed for everything that varies); meter: beats per bar; bpm. Returns [{b, note, vel, ms}]: b in beats from the
// bar's start, ms a timing nudge, sorted by time.
export function drummerBar(o, form, n, meter = 4, bpm = 120) {
  if (GROOVES[o.style]) return grooveBar(o, form, n, meter, bpm, GROOVES[o.style]);
  const out = [], seed = o.seed | 0, R = rng(seed, 'bar', n), I = intensityAt(o, form, n);
  const style = o.style || 'medium', busy = o.busy ?? 0.5;
  const r = swingRatio(bpm, style), sw = r / (r + 1);
  const at = (q, w) => q + (w === '&' ? sw : w === 't1' ? 1 / 3 : w === 't2' ? 2 / 3 : 0);
  const add = (b, note, vel, ms = 0) => { if (b < meter - 1e-6 && vel > 0) out.push({ b, note, vel: Math.round(clamp(vel, 1, 127)), ms }); };
  const human = (v, k) => v * (0.75 + 0.45 * I) + (rnd1(seed, 'v', n, k) - 0.5) * 10;
  const feel = o.feel && o.feel !== 'auto' ? o.feel : style === 'two' ? '2' : style === 'medium' && (form.kind === 'head' || form.kind === 'intro') && form.pass === 0 && bpm < 210 && I < 0.55 ? '2' : '4';

  // the very last bar of the song: one big hit, left to ring
  if (form.final) { add(0, KIT.crash, 110); add(0, KIT.kick, 105); add(0, KIT.snare, 95); return out; }
  if (form.kind === 'break') { if (form.sectionBar === 0) { add(0, KIT.crash, 90); add(0, KIT.kick, 90); } add(meter - 1 + sw, KIT.snare, 60); return out; }

  const fill = planFill(o, form, n), landed = form.prevFill || (form.sectionBar === 0 && form.pass === 0 && form.kind !== 'intro' && n > 0);
  const fillFrom = fill ? meter - fill.beats : meter;
  const tradeMine = form.kind === 'trade' && Math.floor(form.sectionBar / 4) % 2 === 1;
  const soloBar = tradeMine || form.kind === 'drumsolo';

  // ---------- time ----------
  if (landed) { add(0, KIT.crash, 70 + 40 * I); add(0, KIT.kick, 60 + 40 * I); }
  const hatAhead = -(4 + 8 * rnd1(seed, 'hat', 0));   // ms: the hi-hat sits a little ahead of the ride
  if (style === 'bossa') {
    for (let e = 0; e < meter * 2; e++) { const b = e / 2; if (b >= fillFrom) break; if (!(landed && e === 0)) add(b, KIT.ride, human(e % 2 ? 46 : 66, 'r' + e)); }
    const xs = n % 2 === 0 ? [0, 1.5, 3] : [1, 2.5];
    for (const b of xs) if (b < fillFrom && b < meter) add(b, KIT.xstick, human(58, 'x' + b));
    for (const [b, v] of [[0, 55], [1.5, 38], [2, 55], [3.5, 38]]) if (b < fillFrom && b < meter) add(b, KIT.kick, human(v, 'k' + b));
  } else if (style === 'brushes') {
    // swish: a soft brush stirring on every triplet, slaps on 2 and 4
    for (let q = 0; q < meter; q++) {
      if (q >= fillFrom) break;
      for (let t = 0; t < 3; t++) add(q + t / 3, KIT.snare, human(10 + 6 * (t === 2), 'sw' + q + t) * 0.9);
      if (q % 2 === 1) add(q, KIT.snare, human(46, 'sl' + q));
      if (q % 2 === 1) add(q, KIT.hhFoot, human(50, 'hf' + q), hatAhead);
      if (q % 2 === 0) add(q, KIT.kick, human(18, 'kf' + q));
    }
    if (rnd1(seed, 'brushride', n) < 0.25 + 0.4 * I) for (let q = 0; q < Math.min(meter, fillFrom); q++) add(q, KIT.ride, human(q % 2 ? 44 : 36, 'br' + q));
  } else {
    // ride: quarters, with the skip on the swung upbeat of 2 and 4 ("ding, ding-a ding"), varied bar to bar
    const v = R(), skipBeats = new Set();
    const three = meter === 3 || style === 'waltz';
    if (three) skipBeats.add(1); else for (let q = 1; q < meter; q += 2) skipBeats.add(q);
    if (feel === '2' || style === 'up') { if (v < 0.5) skipBeats.clear(); if (meter >= 4 && v >= 0.5) { skipBeats.clear(); skipBeats.add(meter - 1); } }
    else if (v < 0.12) skipBeats.delete(1);
    else if (v < 0.27 + 0.1 * I) skipBeats.add(Math.floor(R() * meter));
    for (let q = 0; q < meter; q++) {
      if (q >= fillFrom || (soloBar && R() < 0.5)) continue;
      if (!(landed && q === 0)) add(q, KIT.ride, human(q % 2 ? 82 : 66, 'ride' + q));
      // the skip: the swung upbeat after 2 and 4, leading into 3 and 1 ("ding, ding-a ding, ding-a")
      if (skipBeats.has(q) && at(q, '&') < fillFrom) add(at(q, '&'), KIT.ride, human(52, 'skip' + q));
    }
    if (R() < 0.05 * busy && !soloBar) { const q = Math.floor(R() * Math.min(meter, fillFrom)); add(q + 1 / 3, KIT.ride, human(40, 'trip')); add(q + 2 / 3, KIT.ride, human(48, 'trip2')); }
    // hi-hat foot on 2 and 4 (2 and 3 in a waltz, now and then)
    for (let q = 0; q < meter; q++) if (three ? q > 0 && (q === 1 || rnd1(seed, 'w3', n) < 0.4) : q % 2 === 1) add(q, KIT.hhFoot, human(62, 'hh' + q), hatAhead);
    // bass drum: feathered quarters (two-feel: 1 and 3, a little firmer)
    if (I > 0.18) for (let q = 0; q < Math.min(meter, fillFrom); q++) { if (landed && q === 0) continue; if (feel === '2' ? q % 2 === 0 : true) add(q, KIT.kick, human(feel === '2' ? 34 : 24, 'kf' + q)); }
  }

  // ---------- comping ----------
  if (style !== 'brushes' && style !== 'bossa') {
    const phrase = Math.floor(form.sectionBar / 2), motif = CELLS[Math.floor(rnd1(seed, 'motif', n - (form.sectionBar % 2)) * CELLS.length)];
    const pComp = soloBar ? 1 : clamp(0.15 + 0.75 * I * (0.4 + busy) - (feel === '2' ? 0.2 : 0));
    if (R() < pComp) {
      const cells = [rnd1(seed, 'reuse', n) < 0.45 ? motif : CELLS[Math.floor(R() * CELLS.length)]];
      if (soloBar || R() < I * busy * 0.6) cells.push(CELLS[Math.floor(R() * CELLS.length)]);
      const shift = rnd1(seed, 'shift', phrase) < 0.2 ? 1 : 0;
      for (const c of cells) for (const [q0, w, limb] of c.hits) {
        const q = (q0 + shift) % 4; if (q >= meter) continue;
        const b = at(q, w); if (b >= fillFrom) continue;
        if (limb === 's') add(b, soloBar && R() < 0.4 ? [KIT.tomHi, KIT.tomMid, KIT.floor][Math.floor(R() * 3)] : KIT.snare, human(soloBar ? 72 : 40 + 25 * I, 'c' + b), 3);
        else add(b, KIT.kick, human(soloBar ? 80 : 55 + 30 * I, 'cb' + b), 2);
      }
    }
  }

  // ---------- fill ----------
  if (fill) {
    const steps = fill.beats * 3, toms = [KIT.snare, KIT.tomHi, KIT.tomMid, KIT.tomLo, KIT.floor];
    for (let i = 0; i < steps; i++) {
      const b = fillFrom + i / 3, cres = 0.55 + 0.45 * (i / Math.max(1, steps - 1));
      if (style === 'brushes') { for (let j = 0; j < 2; j++) add(b + j / 6, KIT.snare, (18 + 40 * cres) * (0.7 + 0.4 * fill.I)); continue; }
      let note = KIT.snare;
      if (fill.kind === 1) note = toms[Math.min(toms.length - 1, Math.floor((i / steps) * toms.length))];
      else if (fill.kind === 2) { if (i % 3 === 1) continue; note = i % 3 === 2 ? KIT.kick : KIT.snare; }
      else if (fill.kind === 3) { if (rnd1(seed, 'gap', n, i) < 0.35) continue; note = rnd1(seed, 'fn', n, i) < 0.5 ? KIT.snare : KIT.tomLo; }
      add(b, note, (50 + 55 * cres) * (0.6 + 0.5 * fill.I), 2);
    }
    if (style !== 'brushes') add(meter - 1 / 3, KIT.kick, 70 + 30 * fill.I, 2);   // the kick under the last stroke, setting up the landing
  }
  if (form.kind === 'ending' && form.last) { out.length = 0; add(0, KIT.crash, 105); add(0, KIT.kick, 100); add(0, KIT.snare, 90); }

  // ---------- feel: slow timing drift (and the hi-hat's lead already set) ----------
  const drift = (b) => pink(seed, 'time', n * meter + b) * (6 + 6 * (1 - (o.tight ?? 0.5)));
  for (const e of out) e.ms = Math.round((e.ms + drift(e.b)) * 10) / 10;
  return out.sort((a, b) => a.b - b.b || a.note - b.note);
}
// fills land on the next bar's downbeat: the bar after a fill opens on a crash
export function withPrevFill(o, form, prevForm, n) { return { ...form, prevFill: !!(prevForm && planFill(o, prevForm, n - 1)) && form.kind !== 'ending' }; }

// ---------- the groove drummer: rock, funk, hip-hop, house, drum & bass, reggae, afrobeat, trap ----------
// Patterns are 16 steps of a 4/4 bar (cut or repeated for other meters): X accent, x hit, g ghost, o open hi-hat,
// . rest. Each limb has a main pattern and a few variations; a bar picks one, a two-bar phrase tends to reuse it.
const GROOVES = {
  rock: { swing: 0, loose: 5, hat: ['x.x.x.x.x.x.x.x.', 'x.x.x.x.x.x.xxx.', 'x.x.x.x.x.x.x.o.'], kick: ['x.......x.x.....', 'x......xx.......', 'x.....x.x.x.....', 'x.......x...x...'], snare: ['....X.......X...', '....X.......X..g', '....X..g....X...'], chorusRide: true, fill: 'toms' },
  halftime: { swing: 0, loose: 6, hat: ['x.x.x.x.x.x.x.x.', 'x...x...x...x...'], kick: ['x.........x.....', 'x......x..x.....', 'x.x.......x.....'], snare: ['........X.......', '........X......g'], chorusRide: true, fill: 'toms' },
  funk: { swing: 0.06, loose: 3, hat: ['xxXxxxXxxxXxxxXx', 'xxXxxxXxxxXxxoXx', 'x.Xx.xXxx.Xx.xXx'], kick: ['x.x....x..x.....', 'x..x...x.xx.....', 'x.....x...x..x..', 'x.x...x....x..x.'], snare: ['....X..g.g..X..g', '.g..X.g..g..X.gg', '....X..g.g.gX...'], fill: 'snare16' },
  hiphop: { swing: 0.22, loose: 9, lazy: 14, hat: ['x.x.x.x.x.x.x.x.', 'x.x.x.xxx.x.x.x.', 'x.x.x.x.x.x.x.o.'], kick: ['x......x..x.....', 'x.........xx....', 'x......x.x....x.', 'x.x.......x.....'], snare: ['....X.......X...', '....X.......X..g', '....X....g..X...'], fill: 'sparse' },
  trap: { swing: 0, loose: 2, hat: ['x.x.x.x.x.x.x.x.', 'x.x.x.x.xxxxx.x.', 'x.x.xxx.x.x.xxxx'], rolls: true, kick: ['x.......x.....x.', 'x.....x...x.....', 'x..x......x...x.'], snare: ['........X.......', '........X......x'], clap: true, fill: 'hats' },
  house: { swing: 0.05, loose: 2, hat: ['..o...o...o...o.', 'x.o.x.o.x.o.x.o.', 'xxoxxxoxxxoxxxox'], kick: ['x...x...x...x...'], snare: ['....x.......x...'], clap: true, fill: 'build' },
  dnb: { swing: 0, loose: 3, hat: ['x.x.x.x.x.x.x.x.', 'xxx.xxx.xxx.xxx.'], kick: ['x.........x.....', 'x.........x..x..', 'x......x..x.....'], snare: ['....X.......X...', '....X..g....X.g.', '....X......gX...'], fill: 'snare16' },
  reggae: { swing: 0.18, loose: 6, hat: ['x.x.x.x.x.x.x.x.', 'x.xxx.x.x.xxx.x.'], kick: ['........x.......'], snare: ['........X.......'], xstick: true, fill: 'sparse' },
  afro: { swing: 0.04, loose: 4, hat: ['x.xxx.xxx.xxx.x.', 'x.x.xxx.x.xxx.x.'], kick: ['x..x..x...x..x..', 'x.....x.x.....x.'], snare: ['....x..g.g..x...', '.g..x....g..x.g.'], ride: 'x..x..x...x.x...', fill: 'toms' },
};
export function grooveBar(o, form, n, meter, bpm, G) {
  const out = [], seed = o.seed | 0, R = rng(seed, 'gbar', n), I = intensityAt(o, form, n), busy = o.busy ?? 0.5;
  const steps = meter * 4, sw = (G.swing || 0) * (bpm > 150 ? 0.5 : 1);
  const pos = (st) => st / 4 + (st % 2 ? sw * 0.25 : 0);
  const add = (b, note, vel, ms = 0) => { if (b < meter - 1e-6 && vel > 0) out.push({ b, note, vel: Math.round(clamp(vel, 1, 127)), ms }); };
  const human = (v, k) => v * (0.72 + 0.45 * I) + (rnd1(seed, 'gv', n, k) - 0.5) * 9;
  if (form.final) { add(0, KIT.crash, 112); add(0, KIT.kick, 110); add(0, KIT.snare, 96); return out; }
  const fill = planFill(o, form, n), fillFrom = fill ? meter - fill.beats : meter, landed = form.prevFill || (form.sectionBar === 0 && form.pass === 0 && n > 0 && form.kind !== 'intro');
  const pick = (arr, tag) => { if (arr.length === 1) return arr[0]; const motif = Math.floor(rnd1(seed, tag + 'm', Math.floor(form.sectionBar / 2)) * arr.length); return rnd1(seed, tag + 'r', n) < 0.6 ? arr[motif] : arr[Math.floor(R() * arr.length)]; };
  const cell = (pat, st) => pat[st % 16] || '.';
  const sparse = form.kind === 'breakdown' || form.kind === 'break', intro = form.kind === 'intro' && form.sectionBar < Math.max(1, form.bars / 2);
  // hats (or the ride in a chorus, for the styles that open up there)
  const useRide = G.chorusRide && (form.kind === 'chorus' || form.kind === 'solo') && I > 0.45;
  const hat = pick(G.hat, 'h'), thin = I < 0.3 && !hat.includes('o');
  for (let st = 0; st < steps; st++) {
    const b = pos(st); if (b >= fillFrom) break;
    let c = cell(hat, st); if (c === '.' || (thin && st % 2)) continue;
    if (sparse && st % 4) continue;
    if (landed && st === 0) continue;
    const note = useRide ? KIT.ride : c === 'o' ? 46 : KIT.hhClosed;
    add(b, note, human(c === 'X' || st % 4 === 0 ? 78 : c === 'o' ? 70 : 54, 'h' + st), -3);
  }
  // trap hi-hat rolls: a beat of 16th triplets or 32nds now and then
  if (G.rolls && R() < 0.25 + 0.4 * I) { const q = Math.floor(R() * Math.min(meter, fillFrom)), div = R() < 0.5 ? 6 : 8; for (let k = 0; k < div; k++) add(q + k / div, KIT.hhClosed, 40 + 40 * (k / div)); }
  if (G.ride && !sparse) for (let st = 0; st < steps; st++) { const b = pos(st); if (b < fillFrom && cell(G.ride, st) !== '.') add(b, KIT.bell, human(52, 'rb' + st)); }
  // kick and snare
  if (!intro) {
    const kick = pick(G.kick, 'k'), snare = pick(G.snare, 's');
    for (let st = 0; st < steps; st++) {
      const b = pos(st); if (b >= fillFrom) break;
      const k = cell(kick, st), sn = cell(snare, st);
      if (k !== '.' && !(sparse && st !== 0) && !(landed && st === 0)) add(b, KIT.kick, human(k === 'X' || st === 0 ? 100 : 84, 'k' + st), 0);
      if (sn !== '.' && !sparse) {
        if (sn === 'g') { if (R() < 0.3 + 0.6 * busy * I) add(b, KIT.snare, human(26, 'g' + st), 4); }
        else { const note = G.xstick ? KIT.xstick : KIT.snare; add(b, note, human(sn === 'X' ? 100 : 82, 's' + st), G.lazy || 0); if (G.clap) add(b, 39, human(88, 'cl' + st), (G.lazy || 0) + 2); }
      }
    }
    if (!sparse && R() < 0.12 * busy * (0.5 + I)) { const st = 2 * Math.floor(R() * Math.min(steps, fillFrom * 4) / 2) + 1; add(pos(st), KIT.kick, human(70, 'kx')); }
  }
  if (landed) { add(0, KIT.crash, 80 + 35 * I); add(0, KIT.kick, 100); }
  // fills in the genre's way
  if (fill) {
    const n16 = fill.beats * 4, toms = [KIT.tomHi, KIT.tomMid, KIT.tomLo, KIT.floor];
    for (let i = 0; i < n16; i++) {
      const b = fillFrom + i / 4, cres = 0.5 + 0.5 * (i / Math.max(1, n16 - 1)), v = (55 + 55 * cres) * (0.6 + 0.5 * fill.I);
      if (G.fill === 'toms') add(b, i < 2 ? KIT.snare : toms[Math.min(3, Math.floor(((i - 2) / Math.max(1, n16 - 2)) * 4))], v, 2);
      else if (G.fill === 'snare16') add(b, KIT.snare, v * (i % 2 ? 0.8 : 1), 2);
      else if (G.fill === 'hats') { add(b, KIT.hhClosed, v * 0.7); add(b + 1 / 8, KIT.hhClosed, v * 0.6); }
      else if (G.fill === 'build') { if (i % 2 === 0 || fill.I > 0.6) add(b, KIT.snare, v); }
      else if (G.fill === 'sparse') { if (i % 3 === 0) add(b, i % 2 ? KIT.kick : KIT.snare, v); }
      if (i % 4 === 0 && G.fill !== 'hats') add(b, KIT.kick, v * 0.85);
    }
  }
  if (form.kind === 'ending' && form.last) { out.length = 0; add(0, KIT.crash, 108); add(0, KIT.kick, 106); add(0, KIT.snare, 92); }
  const drift = (b) => pink(seed, 'gtime', n * meter + b) * (G.loose ?? 4);
  for (const e of out) e.ms = Math.round((e.ms + drift(e.b)) * 10) / 10;
  return out.sort((a, b) => a.b - b.b || a.note - b.note);
}
