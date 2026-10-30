// Chip Lite: a home-computer sound chip voice, a pared-down take on SynthLand's Chip SID (CrumpLab). Triangle, saw,
// pulse (with PWM) or LFSR noise oscillators, chip-style envelopes, one multimode resonant filter after the mix, a
// crunch control, and the classic chip arpeggio: hold a chord and one voice races through its notes.
//
// Deterministic: the arpeggio counts from the moment the chord began (a note's own time), and the noise is a
// shift register reset on every note.

const NAME = 'jj-chip-1';
const PARAMS = [
  { id: 'wave', name: 'Wave', options: ['Triangle', 'Saw', 'Pulse', 'Noise'], min: 0, max: 3, def: 2, step: 1, group: 'Voice' },
  { id: 'pw', name: 'Pulse width', min: 0.05, max: 0.95, def: 0.35, group: 'Voice', cc: 71 },
  { id: 'pwm', name: 'PWM', min: 0, max: 0.4, def: 0.15, group: 'Voice' },
  { id: 'pwmRate', name: 'PWM rate', min: 0.05, max: 8, def: 0.6, curve: 'exp', unit: 'Hz', group: 'Voice' },
  { id: 'vib', name: 'Vibrato', min: 0, max: 1, def: 0.15, cc: 1, group: 'Voice' },
  { id: 'attack', name: 'Attack', min: 0.001, max: 2, def: 0.005, curve: 'exp', unit: 's', group: 'Envelope' },
  { id: 'decay', name: 'Decay', min: 0.01, max: 4, def: 0.3, curve: 'exp', unit: 's', group: 'Envelope' },
  { id: 'sustain', name: 'Sustain', min: 0, max: 1, def: 0.6, group: 'Envelope' },
  { id: 'release', name: 'Release', min: 0.005, max: 4, def: 0.2, curve: 'exp', unit: 's', group: 'Envelope' },
  { id: 'filter', name: 'Filter', options: ['Off', 'Low', 'Band', 'High'], min: 0, max: 3, def: 1, step: 1, group: 'Filter' },
  { id: 'cutoff', name: 'Cutoff', min: 80, max: 12000, def: 3200, curve: 'exp', unit: 'Hz', cc: 74, group: 'Filter' },
  { id: 'reso', name: 'Resonance', min: 0, max: 1, def: 0.3, group: 'Filter' },
  { id: 'arp', name: 'Arpeggio', options: ['Off', 'Up', 'Down', 'Up-down'], min: 0, max: 3, def: 0, step: 1, group: 'Arp' },
  { id: 'arpRate', name: 'Arp speed', min: 4, max: 60, def: 25, unit: 'Hz', group: 'Arp' },
  { id: 'crunch', name: 'Crunch', min: 0, max: 1, def: 0.2, group: 'Arp' },
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.6, cc: 7, group: 'Arp' },
];
const PRESETS = {
  lead: { wave: 2, pw: 0.25, pwm: 0.2, pwmRate: 0.8, vib: 0.3, attack: 0.004, decay: 0.4, sustain: 0.7, release: 0.15, filter: 1, cutoff: 4500, reso: 0.25, arp: 0 },
  bass: { wave: 1, vib: 0, attack: 0.002, decay: 0.25, sustain: 0.5, release: 0.08, filter: 1, cutoff: 900, reso: 0.55, arp: 0, crunch: 0.3 },
  arp: { wave: 2, pw: 0.5, pwm: 0.1, vib: 0, attack: 0.002, decay: 0.2, sustain: 0.8, release: 0.1, filter: 0, arp: 1, arpRate: 25, crunch: 0.35 },
  pwm: { wave: 2, pw: 0.5, pwm: 0.38, pwmRate: 0.35, vib: 0.1, attack: 0.15, decay: 1, sustain: 0.8, release: 0.6, filter: 1, cutoff: 2400, reso: 0.15, arp: 0 },
  flute: { wave: 0, vib: 0.4, attack: 0.05, decay: 0.5, sustain: 0.85, release: 0.25, filter: 0, arp: 0, crunch: 0.1 },
  zap: { wave: 3, attack: 0.001, decay: 0.35, sustain: 0.1, release: 0.1, filter: 2, cutoff: 3500, reso: 0.6, arp: 0, level: 0.8 },
};

const PROC = `
const SR = sampleRate, TAU = Math.PI * 2, NV = 6;
class Chip extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({}, o.processorOptions.params);
    this.q = []; this.alive = true;
    this.port.onmessage = (e) => { const m = e.data; if (m[0] === 9) { this.alive = false; return; } let i = this.q.length; while (i > 0 && this.q[i - 1][1] > m[1]) i--; this.q.splice(i, 0, m); };
    this.v = []; for (let i = 0; i < NV; i++) this.v.push({ note: -1, f: 0, ph: 0, env: 0, st: 0, gate: false, age: 0, lfsr: 0x7ffff8, nz: 0, nph: 0, vibPh: 0, vel: 1 });
    this.clock = 0; this.held = []; this.chord0 = 0; this.arpV = this.v[0]; this.bend = 0;
    this.lp = 0; this.bp = 0; this.pwmPh = 0; this.hold = 0; this.holdN = 0;
  }
  start(v, note, vel) {
    v.note = note; v.f = 440 * Math.pow(2, (note - 69) / 12); v.gate = true; v.st = 1; v.age = ++this.clock; v.vel = vel / 127; v.lfsr = 0x7ffff8; v.vibPh = 0;
  }
  event(m, frame) {
    const [type, , a, b] = m;
    if (type === 1) {
      if (!this.held.length) this.chord0 = frame;
      if (!this.held.some((h) => h.n === a)) this.held.push({ n: a, vel: b });
      if (this.p.arp >= 0.5) { if (this.held.length === 1) this.start(this.arpV, a, b); return; }
      let v = this.v.find((x) => x.note === a);
      if (!v) { const free = this.v.filter((x) => !x.gate); v = (free.length ? free : this.v).reduce((x, y) => (y.age < x.age ? y : x)); }
      this.start(v, a, b);
    } else if (type === 0) {
      this.held = this.held.filter((h) => h.n !== a);
      if (this.p.arp >= 0.5) { if (!this.held.length) { this.arpV.gate = false; this.arpV.st = 3; } return; }
      const v = this.v.find((x) => x.note === a && x.gate); if (v) { v.gate = false; v.st = 3; }
    } else if (type === 2) { if (a === 'bend') this.bend = b; else this.p[a] = b; }
    else if (type === 3) { for (const v of this.v) { v.gate = false; v.st = 3; } this.held = []; }
  }
  process(_, outputs) {
    if (!this.alive) return false;
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length, p = this.p, f0 = currentFrame;
    const ar = 1 / (Math.max(0.001, p.attack) * SR), dk = Math.exp(-1 / (Math.max(0.005, p.decay / 4) * SR)), rk = Math.exp(-1 / (Math.max(0.003, p.release / 4) * SR));
    const wave = p.wave | 0, arp = p.arp | 0, ftype = p.filter | 0;
    const fc = 2 * Math.sin(Math.PI * Math.min(0.45, p.cutoff / SR)), q = 1.6 - p.reso * 1.5;
    const bits = 16 - p.crunch * 11, qz = Math.pow(2, bits - 1), holdN = 1 + Math.round(p.crunch * p.crunch * 6);
    const bendM = Math.pow(2, this.bend / 12);
    for (let i = 0; i < n; i++) {
      while (this.q.length && this.q[0][1] <= f0 + i) this.event(this.q.shift(), f0 + i);
      // the arpeggio: one voice steps through the held chord, counted from when the chord began
      if (arp && this.held.length) {
        const ns = this.held.map((h) => h.n).sort((a, b) => a - b), k = Math.floor(((f0 + i - this.chord0) / SR) * p.arpRate);
        const len = ns.length, idx = arp === 1 ? k % len : arp === 2 ? len - 1 - (k % len) : len < 2 ? 0 : (() => { const c = 2 * len - 2, m = k % c; return m < len ? m : c - m; })();
        const want = ns[idx]; if (this.arpV.note !== want) { this.arpV.note = want; this.arpV.f = 440 * Math.pow(2, (want - 69) / 12); }
      }
      this.pwmPh += p.pwmRate / SR; if (this.pwmPh >= 1) this.pwmPh -= 1;
      const pw = Math.min(0.97, Math.max(0.03, p.pw + p.pwm * Math.sin(TAU * this.pwmPh)));
      let x = 0;
      for (const v of this.v) {
        if (v.st === 0) continue;
        if (v.st === 1) { v.env += ar; if (v.env >= 1) { v.env = 1; v.st = 2; } }
        else if (v.st === 2) v.env = p.sustain + (v.env - p.sustain) * dk;
        else { v.env *= rk; if (v.env < 1e-4) { v.env = 0; v.st = 0; continue; } }
        v.vibPh += 5.5 / SR; const vib = 1 + p.vib * 0.012 * Math.sin(TAU * v.vibPh) * Math.min(1, v.vibPh / 2);
        const f = v.f * vib * bendM; v.ph += f / SR; if (v.ph >= 1) v.ph -= Math.floor(v.ph);
        let s;
        if (wave === 0) s = 4 * Math.abs(v.ph - 0.5) - 1;
        else if (wave === 1) s = 2 * v.ph - 1;
        else if (wave === 2) s = v.ph < pw ? 1 : -1;
        else {
          v.nph += (f * 8) / SR;
          while (v.nph >= 1) { v.nph -= 1; const bit = ((v.lfsr >> 22) ^ (v.lfsr >> 17)) & 1; v.lfsr = ((v.lfsr << 1) | bit) & 0x7fffff; v.nz = ((v.lfsr >> 15) & 0xff) / 127.5 - 1; }
          s = v.nz;
        }
        x += s * v.env * (0.55 + 0.45 * v.vel);
      }
      x *= 0.22;
      if (ftype) { const hp = x - this.lp - q * this.bp; this.bp += fc * hp; this.lp += fc * this.bp; x = ftype === 1 ? this.lp : ftype === 2 ? this.bp * 2.2 : hp; }
      // crunch: fewer bits and a held sample (the chip's own lo-fi)
      if (++this.holdN >= holdN) { this.holdN = 0; this.hold = Math.round(Math.max(-1, Math.min(1, x)) * qz) / qz; }
      const y = this.hold * p.level;
      L[i] = y; R[i] = y;
    }
    return true;
  }
}
registerProcessor('${NAME}', Chip);
`;

export default {
  id: 'chip',
  name: 'Chip Lite',
  family: 'Sound chip synth',
  blurb: "A home-computer sound chip: triangle, saw, pulse with PWM or noise, chip envelopes, a resonant multimode filter, crunch, and the race-through-the-chord arpeggio. A lite version of SynthLand's Chip SID.",
  lineage: 'SynthLand (CrumpLab) Chip SID, pared down for MEGAjam',
  by: 'Matt',   // the full SynthLand instrument is Matt's design; this lite one credits him on its tile
  params: PARAMS,
  presets: PRESETS,
  presetNames: { lead: 'Lead', bass: 'Bass', arp: 'Chord arp', pwm: 'PWM pad', flute: 'Flute', zap: 'Zap' },
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
