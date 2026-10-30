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

export const STYLES = [
  { id: 'medium', name: 'Medium swing', patch: 'jazz' },
  { id: 'two', name: 'Two-feel', patch: 'jazz' },
  { id: 'up', name: 'Up-tempo', patch: 'jazz' },
  { id: 'brushes', name: 'Ballad, brushes', patch: 'brushes' },
  { id: 'waltz', name: 'Jazz waltz', patch: 'jazz' },
  { id: 'bossa', name: 'Bossa nova', patch: 'jazz' },
];
export const VIRTUAL = {
  'jazz-drums': { name: 'Jazz drummer', inst: 'machina', blurb: 'Keeps time, comps, builds through solos and fills into the next section. Follows the song.', styles: STYLES },
};
export function newVirtual(kind, by, byName) {
  const def = VIRTUAL[kind];
  return { id: Math.random().toString(36).slice(2, 7), kind, name: def.name, inst: def.inst, patch: 'jazz', style: 'medium', feel: 'auto',
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
  if (/break|stop/.test(s)) return 'break';
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
  I += vnoise(o.seed, 'wander', n / 8) * 0.1;
  if (form.band != null) I += (form.band - 1.2) * 0.07;   // listens: more when the band plays more
  return clamp(I);
}

// The notes of one bar. o: the player's settings; form: where the bar sits; n: the bar's number in the performance
// (the seed for everything that varies); meter: beats per bar; bpm. Returns [{b, note, vel, ms}]: b in beats from the
// bar's start, ms a timing nudge, sorted by time.
export function drummerBar(o, form, n, meter = 4, bpm = 120) {
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
