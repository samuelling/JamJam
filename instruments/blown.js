// Blown Lite: winds played by breath, a pared-down take on SynthLand's Blown (CrumpLab). A digital waveguide bore
// excited by a reed (clarinet, and a brighter, gruffer reed) or by an air jet across an edge (flute), with breath
// noise and a delayed vibrato. Velocity is how hard you blow. Not the full model: a cylindrical bore only, no tone
// holes, no lips (so no brass), no register key.
//
// Deterministic: the breath noise is seeded from each note.

const NAME = 'jj-blown-1';
const PARAMS = [
  { id: 'kind', name: 'Instrument', options: ['Clarinet', 'Flute', 'Gruff reed'], min: 0, max: 2, def: 0, step: 1, group: 'Breath' },
  { id: 'breath', name: 'Breath', min: 0.3, max: 1.2, def: 0.8, cc: 2, group: 'Breath' },
  { id: 'attack', name: 'Attack', min: 0.005, max: 0.5, def: 0.04, curve: 'exp', unit: 's', group: 'Breath' },
  { id: 'noise', name: 'Air', min: 0, max: 1, def: 0.25, group: 'Breath' },
  { id: 'vib', name: 'Vibrato', min: 0, max: 1, def: 0.3, cc: 1, group: 'Expression' },
  { id: 'vibRate', name: 'Vibrato rate', min: 3, max: 8, def: 5.2, unit: 'Hz', group: 'Expression' },
  { id: 'tone', name: 'Tone', min: 0.1, max: 1, def: 0.6, cc: 74, group: 'Expression' },
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.7, cc: 7, group: 'Expression' },
];
const PRESETS = {
  clarinet: { kind: 0, breath: 0.8, attack: 0.04, noise: 0.2, vib: 0.15, tone: 0.55 },
  flute: { kind: 1, breath: 0.85, attack: 0.06, noise: 0.45, vib: 0.45, tone: 0.7 },
  reed: { kind: 2, breath: 0.95, attack: 0.03, noise: 0.3, vib: 0.35, tone: 0.75 },
  breathy: { kind: 1, breath: 0.6, attack: 0.15, noise: 0.9, vib: 0.2, tone: 0.5 },
  lowreed: { kind: 0, breath: 0.95, attack: 0.02, noise: 0.15, vib: 0, tone: 0.35 },
};

const PROC = `
const SR = sampleRate, TAU = Math.PI * 2, NV = 4, MAXD = 4096;
class Bore {
  constructor() { this.b = new Float32Array(MAXD); this.w = 0; this.len = 100; }
  read() { const r = this.w - this.len + MAXD * 2, i = Math.floor(r), f = r - i; return this.b[i % MAXD] * (1 - f) + this.b[(i + 1) % MAXD] * f; }
  write(x) { this.b[this.w] = x; this.w = (this.w + 1) % MAXD; }
  clear() { this.b.fill(0); }
}
class Blown extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({}, o.processorOptions.params);
    this.q = []; this.alive = true;
    this.port.onmessage = (e) => { const m = e.data; if (m[0] === 9) { this.alive = false; return; } let i = this.q.length; while (i > 0 && this.q[i - 1][1] > m[1]) i--; this.q.splice(i, 0, m); };
    this.v = []; for (let i = 0; i < NV; i++) this.v.push({ note: -1, gate: false, age: 0, env: 0, vel: 0, bore: new Bore(), jet: new Bore(), lp: 0, dc: 0, dcx: 0, vibPh: 0, vibAmt: 0, seed: 1, on: false, f: 440 });
    this.clock = 0; this.bend = 0;
  }
  rnd(v) { let t = (v.seed = (v.seed + 0x6D2B79F5) | 0); t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1; }
  tune(v) {
    const f = v.f * Math.pow(2, this.bend / 12), kind = this.p.kind | 0;
    // a clarinet's closed tube sounds an octave below its length: half the period in each direction
    if (kind === 1) { v.bore.len = Math.max(2, SR / f - 2); v.jet.len = Math.max(2, v.bore.len * 0.32); }
    else v.bore.len = Math.max(2, SR / f / 2 - 1.5);
  }
  event(m) {
    const [type, , a, b] = m;
    if (type === 1) {
      let v = this.v.find((x) => x.note === a);
      if (!v) { const free = this.v.filter((x) => !x.gate); v = (free.length ? free : this.v).reduce((x, y) => (y.age < x.age ? y : x)); }
      if (!v.on) { v.bore.clear(); v.jet.clear(); v.lp = 0; v.dc = 0; v.dcx = 0; }
      v.note = a; v.f = 440 * Math.pow(2, (a - 69) / 12); v.vel = 0.55 + 0.45 * (b / 127); v.gate = true; v.on = true; v.age = ++this.clock; v.vibPh = 0; v.vibAmt = 0; v.seed = 31337 + a * 113 + b;
      this.tune(v);
    } else if (type === 0) { const v = this.v.find((x) => x.note === a && x.gate); if (v) v.gate = false; }
    else if (type === 2) { if (a === 'bend') { this.bend = b; for (const v of this.v) if (v.on) this.tune(v); } else this.p[a] = b; }
    else if (type === 3) { for (const v of this.v) v.gate = false; }
  }
  process(_, outputs) {
    if (!this.alive) return false;
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length, p = this.p, f0 = currentFrame, kind = p.kind | 0;
    const kA = 1 - Math.exp(-1 / (Math.max(0.003, p.attack) * SR)), kR = 1 - Math.exp(-1 / (0.06 * SR)), lpC = 0.15 + 0.8 * p.tone;
    for (let i = 0; i < n; i++) {
      while (this.q.length && this.q[0][1] <= f0 + i) this.event(this.q.shift());
      let x = 0;
      for (const v of this.v) {
        if (!v.on) continue;
        v.env += ((v.gate ? v.vel : 0) - v.env) * (v.gate ? kA : kR);
        if (!v.gate && v.env < 1e-4) { v.on = false; continue; }
        v.vibPh += p.vibRate / SR; if (v.vibPh >= 1) v.vibPh -= 1; v.vibAmt = Math.min(1, v.vibAmt + 1 / (0.5 * SR));
        const breath = p.breath * v.env * (1 + p.noise * 0.12 * this.rnd(v)) * (1 + p.vib * 0.035 * v.vibAmt * Math.sin(TAU * v.vibPh));
        let y;
        if (kind === 1) {
          // the flute: the jet across the embouchure, pushed by the bore's reflection, through a sigmoid
          const bo = v.bore.read();
          v.jet.write(breath + p.noise * 0.04 * this.rnd(v) * v.env - 0.5 * bo);
          let j = v.jet.read(); j = j * (j * j - 1); j = Math.max(-1, Math.min(1, j));
          v.lp += (j + 0.5 * bo - v.lp) * lpC;
          v.bore.write(v.lp);
          y = bo * 0.6;
        } else {
          // the reed: the pressure difference across it sets how far it opens (the reed table)
          const bo = v.bore.read();
          v.lp += (bo - v.lp) * lpC;
          const diff = -0.95 * v.lp - breath;
          const slope = kind === 2 ? -0.33 : -0.38, off = kind === 2 ? 0.72 : 0.7;
          const reed = Math.max(-1, Math.min(1, off + slope * diff));
          v.bore.write(breath + diff * reed);
          y = bo * (kind === 2 ? 0.55 : 0.45);
        }
        // block DC and gather
        const d = y - v.dcx + 0.995 * v.dc; v.dcx = y; v.dc = d;
        x += d;
      }
      const s = Math.tanh(x * 1.4) * p.level;
      L[i] = s; R[i] = s;
    }
    return true;
  }
}
registerProcessor('${NAME}', Blown);
`;

export default {
  id: 'blown',
  name: 'Blown Lite',
  family: 'Modelled winds',
  blurb: "Winds played by breath: a waveguide bore with a reed (clarinet, or a gruffer sax-like reed) or an air jet (flute), breath noise and a vibrato that creeps in. Play harder to blow harder. A lite version of SynthLand's Blown.",
  lineage: 'SynthLand (CrumpLab) Blown, pared down for MEGAjam',
  params: PARAMS,
  presets: PRESETS,
  presetNames: { clarinet: 'Clarinet', flute: 'Flute', reed: 'Gruff reed', breathy: 'Breathy flute', lowreed: 'Low reed' },
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
