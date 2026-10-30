// Machina: a synthesis drum machine in the spirit of the late-90s Swedish "machine" drum computers.
// Nine voice slots on the General MIDI drum map. Each slot loads one of four synthesis machines:
//   TRX  analog-style circuits (pitch-swept sines, square-cluster metal, filtered noise)
//   EFM  FM percussion (phase-modulated sine pairs with decaying index)
//   PI   modal "physical" models (inharmonic partials of membranes, plates, bars and bells)
//   GND  raw ground sources (sine, noise, impulse)
// and every slot has pitch, decay, tone, snap, crush (sample-rate reduction), level and pan.
// Slots: kick 35/36 · snare 38/40 · clap 39 · rim 37 · closed hat 42/44 · open hat 46 (choked by closed) ·
// toms 41-50 · cymbals 49/51/57/59 · perc 56, plus every note from 60 up played chromatically on the perc slot.
//
// Sample-accurate and deterministic in an AudioWorklet: each hit's noise is seeded from the slot, note and velocity.

const NAME = 'jj-machina-1';
const MACHINES = ['TRX', 'EFM', 'PI', 'GND']; // analog circuits, FM, modal physics, raw sources
const SLOTS = [
  ['kick', 'Kick'], ['snare', 'Snare'], ['clap', 'Clap'], ['rim', 'Rim'], ['chh', 'Closed hat'],
  ['ohh', 'Open hat'], ['tom', 'Toms'], ['cym', 'Cymbals'], ['perc', 'Perc + keys'],
];

const PARAMS = [];
for (const [id, label] of SLOTS) {
  PARAMS.push(
    { id: `${id}.m`, name: 'Machine', options: MACHINES, min: 0, max: 3, def: 0, step: 1, group: label },
    { id: `${id}.pitch`, name: 'Pitch', min: -24, max: 24, def: 0, unit: 'st', group: label },
    { id: `${id}.decay`, name: 'Decay', min: 0.1, max: 4, def: 1, curve: 'exp', unit: '×', group: label },
    { id: `${id}.tone`, name: 'Tone', min: 0, max: 1, def: 0.5, group: label },
    { id: `${id}.snap`, name: 'Snap', min: 0, max: 1, def: 0.4, group: label },
    { id: `${id}.crush`, name: 'Crush', min: 0, max: 1, def: 0, group: label },
    { id: `${id}.level`, name: 'Level', min: 0, max: 1, def: 0.8, group: label },
    { id: `${id}.pan`, name: 'Pan', min: -1, max: 1, def: 0, group: label },
  );
}
PARAMS.push(
  { id: 'drive', name: 'Drive', min: 0, max: 1, def: 0.2, group: 'Master' },
  { id: 'bits', name: 'Bit depth', min: 4, max: 16, def: 16, step: 1, unit: 'bit', group: 'Master' },
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.85, cc: 7, group: 'Master' },
);

// kits (patch types): per-slot machine choices and settings
function kit(machines, over = {}) {
  const o = {};
  SLOTS.forEach(([id], i) => { o[`${id}.m`] = machines[i]; });
  for (const [k, v] of Object.entries(over)) o[k] = v;
  return o;
}
const PRESETS = {
  hybrid: kit([0, 1, 0, 2, 1, 1, 2, 2, 1], { 'kick.decay': 1.2, 'kick.snap': 0.5, 'snare.tone': 0.6, 'chh.tone': 0.6, 'perc.tone': 0.4, drive: 0.3, 'chh.pan': -0.25, 'ohh.pan': -0.25, 'tom.pan': 0.2, 'cym.pan': 0.3, 'perc.pan': 0.15 }),
  '808': kit([0, 0, 0, 0, 0, 0, 0, 0, 0], { 'kick.decay': 2, 'kick.tone': 0.15, 'kick.snap': 0.05, 'snare.snap': 0.45, 'snare.tone': 0.35, 'chh.tone': 0.2, 'chh.snap': 0.1, 'clap.tone': 0.3, drive: 0.1 }),
  '909': kit([0, 0, 0, 0, 0, 0, 0, 0, 0], { 'kick.decay': 0.8, 'kick.tone': 0.55, 'kick.snap': 0.75, 'kick.pitch': 2, 'snare.snap': 0.8, 'snare.tone': 0.65, 'chh.tone': 0.7, 'chh.snap': 0.65, 'ohh.snap': 0.65, drive: 0.35 }),
  efm: kit([1, 1, 1, 1, 1, 1, 1, 1, 1], { 'kick.tone': 0.3, 'snare.tone': 0.55, 'chh.tone': 0.7, 'cym.tone': 0.6, 'perc.tone': 0.5, drive: 0.25 }),
  acoustic: kit([2, 2, 2, 2, 2, 2, 2, 2, 2], { 'kick.tone': 0.3, 'snare.snap': 0.6, 'tom.decay': 1.4, 'cym.decay': 1.5, drive: 0.05, 'chh.pan': -0.3, 'ohh.pan': -0.3, 'tom.pan': 0.25, 'cym.pan': 0.35 }),
  lofi: kit([0, 3, 0, 3, 3, 3, 0, 3, 1], { 'kick.crush': 0.45, 'snare.crush': 0.55, 'chh.crush': 0.6, 'ohh.crush': 0.6, 'clap.crush': 0.4, 'perc.crush': 0.35, bits: 9, drive: 0.5 }),
};

const PROC = `
const SR = sampleRate;
const TAU = Math.PI * 2;
const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
const SLOT_OF = { 35: 0, 36: 0, 38: 1, 40: 1, 39: 2, 37: 3, 42: 4, 44: 4, 46: 5, 41: 6, 43: 6, 45: 6, 47: 6, 48: 6, 50: 6, 49: 7, 51: 7, 57: 7, 59: 7, 52: 7, 55: 7, 53: 7, 56: 8, 54: 8, 58: 8 };
const SLOT_IDS = ${JSON.stringify(SLOTS.map((s) => s[0]))};
const TOM = { 41: 82, 43: 98, 45: 110, 47: 131, 48: 147, 50: 165 };
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];
const kd = (sec) => Math.exp(-1 / (Math.max(0.002, sec) * SR)); // per-sample decay factor
function svfCoef(fc, q) { const g = Math.tan(Math.PI * Math.min(0.49, fc / SR)), k = 1 / q, a1 = 1 / (1 + g * (g + k)); return { k, a1, a2: g * a1, a3: g * g * a1 }; }
function svf(st, c, x) { const v3 = x - st.i2, v1 = c.a1 * st.i1 + c.a2 * v3, v2 = st.i2 + c.a2 * st.i1 + c.a3 * v3; st.i1 = 2 * v1 - st.i1; st.i2 = 2 * v2 - st.i2; return { lp: v2, bp: v1, hp: x - c.k * v1 - v2 }; }

// A hit is a recipe: sine partials, an FM pair, a square cluster, filtered noise and a click, with a pitch sweep.
function recipe(slot, m, P, note, vel) {
  const id = SLOT_IDS[slot], g = (k) => P[id + '.' + k];
  const pm = Math.pow(2, g('pitch') / 12), dec = g('decay'), tone = g('tone'), snap = g('snap');
  const r = { sines: [], fm: null, sq: null, noise: null, click: 0, pitch: 1, ptime: 0.02, bursts: 0 };
  const modal = (f0, ratios, amps, decs) => ratios.forEach((q, i) => r.sines.push({ f: f0 * q, a: amps[i], d: decs[i] }));
  const nz = (a, d, type, ff, q) => { r.noise = { a, d, type, ff, q }; };
  if (slot === 0) { // kick
    const f0 = 52 * pm;
    if (m === 0) { r.sines.push({ f: f0, a: 1, d: 0.45 * dec }); r.pitch = 2.6 + tone * 3; r.ptime = 0.03; nz(snap * 0.45, 0.006, 2, 1500, 0.7); }
    else if (m === 1) { r.fm = { fc: f0, ratio: 1 + Math.round(tone * 3), index: 2 + tone * 6, idec: 0.05 * dec, a: 1, d: 0.4 * dec }; r.pitch = 2.2; r.ptime = 0.02; r.click = snap * 0.4; }
    else if (m === 2) { modal(f0, [1, 1.59, 2.14, 2.3, 2.65], [1, 0.5 * tone, 0.35 * tone, 0.25 * tone, 0.15 * tone], [0.5 * dec, 0.25 * dec, 0.18 * dec, 0.15 * dec, 0.1 * dec]); r.pitch = 1.35; r.ptime = 0.012; nz(snap * 0.35, 0.012, 0, 1800, 0.7); }
    else { r.sines.push({ f: f0, a: 1, d: 0.5 * dec }); r.pitch = 1 + tone; r.ptime = 0.04; r.click = snap * 0.2; }
  } else if (slot === 1) { // snare
    const f0 = 185 * pm;
    if (m === 0) { r.sines.push({ f: f0, a: 0.55 * (1 - snap * 0.4), d: 0.12 * dec }, { f: f0 * 1.62, a: 0.3 * (1 - snap * 0.4), d: 0.08 * dec }); r.pitch = 1.4; nz(0.25 + snap * 0.6, 0.17 * dec, 2, 1500 + tone * 4000, 0.7); }
    else if (m === 1) { r.fm = { fc: f0, ratio: 2.3 + tone * 3, index: 4, idec: 0.04 * dec, a: 0.6, d: 0.12 * dec }; r.pitch = 1.3; nz(0.25 + snap * 0.5, 0.15 * dec, 1, 4000 + tone * 4000, 0.8); }
    else if (m === 2) { modal(f0, [1, 1.59, 2.14, 2.3, 2.65, 2.92], [0.6, 0.4, 0.3, 0.25, 0.2, 0.15], [0.16, 0.1, 0.08, 0.07, 0.06, 0.05].map((d) => d * dec)); nz(0.2 + snap * 0.6, 0.2 * dec, 1, 2500 + tone * 3000, 0.9); }
    else { nz(0.9, 0.18 * dec, 1, 1000 + tone * 6000, 0.6); r.click = snap * 0.3; }
  } else if (slot === 2) { // clap
    const ff = (1100 + tone * 1500) * pm;
    if (m === 0) { nz(0.9, 0.12 * dec, 1, ff, 1.5); r.bursts = 3; }
    else if (m === 1) { r.fm = { fc: ff, ratio: 3.7, index: 8, idec: 0.03, a: 0.5, d: 0.07 * dec }; nz(0.6, 0.1 * dec, 1, ff, 1.2); r.bursts = 3; }
    else if (m === 2) { modal(900 * pm, [1, 1.73, 2.4, 3.1], [0.5, 0.4, 0.3, 0.2], [0.04, 0.035, 0.03, 0.02].map((d) => d * dec)); nz(0.5, 0.09 * dec, 1, ff, 1.4); r.bursts = 3; }
    else { r.click = 0.8; nz(0.6 + snap * 0.3, 0.05 * dec, 1, ff, 1); }
  } else if (slot === 3) { // rim
    const f0 = 1700 * pm;
    if (m === 0) { r.sines.push({ f: f0, a: 0.6, d: 0.02 * dec }, { f: f0 * 0.29, a: 0.3, d: 0.015 * dec }); nz(snap * 0.4, 0.01, 1, 3000, 1); }
    else if (m === 1) { r.fm = { fc: f0 * 0.5, ratio: 3.1, index: 3 + tone * 3, idec: 0.01, a: 0.6, d: 0.03 * dec }; }
    else if (m === 2) { modal(900 * pm * (0.7 + tone * 0.6), [1, 2.57, 4.2], [0.6, 0.35, 0.2], [0.05, 0.03, 0.02].map((d) => d * dec)); r.click = snap * 0.3; }
    else { r.click = 1; nz(0.3, 0.008 * dec, 2, 4000, 0.7); }
  } else if (slot === 4 || slot === 5) { // hats
    const open = slot === 5, d = (open ? 0.32 : 0.055) * dec;
    if (m === 0) { r.sq = { fs: METAL.map((f) => f * pm * (1 + tone * 0.5)), a: 0.5 * (1 - snap * 0.5), d, hp: 7000 }; nz(snap * 0.5, d, 2, 8000, 0.7); }
    else if (m === 1) { r.fm = { fc: (3500 + tone * 3000) * pm, ratio: 2.83, index: 6, idec: d * 2, a: 0.35, d, hp: 6000 }; nz(snap * 0.3, d, 2, 9000, 0.7); }
    else if (m === 2) { modal(4200 * pm * (0.8 + tone * 0.4), [1, 1.47, 2.09, 2.56, 3.14, 3.71], [0.3, 0.25, 0.22, 0.2, 0.16, 0.12], [1, 0.9, 0.8, 0.7, 0.6, 0.5].map((x) => x * d)); nz(snap * 0.3, d, 2, 9000, 0.7); }
    else nz(0.6, d, 2, 6000 + tone * 4000, 0.7);
  } else if (slot === 6) { // toms
    const f0 = (TOM[note] || 110) * pm;
    if (m === 0) { r.sines.push({ f: f0, a: 0.8, d: 0.45 * dec }); r.pitch = 1.6 + tone; r.ptime = 0.06; nz(snap * 0.25, 0.02, 0, 2500, 0.7); }
    else if (m === 1) { r.fm = { fc: f0, ratio: 1.5, index: 2 + tone * 3, idec: 0.08, a: 0.8, d: 0.4 * dec }; r.pitch = 1.4; r.ptime = 0.05; }
    else if (m === 2) { modal(f0, [1, 1.59, 2.14, 2.3, 2.65], [0.8, 0.45 * tone + 0.1, 0.3, 0.2, 0.12], [0.5, 0.3, 0.22, 0.18, 0.12].map((x) => x * dec)); r.pitch = 1.15; r.ptime = 0.03; nz(snap * 0.25, 0.015, 0, 2000, 0.7); }
    else { r.sines.push({ f: f0, a: 0.8, d: 0.4 * dec }); r.pitch = 1 + tone * 0.6; r.ptime = 0.05; }
  } else if (slot === 7) { // cymbals: 49/57 crash, 51/59 ride
    const ride = note === 51 || note === 59, d = (ride ? 0.9 : 1.4) * dec;
    if (m === 0) { r.sq = { fs: METAL.map((f) => f * pm * (ride ? 1.3 : 1) * (1 + tone * 0.6)), a: 0.4, d, hp: ride ? 5500 : 4000 }; nz(0.3 + snap * 0.3, d * 0.7, 2, 6000, 0.7); }
    else if (m === 1) { r.fm = { fc: (ride ? 2600 : 1900) * pm, ratio: 3.41 + tone, index: 7, idec: d, a: 0.3, d, hp: 3000 }; nz(0.25, d * 0.6, 2, 7000, 0.7); }
    else if (m === 2) { const f0 = (ride ? 620 : 460) * pm; modal(f0, [1, 1.83, 2.61, 3.47, 4.39, 5.31, 6.68], [0.25, 0.22, 0.2, 0.18, 0.16, 0.14, 0.12], [1, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5].map((x) => x * d)); nz(0.2 + snap * 0.2, d * 0.5, 2, 6000, 0.7); }
    else nz(0.55, d, 2, 4000 + tone * 5000, 0.6);
  } else { // perc: 56 cowbell-ish, 60+ chromatic
    const f0 = (note >= 60 ? mtof(note) : 540) * pm;
    if (m === 0) { r.sq = { fs: [f0, f0 * 1.48], a: 0.45, d: 0.25 * dec, bp: f0 * 4.9 }; }
    else if (m === 1) { r.fm = { fc: f0, ratio: 3.5 - tone * 2, index: 1.5 + tone * 4, idec: 0.15 * dec, a: 0.6, d: 0.6 * dec }; }
    else if (m === 2) { const ratios = tone < 0.5 ? [1, 3.93, 9.54] : [1, 2.76, 5.4, 8.93]; modal(f0, ratios, [0.7, 0.3, 0.15, 0.08], ratios.map((_, i) => (0.5 / (1 + i * 1.5)) * dec)); r.click = snap * 0.2; }
    else { r.sines.push({ f: f0, a: 0.7, d: 0.2 * dec }); r.click = snap * 0.2; }
  }
  return r;
}

class Machina extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({}, o.processorOptions.params);
    this.q = []; this.alive = true;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m[0] === 9) { this.alive = false; return; }
      let i = this.q.length; while (i > 0 && this.q[i - 1][1] > m[1]) i--;
      this.q.splice(i, 0, m);
    };
    this.voices = new Array(9).fill(null);
    this.fade = []; // voices being cut off, faded over 2 ms to avoid clicks
  }
  trigger(note, vel) {
    let slot = SLOT_OF[note];
    if (slot === undefined) slot = note >= 60 ? 8 : note < 35 ? 0 : 3;
    if (slot === 4 && this.voices[5]) { this.fade.push(this.voices[5]); this.voices[5] = null; } // closed hat chokes open hat
    if (this.voices[slot]) this.fade.push(this.voices[slot]);
    const id = SLOT_IDS[slot], P = this.p, m = P[id + '.m'] | 0;
    const r = recipe(slot, m, P, note, vel);
    const k = Math.pow(vel / 127, 1.3);
    const v = { r, t: 0, k, seed: 9001 + slot * 131 + note * 7 + vel, level: P[id + '.level'], pan: P[id + '.pan'], crush: P[id + '.crush'], hold: 0, held: 0, holdN: 0 };
    v.sines = r.sines.map((s) => ({ ph: 0, f: s.f, a: s.a, e: 1, k: kd(s.d) }));
    if (r.fm) v.fm = { cph: 0, mph: 0, e: 1, k: kd(r.fm.d), ie: 1, ik: kd(r.fm.idec), hp: r.fm.hp ? svfCoef(r.fm.hp, 0.7) : null, st: { i1: 0, i2: 0 } };
    if (r.sq) v.sq = { ph: r.sq.fs.map(() => 0), e: 1, k: kd(r.sq.d), c: r.sq.bp ? svfCoef(r.sq.bp, 2) : svfCoef(r.sq.hp, 0.7), bp: !!r.sq.bp, st: { i1: 0, i2: 0 } };
    if (r.noise) v.nz = { e: 1, k: kd(r.noise.d), c: svfCoef(r.noise.ff, r.noise.q), st: { i1: 0, i2: 0 } };
    v.holdN = v.crush > 0 ? 1 + Math.round(v.crush * v.crush * 30) : 0;
    this.voices[slot] = v;
  }
  rnd(v) { let t = (v.seed = (v.seed + 0x6D2B79F5) | 0); t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1; }
  render(v) {
    const r = v.r, tt = v.t / SR;
    const pm = r.pitch !== 1 ? 1 + (r.pitch - 1) * Math.exp(-tt / r.ptime) : 1;
    let s = 0, alive = false;
    for (const o of v.sines) { o.ph += (o.f * pm) / SR; if (o.ph >= 1) o.ph -= Math.floor(o.ph); s += Math.sin(TAU * o.ph) * o.a * o.e; o.e *= o.k; if (o.e > 1e-4) alive = true; }
    if (v.fm) {
      const f = v.fm, F = r.fm;
      f.mph += (F.fc * F.ratio * pm) / SR; if (f.mph >= 1) f.mph -= Math.floor(f.mph);
      f.cph += (F.fc * pm) / SR; if (f.cph >= 1) f.cph -= Math.floor(f.cph);
      let x = Math.sin(TAU * f.cph + F.index * f.ie * Math.sin(TAU * f.mph)) * F.a * f.e;
      if (f.hp) x = svf(f.st, f.hp, x).hp;
      s += x; f.e *= f.k; f.ie *= f.ik; if (f.e > 1e-4) alive = true;
    }
    if (v.sq) {
      const q = v.sq; let x = 0;
      for (let i = 0; i < q.ph.length; i++) { q.ph[i] += (r.sq.fs[i] * pm) / SR; if (q.ph[i] >= 1) q.ph[i] -= 1; x += q.ph[i] < 0.5 ? 1 : -1; }
      x /= q.ph.length;
      const y = svf(q.st, q.c, x);
      s += (q.bp ? y.bp : y.hp) * r.sq.a * q.e; q.e *= q.k; if (q.e > 1e-4) alive = true;
    }
    if (v.nz) {
      const n = v.nz, N = r.noise, y = svf(n.st, n.c, this.rnd(v));
      let e = n.e;
      if (r.bursts) { const ms = tt * 1000; e = ms < 30 ? Math.exp(-((ms % 10) / 2.2)) * 0.9 : n.e; }
      s += (N.type === 0 ? y.lp : N.type === 1 ? y.bp * 2 : y.hp) * N.a * e; n.e *= n.k; if (n.e > 1e-4 || tt < 0.04) alive = true;
    }
    if (r.click && v.t < 48) s += r.click * (1 - v.t / 48) * (v.t % 2 ? -1 : 1) * 0.8;
    const att = v.t < 48 ? v.t / 48 : 1; // 1 ms de-click ramp (the click above stays sharp)
    s *= att * v.k * v.level;
    if (v.holdN) { if (v.hold++ % v.holdN === 0) v.held = s; s = v.held; }
    v.t++;
    v.done = !alive && v.t > SR * 0.01;
    return s;
  }
  process(_, outputs) {
    if (!this.alive) return false;
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length, P = this.p, f0 = currentFrame;
    const drive = 1 + P.drive * 5, norm = Math.tanh(drive * 0.7), lv = P.level, bits = P.bits | 0, qz = bits < 16 ? Math.pow(2, bits - 1) : 0;
    for (let i = 0; i < n; i++) {
      while (this.q.length && this.q[0][1] <= f0 + i) {
        const [type, , a, b] = this.q.shift();
        if (type === 1) this.trigger(a, b);
        else if (type === 2) this.p[a] = b;
      }
      let l = 0, r = 0;
      for (let s = 0; s < 9; s++) {
        const v = this.voices[s]; if (!v) continue;
        const x = this.render(v), pan = v.pan;
        l += x * Math.min(1, 1 - pan); r += x * Math.min(1, 1 + pan);
        if (v.done) this.voices[s] = null;
      }
      for (let j = this.fade.length - 1; j >= 0; j--) {
        const v = this.fade[j]; v.ff = (v.ff ?? 96) - 1;
        const x = this.render(v) * (v.ff / 96), pan = v.pan;
        l += x * Math.min(1, 1 - pan); r += x * Math.min(1, 1 + pan);
        if (v.ff <= 0 || v.done) this.fade.splice(j, 1);
      }
      l = Math.tanh(l * drive) / norm * lv * 0.8; r = Math.tanh(r * drive) / norm * lv * 0.8;
      if (qz) { l = Math.round(l * qz) / qz; r = Math.round(r * qz) / qz; }
      L[i] = l; R[i] = r;
    }
    return true;
  }
}
registerProcessor('${NAME}', Machina);
`;

export default {
  id: 'machina',
  name: 'Machina',
  family: 'Synthesis drum machine',
  blurb: "Nine drum slots on the GM map, each running one of four synthesis machines: analog TRX, FM, modal physics or raw ground. Crush, pan and drive per slot.",
  drums: true,
  // sequencer tracks (one per slot): the note each plays and a short label for the track keys
  seq: { tracks: [
    { id: 'kick', label: 'BD', note: 36 }, { id: 'snare', label: 'SD', note: 38 }, { id: 'clap', label: 'CP', note: 39 },
    { id: 'rim', label: 'RS', note: 37 }, { id: 'chh', label: 'CH', note: 42 }, { id: 'ohh', label: 'OH', note: 46 },
    { id: 'tom', label: 'TT', note: 45 }, { id: 'cym', label: 'CY', note: 49 }, { id: 'perc', label: 'PC', note: 60 },
  ] },
  params: PARAMS,
  presets: PRESETS,
  async init(ctx) {
    ctx.__jjWorklets = ctx.__jjWorklets || new Set();
    if (ctx.__jjWorklets.has(NAME)) return;
    const url = URL.createObjectURL(new Blob([PROC], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    ctx.__jjWorklets.add(NAME);
  },
  create(ctx, out, init = {}) {
    const params = {};
    for (const d of PARAMS) params[d.id] = init[d.id] ?? d.def;
    const node = new AudioWorkletNode(ctx, NAME, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { params } });
    node.connect(out);
    const at = (t) => Math.round(t * ctx.sampleRate);
    return {
      noteOn: (note, vel, t) => node.port.postMessage([1, at(t), note, vel]),
      noteOff: () => {},
      set: (id, v, t) => node.port.postMessage([2, at(t), id, v]),
      allOff: () => {},
      dispose: () => { node.port.postMessage([9, 0]); node.disconnect(); },
    };
  },
};
