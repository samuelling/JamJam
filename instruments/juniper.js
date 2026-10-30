// Juniper: a six-voice DCO polysynth in the spirit of the classic early-80s Japanese poly.
// One rock-steady DCO per voice (saw and pulse, switchable together, manual or LFO pulse-width), a sub-oscillator an
// octave down and noise; a four-position high-pass; a resonant 4-pole low-pass with envelope (either polarity), LFO
// and key follow; one ADSR for filter and amp (or gate for the amp); a delayed LFO; and the stereo bucket-brigade
// chorus with modes I, II and I+II.
//
// Runs sample by sample in an AudioWorklet with sample-accurate, timestamped events. Noise is seeded per voice.

const NAME = 'jj-juniper-1';

const PARAMS = [
  { id: 'range', name: 'Range', options: ["16'", "8'", "4'"], min: 0, max: 2, def: 1, step: 1, group: 'DCO' },
  { id: 'saw', name: 'Saw', options: ['Off', 'On'], min: 0, max: 1, def: 1, step: 1, group: 'DCO' },
  { id: 'pulse', name: 'Pulse', options: ['Off', 'On'], min: 0, max: 1, def: 0, step: 1, group: 'DCO' },
  { id: 'pw', name: 'Pulse width', min: 0, max: 1, def: 0.3, group: 'DCO' },
  { id: 'pwm', name: 'PW source', options: ['Manual', 'LFO'], min: 0, max: 1, def: 0, step: 1, group: 'DCO' },
  { id: 'sub', name: 'Sub osc', min: 0, max: 1, def: 0.3, group: 'DCO' },
  { id: 'noise', name: 'Noise', min: 0, max: 1, def: 0, group: 'DCO' },
  { id: 'lfoPitch', name: 'LFO → pitch', min: 0, max: 1, def: 0, cc: 1, group: 'DCO' },
  { id: 'hpf', name: 'HPF', options: ['0 (bass boost)', '1 (flat)', '2', '3'], min: 0, max: 3, def: 1, step: 1, group: 'Filter' },
  { id: 'cutoff', name: 'Cutoff', min: 40, max: 16000, def: 2200, curve: 'exp', unit: 'Hz', cc: 74, group: 'Filter' },
  { id: 'reso', name: 'Resonance', min: 0, max: 1, def: 0.15, cc: 71, group: 'Filter' },
  { id: 'envAmt', name: 'Env amount', min: 0, max: 1, def: 0.35, group: 'Filter' },
  { id: 'envPol', name: 'Env polarity', options: ['Normal', 'Inverted'], min: 0, max: 1, def: 0, step: 1, group: 'Filter' },
  { id: 'lfoFilter', name: 'LFO → filter', min: 0, max: 1, def: 0, group: 'Filter' },
  { id: 'kbd', name: 'Key follow', min: 0, max: 1, def: 0.5, group: 'Filter' },
  { id: 'attack', name: 'Attack', min: 0.0015, max: 3, def: 0.004, curve: 'exp', unit: 's', cc: 73, group: 'Envelope' },
  { id: 'decay', name: 'Decay', min: 0.002, max: 12, def: 0.9, curve: 'exp', unit: 's', group: 'Envelope' },
  { id: 'sustain', name: 'Sustain', min: 0, max: 1, def: 0.65, group: 'Envelope' },
  { id: 'release', name: 'Release', min: 0.002, max: 12, def: 0.45, curve: 'exp', unit: 's', cc: 72, group: 'Envelope' },
  { id: 'vca', name: 'VCA', options: ['Env', 'Gate'], min: 0, max: 1, def: 0, step: 1, group: 'Envelope' },
  { id: 'lfoRate', name: 'LFO rate', min: 0.1, max: 20, def: 3, curve: 'exp', unit: 'Hz', group: 'LFO & chorus' },
  { id: 'lfoDelay', name: 'LFO delay', min: 0, max: 3, def: 0, unit: 's', group: 'LFO & chorus' },
  { id: 'chorus', name: 'Chorus', options: ['Off', 'I', 'II', 'I + II'], min: 0, max: 3, def: 1, step: 1, cc: 93, group: 'LFO & chorus' },
  { id: 'velAmt', name: 'Velocity', min: 0, max: 1, def: 0.2, group: 'LFO & chorus' },
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.7, cc: 7, group: 'LFO & chorus' },
];

const PRESETS = {
  pad:     { saw: 1, pulse: 1, pw: 0.45, pwm: 1, sub: 0.25, cutoff: 1500, reso: 0.12, envAmt: 0.2, attack: 0.6, decay: 2, sustain: 0.85, release: 1.8, lfoRate: 0.6, chorus: 2, hpf: 1 },
  strings: { saw: 1, pulse: 0, sub: 0, cutoff: 3200, reso: 0.05, envAmt: 0.12, kbd: 0.7, attack: 0.35, decay: 1, sustain: 0.9, release: 1.1, chorus: 3, hpf: 2, lfoRate: 5, lfoPitch: 0.06, lfoDelay: 0.5 },
  keys:    { saw: 1, pulse: 0, sub: 0.35, cutoff: 1800, reso: 0.18, envAmt: 0.45, attack: 0.002, decay: 0.8, sustain: 0.45, release: 0.4, chorus: 1 },
  brass:   { saw: 1, pulse: 0, sub: 0.2, cutoff: 700, reso: 0.08, envAmt: 0.55, attack: 0.06, decay: 0.5, sustain: 0.7, release: 0.25, chorus: 1 },
  bass:    { range: 0, saw: 0, pulse: 1, pw: 0.15, pwm: 0, sub: 0.8, cutoff: 420, reso: 0.3, envAmt: 0.5, kbd: 0.3, attack: 0.0015, decay: 0.35, sustain: 0.3, release: 0.08, chorus: 0, hpf: 0 },
  pluck:   { saw: 1, pulse: 1, pw: 0.2, sub: 0.2, cutoff: 500, reso: 0.35, envAmt: 0.7, attack: 0.0015, decay: 0.3, sustain: 0, release: 0.3, chorus: 1 },
  lead:    { saw: 1, pulse: 1, pw: 0.35, pwm: 1, sub: 0.15, cutoff: 2600, reso: 0.3, envAmt: 0.3, attack: 0.004, decay: 0.6, sustain: 0.8, release: 0.2, lfoRate: 5.5, lfoPitch: 0.08, lfoDelay: 0.4, chorus: 1 },
};

const PROC = `
const SR = sampleRate;
const tc = (s) => 1 - Math.exp(-1 / (Math.max(0.0005, s) * SR));
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
const NV = 6;
const ahead = (env, attack, late) => (late > 0 && attack > 1.5 * late ? Math.max(env, Math.min(1, 1.25 * (1 - Math.exp(-late / (attack / 2.2))))) : env);
class Juniper extends AudioWorkletProcessor {
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
    this.v = [];
    for (let i = 0; i < NV; i++) this.v.push({ note: -1, f: 0, ph: 0, sph: 0, env: 0, st: 0, gate: false, vel: 1, age: 0, y1: 0, y2: 0, y3: 0, y4: 0, ox: 0, o1: 0, o2: 0, o3: 0, seed: i * 977 });
    this.clock = 0; this.lfoPh = 0; this.lfoAmp = 0; this.held = 0; this.bend = 0;
    this.hp = 0; this.hpx = 0; this.lb = 0;
    const len = Math.ceil(SR * 0.03); this.buf = new Float32Array(len); this.w = 0; this.cph = 0; this.wl = 0; this.wr = 0;
  }
  rnd(v) { let t = (v.seed = (v.seed + 0x6D2B79F5) | 0); t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1; }
  event(m) {
    const [type, , a, b, late] = m;
    if (type === 1) {
      // reuse this note's voice, else the longest-released free voice, else steal the oldest
      let v = this.v.find((x) => x.note === a);
      if (!v) { const free = this.v.filter((x) => !x.gate); v = (free.length ? free : this.v).reduce((x, y) => (y.age < x.age ? y : x)); }
      if (this.held === 0) this.lfoAmp = 0; // the LFO delay starts over when a phrase starts
      this.held++;
      v.note = a; v.f = 440 * Math.pow(2, (a - 69) / 12); v.vel = b / 127; v.gate = true; v.st = 1; v.age = ++this.clock;
      v.env = ahead(v.env, this.p.attack, late || 0);
      v.seed = 4242 + a * 31 + b;
    } else if (type === 0) {
      const v = this.v.find((x) => x.note === a && x.gate);
      if (v) { v.gate = false; v.st = 3; v.age = ++this.clock; this.held = Math.max(0, this.held - 1); }
    } else if (type === 2) { if (a === 'bend') this.bend = b; else this.p[a] = b; }
    else if (type === 3) { for (const v of this.v) { if (v.gate) { v.gate = false; v.st = 3; } } this.held = 0; }
  }
  process(_, outputs) {
    if (!this.alive) return false;
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length, p = this.p, f0 = currentFrame;
    const A = tc(p.attack / 2.2), D = tc(p.decay / 3), Rl = tc(p.release / 3), S = p.sustain;
    const oct = Math.pow(2, (p.range | 0) - 1), saw = p.saw >= 0.5, pul = p.pulse >= 0.5, sub = p.sub, nz = p.noise;
    const res = p.reso * 1.05, pol = p.envPol >= 0.5 ? -1 : 1, gateVca = p.vca >= 0.5;
    const lfoDelayC = tc(Math.max(0.01, p.lfoDelay) / 2);
    const ch = p.chorus | 0;
    const cRate = ch === 1 ? 0.513 : ch === 2 ? 0.863 : 9.75, cDepth = ch === 3 ? 0.00035 : ch === 2 ? 0.00185 : 0.00165, cBase = ch === 3 ? 0.0033 : 0.0035;
    const hpf = p.hpf | 0, hpC = hpf === 2 ? tc(1 / (2 * Math.PI * 240)) : hpf === 3 ? tc(1 / (2 * Math.PI * 720)) : tc(1 / (2 * Math.PI * 90));
    const buf = this.buf, blen = buf.length;
    for (let i = 0; i < n; i++) {
      while (this.q.length && this.q[0][1] <= f0 + i) this.event(this.q.shift());
      this.lfoPh += p.lfoRate / SR; if (this.lfoPh >= 1) this.lfoPh -= 1;
      this.lfoAmp += ((this.held > 0 ? 1 : this.lfoAmp) - this.lfoAmp) * (p.lfoDelay > 0 ? lfoDelayC : 1);
      const lfo = (1 - 4 * Math.abs(this.lfoPh - 0.5)) * this.lfoAmp;
      const pitchMod = Math.pow(2, (this.bend + lfo * p.lfoPitch * 0.5) / 12) * oct;
      const pw = 0.5 - 0.45 * Math.min(1, Math.max(0, p.pwm >= 0.5 ? p.pw * (0.5 + 0.5 * lfo) : p.pw));
      let sum = 0;
      for (const v of this.v) {
        if (v.st === 0) continue;
        if (v.st === 1) { v.env += (1.25 - v.env) * A; if (v.env >= 1) { v.env = 1; v.st = 2; } }
        else if (v.st === 2) v.env += (S - v.env) * D;
        else { v.env += -v.env * Rl; if (v.env < 1e-5) { v.env = 0; v.st = 0; v.y1 = v.y2 = v.y3 = v.y4 = v.ox = v.o1 = v.o2 = v.o3 = 0; continue; } }
        const f = v.f * pitchMod, dt = Math.min(0.45, f / SR);
        let s = 0;
        if (saw) s += 2 * v.ph - 1 - blep(v.ph, dt);
        if (pul) { let q = v.ph < pw ? 1 : -1; q += blep(v.ph, dt); q -= blep((v.ph - pw + 1) % 1, dt); s += q - (2 * pw - 1); }
        if (sub > 0) { const sdt = dt / 2; let q = v.sph < 0.5 ? 1 : -1; q += blep(v.sph, sdt); q -= blep((v.sph + 0.5) % 1, sdt); s += q * sub; }
        if (nz > 0) s += this.rnd(v) * nz;
        v.ph += dt; if (v.ph >= 1) v.ph -= 1; v.sph += dt * 0.5; if (v.sph >= 1) v.sph -= 1;
        let fc = p.cutoff * Math.pow(2, pol * p.envAmt * v.env * 6 + p.lfoFilter * lfo * 2 + p.kbd * Math.log2(f / 261.63));
        fc = Math.min(SR * 0.45, Math.max(20, fc));
        const ff = (2 * fc) / (SR * 2), k = 3.6 * ff - 1.6 * ff * ff - 1, pp = (k + 1) * 0.5, r = res * Math.exp((1 - pp) * 1.386249);
        const x0 = Math.tanh(s * 0.5);
        for (let o = 0; o < 2; o++) {
          const x = x0 - r * v.y4;
          v.y1 = x * pp + v.ox * pp - k * v.y1;
          v.y2 = v.y1 * pp + v.o1 * pp - k * v.y2;
          v.y3 = v.y2 * pp + v.o2 * pp - k * v.y3;
          v.y4 = v.y3 * pp + v.o3 * pp - k * v.y4;
          v.y4 -= (v.y4 * v.y4 * v.y4) / 6;
          v.ox = x; v.o1 = v.y1; v.o2 = v.y2; v.o3 = v.y3;
        }
        const amp = (gateVca ? (v.gate ? 1 : v.env > 0.001 ? v.env : 0) : v.env) * (1 - p.velAmt + p.velAmt * v.vel);
        sum += v.y4 * amp;
      }
      // high-pass section (position 0 adds a little bass instead)
      this.lb += (sum - this.lb) * hpC;
      let y = hpf === 0 ? sum + this.lb * 0.5 : hpf === 1 ? sum : sum - this.lb;
      y = Math.tanh(y * 0.55) * p.level;
      // bucket-brigade chorus: a short delay swept by a triangle LFO, opposite phase left and right, darkened
      let l = y, rr = y;
      if (ch > 0) {
        buf[this.w] = y;
        this.cph += cRate / SR; if (this.cph >= 1) this.cph -= 1;
        const tri = 1 - 4 * Math.abs(this.cph - 0.5);
        const dl = (cBase + cDepth * tri) * SR, dr = (cBase - cDepth * tri) * SR;
        const tap = (d) => { let pos = this.w - d; while (pos < 0) pos += blen; const i0 = pos | 0, fr = pos - i0; return buf[i0] * (1 - fr) + buf[(i0 + 1) % blen] * fr; };
        this.wl += (tap(dl) - this.wl) * 0.45; this.wr += (tap(dr) - this.wr) * 0.45;
        l = (y + this.wl) * 0.75; rr = (y + this.wr) * 0.75;
        this.w = (this.w + 1) % blen;
      }
      L[i] = l; R[i] = rr;
    }
    return true;
  }
}
registerProcessor('${NAME}', Juniper);
`;

export default {
  id: 'juniper',
  name: 'Juniper',
  family: 'Six-voice DCO poly with chorus',
  blurb: "Six DCO voices with saw, pulse/PWM, sub and noise, a resonant 4-pole filter, delayed LFO and the stereo bucket-brigade chorus. Pads, strings, stabs, bass.",
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
      // late: how late this browser got the note (s); a slow attack then starts where it would be by now
      noteOn: (note, vel, t, _at, late = 0) => node.port.postMessage([1, at(t), note, vel, late]),
      noteOff: (note, t) => node.port.postMessage([0, at(t), note, 0]),
      set: (id, v, t) => node.port.postMessage([2, at(t), id, v]),
      allOff: (t) => node.port.postMessage([3, at(t)]),
      dispose: () => { node.port.postMessage([9, 0]); node.disconnect(); },
    };
  },
};
