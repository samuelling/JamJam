// Tonewheel Lite: a drawbar organ, a pared-down take on SynthLand's Tonewheel (CrumpLab). Nine drawbars of sine
// tonewheels with foldback at the top, contact key click, single-triggered percussion on the second or third
// harmonic, a scanner vibrato and chorus, a tube-ish preamp, and a rotating speaker whose horn and drum speed up and
// slow down at their own rates. Not the full model: one manual, no leakage or crosstalk, a simple speaker.
//
// Deterministic: no randomness except the click noise, which is seeded from each note.

const NAME = 'jj-tonewheel-1';
const BARS = [['db16', "16'", 0.5], ['db513', "5⅓'", 1.5], ['db8', "8'", 1], ['db4', "4'", 2], ['db223', "2⅔'", 3], ['db2', "2'", 4], ['db135', "1⅗'", 5], ['db113', "1⅓'", 6], ['db1', "1'", 8]];
const PARAMS = [
  ...BARS.map(([id, name]) => ({ id, name, min: 0, max: 8, def: id === 'db16' || id === 'db513' || id === 'db8' ? 8 : 0, step: 1, group: 'Drawbars' })),
  { id: 'perc', name: 'Percussion', options: ['Off', '2nd', '3rd'], min: 0, max: 2, def: 2, step: 1, group: 'Voice' },
  { id: 'percFast', name: 'Perc decay', options: ['Slow', 'Fast'], min: 0, max: 1, def: 1, step: 1, group: 'Voice' },
  { id: 'click', name: 'Key click', min: 0, max: 1, def: 0.45, group: 'Voice' },
  { id: 'vib', name: 'Vibrato', options: ['Off', 'V1', 'V2', 'V3', 'C1', 'C2', 'C3'], min: 0, max: 6, def: 6, step: 1, group: 'Voice' },
  { id: 'drive', name: 'Drive', min: 0, max: 1, def: 0.2, cc: 74, group: 'Voice' },
  { id: 'rotary', name: 'Rotary', options: ['Stop', 'Slow', 'Fast'], min: 0, max: 2, def: 1, step: 1, cc: 1, group: 'Speaker' },
  { id: 'rotMix', name: 'Speaker', min: 0, max: 1, def: 0.85, group: 'Speaker' },
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.7, cc: 7, group: 'Speaker' },
];
const reg = (s, o = {}) => { const v = {}; BARS.forEach(([id], i) => { v[id] = +s[i]; }); return { ...v, ...o }; };
const PRESETS = {
  jazz: reg('888000000', { perc: 2, percFast: 1, click: 0.5, vib: 6, drive: 0.15, rotary: 1 }),
  soul: reg('888800000', { perc: 1, percFast: 1, click: 0.4, vib: 6, drive: 0.3, rotary: 1 }),
  gospel: reg('888888888', { perc: 0, click: 0.35, vib: 6, drive: 0.35, rotary: 2 }),
  rock: reg('888600000', { perc: 0, click: 0.6, vib: 0, drive: 0.75, rotary: 2, level: 0.6 }),
  ballad: reg('008600000', { perc: 0, click: 0.15, vib: 6, drive: 0.05, rotary: 1 }),
  flutes: reg('008000400', { perc: 0, click: 0.2, vib: 4, drive: 0, rotary: 1 }),
};

const PROC = `
const SR = sampleRate, TAU = Math.PI * 2;
const TAB = new Float32Array(4097); for (let i = 0; i <= 4096; i++) TAB[i] = Math.sin((i / 4096) * TAU);
const sine = (ph) => { const x = ph * 4096, i = x | 0, f = x - i; return TAB[i] + (TAB[i + 1] - TAB[i]) * f; };
const RATIOS = [0.5, 1.5, 1, 2, 3, 4, 5, 6, 8];
const IDS = ${JSON.stringify(BARS.map((b) => b[0]))};
const NV = 16;
const tc = (s) => 1 - Math.exp(-1 / (Math.max(0.0005, s) * SR));
class Tonewheel extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({}, o.processorOptions.params);
    this.q = []; this.alive = true;
    this.port.onmessage = (e) => { const m = e.data; if (m[0] === 9) { this.alive = false; return; } let i = this.q.length; while (i > 0 && this.q[i - 1][1] > m[1]) i--; this.q.splice(i, 0, m); };
    this.v = []; for (let i = 0; i < NV; i++) this.v.push({ note: -1, f: 0, ph: new Float64Array(9), env: 0, gate: false, age: 0, perc: 0, pph: 0, click: 0, seed: 1 });
    this.clock = 0; this.held = 0;
    this.vbuf = new Float32Array(1024); this.vw = 0; this.vph = 0;
    this.rbuf = new Float32Array(2048); this.rw = 0; this.hornA = 0; this.drumA = 0; this.hornW = 0.83; this.drumW = 0.7; this.lp = 0;
  }
  event(m) {
    const [type, , a, b] = m;
    if (type === 1) {
      let v = this.v.find((x) => x.note === a);
      if (!v) { const free = this.v.filter((x) => !x.gate); v = (free.length ? free : this.v).reduce((x, y) => (y.age < x.age ? y : x)); }
      if (v.note !== a) v.ph.fill(0);
      v.note = a; v.f = 440 * Math.pow(2, (a - 69) / 12); v.gate = true; v.age = ++this.clock;
      v.perc = this.held === 0 && this.p.perc > 0 ? 1 : 0; v.pph = 0;   // single-triggered: only the first key of a phrase
      v.click = 1; v.seed = 9001 + a * 131 + b;
      this.held++;
    } else if (type === 0) {
      const v = this.v.find((x) => x.note === a && x.gate);
      if (v) { v.gate = false; v.click = Math.max(v.click, 0.5); this.held = Math.max(0, this.held - 1); }
    } else if (type === 2) this.p[a] = b;
    else if (type === 3) { for (const v of this.v) v.gate = false; this.held = 0; }
  }
  rnd(v) { let t = (v.seed = (v.seed + 0x6D2B79F5) | 0); t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1; }
  process(_, outputs) {
    if (!this.alive) return false;
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length, p = this.p, f0 = currentFrame;
    // drawbar levels: each step about 3 dB
    const amp = IDS.map((id) => (p[id] > 0 ? Math.pow(10, ((p[id] - 8) * 3) / 20) : 0));
    const norm = 0.16 / Math.max(1, Math.sqrt(amp.reduce((s, x) => s + x * x, 0)) * 1.2);
    const atk = tc(0.002), rel = tc(0.008), percK = Math.exp(-1 / ((p.percFast >= 0.5 ? 0.2 : 0.65) * SR)), clickK = Math.exp(-1 / (0.004 * SR));
    const percR = p.perc >= 1.5 ? 3 : 2, vib = p.vib | 0, vDepth = [0, 0.00025, 0.0005, 0.0009, 0.00025, 0.0005, 0.0009][vib] * SR, chorus = vib >= 4;
    const drive = 1 + p.drive * 7, dNorm = 1 / Math.tanh(drive * 0.5);
    const rot = p.rotary | 0, hornT = [0, 0.83, 6.7][rot], drumT = [0, 0.7, 5.8][rot];
    const hornK = tc(hornT > this.hornW ? 0.6 : 1.6), drumK = tc(drumT > this.drumW ? 3 : 4.5), lpC = 1 - Math.exp(-TAU * 800 / SR);
    for (let i = 0; i < n; i++) {
      while (this.q.length && this.q[0][1] <= f0 + i) this.event(this.q.shift());
      let x = 0, cl = 0;
      for (const v of this.v) {
        v.env += ((v.gate ? 1 : 0) - v.env) * (v.gate ? atk : rel);
        if (v.env < 1e-5 && !v.gate && v.click < 1e-4) continue;
        let s = 0;
        for (let h = 0; h < 9; h++) {
          if (!amp[h]) continue;
          let f = v.f * RATIOS[h]; while (f > 5900) f *= 0.5;   // foldback: the top wheels repeat an octave down
          const ph = v.ph[h] + f / SR; v.ph[h] = ph - Math.floor(ph);
          s += sine(v.ph[h]) * amp[h];
        }
        if (v.perc > 1e-4) { v.pph += (v.f * percR) / SR; v.pph -= Math.floor(v.pph); s += sine(v.pph) * v.perc * 0.9; v.perc *= percK; }
        x += s * v.env;
        if (v.click > 1e-4) { cl += this.rnd(v) * v.click; v.click *= clickK; }
      }
      x = x * norm + cl * p.click * 0.05;
      // scanner vibrato (and chorus: the vibrato mixed with the dry signal)
      if (vib) {
        this.vbuf[this.vw] = x; this.vph += 6.86 / SR; if (this.vph >= 1) this.vph -= 1;
        const d = 2 + vDepth * (1 + Math.sin(TAU * this.vph)), rp = this.vw - d + 1024, i0 = Math.floor(rp) & 1023, fr = rp - Math.floor(rp);
        const w = this.vbuf[i0] * (1 - fr) + this.vbuf[(i0 + 1) & 1023] * fr;
        this.vw = (this.vw + 1) & 1023; x = chorus ? (x + w) * 0.5 : w;
      }
      x = Math.tanh(x * drive) * dNorm * 0.5;
      // the rotating speaker: a drum below 800 Hz and a horn above, each turning at its own speed
      this.hornW += (hornT - this.hornW) * hornK; this.drumW += (drumT - this.drumW) * drumK;
      this.hornA += this.hornW / SR; this.hornA -= Math.floor(this.hornA); this.drumA += this.drumW / SR; this.drumA -= Math.floor(this.drumA);
      this.lp += (x - this.lp) * lpC; const lo = this.lp, hi = x - lo;
      this.rbuf[this.rw] = hi;
      const hc = Math.cos(TAU * this.hornA), dop = 14 + 10 * Math.sin(TAU * this.hornA), rp = this.rw - dop + 2048, j0 = Math.floor(rp) & 2047, fj = rp - Math.floor(rp);
      const hd = this.rbuf[j0] * (1 - fj) + this.rbuf[(j0 + 1) & 2047] * fj; this.rw = (this.rw + 1) & 2047;
      const dc = Math.cos(TAU * this.drumA);
      const rl = hd * (1 + 0.55 * hc) + lo * (1 + 0.25 * dc), rr = hd * (1 - 0.55 * hc) + lo * (1 - 0.25 * dc);
      const m = rot === 0 ? 0 : p.rotMix, lv = p.level;
      L[i] = (x * (1 - m) + rl * m) * lv; R[i] = (x * (1 - m) + rr * m) * lv;
    }
    return true;
  }
}
registerProcessor('${NAME}', Tonewheel);
`;

export default {
  id: 'tonewheel',
  name: 'Tonewheel Lite',
  family: 'Drawbar organ',
  blurb: "A drawbar organ with key click, percussion, scanner vibrato and chorus, drive and a rotating speaker. A lite version of SynthLand's Tonewheel.",
  lineage: 'SynthLand (CrumpLab) Tonewheel, pared down for MEGAjam',
  by: 'Matt',   // the full SynthLand instrument is Matt's design; this lite one credits him on its tile
  params: PARAMS,
  presets: PRESETS,
  presetNames: { jazz: 'Jazz', soul: 'Soul', gospel: 'Full gospel', rock: 'Rock drive', ballad: 'Ballad', flutes: 'Flutes' },
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
