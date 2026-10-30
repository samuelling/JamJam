// The song the band is composing: sections (intro, verse, chorus...) with lengths, chord charts and notes, the parts
// locked into each, and the order they play in. Shared like everything else in the room: every edit is a timed
// write to one key, and the latest room time wins (ties by jammer id), so edits made at once still agree everywhere.
//
// Formats in: a standard MIDI file (tracks become parts, markers become sections, the tempo and key come along), or
// a song from SynthLand's Tracker ("tracker-song/0.1": rows become sections, tracks become parts, meta.jam has the
// key). Formats out: a type 1 MIDI file of the whole arrangement, and this song as JSON ("megajam.song/1").

export const SECTION_NAMES = ['Intro', 'Verse', 'Pre-chorus', 'Chorus', 'Bridge', 'Solo', 'Breakdown', 'Drop', 'Outro'];
export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const rid = () => Math.random().toString(36).slice(2, 8);

export function emptySong() {
  return { format: 'megajam.song/1', title: 'Untitled', bpm: 96, key: { root: 9, mode: 'minor' }, meter: 4, order: [], labels: [], rule: 'newest', variations: {}, lanes: {}, sections: {} };
}
export function newSection(name = 'Verse', bars = 8) { return { id: rid(), name, bars, chords: Array(bars).fill(''), notes: '', parts: {} }; }
export const sectionBeats = (song, s) => s.bars * (song.meter || 4);

// ---------- the shared store: key -> value, with (at, by) stamps ----------
export class SongStore {
  constructor() { this.song = emptySong(); this.stamps = {}; this.listeners = new Set(); }
  // keys: 'master' ({vol: dB}: the song's master fader) | 'share' ({url}: the band's shared folder) | 'title' | 'bpm' | 'key' | 'meter' | 'order' | 'transport' ({on, mode: 'loop' | 'song', sid, start (room beat)}) | 'sec:<id>' (name, bars, chords, notes; null = gone)
  //       | 'lane:<id>' (a track: name, owner, instrument and its settings, muted) | 'part:<sid>:<pid>' (a track's block in a section; pid = the track id)
  apply(k, v, at, by) {
    const st = this.stamps[k];
    if (st && (st[0] > at || (st[0] === at && String(st[1]) >= String(by)))) return false;
    this.stamps[k] = [at, by];
    const s = this.song;
    if (['title', 'bpm', 'key', 'meter', 'order', 'labels', 'rule', 'transport', 'master', 'share'].includes(k)) s[k] = v;
    else if (k.startsWith('vp:')) { s.players = s.players || {}; if (v == null) delete s.players[k.slice(3)]; else s.players[k.slice(3)] = { ...v, id: k.slice(3) }; }
    else if (k.startsWith('lane:')) { s.lanes = s.lanes || {}; if (v == null) delete s.lanes[k.slice(5)]; else s.lanes[k.slice(5)] = { ...v, id: k.slice(5) }; }
    else if (k.startsWith('var:')) { s.variations = s.variations || {}; if (v == null) delete s.variations[k.slice(4)]; else s.variations[k.slice(4)] = v; }
    else if (k.startsWith('sec:')) { const id = k.slice(4); if (v == null) delete s.sections[id]; else s.sections[id] = { parts: s.sections[id]?.parts || {}, ...v, id }; }
    else if (k.startsWith('part:')) { const [, sid, pid] = k.split(':'); const sec = s.sections[sid] || (s.sections[sid] = { id: sid, name: '…', bars: 8, chords: [], notes: '', parts: {} }); if (v == null) delete sec.parts[pid]; else sec.parts[pid] = { ...v, id: pid }; }
    for (const f of this.listeners) f(k, v);
    return true;
  }
  snapshot() { return { song: JSON.parse(JSON.stringify(this.song)), stamps: { ...this.stamps } }; }
  load(snap) {
    if (!snap || !snap.song) return;
    // merge: newer stamps win key by key
    const keys = Object.keys(snap.stamps || {});
    for (const k of keys) {
      const [at, by] = snap.stamps[k], s = snap.song;
      let v;
      if (k.startsWith('sec:')) { const sec = s.sections[k.slice(4)]; v = sec ? { name: sec.name, bars: sec.bars, chords: sec.chords, notes: sec.notes } : null; }
      else if (k.startsWith('part:')) { const [, sid, pid] = k.split(':'); v = s.sections[sid]?.parts?.[pid] ?? null; }
      else if (k.startsWith('lane:')) v = s.lanes?.[k.slice(5)] ?? null;
      else if (k.startsWith('var:')) v = s.variations?.[k.slice(4)] ?? null;
      else if (k.startsWith('vp:')) v = s.players?.[k.slice(3)] ?? null;
      else v = s[k];
      this.apply(k, v, at, by);
    }
  }
  sections() { return this.song.order.map((id) => this.song.sections[id]).filter(Boolean); }
  // section start beats in arrangement order (sections can repeat)
  timeline() { let b = 0; return this.song.order.map((id) => { const s = this.song.sections[id]; const t = { id, start: b, beats: s ? sectionBeats(this.song, s) : 0 }; b += t.beats; return t; }).filter((t) => t.beats > 0); }
}

// ---------- chords ----------
const TRIADS = []; for (let r = 0; r < 12; r++) { TRIADS.push({ r, q: '', t: [0, 4, 7] }, { r, q: 'm', t: [0, 3, 7] }); }
export function chordName(r, q) { return NOTE_NAMES[r] + q; }
export function parseChord(name) {
  const m = String(name || '').trim().match(/^([A-G])([#♯b♭]?)(.*)$/); if (!m) return null;
  let r = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (/[#♯]/.test(m[2]) ? 1 : /[b♭]/.test(m[2]) ? -1 : 0); r = (r + 12) % 12;
  const rest = m[3].replace(/\s/g, ''), minor = /^(m|min|-)(?!aj)/.test(rest), dim = /^(dim|°)/.test(rest);
  const t = dim ? [0, 3, 6] : minor ? [0, 3, 7] : /^(sus4)/.test(rest) ? [0, 5, 7] : /^(sus2)/.test(rest) ? [0, 2, 7] : [0, 4, 7];
  if (/7/.test(rest)) t.push(/maj7|M7|Δ/.test(rest) ? 11 : 10);
  return { root: r, tones: t };
}
// the triad that best explains a bar's notes (weighted by how long each sounds, the lowest note counting double)
export function detectChord(notes) {
  if (!notes.length) return '';
  const w = new Array(12).fill(0); let low = 999, lowPc = 0;
  for (const n of notes) { w[n.note % 12] += n.dur; if (n.note < low) { low = n.note; lowPc = n.note % 12; } }
  w[lowPc] += notes.reduce((a, n) => a + n.dur, 0) * 0.25;
  let best = null, bs = -1e9;
  for (const c of TRIADS) { let s = 0; for (let pc = 0; pc < 12; pc++) { const inC = c.t.includes((pc - c.r + 12) % 12); s += inC ? w[pc] : -0.6 * w[pc]; } if (c.r === lowPc) s *= 1.1; if (s > bs) { bs = s; best = c; } }
  return bs > 0 ? chordName(best.r, best.q) : '';
}
export function chartFromParts(parts, bars, meter) {
  const out = [];
  for (let b = 0; b < bars; b++) {
    const a = b * meter, z = a + meter, notes = [];
    for (const p of parts) {
      if (p.drums) continue;
      const on = new Map();
      for (const e of p.events || currentTake(p)?.events || []) {
        if (e.type === 'on') on.set(e.note, e.b);
        else if (e.type === 'off' && on.has(e.note)) { const s = on.get(e.note); on.delete(e.note); const d = Math.min(z, e.b) - Math.max(a, s); if (d > 0) notes.push({ note: e.note, dur: d }); }
      }
    }
    out.push(detectChord(notes));
  }
  // a chart reads better with repeats left blank
  return out.map((c, i) => (i > 0 && c === out[i - 1] ? '' : c));
}

// ---------- instruments for imported parts ----------
// a General MIDI program, or a SynthLand plugin/track name, to the closest built-in instrument and patch
const GUESS = [
  [/kick|bd|snare|sd|clap|hat|hh|ride|crash|cymbal|perc|tom|drum|kit|rim/, { inst: 'machina', patch: '909', drums: true }],
  [/acid|303/, { inst: 'poly', patch: 'acid' }],
  [/sub|bass/, { inst: 'monolith', patch: 'bass' }],
  [/piano|hammer|keys|rhodes|ep\b|wurl|clav|organ|celest|glock|bell|vibes|marimba/, { inst: 'tine', patch: 'keys' }],
  [/guitar|pluck|harp|banjo/, { inst: 'poly', patch: 'pluck' }],
  [/brass|horn|trumpet|trombone|tuba|sax|alto|tenor|reed/, { inst: 'juniper', patch: 'brass' }],
  [/string|violin|viola|cello|choir|voice|ensemble/, { inst: 'juniper', patch: 'strings' }],
  [/pad|warm|wash|ambient|drone|swell/, { inst: 'juniper', patch: 'pad' }],
  [/lead|solo|mono|whistle|flute/, { inst: 'monolith', patch: 'lead' }],
];
export function guessInstrument(name = '', program = -1, channel = -1) {
  if (channel === 9) return { inst: 'machina', patch: '909', drums: true };
  if (program >= 0) {
    const g = program >> 3;   // the General MIDI families
    const byFam = [{ inst: 'tine', patch: 'keys' }, { inst: 'tine', patch: 'bell' }, { inst: 'poly', patch: 'keys' }, { inst: 'poly', patch: 'pluck' }, { inst: 'monolith', patch: 'bass' }, { inst: 'juniper', patch: 'strings' }, { inst: 'juniper', patch: 'strings' }, { inst: 'juniper', patch: 'brass' }, { inst: 'juniper', patch: 'brass' }, { inst: 'monolith', patch: 'soft' }, { inst: 'monolith', patch: 'lead' }, { inst: 'juniper', patch: 'pad' }, { inst: 'juniper', patch: 'pad' }, { inst: 'poly', patch: 'pluck' }, { inst: 'tine', patch: 'bell' }, { inst: 'machina', patch: 'hybrid', drums: true }];
    if (!name || !GUESS.some(([re]) => re.test(name.toLowerCase()))) return byFam[g] || { inst: 'juniper', patch: 'keys' };
  }
  const n = name.toLowerCase();
  for (const [re, v] of GUESS) if (re.test(n)) return { ...v };
  return { inst: 'juniper', patch: 'keys' };
}
// Machina's drum notes (General MIDI)
export const DRUM_NOTE = { bd: 36, kick: 36, sd: 38, snare: 38, cp: 39, clap: 39, rs: 37, rim: 37, ch: 42, hat: 42, hats: 42, oh: 46, ohat: 46, tt: 45, tom: 45, cy: 49, ride: 49, crash: 49, perc: 60, pc: 60 };

// ---------- MIDI in ----------
export function readMidi(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let p = 0;
  const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u[p + i]); p += n; return s; };
  const u32 = () => { const v = (u[p] << 24) | (u[p + 1] << 16) | (u[p + 2] << 8) | u[p + 3]; p += 4; return v >>> 0; };
  const u16 = () => { const v = (u[p] << 8) | u[p + 1]; p += 2; return v; };
  const vlq = () => { let v = 0, b; do { b = u[p++]; v = (v << 7) | (b & 127); } while (b & 128); return v; };
  if (str(4) !== 'MThd') throw new Error("That isn't a MIDI file");
  const hl = u32(); const fmt = u16(), ntr = u16(), div = u16(); p += hl - 6;
  if (div & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  const tracks = [], tempos = [], markers = []; let keySig = null;
  for (let t = 0; t < ntr && p < u.length; t++) {
    if (str(4) !== 'MTrk') break;
    const len = u32(), end = p + len; let tick = 0, run = 0; const tr = { name: '', events: [], program: -1, channel: -1 };
    while (p < end) {
      tick += vlq(); let st = u[p];
      if (st < 0x80) st = run; else { p++; if (st < 0xf0) run = st; }
      if (st === 0xff) {
        const type = u[p++], l = vlq(), d = u.subarray(p, p + l); p += l;
        if (type === 0x51) tempos.push({ tick, bpm: 60e6 / ((d[0] << 16) | (d[1] << 8) | d[2]) });
        else if (type === 0x03 && !tr.name) tr.name = new TextDecoder().decode(d);
        else if (type === 0x06 || type === 0x01 && /^(intro|verse|chorus|bridge|outro|solo|pre|break|drop|section|part)/i.test(new TextDecoder().decode(d))) markers.push({ tick, name: new TextDecoder().decode(d) });
        else if (type === 0x59 && !keySig) { const sf = (d[0] << 24) >> 24, mi = d[1]; keySig = { root: ((sf * 7) % 12 + 12 + (mi ? 9 : 0)) % 12, mode: mi ? 'minor' : 'major' }; }
      } else if (st === 0xf0 || st === 0xf7) { p += vlq(); }
      else {
        const hi = st & 0xf0, ch = st & 15, a = u[p++], b = hi === 0xc0 || hi === 0xd0 ? 0 : u[p++];
        if (hi === 0x90 && b > 0) tr.events.push({ tick, type: 'on', note: a, vel: b, ch });
        else if (hi === 0x80 || (hi === 0x90 && b === 0)) tr.events.push({ tick, type: 'off', note: a, ch });
        else if (hi === 0xc0 && tr.program < 0) tr.program = a;
        if (hi === 0x90 && tr.channel < 0) tr.channel = ch;
      }
    }
    p = end; tracks.push(tr);
  }
  return { format: fmt, ppq: div, tracks, tempos, markers, key: keySig };
}
export function songFromMidi(bytes, title = 'Imported') {
  const m = readMidi(bytes), ppq = m.ppq, beat = (tick) => tick / ppq, meter = 4;
  const song = emptySong(); song.title = title.replace(/\.midi?$/i, '');
  if (m.tempos.length) song.bpm = Math.round(m.tempos[0].bpm);
  const parts = m.tracks.filter((t) => t.events.some((e) => e.type === 'on')).map((t, i) => {
    const g = guessInstrument(t.name, t.program, t.channel);
    return { name: t.name || (g.drums ? 'Drums' : `Part ${i + 1}`), ...g, events: t.events.map((e) => ({ b: beat(e.tick), type: e.type, note: e.note, vel: e.vel })) };
  });
  const lastBeat = Math.max(0, ...parts.flatMap((p) => p.events.map((e) => e.b)));
  const totalBars = Math.max(1, Math.ceil(lastBeat / meter));
  // sections at the markers (on bar lines), or one section per 8 bars
  let cuts = m.markers.map((x) => ({ bar: Math.round(beat(x.tick) / meter), name: x.name })).filter((x, i, a) => x.bar < totalBars && (i === 0 || x.bar !== a[i - 1].bar));
  if (!cuts.length || cuts[0].bar !== 0) cuts.unshift({ bar: 0, name: cuts.length ? 'Intro' : 'Part 1' });
  if (cuts.length === 1 && totalBars > 8) cuts = Array.from({ length: Math.ceil(totalBars / 8) }, (_, i) => ({ bar: i * 8, name: `Part ${i + 1}` }));
  cuts.forEach((c, i) => {
    const bars = (cuts[i + 1]?.bar ?? totalBars) - c.bar, a = c.bar * meter, z = a + bars * meter;
    const sec = newSection(c.name.slice(0, 24), bars);
    for (const p of parts) {
      const ev = sliceEvents(p.events, a, z);
      if (ev.some((e) => e.type === 'on')) { const pid = 'l-' + p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'); sec.parts[pid] = { id: pid, name: p.name, lane: p.name, role: guessRole(p), inst: p.inst, patch: p.patch, drums: !!p.drums, takes: [{ id: 'seed', events: ev, by: 'import', byName: 'seed', at: 0 }], current: 'seed', by: 'import' }; }
    }
    sec.chords = chartFromParts(Object.values(sec.parts), bars, meter);
    song.sections[sec.id] = sec; song.order.push(sec.id);
  });
  if (m.key) song.key = m.key;
  else song.key = keyFromParts(parts);
  return song;
}
// the events in [a, z) beats, re-based to a; notes held over the end are cut at it
// ---------- automation: knob moves in a take ----------
// A take's events can hold knob moves, { b, type: 'p', id, v }, recorded as you play (always), or drawn: a drawn point
// with r: 1 ramps from the point before it. Each block starts from the track's settings plus the take's moves, and
// the moved knobs go back to the track's settings when the block ends.
export function movesOf(events) { let ids = null; for (const e of events || []) if (e.type === 'p') (ids = ids || new Set()).add(e.id); return ids; }
// the moves of one knob, in time order
export function lineOf(events, id) { return (events || []).filter((e) => e.type === 'p' && e.id === id).sort((a, b) => a.b - b.b); }
// a ramp between drawn points becomes small steps (every 1/32 note, at least 25 ms apart), so any instrument plays it
export function expandMoves(events, bpm = 120) {
  if (!(events || []).some((e) => e.type === 'p' && e.r)) return events || [];
  const out = [], step = Math.max(0.125, (0.025 * bpm) / 60), prev = new Map();
  for (const e of [...events].sort((a, b) => a.b - b.b)) {
    if (e.type !== 'p') { out.push(e); continue; }
    const p = prev.get(e.id);
    if (e.r && p && e.b - p.b > step) { for (let b = p.b + step; b < e.b - 1e-6; b += step) out.push({ b, type: 'p', id: e.id, v: p.v + ((e.v - p.v) * (b - p.b)) / (e.b - p.b) }); }
    const { r: _r, ...q } = e; out.push(q); prev.set(e.id, e);
  }
  return out.sort((a, b) => a.b - b.b);
}
export function sliceEvents(events, a, z) {
  const out = [], on = new Set();
  for (const e of [...events].sort((x, y) => x.b - y.b || (x.type === 'off' ? -1 : 1))) {
    if (e.b < a) { if (e.type === 'on') on.add(e.note); else if (e.type === 'off') on.delete(e.note); continue; }
    if (e.b >= z) break;
    if (e.type === 'p') out.push({ ...e, b: e.b - a });
    else if (e.type === 'on') { out.push({ ...e, b: e.b - a }); on.add(e.note); } else if (e.type === 'off') { if (out.some((x) => x.type === 'on' && x.note === e.note)) out.push({ ...e, b: e.b - a }); on.delete(e.note); }
  }
  const open = new Map(); for (const e of out) { if (e.type === 'on') open.set(e.note, (open.get(e.note) || 0) + 1); else open.set(e.note, (open.get(e.note) || 0) - 1); }
  for (const [n, c] of open) for (let i = 0; i < c; i++) out.push({ b: z - a - 0.01, type: 'off', note: n });
  return out;
}
function keyFromParts(parts) {
  const w = new Array(12).fill(0);
  for (const p of parts) if (!p.drums) for (const e of p.events) if (e.type === 'on') w[e.note % 12] += 1;
  const MAJ = [0, 2, 4, 5, 7, 9, 11]; let best = { root: 0, mode: 'major' }, bs = -1;
  for (let r = 0; r < 12; r++) { const s = MAJ.reduce((a, k) => a + w[(r + k) % 12], 0) + w[r] * 0.5; if (s > bs) { bs = s; best = { root: r, mode: 'major' }; } }
  // the relative minor if its tonic sounds more
  const rel = (best.root + 9) % 12; if (w[rel] > w[best.root] * 1.15) best = { root: rel, mode: 'minor' };
  return best;
}

// ---------- SynthLand Tracker songs in ----------
const noteNum = (s) => { const m = String(s).match(/^([A-G])([#b]?)(-?\d)$/); if (!m) return null; return 12 * (+m[3] + 1) + { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0); };
const MODE_OF = { major: 'major', ionian: 'major', minor: 'minor', aeolian: 'minor', dorian: 'dorian', mixolydian: 'mixolydian', phrygian: 'phrygian', lydian: 'lydian', blues: 'blues' };
export function songFromTracker(t) {
  if (!t || t.format !== 'tracker-song/0.1') throw new Error("That isn't a SynthLand Tracker song");
  const c = t.composition, spb = t.transport?.stepsPerBeat || 4, meter = 4, song = emptySong();
  song.title = t.meta?.title || 'Tracker song'; song.bpm = Math.round(t.transport?.bpm || 120);
  const jam = t.meta?.jam; if (jam?.root) { const r = noteNum(jam.root + '4'); if (r != null) song.key = { root: r % 12, mode: MODE_OF[String(jam.mode || '').toLowerCase()] || 'minor' }; }
  const insts = t.sound?.instruments || {};
  const names = new Map((c.song.sections || []).map((s) => [s.row, s.name]));
  c.song.rows.forEach((row, ri) => {
    // each track: its chain's phrases end to end, as notes; a note lasts until the next note or an OFF on its track
    let rowSteps = 0; const parts = [];
    for (const tr of c.tracks) {
      const chainId = row[tr.id]; if (!chainId) continue;
      const chain = c.chains[chainId]; if (!chain) continue;
      const steps = []; for (const r of chain.rows || []) { const ph = c.phrases[r.phrase]; if (ph) steps.push(...ph.steps); }
      rowSteps = Math.max(rowSteps, steps.length);
      const inst = insts[tr.instrument] || {}, label = `${tr.id} ${inst.plugin || ''} ${inst.preset || ''}`;
      const g = inst.drum ? { inst: 'machina', patch: '909', drums: true } : guessInstrument(label);
      const ev = []; let held = [];
      steps.forEach((st, i) => {
        if (!st || st.note == null) return;
        const b = (i + (st.fx?.nudge || 0)) / spb;
        for (const n of held) ev.push({ b, type: 'off', note: n });
        held = [];
        if (st.note === 'OFF') return;
        const ns = (Array.isArray(st.note) ? st.note : [st.note]).map(noteNum).filter((n) => n != null);
        const vel = Math.max(1, Math.min(127, Math.round((st.vel ?? 0.8) * 127)));
        for (let n of ns) { if (g.drums) n = DRUM_NOTE[inst.drum] ?? DRUM_NOTE[tr.id] ?? 36; ev.push({ b, type: 'on', note: n, vel }); held.push(n); }
        if (g.drums) { for (const n of held) ev.push({ b: b + 0.2, type: 'off', note: n }); held = []; }
      });
      for (const n of held) ev.push({ b: steps.length / spb - 0.01, type: 'off', note: n });
      if (ev.some((e) => e.type === 'on')) parts.push({ name: tr.id, ...g, events: ev });
    }
    const bars = Math.max(1, Math.round(rowSteps / spb / meter));
    const sec = newSection(String(names.get(ri) || `Part ${ri + 1}`).replace(/^./, (x) => x.toUpperCase()).slice(0, 24), bars);
    // drum tracks share one Machina part
    const drums = parts.filter((p) => p.drums), tonal = parts.filter((p) => !p.drums);
    const merged = drums.length ? [{ name: 'Drums', inst: 'machina', patch: '909', drums: true, events: drums.flatMap((p) => p.events).sort((a, b) => a.b - b.b) }] : [];
    for (const p of [...tonal, ...merged]) { const pid = 'l-' + p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'); const { events, ...rest } = p; sec.parts[pid] = { id: pid, ...rest, lane: p.name, role: guessRole(p), takes: [{ id: 'seed', events, by: 'import', byName: 'seed', at: 0 }], current: 'seed', by: 'import' }; }
    sec.chords = chartFromParts(tonal, bars, meter);
    song.sections[sec.id] = sec; song.order.push(sec.id);
  });
  return song;
}

// ---------- out ----------
// a type 1 MIDI file of the arrangement: one track per part name, the song's tempo and key, a marker per section
export function songToMidi(song) {
  const PPQ = 480, meter = song.meter || 4, tracks = new Map();
  let at = 0;
  const markers = [];
  for (const id of song.order) {
    const s = song.sections[id]; if (!s) continue;
    markers.push({ t: at, name: s.name });
    for (const p of Object.values(s.parts || {})) {
      const key = laneOf(p), c = { ...p, ...laneCfg(song, p) }; if (!tracks.has(key)) tracks.set(key, { name: laneName(song, p), drums: c.drums, ev: [] });   // one MIDI track per song track
      if (p.muted) continue;
      for (const e of currentTake(p)?.events || []) tracks.get(key).ev.push({ ...e, b: e.b + at });
    }
    at += s.bars * meter;
  }
  const vlq = (n) => { const b = [n & 127]; n >>>= 7; while (n) { b.unshift((n & 127) | 128); n >>>= 7; } return b; };
  const chunk = (evs) => { evs.sort((a, b) => a.t - b.t || a.o - b.o); const out = []; let last = 0; for (const e of evs) { out.push(...vlq(e.t - last), ...e.b); last = e.t; } out.push(0, 0xff, 0x2f, 0); return [0x4d, 0x54, 0x72, 0x6b, (out.length >>> 24) & 255, (out.length >>> 16) & 255, (out.length >>> 8) & 255, out.length & 255, ...out]; };
  const txt = (s) => [...new TextEncoder().encode(s)];
  const us = Math.round(60e6 / song.bpm);
  const sf = ((song.key.mode === 'minor' ? (song.key.root + 3) % 12 : song.key.root) * 7) % 12, sfs = sf > 6 ? sf - 12 : sf;
  const head = [{ t: 0, o: 0, b: [0xff, 0x03, ...vlq(song.title.length), ...txt(song.title)] }, { t: 0, o: 0, b: [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255] }, { t: 0, o: 0, b: [0xff, 0x59, 2, sfs & 255, song.key.mode === 'minor' ? 1 : 0] }, { t: 0, o: 0, b: [0xff, 0x58, 4, meter, 2, 24, 8] },
    ...markers.map((m) => ({ t: Math.round(m.t * PPQ), o: 0, b: [0xff, 0x06, ...vlq(txt(m.name).length), ...txt(m.name)] }))];
  const all = [chunk(head)];
  let next = 0;
  for (const tr of tracks.values()) {
    let c = 9; if (!tr.drums) { c = next % 16; next = next + 1 === 9 ? 10 : next + 1; }
    all.push(chunk([{ t: 0, o: 0, b: [0xff, 0x03, ...vlq(txt(tr.name).length), ...txt(tr.name)] }, ...tr.ev.filter((e) => e.type === 'on' || e.type === 'off').map((e) => ({ t: Math.round(e.b * PPQ), o: e.type === 'off' ? 1 : 2, b: e.type === 'on' ? [0x90 | c, e.note & 127, e.vel ?? 100] : [0x80 | c, e.note & 127, 0] }))]));
  }
  const hdr = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (all.length >> 8) & 255, all.length & 255, PPQ >> 8, PPQ & 255];
  return new Uint8Array([...hdr, ...all.flat()]);
}

// ---------- take lanes ----------
// A part (one lane of the arrangement, in one section) keeps every take anyone has locked into it, and one current
// take, the one that sounds. Changing the current take is stamped for a pass boundary (switchAt, in room beats), so
// the band hears it switch together: before switchAt the previous take plays.
export const ROLES = ['melody', 'comping', 'bass line', 'time', 'solo', 'pad', 'hits', 'backgrounds', 'texture'];
export function guessRole(p) {
  const n = `${p.name || ''} ${p.inst || ''} ${p.patch || ''}`.toLowerCase();
  if (p.drums || /drum|kit|kick|snare|hat|ride/.test(n)) return 'time';
  if (/bass|sub/.test(n)) return 'bass line';
  if (/pad|string|wash/.test(n)) return 'pad';
  if (/piano|keys|comp|organ|rhodes|guitar/.test(n)) return 'comping';
  if (/solo/.test(n)) return 'solo';
  return 'melody';
}
// older parts were one take
export function takesOf(p) { return p.takes && p.takes.length ? p.takes : p.events ? [{ id: 't0', events: p.events, by: p.by, byName: p.byName, at: 0 }] : []; }
export function currentTake(p, beat = Infinity) {
  const ts = takesOf(p); if (!ts.length) return null;
  const want = beat < (p.switchAt ?? -Infinity) ? p.prev : p.current;
  return ts.find((t) => t.id === want) || ts[ts.length - 1];
}
// who gets to pick: 'newest' (the latest take wins), 'owner' (the lane's owner picks), 'vote' (most votes, newest on ties)
export function pickCurrent(p, rule, votes = p.votes || {}) {
  const ts = takesOf(p); if (!ts.length) return null;
  if (rule === 'vote') { let best = ts[ts.length - 1], bv = -1; for (const t of ts) { const v = (votes[t.id] || []).length; if (v > bv || (v === bv && t.at >= best.at)) { best = t; bv = v; } } return best.id; }
  if (rule === 'owner') return p.current || ts[ts.length - 1].id;
  return ts[ts.length - 1].id;
}
// ---------- tracks ----------
// A track (song.lanes[id], like a track in a DAW) is one instrument in the song: its name, who made it, the
// instrument with its patch and knob settings, and whether it's muted. Its block in each section is a part keyed by
// the track's id, holding that section's takes; every take on a track plays on the track's instrument, so changing
// the instrument (or locking a take with a new patch) changes how the whole track sounds, as in a DAW.
// Songs from before tracks named lanes by a label ("Sam · Juniper · Keys"); upgradeLanes turns those into tracks.
export const laneOf = (p) => p.laneId || p.lane || p.name || p.id;   // which track a part belongs to
export const laneName = (song, p) => song?.lanes?.[p.laneId]?.name || p.lane || p.name || p.id;
const CFG = ['inst', 'patch', 'params', 'drums', 'hw', 'kind'];
export function laneCfg(song, p) { const t = song?.lanes?.[p.laneId]; if (!t) return {}; const o = {}; for (const k of CFG) if (t[k] !== undefined) o[k] = t[k]; return o; }
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'track';
// an older song (or an import) with label-named lanes: one track per label, each section's blocks for it merged into
// one (a rejoin used to leave two), and the same ids in every browser (from the label), so it can run anywhere
export function upgradeLanes(song) {
  const out = JSON.parse(JSON.stringify(song)); out.lanes = out.lanes || {};
  const byLabel = new Map(); let n = Object.keys(out.lanes).length;
  for (const id of out.order || []) {
    const sec = out.sections[id]; if (!sec) continue;
    const merged = {};
    for (const p of Object.values(sec.parts || {})) {
      if (p.laneId && out.lanes[p.laneId]) { merged[p.laneId] = merged[p.laneId] ? mergeParts(merged[p.laneId], p) : { ...p, id: p.laneId }; continue; }
      const label = p.lane || p.name || p.id;
      let lid = byLabel.get(label);
      if (!lid) {
        lid = p.id && !out.lanes[p.id] ? p.id : 't-' + slug(label); let k = 2; while (out.lanes[lid] && out.lanes[lid].name !== label) lid = 't-' + slug(label) + '-' + k++;   // keep the part's id where it can
        byLabel.set(label, lid);
        out.lanes[lid] = { id: lid, name: label, ownerName: p.byName && p.by !== 'import' ? p.byName : '', by: p.by || '', inst: p.inst, patch: p.patch, params: p.params || null, drums: !!p.drums, hw: p.hw || null, kind: p.kind || 'midi', role: p.role || guessRole(p), at: n++ };
      }
      const q = { ...p, id: lid, laneId: lid, lane: label };
      merged[lid] = merged[lid] ? mergeParts(merged[lid], q) : q;
    }
    sec.parts = merged;
  }
  return out;
}
function mergeParts(a, b) {
  const seen = new Set(takesOf(a).map((t) => t.id)), takes = [...takesOf(a), ...takesOf(b).filter((t) => !seen.has(t.id))].sort((x, y) => (x.at || 0) - (y.at || 0)).slice(-32);
  const newest = (takesOf(b).at(-1)?.at || 0) > (takesOf(a).at(-1)?.at || 0) ? b : a;
  return { ...a, takes, events: undefined, current: newest.current ?? takes.at(-1)?.id, prev: null, switchAt: null, votes: { ...(a.votes || {}), ...(b.votes || {}) } };
}
