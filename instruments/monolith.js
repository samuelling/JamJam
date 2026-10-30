// Monolith: a three-oscillator monosynth in the spirit of the classic 1970s American mono.
// Three band-limited oscillators with footage ranges and six waveforms, a noise source, a 4-pole transistor-ladder
// low-pass with contour and keyboard tracking, filter and loudness envelopes, glide, low- or last-note priority,
// single triggering (envelopes retrigger only after all keys are up), vibrato and output drive.
//
// Everything runs sample by sample inside an AudioWorklet and every event lands on an exact sample frame, so every
// jammer's copy makes the same sound. The only randomness (noise) comes from a fixed seed reset on each new gesture.

const NAME = 'jj-monolith-1';
const RANGES = ["32'", "16'", "8'", "4'", "2'"];
const WAVES = ['Triangle', 'Tri-saw', 'Saw', 'Square', 'Wide pulse', 'Narrow pulse'];

const PARAMS = [
  { id: 'osc1Range', name: 'Osc 1 range', options: RANGES, min: 0, max: 4, def: 2, step: 1, group: 'Oscillators' },
  { id: 'osc1Wave', name: 'Osc 1 wave', options: WAVES, min: 0, max: 5, def: 2, step: 1, group: 'Oscillators' },
  { id: 'osc2Range', name: 'Osc 2 range', options: RANGES, min: 0, max: 4, def: 2, step: 1, group: 'Oscillators' },
  { id: 'osc2Wave', name: 'Osc 2 wave', options: WAVES, min: 0, max: 5, def: 2, step: 1, group: 'Oscillators' },
  { id: 'osc2Detune', name: 'Osc 2 tune', min: -7, max: 7, def: 0.07, unit: 'st', group: 'Oscillators' },
  { id: 'osc3Range', name: 'Osc 3 range', options: RANGES, min: 0, max: 4, def: 1, step: 1, group: 'Oscillators' },
  { id: 'osc3Wave', name: 'Osc 3 wave', options: WAVES, min: 0, max: 5, def: 3, step: 1, group: 'Oscillators' },
  { id: 'osc3Detune', name: 'Osc 3 tune', min: -7, max: 7, def: -0.05, unit: 'st', group: 'Oscillators' },
  { id: 'mix1', name: 'Osc 1', min: 0, max: 1, def: 1, group: 'Mixer' },
  { id: 'mix2', name: 'Osc 2', min: 0, max: 1, def: 0.8, group: 'Mixer' },
  { id: 'mix3', name: 'Osc 3', min: 0, max: 1, def: 0.55, group: 'Mixer' },
  { id: 'noise', name: 'Noise', min: 0, max: 1, def: 0, group: 'Mixer' },
  { id: 'drive', name: 'Mixer drive', min: 0, max: 1, def: 0.35, group: 'Mixer' },
  { id: 'cutoff', name: 'Cutoff', min: 40, max: 16000, def: 700, curve: 'exp', unit: 'Hz', cc: 74, group: 'Filter' },
  { id: 'emphasis', name: 'Emphasis', min: 0, max: 1, def: 0.35, cc: 71, group: 'Filter' },
  { id: 'contour', name: 'Contour amount', min: 0, max: 1, def: 0.55, group: 'Filter' },
  { id: 'kbd', name: 'Key tracking', min: 0, max: 1, def: 0.33, group: 'Filter' },
  { id: 'fAttack', name: 'Filter attack', min: 0.001, max: 4, def: 0.004, curve: 'exp', unit: 's', group: 'Envelopes' },
  { id: 'fDecay', name: 'Filter decay', min: 0.01, max: 6, def: 0.45, curve: 'exp', unit: 's', group: 'Envelopes' },
  { id: 'fSustain', name: 'Filter sustain', min: 0, max: 1, def: 0.25, group: 'Envelopes' },
  { id: 'attack', name: 'Amp attack', min: 0.001, max: 4, def: 0.003, curve: 'exp', unit: 's', cc: 73, group: 'Envelopes' },
  { id: 'decay', name: 'Amp decay', min: 0.01, max: 6, def: 0.6, curve: 'exp', unit: 's', group: 'Envelopes' },
  { id: 'sustain', name: 'Amp sustain', min: 0, max: 1, def: 0.85, group: 'Envelopes' },
  { id: 'release', name: 'Release', min: 0.005, max: 6, def: 0.12, curve: 'exp', unit: 's', cc: 72, group: 'Envelopes' },
  { id: 'glide', name: 'Glide', min: 0, max: 1, def: 0, unit: 's', cc: 5, group: 'Performance' },
  { id: 'priority', name: 'Note priority', options: ['Low note', 'Last note'], min: 0, max: 1, def: 0, step: 1, group: 'Performance' },
  { id: 'vibrato', name: 'Vibrato (mod wheel)', min: 0, max: 1, def: 0, cc: 1, group: 'Performance' },
  { id: 'lfoRate', name: 'Vibrato rate', min: 0.5, max: 12, def: 5.5, unit: 'Hz', group: 'Performance' },
  { id: 'velAmt', name: 'Velocity', min: 0, max: 1, def: 0.25, group: 'Performance' },
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.7, cc: 7, group: 'Performance' },
];

const PRESETS = {
  lead:  { osc1Wave: 2, osc2Wave: 2, osc3Wave: 3, osc2Detune: 0.08, osc3Range: 2, osc3Detune: -0.07, mix3: 0.5, cutoff: 1100, emphasis: 0.45, contour: 0.5, fAttack: 0.004, fDecay: 0.6, fSustain: 0.35, attack: 0.003, decay: 0.5, sustain: 0.9, release: 0.18, glide: 0.06, priority: 1, drive: 0.45 },
  bass:  { osc1Range: 1, osc2Range: 1, osc3Range: 0, osc1Wave: 2, osc2Wave: 4, osc3Wave: 2, osc2Detune: 0.05, mix3: 0.7, cutoff: 380, emphasis: 0.3, contour: 0.65, kbd: 0.33, fAttack: 0.001, fDecay: 0.32, fSustain: 0.12, attack: 0.002, decay: 0.4, sustain: 0.8, release: 0.08, glide: 0, priority: 0, drive: 0.55 },
  brass: { osc1Wave: 2, osc2Wave: 2, osc3Wave: 2, osc2Detune: 0.12, osc3Detune: -0.1, cutoff: 600, emphasis: 0.15, contour: 0.6, fAttack: 0.09, fDecay: 0.7, fSustain: 0.55, attack: 0.04, decay: 0.8, sustain: 0.85, release: 0.25, glide: 0.02, drive: 0.3 },
  pluck: { osc1Wave: 3, osc2Wave: 2, osc3Wave: 0, osc3Range: 3, mix3: 0.3, cutoff: 300, emphasis: 0.55, contour: 0.85, fAttack: 0.001, fDecay: 0.2, fSustain: 0, attack: 0.001, decay: 0.35, sustain: 0, release: 0.2, drive: 0.25 },
  soft:  { osc1Wave: 0, osc2Wave: 0, osc3Wave: 1, osc2Range: 3, mix2: 0.4, mix3: 0.25, noise: 0.04, cutoff: 1400, emphasis: 0.1, contour: 0.2, fAttack: 0.12, fDecay: 1, fSustain: 0.7, attack: 0.08, decay: 1, sustain: 0.9, release: 0.5, glide: 0.12, priority: 1, vibrato: 0.25, drive: 0.1 },
};

const PROC = `
const SR = sampleRate;
const RANGE_OCT = [-2, -1, 0, 1, 2];
const tc = (s) => 1 - Math.exp(-1 / (Math.max(0.0005, s) * SR));
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
function osc(ph, dt, w) {
  switch (w) {
    case 0: return 1 - 4 * Math.abs(ph - 0.5);
    case 1: return 0.55 * (1 - 4 * Math.abs(ph - 0.5)) + 0.45 * (2 * ph - 1 - blep(ph, dt));
    case 2: return 2 * ph - 1 - blep(ph, dt);
    default: {
      const pw = w === 3 ? 0.5 : w === 4 ? 0.3 : 0.12;
      let v = ph < pw ? 1 : -1;
      v += blep(ph, dt); v -= blep((ph - pw + 1) % 1, dt);
      return v - (2 * pw - 1);
    }
  }
}
class Monolith extends AudioWorkletProcessor {
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
    this.ph = [0, 0, 0]; this.freq = 0; this.target = 0; this.stack = []; this.gate = false;
    this.fenv = 0; this.fst = 0; this.aenv = 0; this.ast = 0; this.vel = 1;
    this.y1 = 0; this.y2 = 0; this.y3 = 0; this.y4 = 0; this.ox = 0; this.o1 = 0; this.o2 = 0; this.o3 = 0;
    this.lfo = 0; this.bend = 0; this.seed = 1;
  }
  rnd() { let t = (this.seed = (this.seed + 0x6D2B79F5) | 0); t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1; }
  pick() { const s = this.stack; if (!s.length) return -1; return this.p.priority >= 0.5 ? s[s.length - 1] : Math.min(...s); }
  event(m) {
    const [type, , a, b] = m;
    if (type === 1) {
      this.stack = this.stack.filter((n) => n !== a); this.stack.push(a);
      const n = this.pick(), f = 440 * Math.pow(2, (n - 69) / 12);
      if (!this.gate) {
        this.gate = true; this.fst = 1; this.ast = 1; this.vel = b / 127; this.seed = 1000 + a * 7 + b;
        if (this.freq === 0 || this.p.glide <= 0) this.freq = f;
      }
      this.target = f;
    } else if (type === 0) {
      this.stack = this.stack.filter((n) => n !== a);
      if (!this.stack.length) { this.gate = false; this.fst = 3; this.ast = 3; }
      else this.target = 440 * Math.pow(2, (this.pick() - 69) / 12);
    } else if (type === 2) {
      if (a === 'bend') this.bend = b; else this.p[a] = b;
    } else if (type === 3) { this.stack = []; this.gate = false; this.fst = 3; this.ast = 3; }
  }
  env(v, st, A, D, S, R) {
    if (st === 1) { v += (1.25 - v) * tc(A / 2.2); if (v >= 1) { v = 1; st = 2; } }
    else if (st === 2) v += (S - v) * tc(D / 3);
    else if (st === 3) { v += (0 - v) * tc(R / 3); if (v < 1e-5) { v = 0; st = 0; } }
    return [v, st];
  }
  process(_, outputs) {
    if (!this.alive) return false;
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length, p = this.p;
    const glideC = p.glide > 0 ? tc(p.glide / 2.5) : 1;
    const f0 = currentFrame;
    const r1 = RANGE_OCT[p.osc1Range | 0], r2 = RANGE_OCT[p.osc2Range | 0], r3 = RANGE_OCT[p.osc3Range | 0];
    const m2 = Math.pow(2, r2 + p.osc2Detune / 12), m3 = Math.pow(2, r3 + p.osc3Detune / 12), m1 = Math.pow(2, r1);
    const w1 = p.osc1Wave | 0, w2 = p.osc2Wave | 0, w3 = p.osc3Wave | 0;
    const drive = 1 + p.drive * 4, level = p.level, kbd = p.kbd, res = Math.min(1.08, p.emphasis * 1.08);
    for (let i = 0; i < n; i++) {
      while (this.q.length && this.q[0][1] <= f0 + i) this.event(this.q.shift());
      if (this.ast === 0 && this.fst === 0 && !this.gate) { L[i] = R[i] = 0; continue; }
      this.freq += (this.target - this.freq) * glideC;
      this.lfo += p.lfoRate / SR; if (this.lfo >= 1) this.lfo -= 1;
      const vib = p.vibrato * 0.6 * (1 - 4 * Math.abs(this.lfo - 0.5));
      const fb = this.freq * Math.pow(2, (this.bend + vib) / 12);
      let mix = 0;
      const mul = [m1, m2, m3], wv = [w1, w2, w3], lv = [p.mix1, p.mix2, p.mix3];
      for (let k = 0; k < 3; k++) {
        const dt = Math.min(0.45, fb * mul[k] / SR);
        if (lv[k] > 0) mix += osc(this.ph[k], dt, wv[k]) * lv[k];
        this.ph[k] += dt; if (this.ph[k] >= 1) this.ph[k] -= 1;
      }
      if (p.noise > 0) mix += this.rnd() * p.noise * 0.8;
      const input = Math.tanh(mix * 0.45 * drive) / Math.tanh(drive * 0.6);
      [this.fenv, this.fst] = this.env(this.fenv, this.fst, p.fAttack, p.fDecay, p.fSustain, p.release);
      [this.aenv, this.ast] = this.env(this.aenv, this.ast, p.attack, p.decay, p.sustain, p.release);
      let fc = p.cutoff * Math.pow(2, p.contour * this.fenv * 5 + kbd * Math.log2(fb / 261.63));
      fc = Math.min(SR * 0.45, Math.max(20, fc));
      // 4-pole ladder, run twice per sample (2x oversampling)
      const f = (2 * fc) / (SR * 2), k = 3.6 * f - 1.6 * f * f - 1, pp = (k + 1) * 0.5;
      const r = res * Math.exp((1 - pp) * 1.386249);
      for (let s = 0; s < 2; s++) {
        const x = input - r * this.y4;
        this.y1 = x * pp + this.ox * pp - k * this.y1;
        this.y2 = this.y1 * pp + this.o1 * pp - k * this.y2;
        this.y3 = this.y2 * pp + this.o2 * pp - k * this.y3;
        this.y4 = this.y3 * pp + this.o3 * pp - k * this.y4;
        this.y4 -= (this.y4 * this.y4 * this.y4) / 6;
        this.ox = x; this.o1 = this.y1; this.o2 = this.y2; this.o3 = this.y3;
      }
      const amp = this.aenv * (1 - p.velAmt + p.velAmt * this.vel);
      const v = Math.tanh(this.y4 * amp * 1.6) * level * 0.8;
      L[i] = v; R[i] = v;
    }
    return true;
  }
}
registerProcessor('${NAME}', Monolith);
`;

export default {
  id: 'monolith',
  name: 'Monolith',
  family: 'Three-oscillator mono (ladder filter)',
  blurb: "Three oscillators in footage ranges, a mixer that overdrives, the 4-pole ladder filter, glide and single-trigger envelopes. Leads and bass that sit on top.",
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
      noteOff: (note, t) => node.port.postMessage([0, at(t), note, 0]),
      set: (id, v, t) => node.port.postMessage([2, at(t), id, v]),
      allOff: (t) => node.port.postMessage([3, at(t)]),
      dispose: () => { node.port.postMessage([9, 0]); node.disconnect(); },
    };
  },
};
