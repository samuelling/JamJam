// Hammerwork Lite: a modelled piano with no samples, a pared-down take on SynthLand's Hammerwork (CrumpLab). Each
// note is up to 32 stiff-string partials (stretched sharp by the string's stiffness, f_n = n f0 sqrt(1 + B n^2),
// supple in the bass and stiff in the treble), struck by a felt hammer whose contact rolls the highs off steeply
// when soft and opens up when hard, with a notch where it meets the string. Two strings per note, a few cents apart,
// give the prompt sound and the long aftersound and beat against each other. Then the hammer's knock, the key bed's
// thump, dampers that take the highs first, and a little soundboard. Not the full model: no coupled strings in
// time, no sympathetic resonance, no hammer-string interaction.
//
// Deterministic: no randomness except the thump, seeded from each note.

const NAME = 'jj-hammerwork-1';
const PARAMS = [
  { id: 'hard', name: 'Hammer', min: 0, max: 1, def: 0.5, cc: 74, group: 'Piano' },
  { id: 'decay', name: 'Sustain', min: 0.3, max: 2, def: 1, group: 'Piano' },
  { id: 'damper', name: 'Damper', min: 0.03, max: 0.6, def: 0.12, curve: 'exp', unit: 's', group: 'Piano' },
  { id: 'stretch', name: 'Stiffness', min: 0, max: 1, def: 0.5, group: 'Piano' },
  { id: 'unison', name: 'String detune', min: 0, max: 1, def: 0.3, group: 'Piano' },
  { id: 'body', name: 'Soundboard', min: 0, max: 1, def: 0.5, group: 'Room' },
  { id: 'tone', name: 'Lid', min: 1500, max: 16000, def: 9000, curve: 'exp', unit: 'Hz', group: 'Room' },
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.75, cc: 7, group: 'Room' },
];
const PRESETS = {
  grand: {},
  bright: { hard: 0.8, tone: 14000, body: 0.4 },
  mellow: { hard: 0.25, tone: 4500, body: 0.65, decay: 1.2 },
  felt: { hard: 0.05, tone: 2600, body: 0.7, damper: 0.25, decay: 0.8, unison: 0.15 },
  honky: { hard: 0.6, unison: 1, tone: 7000, body: 0.3, decay: 0.8 },
  upright: { hard: 0.55, stretch: 0.8, decay: 0.7, body: 0.35, tone: 7500 },
};

const PROC = `
const SR = sampleRate, TAU = Math.PI * 2, NV = 10, NPMAX = 32;
// Each partial is a decaying sine made by a two-pole resonator (y = a1 y1 - a2 y2): two multiplies a sample, and
// its decay is built in. Every partial has two of them, one per string of the pair, a few cents apart and decaying
// at different rates: the fast one is the piano's prompt sound, the slow one its aftersound, and their beating is
// what makes a held piano note breathe.
class Hammerwork extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({}, o.processorOptions.params);
    this.q = []; this.alive = true;
    this.port.onmessage = (e) => { const m = e.data; if (m[0] === 9) { this.alive = false; return; } let i = this.q.length; while (i > 0 && this.q[i - 1][1] > m[1]) i--; this.q.splice(i, 0, m); };
    const M = NPMAX * 2;
    this.v = []; for (let i = 0; i < NV; i++) this.v.push({ note: -1, gate: false, age: 0, n: 0, y1: new Float64Array(M), y2: new Float64Array(M), a1: new Float64Array(M), a2: new Float64Array(M), w: new Float64Array(M), Td: new Float64Array(M), knock: 0, thump: 0, thPh: 0, thF: 70, nz: 0, seed: 1, pan: 0, kc: 0, k1: 0, k2: 0, level: 0, dead: true, rel: 0 });
    this.clock = 0; this.held = 0;
    this.bands = [[95, 1.4], [220, 1.8], [480, 2.2], [1150, 2.6]].map(() => [0, 0]);
    this.er = new Float32Array(2048); this.ew = 0; this.lpL = 0; this.lpR = 0;
  }
  rnd(v) { let t = (v.seed = (v.seed + 0x6D2B79F5) | 0); t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1; }
  setOsc(v, j, f, amp, T, keep) {
    const w = TAU * f / SR, r = Math.exp(-1 / (T * SR));
    v.w[j] = w; v.a1[j] = 2 * r * Math.cos(w); v.a2[j] = r * r;
    // starts at zero phase with amplitude amp; a string struck again while it still rings keeps ringing under the new blow
    const y1 = -amp * Math.sin(w) / r, y2 = -amp * Math.sin(2 * w) / (r * r);
    if (keep) { v.y1[j] += y1; v.y2[j] += y2; } else { v.y1[j] = y1; v.y2[j] = y2; }
  }
  strike(v, note, vel) {
    const p = this.p, f0 = 440 * Math.pow(2, (note - 69) / 12), velN = vel / 127;
    // stiffness: the wound bass strings are supple, the short treble strings stiff
    const B = 0.00012 * (0.4 + p.stretch * 1.6) * Math.pow(2, (note - 60) / 12 * 1.1);
    // the hammer: a softer, slower contact at low velocity rolls the highs off steeply; it strikes at 1/8 of the string
    const nc = (2.5 + 20 * p.hard) * Math.pow(velN, 1.5) + 2, x0 = 0.12 + 0.01 * ((note * 7) % 5) / 5;
    const T0 = p.decay * Math.min(24, Math.max(0.7, 26 * Math.pow(2, -(note - 21) / 13)));
    const cents = 0.6 + p.unison * 6;
    const NP = note < 40 ? 32 : note < 64 ? 24 : note < 84 ? 16 : 10;
    let m = 0, norm = 0;
    const keep = v.note === note && !v.dead;
    for (let k = 1; k <= NP; k++) {
      const fk = k * f0 * Math.sqrt(1 + B * k * k); if (fk > SR * 0.45) break;
      const hammer = 1 / (1 + Math.pow(k / nc, 3)), notch = Math.abs(Math.sin(Math.PI * k * x0)) * 0.85 + 0.15;
      const amp = Math.pow(k, -0.55) * hammer * notch;
      const Tk = T0 / (1 + 0.12 * k + 0.0009 * k * k * f0 / 100);
      const det = Math.pow(2, (cents * (0.6 + 0.4 * ((k * 13 + note) % 7) / 7)) / 1200);
      this.setOsc(v, m++, fk, amp * 0.62, Tk * 0.18, keep);       // prompt sound: most of the energy, short
      this.setOsc(v, m++, fk * det, amp * 0.38, Tk, keep);       // aftersound: less of it, long, a little sharp
      v.Td[m - 2] = Tk; v.Td[m - 1] = Tk;
      norm += amp;
    }
    v.n = m; v.note = note; v.gate = true; v.age = ++this.clock; v.dead = false; v.rel = 0;
    v.level = Math.pow(velN, 1.6) * 0.42 * (1 + Math.max(0, note - 64) / 50) / Math.max(1, Math.sqrt(norm));
    v.knock = velN * (0.25 + 0.6 * p.hard); v.thump = velN * 0.6; v.thPh = 0; v.thF = 55 + f0 * 0.15;
    v.seed = 777 + note * 97 + vel; v.pan = Math.max(-0.55, Math.min(0.55, (note - 64) / 48));
    const kf = Math.min(0.9, 2 * Math.sin(Math.PI * Math.min(5000, 900 + f0 * 3) / SR)); v.kc = kf; v.k1 = 0; v.k2 = 0;
  }
  damp(v) {
    // dampers: felt on the strings; the highs go first. The top keys have no dampers.
    if (v.note > 88) return;
    const tau = Math.max(0.03, this.p.damper);
    for (let j = 0; j < v.n; j++) { const r = Math.exp(-1 / ((tau / (1 + j * 0.03)) * SR)), w = v.w[j]; v.a1[j] = 2 * r * Math.cos(w); v.a2[j] = r * r; }
    v.rel = 0.4;   // the damper's own soft thud
  }
  event(m) {
    const [type, , a, b] = m;
    if (type === 1) {
      let v = this.v.find((x) => x.note === a);
      if (!v) { const free = this.v.filter((x) => !x.gate); v = (free.length ? free : this.v).reduce((x, y) => (y.age < x.age ? y : x)); }
      this.strike(v, a, b);
    } else if (type === 0) { const v = this.v.find((x) => x.note === a && x.gate); if (v) { v.gate = false; this.damp(v); } }
    else if (type === 2) this.p[a] = b;
    else if (type === 3) { for (const v of this.v) if (v.gate) { v.gate = false; this.damp(v); } }
  }
  process(_, outputs) {
    if (!this.alive) return false;
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length, p = this.p, f0 = currentFrame;
    const lpC = 1 - Math.exp(-TAU * p.tone / SR), knK = Math.exp(-1 / (0.004 * SR)), thK = Math.exp(-1 / (0.035 * SR)), relK = Math.exp(-1 / (0.02 * SR));
    const bandW = [95, 220, 480, 1150].map((f) => 2 * Math.sin(Math.PI * f / SR)), bandQ = [1 / 1.4, 1 / 1.8, 1 / 2.2, 1 / 2.6];
    const body = p.body;
    for (let i = 0; i < n; i++) {
      while (this.q.length && this.q[0][1] <= f0 + i) this.event(this.q.shift());
      let l = 0, r = 0, hits = 0;
      for (const v of this.v) {
        if (v.dead) continue;
        const a1 = v.a1, a2 = v.a2, y1 = v.y1, y2 = v.y2;
        let s = 0, e = 0;
        for (let j = 0; j < v.n; j++) { const y = a1[j] * y1[j] - a2[j] * y2[j]; y2[j] = y1[j]; y1[j] = y; s += y; e += y > 0 ? y : -y; }
        s *= v.level;
        // the hammer's knock (a short band of noise) and the key bed's thump, as the hammer lands
        if (v.knock > 1e-4) { const x = this.rnd(v) * v.knock; const hp = x - v.k1 - 0.7 * v.k2; v.k2 += v.kc * hp; v.k1 += v.kc * v.k2; s += v.k2 * 0.35; v.knock *= knK; }
        if (v.thump > 1e-4) { v.thPh += v.thF / SR; s += Math.sin(TAU * v.thPh) * v.thump * 0.12; v.thump *= thK; }
        if (v.rel > 1e-4) { s += this.rnd(v) * v.rel * 0.01; v.rel *= relK; }
        hits += s;
        l += s * (1 - v.pan); r += s * (1 + v.pan);
        if (e * v.level < 1e-5 && v.knock < 1e-4 && v.thump < 1e-4 && !v.gate) { v.dead = true; v.note = -1; }
      }
      // the soundboard: a few broad resonances driven by everything, and two early reflections from the lid
      let bsum = 0;
      for (let k = 0; k < 4; k++) { const st = this.bands[k]; const hp = hits - st[0] - bandQ[k] * st[1]; st[1] += bandW[k] * hp; st[0] += bandW[k] * st[1]; bsum += st[1]; }
      this.er[this.ew] = hits; const e1 = this.er[(this.ew - Math.round(0.0047 * SR) + 2048) & 2047], e2 = this.er[(this.ew - Math.round(0.0113 * SR) + 2048) & 2047]; this.ew = (this.ew + 1) & 2047;
      const bodyL = bsum * body * 0.12 + (e1 * 0.18 + e2 * 0.1) * body, bodyR = bsum * body * 0.12 + (e1 * 0.1 + e2 * 0.18) * body;
      this.lpL += (l + bodyL - this.lpL) * lpC; this.lpR += (r + bodyR - this.lpR) * lpC;
      L[i] = Math.tanh(this.lpL * 0.9) * p.level; R[i] = Math.tanh(this.lpR * 0.9) * p.level;
    }
    return true;
  }
}
registerProcessor('${NAME}', Hammerwork);
`;

export default {
  id: 'hammerwork',
  name: 'Hammerwork Lite',
  family: 'Modelled piano',
  blurb: "A piano with no samples: stiff-string partials struck by a felt hammer that brightens as you play harder, two strings per note beating against each other, dampers and a soundboard. A lite version of SynthLand's Hammerwork.",
  lineage: 'SynthLand (CrumpLab) Hammerwork, pared down for MEGAjam',
  by: 'Matt',   // the full SynthLand instrument is Matt's design; this lite one credits him on its tile
  params: PARAMS,
  presets: PRESETS,
  presetNames: { grand: 'Grand', bright: 'Bright', mellow: 'Mellow', felt: 'Felt', honky: 'Honky-tonk', upright: 'Upright' },
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
      noteOff: (note, t) => node.port.postMessage([0, at(t), note, 0]),
      set: (id, v, t) => node.port.postMessage([2, at(t), id, v]),
      allOff: (t) => node.port.postMessage([3, at(t)]),
      dispose: () => { node.port.postMessage([9, 0]); node.disconnect(); },
    };
  },
};
