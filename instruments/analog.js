// Analog Drums Lite: an analog drum machine in the step-programmer tradition, a pared-down take on SynthLand's
// Analog Drums (CrumpLab). Pinged resonators for the kick, toms, rim and cowbell, a two-mode snare with its
// noise "snappy", a clap of noise bursts, and hats and cymbal from six detuned square waves through a band-pass,
// the closed hat choking the open one. Plays the General MIDI drum map.
//
// Deterministic: each hit's noise is seeded from its slot, note and velocity.

const NAME = 'jj-analog-1';
const PARAMS = [
  { id: 'kickTune', name: 'Kick tune', min: 35, max: 90, def: 52, unit: 'Hz', group: 'Kick & snare' },
  { id: 'kickDecay', name: 'Kick decay', min: 0.1, max: 2, def: 0.55, curve: 'exp', unit: 's', group: 'Kick & snare' },
  { id: 'kickPunch', name: 'Kick punch', min: 0, max: 1, def: 0.5, group: 'Kick & snare' },
  { id: 'snareTone', name: 'Snare tone', min: 0, max: 1, def: 0.5, group: 'Kick & snare' },
  { id: 'snappy', name: 'Snappy', min: 0, max: 1, def: 0.6, group: 'Kick & snare' },
  { id: 'tomTune', name: 'Tom tune', min: -12, max: 12, def: 0, unit: 'st', group: 'Toms & metal' },
  { id: 'hatDecay', name: 'Hat decay', min: 0.2, max: 3, def: 1, curve: 'exp', unit: '×', group: 'Toms & metal' },
  { id: 'hatTone', name: 'Hat tone', min: 0, max: 1, def: 0.5, group: 'Toms & metal' },
  { id: 'drive', name: 'Drive', min: 0, max: 1, def: 0.2, group: 'Toms & metal' },
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.8, cc: 7, group: 'Toms & metal' },
];
const PRESETS = {
  classic: {},
  boom: { kickTune: 45, kickDecay: 1.4, kickPunch: 0.3, snareTone: 0.35, snappy: 0.5, hatDecay: 0.8 },
  tight: { kickTune: 62, kickDecay: 0.3, kickPunch: 0.8, snareTone: 0.65, snappy: 0.8, hatDecay: 0.6, hatTone: 0.7, drive: 0.35 },
  dusty: { kickTune: 50, kickDecay: 0.5, kickPunch: 0.4, snareTone: 0.4, snappy: 0.4, hatTone: 0.3, drive: 0.6, level: 0.7 },
  vintage: { kickTune: 58, kickDecay: 0.4, kickPunch: 0.2, snareTone: 0.55, snappy: 0.3, tomTune: 3, hatDecay: 0.5, hatTone: 0.4 },
};

const PROC = `
const SR = sampleRate, TAU = Math.PI * 2;
// note -> voice: kick, snare, clap, rim, closed hat, open hat, tom (pitched), cymbal, cowbell
const KIND = { 35: 'kick', 36: 'kick', 38: 'snare', 40: 'snare', 39: 'clap', 37: 'rim', 42: 'ch', 44: 'ch', 46: 'oh', 49: 'cym', 51: 'cym', 57: 'cym', 59: 'cym', 52: 'cym', 55: 'cym', 53: 'cym', 56: 'bell',
  41: 'tom', 43: 'tom', 45: 'tom', 47: 'tom', 48: 'tom', 50: 'tom' };
const TOM_HZ = { 41: 82, 43: 98, 45: 115, 47: 138, 48: 165, 50: 196 };
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];   // six squares, in the classic inharmonic spread
class Analog extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({}, o.processorOptions.params);
    this.q = []; this.alive = true;
    this.port.onmessage = (e) => { const m = e.data; if (m[0] === 9) { this.alive = false; return; } let i = this.q.length; while (i > 0 && this.q[i - 1][1] > m[1]) i--; this.q.splice(i, 0, m); };
    this.voices = []; this.mph = new Float64Array(6);
  }
  rnd(v) { let t = (v.seed = (v.seed + 0x6D2B79F5) | 0); t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1; }
  event(m) {
    const [type, , a, b] = m;
    if (type === 2) { this.p[a] = b; return; }
    if (type !== 1) return;
    const kind = KIND[a]; if (!kind) return;
    const p = this.p, vel = b / 127, acc = 0.4 + 0.6 * vel;
    if (kind === 'ch') for (const v of this.voices) if (v.kind === 'oh') v.k = Math.exp(-1 / (0.008 * SR));   // choke
    // one of each kind at a time (a new hit restarts it), toms by pitch
    this.voices = this.voices.filter((v) => !(v.kind === kind && (kind !== 'tom' || v.note === a)));
    const v = { kind, note: a, t: 0, g: acc, seed: 4211 + a * 53 + b, ph: 0, ph2: 0, s1: 0, s2: 0, s3: 0, s4: 0, lp: 0 };
    const hd = p.hatDecay;
    if (kind === 'kick') { v.f = p.kickTune; v.k = Math.exp(-1 / (p.kickDecay * 0.3 * SR)); }
    else if (kind === 'snare') { v.k = Math.exp(-1 / (0.06 * SR)); v.kn = Math.exp(-1 / ((0.08 + 0.12 * p.snappy) * SR)); v.f = 175 + 60 * p.snareTone; }
    else if (kind === 'clap') { v.k = Math.exp(-1 / (0.12 * SR)); }
    else if (kind === 'rim') { v.k = Math.exp(-1 / (0.012 * SR)); v.f = 1700; }
    else if (kind === 'ch') { v.k = Math.exp(-1 / (0.035 * hd * SR)); }
    else if (kind === 'oh') { v.k = Math.exp(-1 / (0.32 * hd * SR)); }
    else if (kind === 'cym') { v.k = Math.exp(-1 / (0.9 * hd * SR)); }
    else if (kind === 'bell') { v.k = Math.exp(-1 / (0.09 * SR)); }
    else if (kind === 'tom') { v.f = (TOM_HZ[a] || 120) * Math.pow(2, p.tomTune / 12); v.k = Math.exp(-1 / (0.22 * SR)); }
    v.e = 1; this.voices.push(v);
  }
  svf(v, x, f, q) { const w = 2 * Math.sin(Math.PI * Math.min(0.45, f / SR)); const hp = x - v.s1 - q * v.s2; v.s2 += w * hp; v.s1 += w * v.s2; return { lp: v.s1, bp: v.s2, hp }; }
  process(_, outputs) {
    if (!this.alive) return false;
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length, p = this.p, f0 = currentFrame;
    const drive = 1 + p.drive * 4, hatF = 6500 + p.hatTone * 4500;
    for (let i = 0; i < n; i++) {
      while (this.q.length && this.q[0][1] <= f0 + i) this.event(this.q.shift());
      // the shared metal oscillators (always running, like the chip's)
      let metal = 0; for (let k = 0; k < 6; k++) { this.mph[k] += METAL[k] / SR; if (this.mph[k] >= 1) this.mph[k] -= 1; metal += this.mph[k] < 0.5 ? 1 : -1; }
      metal /= 6;
      let l = 0, r = 0;
      for (const v of this.voices) {
        const tt = v.t / SR; v.t++;
        let s = 0, pan = 0;
        if (v.kind === 'kick') {
          const f = v.f * (1 + 2.2 * p.kickPunch * Math.exp(-tt / 0.012) + 0.4 * Math.exp(-tt / 0.06));
          v.ph += f / SR; s = Math.sin(TAU * v.ph) * v.e * 1.1 + (tt < 0.002 ? this.rnd(v) * 0.4 * p.kickPunch : 0);
        } else if (v.kind === 'snare') {
          v.ph += v.f / SR; v.ph2 += (v.f * 1.87) / SR;
          const tone = (Math.sin(TAU * v.ph) * 0.6 + Math.sin(TAU * v.ph2) * 0.4) * v.e;
          v.en = (v.en ?? 1) * v.kn; const nz = this.svf(v, this.rnd(v), 5000, 1.2).hp * v.en * p.snappy * 1.1;
          s = tone * (1 - 0.4 * p.snappy) + nz;
        } else if (v.kind === 'clap') {
          const burst = tt < 0.03 ? (Math.floor(tt / 0.01) % 1 === 0 ? Math.exp(-(tt % 0.01) / 0.003) : 0) : 0;
          const env = burst * 0.9 + (tt > 0.02 ? v.e : 0);
          s = this.svf(v, this.rnd(v), 1100, 0.9).bp * env * 2.2; pan = -0.15;
        } else if (v.kind === 'rim') { v.ph += v.f / SR; s = Math.sin(TAU * v.ph) * v.e * 0.7 + this.rnd(v) * v.e * 0.15; pan = 0.1; }
        else if (v.kind === 'ch' || v.kind === 'oh' || v.kind === 'cym') {
          const f = v.kind === 'cym' ? hatF * 0.7 : hatF, b = this.svf(v, metal + this.rnd(v) * (v.kind === 'cym' ? 0.4 : 0.15), f, 0.7);
          v.lp += (b.bp - v.lp) * 0.5; s = (b.bp - v.lp * 0.3) * v.e * (v.kind === 'cym' ? 1.2 : 1.6); pan = v.kind === 'cym' ? 0.35 : -0.3;
        } else if (v.kind === 'bell') {
          v.ph += 540 / SR; v.ph2 += 800 / SR;
          const sq = (v.ph % 1 < 0.5 ? 1 : -1) + (v.ph2 % 1 < 0.5 ? 1 : -1);
          s = this.svf(v, sq * 0.5, 2600, 1.4).bp * v.e * 1.4; pan = 0.2;
        } else if (v.kind === 'tom') {
          const f = v.f * (1 + 0.25 * Math.exp(-tt / 0.03)); v.ph += f / SR; s = Math.sin(TAU * v.ph) * v.e + this.rnd(v) * 0.05 * v.e;
          pan = Math.max(-0.4, Math.min(0.4, (v.f - 130) / 150));
        }
        v.e *= v.k; s *= v.g;
        l += s * (1 - pan); r += s * (1 + pan);
      }
      this.voices = this.voices.filter((v) => v.e > 1e-4 || v.t < SR * 0.04);
      L[i] = Math.tanh(l * drive * 0.6) * p.level; R[i] = Math.tanh(r * drive * 0.6) * p.level;
    }
    return true;
  }
}
registerProcessor('${NAME}', Analog);
`;

export default {
  id: 'analog',
  name: 'Analog Drums Lite',
  family: 'Analog drum machine',
  blurb: "An analog drum machine: a pinged kick with punch, a snare with snappy noise, a clap, rim, toms, a cowbell, and hats and cymbal from six detuned squares, the closed hat choking the open. A lite version of SynthLand's Analog Drums.",
  lineage: 'SynthLand (CrumpLab) Analog Drums, pared down for MEGAjam',
  drums: true,
  seq: { tracks: [
    { id: 'kick', label: 'BD', note: 36 }, { id: 'snare', label: 'SD', note: 38 }, { id: 'clap', label: 'CP', note: 39 }, { id: 'rim', label: 'RS', note: 37 },
    { id: 'ch', label: 'CH', note: 42 }, { id: 'oh', label: 'OH', note: 46 }, { id: 'tom', label: 'LT', note: 45 }, { id: 'tomh', label: 'HT', note: 50 },
    { id: 'cym', label: 'CY', note: 49 }, { id: 'bell', label: 'CB', note: 56 },
  ] },
  params: PARAMS,
  presets: PRESETS,
  presetNames: { classic: 'Classic', boom: 'Boom', tight: 'Tight', dusty: 'Dusty', vintage: 'Vintage' },
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
