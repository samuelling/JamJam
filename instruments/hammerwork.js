// Hammerwork Lite: a modelled piano with no samples, a pared-down take on SynthLand's Hammerwork (CrumpLab). Each
// note is a set of stiff-string partials (stretched sharp by the string's stiffness, f_n = n f0 sqrt(1 + B n^2)),
// struck by a felt hammer whose spectrum brightens with velocity and has a notch where the hammer meets the string,
// with two slightly detuned strings per note beating against each other for the prompt sound and the aftersound,
// a damper on release, a hammer thump, and a small soundboard. Not the full model: no coupled strings, no
// sympathetic resonance, no hammer-string interaction in time.
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
const SR = sampleRate, TAU = Math.PI * 2, NV = 12, NP = 12;
const TAB = new Float32Array(4097); for (let i = 0; i <= 4096; i++) TAB[i] = Math.sin((i / 4096) * TAU);
const sine = (ph) => { const x = ph * 4096, i = x | 0, f = x - i; return TAB[i] + (TAB[i + 1] - TAB[i]) * f; };
class Hammerwork extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({}, o.processorOptions.params);
    this.q = []; this.alive = true;
    this.port.onmessage = (e) => { const m = e.data; if (m[0] === 9) { this.alive = false; return; } let i = this.q.length; while (i > 0 && this.q[i - 1][1] > m[1]) i--; this.q.splice(i, 0, m); };
    this.v = []; for (let i = 0; i < NV; i++) this.v.push({ note: -1, gate: false, age: 0, n: 0, inc: new Float64Array(NP * 2), ph: new Float64Array(NP * 2), a: new Float32Array(NP * 2), k: new Float32Array(NP * 2), damp: 1, dk: 1, thump: 0, seed: 1, pan: 0, tlp: 0 });
    this.clock = 0; this.b1 = [0, 0]; this.b2 = [0, 0]; this.b3 = [0, 0]; this.lpL = 0; this.lpR = 0;
  }
  rnd(v) { let t = (v.seed = (v.seed + 0x6D2B79F5) | 0); t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1; }
  strike(v, note, vel) {
    const p = this.p, f0 = 440 * Math.pow(2, (note - 69) / 12), velN = vel / 127;
    const B = 0.00004 * (0.3 + p.stretch * 2) * Math.pow(2, (note - 60) / 18);   // stiffness grows up the keyboard
    const nc = 1.5 + (2 + 10 * p.hard) * Math.pow(velN, 1.3), x0 = 1 / 8;          // hammer: brighter when harder; strikes at 1/8
    const T0 = p.decay * Math.max(0.8, 16 * Math.pow(2, -(note - 21) / 20));       // low strings ring longest
    const det = 1 + (0.0004 + p.unison * 0.0035);
    let m = 0;
    for (let k = 1; k <= NP; k++) {
      const fk = k * f0 * Math.sqrt(1 + B * k * k); if (fk > SR * 0.42) break;
      const amp = Math.pow(k, -0.6) * Math.exp(-Math.pow(k / nc, 2)) * Math.abs(Math.sin(Math.PI * k * x0)) * (0.35 + 0.65 * velN);
      const Tk = T0 / (1 + 0.35 * k + 0.002 * fk / 100);
      // two strings: one decays fast (prompt sound), the other slowly (aftersound), a few cents apart so they beat
      v.inc[m] = fk / SR; v.a[m] = amp * 0.6; v.k[m] = Math.exp(-1 / (Tk * 0.25 * SR)); v.ph[m] = 0; m++;
      v.inc[m] = (fk * det) / SR; v.a[m] = amp * 0.4; v.k[m] = Math.exp(-1 / (Tk * SR)); v.ph[m] = 0.25; m++;
    }
    v.n = m; v.note = note; v.gate = true; v.age = ++this.clock; v.damp = 1; v.dk = 1;
    v.thump = velN * (0.4 + 0.6 * p.hard); v.seed = 777 + note * 97 + vel; v.pan = Math.max(-0.6, Math.min(0.6, (note - 64) / 50)); v.tlp = 0;
  }
  event(m) {
    const [type, , a, b] = m;
    if (type === 1) {
      let v = this.v.find((x) => x.note === a);
      if (!v) { const free = this.v.filter((x) => !x.gate); v = (free.length ? free : this.v).reduce((x, y) => (y.age < x.age ? y : x)); }
      this.strike(v, a, b);
    } else if (type === 0) {
      const v = this.v.find((x) => x.note === a && x.gate);
      if (v) { v.gate = false; v.dk = a > 88 ? 1 : Math.exp(-1 / (this.p.damper * SR)); }   // the top octave has no dampers
    } else if (type === 2) this.p[a] = b;
    else if (type === 3) { for (const v of this.v) { v.gate = false; v.dk = Math.exp(-1 / (0.05 * SR)); } }
  }
  process(_, outputs) {
    if (!this.alive) return false;
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length, p = this.p, f0 = currentFrame;
    const lpC = 1 - Math.exp(-TAU * p.tone / SR), thK = Math.exp(-1 / (0.006 * SR)), thLp = 1 - Math.exp(-TAU * 180 / SR);
    // the soundboard: three broad resonances
    const bands = [[110, 1.2], [420, 1.6], [1900, 2.2]].map(([f, q]) => { const w = 2 * Math.sin(Math.PI * f / SR); return [w, 1 / q]; });
    for (let i = 0; i < n; i++) {
      while (this.q.length && this.q[0][1] <= f0 + i) this.event(this.q.shift());
      let l = 0, r = 0;
      for (const v of this.v) {
        if (v.n === 0) continue;
        let s = 0, alive = false;
        v.damp *= v.dk;
        for (let j = 0; j < v.n; j++) {
          const a = v.a[j]; if (a < 1e-5) continue; alive = true;
          let ph = v.ph[j] + v.inc[j]; ph -= Math.floor(ph); v.ph[j] = ph;
          s += sine(ph) * a; v.a[j] = a * v.k[j];
        }
        if (v.thump > 1e-4) { v.tlp += (this.rnd(v) * v.thump - v.tlp) * thLp; s += v.tlp * 0.8; v.thump *= thK; }
        s *= v.damp;
        if (!alive && v.thump < 1e-4 || v.damp < 1e-4) { v.n = 0; v.note = -1; continue; }
        l += s * (1 - v.pan); r += s * (1 + v.pan);
      }
      // soundboard colour, then the lid
      let bl = 0, br = 0;
      for (let k = 0; k < 3; k++) {
        const [w, q] = bands[k], st = this['b' + (k + 1)];
        const hpL = l - st[0] - q * st[1]; st[1] += w * hpL; st[0] += w * st[1];
        bl += st[1]; br += st[1];
      }
      l = l + bl * p.body * 0.35; r = r + br * p.body * 0.35;
      this.lpL += (l - this.lpL) * lpC; this.lpR += (r - this.lpR) * lpC;
      L[i] = Math.tanh(this.lpL * 0.18) * p.level * 1.6; R[i] = Math.tanh(this.lpR * 0.18) * p.level * 1.6;
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
