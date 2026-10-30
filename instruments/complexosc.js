// Complex Osc Lite: a west-coast voice, a pared-down take on SynthLand's Complex Osc (CrumpLab). A principal
// oscillator that morphs from sine to triangle, frequency-modulated through zero by a modulator at a ratio of it,
// a wavefolder for timbre, and a low-pass gate that both opens the tone and the level as one, with a vactrol's
// quick-then-slow decay: pinged for bongos and plucks, or held for drones.
//
// Deterministic: no randomness.

const NAME = 'jj-complexosc-1';
const PARAMS = [
  { id: 'shape', name: 'Shape', min: 0, max: 1, def: 0.2, group: 'Oscillators' },
  { id: 'ratio', name: 'Mod ratio', min: 0.25, max: 8, def: 1.5, step: 0.25, group: 'Oscillators' },
  { id: 'index', name: 'FM index', min: 0, max: 8, def: 1.2, cc: 1, group: 'Oscillators' },
  { id: 'indexEnv', name: 'Index from gate', min: 0, max: 8, def: 2, group: 'Oscillators' },
  { id: 'fold', name: 'Timbre (fold)', min: 0, max: 1, def: 0.25, cc: 74, group: 'Oscillators' },
  { id: 'mode', name: 'Gate', options: ['Ping', 'Hold'], min: 0, max: 1, def: 0, step: 1, group: 'Low-pass gate' },
  { id: 'decay', name: 'Decay', min: 0.05, max: 4, def: 0.6, curve: 'exp', unit: 's', group: 'Low-pass gate' },
  { id: 'colour', name: 'Brightness', min: 0, max: 1, def: 0.6, cc: 71, group: 'Low-pass gate' },
  { id: 'reso', name: 'Ring', min: 0, max: 1, def: 0.2, group: 'Low-pass gate' },
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.7, cc: 7, group: 'Low-pass gate' },
];
const PRESETS = {
  bongo: { shape: 0, ratio: 1.5, index: 0.6, indexEnv: 1.5, fold: 0.1, mode: 0, decay: 0.35, colour: 0.45, reso: 0.35 },
  bell: { shape: 0.1, ratio: 3.5, index: 1.8, indexEnv: 3, fold: 0.35, mode: 0, decay: 2.2, colour: 0.75, reso: 0.1 },
  bubble: { shape: 0.3, ratio: 1, index: 2.5, indexEnv: 4, fold: 0.2, mode: 0, decay: 0.18, colour: 0.55, reso: 0.6 },
  wood: { shape: 0.8, ratio: 2.25, index: 0.8, indexEnv: 2, fold: 0.15, mode: 0, decay: 0.12, colour: 0.4, reso: 0.15 },
  bass: { shape: 0.6, ratio: 0.5, index: 1.5, indexEnv: 1, fold: 0.4, mode: 1, decay: 0.4, colour: 0.4, reso: 0.25 },
  drone: { shape: 0.4, ratio: 1.75, index: 2.2, indexEnv: 0, fold: 0.6, mode: 1, decay: 1.5, colour: 0.6, reso: 0.3, level: 0.55 },
};

const PROC = `
const SR = sampleRate, TAU = Math.PI * 2, NV = 6;
class ComplexOsc extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({}, o.processorOptions.params);
    this.q = []; this.alive = true;
    this.port.onmessage = (e) => { const m = e.data; if (m[0] === 9) { this.alive = false; return; } let i = this.q.length; while (i > 0 && this.q[i - 1][1] > m[1]) i--; this.q.splice(i, 0, m); };
    this.v = []; for (let i = 0; i < NV; i++) this.v.push({ note: -1, f: 0, cph: 0, mph: 0, env: 0, gate: false, vel: 1, age: 0, s1: 0, s2: 0, strike: 0 });
    this.clock = 0; this.bend = 0;
  }
  event(m) {
    const [type, , a, b] = m;
    if (type === 1) {
      let v = this.v.find((x) => x.note === a);
      if (!v) { const free = this.v.filter((x) => !x.gate); v = (free.length ? free : this.v).reduce((x, y) => (y.age < x.age ? y : x)); }
      if (v.env < 0.01) { v.cph = 0; v.mph = 0; v.s1 = 0; v.s2 = 0; }
      v.note = a; v.f = 440 * Math.pow(2, (a - 69) / 12); v.vel = b / 127; v.gate = true; v.age = ++this.clock; v.strike = 1;
    } else if (type === 0) { const v = this.v.find((x) => x.note === a && x.gate); if (v) v.gate = false; }
    else if (type === 2) { if (a === 'bend') this.bend = b; else this.p[a] = b; }
    else if (type === 3) { for (const v of this.v) v.gate = false; }
  }
  process(_, outputs) {
    if (!this.alive) return false;
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length, p = this.p, f0 = currentFrame;
    const hold = p.mode >= 0.5, bendM = Math.pow(2, this.bend / 12);
    // the vactrol: a fast first fall, then a long tail
    const kFast = Math.exp(-1 / (Math.max(0.01, p.decay * 0.25) * SR)), kSlow = Math.exp(-1 / (Math.max(0.02, p.decay) * SR)), kRel = Math.exp(-1 / (0.12 * SR));
    const kAtk = 1 - Math.exp(-1 / (0.0015 * SR)), foldG = 1 + p.fold * 5, q = 1.9 - p.reso * 1.75;
    for (let i = 0; i < n; i++) {
      while (this.q.length && this.q[0][1] <= f0 + i) this.event(this.q.shift());
      let x = 0;
      for (const v of this.v) {
        // gate envelope: strike to the velocity, then fall (or rest at 0.7 while held, in Hold)
        if (v.strike > 0) { v.env += (v.vel - v.env) * kAtk; if (v.env > v.vel * 0.98) v.strike = 0; }
        else if (hold && v.gate) v.env += (v.vel * 0.7 - v.env) * (1 - kSlow);
        else { const k = v.gate || hold ? (v.env > v.vel * 0.4 ? kFast : kSlow) : (v.env > v.vel * 0.4 ? kFast : kSlow); v.env *= hold && !v.gate ? kRel : k; }
        if (v.env < 1e-4 && v.strike === 0) continue;
        const f = v.f * bendM, fm = f * p.ratio;
        v.mph += fm / SR; v.mph -= Math.floor(v.mph);
        const mod = Math.sin(TAU * v.mph), idx = p.index + p.indexEnv * v.env;
        v.cph += (f + idx * fm * mod) / SR; v.cph -= Math.floor(v.cph);   // through-zero: the phase may run backwards
        const sn = Math.sin(TAU * v.cph), tri = 1 - 4 * Math.abs(v.cph - 0.5);
        let s = sn * (1 - p.shape) + tri * p.shape;
        s = Math.sin(s * foldG * Math.PI * 0.5);   // the folder
        // the low-pass gate: level and cutoff follow the same envelope
        const fc = Math.min(0.9, 2 * Math.sin(Math.PI * Math.min(0.45, (60 + Math.pow(v.env, 1.6) * (300 + p.colour * 11000)) / SR)));
        const hp = s - v.s1 - q * v.s2; v.s2 += fc * hp; v.s1 += fc * v.s2;
        x += v.s1 * v.env;
      }
      const y = Math.tanh(x * 0.5) * p.level;
      L[i] = y; R[i] = y;
    }
    return true;
  }
}
registerProcessor('${NAME}', ComplexOsc);
`;

export default {
  id: 'complexosc',
  name: 'Complex Osc Lite',
  family: 'West-coast complex oscillator',
  blurb: "A west-coast voice: a sine-to-triangle oscillator FM'd through zero by a modulator, a wavefolder, and a low-pass gate with a vactrol's decay, pinged for bongos and bells or held for drones. A lite version of SynthLand's Complex Osc.",
  lineage: 'SynthLand (CrumpLab) Complex Osc, pared down for MEGAjam',
  by: 'Matt',   // the full SynthLand instrument is Matt's design; this lite one credits him on its tile
  params: PARAMS,
  presets: PRESETS,
  presetNames: { bongo: 'Bongo', bell: 'Bell', bubble: 'Bubble', wood: 'Wood', bass: 'Folded bass', drone: 'Drone' },
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
