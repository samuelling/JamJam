// Wobbler: a wobble bass whose LFO runs on the room's beat, and whose speed is picked by the key you play.
// Two detuned saws, a square and a sub, an optional FM growl, then drive into a resonant low-pass (or a vowel
// filter, for the "yoi" talk) that the LFO sweeps, a soft clip at the end. Mono: legato or retriggered.
//
// Clock sync: the LFO's phase is the room beat times cycles-per-beat, so every jammer's copy wobbles on the same
// beat, on the same edge. The page sends the worklet beat anchors (an audio frame, the room beat there, beats per
// second) with every note and a few times a second; between anchors the worklet counts frames. With no room clock
// (an offline render with no env) it falls back to the BPM knob, counting beats from frame 0.
//
// Key -> rate: 'Octave' (each octave up from the map's start doubles the speed: 1/2, 1/4, 1/8, 1/16, 1/32),
// 'Keys' (each semitone of the octave is its own division, so a riff of notes plays a rhythm), or 'Fixed'.
// Everything runs sample by sample in the worklet; no randomness, so renders are identical everywhere.

const NAME = 'jj-wobbler-1';
// divisions, slowest to fastest, in LFO cycles per beat (a beat is a quarter note)
const DIVS = [['1/1', 0.25], ['1/2', 0.5], ['1/4.', 2 / 3], ['1/2T', 0.75], ['1/4', 1], ['1/8.', 4 / 3], ['1/4T', 1.5], ['1/8', 2], ['1/8T', 3], ['1/16', 4], ['1/16T', 6], ['1/32', 8]];
const OCT_DIVS = [1, 4, 7, 9, 11];   // Octave mode: 1/2, 1/4, 1/8, 1/16, 1/32
const PARAMS = [
  { id: 'map', name: 'Key picks rate', options: ['Octave', 'Keys', 'Fixed'], min: 0, max: 2, def: 0, step: 1, group: 'Wobble' },
  { id: 'mapFrom', name: 'Map starts at', options: ['C0', 'C1', 'C2', 'C3'], min: 0, max: 3, def: 1, step: 1, group: 'Wobble' },
  { id: 'rate', name: 'Fixed rate', options: DIVS.map((d) => d[0]), min: 0, max: DIVS.length - 1, def: 7, step: 1, group: 'Wobble' },
  { id: 'shape', name: 'LFO shape', options: ['Sine', 'Triangle', 'Ramp down', 'Ramp up', 'Square'], min: 0, max: 4, def: 0, step: 1, group: 'Wobble' },
  { id: 'retrig', name: 'LFO phase', options: ['Locked to beat', 'Restart on note'], min: 0, max: 1, def: 0, step: 1, group: 'Wobble' },
  { id: 'depth', name: 'Wub depth', min: 0, max: 1, def: 0.75, cc: 1, group: 'Wobble' },
  { id: 'ampWub', name: 'Volume wub', min: 0, max: 1, def: 0.1, group: 'Wobble' },
  { id: 'bpm', name: 'BPM (no room clock)', min: 60, max: 200, def: 140, unit: 'bpm', group: 'Wobble' },
  { id: 'saw', name: 'Saws', min: 0, max: 1, def: 0.8, group: 'Oscillators' },
  { id: 'detune', name: 'Saw detune', min: 0, max: 50, def: 12, unit: 'ct', group: 'Oscillators' },
  { id: 'square', name: 'Square', min: 0, max: 1, def: 0.35, group: 'Oscillators' },
  { id: 'sub', name: 'Sub', min: 0, max: 1, def: 0.6, group: 'Oscillators' },
  { id: 'growl', name: 'FM growl', min: 0, max: 1, def: 0, group: 'Oscillators' },
  { id: 'mode', name: 'Filter', options: ['Low-pass', 'Vowel (yoi)'], min: 0, max: 1, def: 0, step: 1, group: 'Filter' },
  { id: 'cutoff', name: 'Cutoff', min: 40, max: 8000, def: 110, curve: 'exp', unit: 'Hz', cc: 74, group: 'Filter' },
  { id: 'reso', name: 'Resonance', min: 0, max: 1, def: 0.45, cc: 71, group: 'Filter' },
  { id: 'drive', name: 'Drive', min: 0, max: 1, def: 0.5, group: 'Filter' },
  { id: 'attack', name: 'Attack', min: 0.001, max: 1, def: 0.004, curve: 'exp', unit: 's', cc: 73, group: 'Performance' },
  { id: 'release', name: 'Release', min: 0.005, max: 2, def: 0.09, curve: 'exp', unit: 's', cc: 72, group: 'Performance' },
  { id: 'glide', name: 'Glide', min: 0, max: 0.5, def: 0.03, unit: 's', cc: 5, group: 'Performance' },
  { id: 'voice', name: 'Notes', options: ['Legato', 'Retrigger'], min: 0, max: 1, def: 0, step: 1, group: 'Performance' },
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.7, cc: 7, group: 'Performance' },
];
const PRESETS = {
  classic: {},
  yoi: { mode: 1, depth: 0.85, reso: 0.6, growl: 0.35, saw: 0.9, square: 0.2, sub: 0.5, drive: 0.6, shape: 1 },
  reese: { map: 2, rate: 4, depth: 0.45, detune: 38, saw: 1, square: 0, sub: 0.7, cutoff: 260, reso: 0.25, drive: 0.35, glide: 0.08, ampWub: 0 },
  drop: { map: 2, rate: 1, depth: 0.95, cutoff: 70, reso: 0.55, drive: 0.75, growl: 0.2, sub: 0.75, ampWub: 0.05 },
  triplet: { map: 1, shape: 4, depth: 0.7, ampWub: 0.55, cutoff: 160, reso: 0.35, drive: 0.55, voice: 1, release: 0.05 },
};

const PROC = `
const SR = sampleRate, TAU = Math.PI * 2;
const DIVS = ${JSON.stringify(DIVS.map((d) => d[1]))}, OCT_DIVS = ${JSON.stringify(OCT_DIVS)};
// vowels for the yoi filter, three formants each (Hz): oo, oh, ah, eh, ee
const VOW = [[300, 870, 2240], [430, 820, 2600], [730, 1090, 2440], [530, 1840, 2480], [270, 2290, 3010]];
const tc = (s) => 1 - Math.exp(-1 / (Math.max(0.0005, s) * SR));
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
class Svf {   // trapezoidal state-variable filter
  constructor() { this.a = 0; this.b = 0; }
  run(x, f, q) {
    const g = Math.tan(Math.PI * Math.min(f, SR * 0.45) / SR), k = 1 / q, a1 = 1 / (1 + g * (g + k));
    const v1 = a1 * this.a + g * a1 * (x - this.b), v2 = this.b + g * v1;
    this.a = 2 * v1 - this.a; this.b = 2 * v2 - this.b;
    return v1;   // band-pass
  }
}
class Wobbler extends AudioWorkletProcessor {
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
    this.anchor = null;   // [frame, beat, beats per second] from the room clock
    this.stack = []; this.gate = false; this.freq = 0; this.target = 0; this.note = 36; this.vel = 1;
    this.env = 0; this.cpb = 2; this.noteBeat = 0;
    this.ph = [0, 0, 0, 0, 0]; this.bend = 0;
    this.y1 = 0; this.y2 = 0; this.y3 = 0; this.y4 = 0; this.ox = 0; this.o1 = 0; this.o2 = 0; this.o3 = 0;
    this.f = [new Svf(), new Svf(), new Svf()]; this.dc = 0; this.dcx = 0;
  }
  rateFor(n) {
    const p = this.p, map = p.map | 0;
    if (map === 2) return DIVS[Math.max(0, Math.min(DIVS.length - 1, p.rate | 0))];
    const from = 12 + 12 * (p.mapFrom | 0);   // C0 = 12
    if (map === 1) return DIVS[((n - from) % 12 + 12) % 12];
    return DIVS[OCT_DIVS[Math.max(0, Math.min(OCT_DIVS.length - 1, Math.floor((n - from) / 12)))]];
  }
  beatAt(frame) {
    const a = this.anchor;
    if (a) return a[1] + ((frame - a[0]) / SR) * a[2];
    return (frame / SR) * this.p.bpm / 60;
  }
  start(n) {
    const f = 440 * Math.pow(2, (n - 69) / 12);
    this.note = n; this.target = f; this.cpb = this.rateFor(n);
    if (this.freq === 0 || this.p.glide <= 0) this.freq = f;
  }
  event(m, frame) {
    const [type, , a, b] = m;
    if (type === 4) { this.anchor = [m[1], a, b]; return; }
    if (type === 1) {
      this.stack = this.stack.filter((n) => n !== a); this.stack.push(a);
      const fresh = !this.gate || (this.p.voice | 0) === 1;
      this.start(a);
      if (fresh) { this.gate = true; this.vel = b / 127; this.noteBeat = this.beatAt(frame); }
    } else if (type === 0) {
      this.stack = this.stack.filter((n) => n !== a);
      if (!this.stack.length) this.gate = false;
      else if (a === this.note) this.start(this.stack[this.stack.length - 1]);
    } else if (type === 2) {
      if (a === 'bend') this.bend = b; else { this.p[a] = b; if (a === 'map' || a === 'rate' || a === 'mapFrom') this.cpb = this.rateFor(this.note); }
    } else if (type === 3) { this.stack = []; this.gate = false; }
  }
  lfo(ph) {
    switch (this.p.shape | 0) {
      case 1: return 1 - Math.abs(2 * ph - 1);   // triangle, from the bottom
      case 2: return 1 - ph;                     // ramp down: opens at once, closes over the cycle
      case 3: return ph;                         // ramp up
      case 4: return ph < 0.5 ? 0 : 1;           // square: shut, then open
      default: return 0.5 - 0.5 * Math.cos(TAU * ph);   // sine, from the bottom
    }
  }
  process(_, outputs) {
    if (!this.alive) return false;
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length, p = this.p, f0 = currentFrame;
    const atk = tc(p.attack / 2.2), rel = tc(p.release / 3), glideC = p.glide > 0 ? tc(p.glide / 2.5) : 1;
    const det = Math.pow(2, p.detune / 1200), drive = 1 + p.drive * 6, level = p.level, vowel = (p.mode | 0) === 1;
    const res = Math.min(1.05, p.reso * 1.05);
    for (let i = 0; i < n; i++) {
      while (this.q.length && this.q[0][1] <= f0 + i) this.event(this.q.shift(), f0 + i);
      if (!this.gate && this.env < 1e-5) { L[i] = R[i] = 0; this.env = 0; continue; }
      this.env += ((this.gate ? 1 : 0) - this.env) * (this.gate ? atk : rel);
      this.freq += (this.target - this.freq) * glideC;
      // the wobble: the room beat times cycles per beat (or counted from the note, when it restarts)
      const beat = this.beatAt(f0 + i), into = (p.retrig | 0) === 1 ? beat - this.noteBeat : beat;
      const lph = (into * this.cpb) % 1, w = this.lfo(lph < 0 ? lph + 1 : lph);
      const fb = this.freq * Math.pow(2, this.bend / 12);
      // oscillators: two detuned saws (phase-modulated by the growl), a square, a sine sub an octave down
      const g = p.growl * (0.4 + 0.6 * w) * 2.2;
      const fm = g > 0 ? Math.sin(TAU * this.ph[4]) * g : 0;
      this.ph[4] += fb / SR; if (this.ph[4] >= 1) this.ph[4] -= 1;
      let mix = 0;
      const d1 = Math.min(0.45, (fb * det) / SR), d2 = Math.min(0.45, fb / det / SR), d3 = Math.min(0.45, fb / SR);
      if (p.saw > 0) {
        const a1 = (this.ph[0] + fm * 0.15 + 2) % 1, a2 = (this.ph[1] + fm * 0.15 + 2) % 1;
        mix += p.saw * 0.5 * (2 * a1 - 1 - blep(a1, d1) + 2 * a2 - 1 - blep(a2, d2));
      }
      if (p.square > 0) { const s = this.ph[2]; let v = s < 0.5 ? 1 : -1; v += blep(s, d3); v -= blep((s + 0.5) % 1, d3); mix += p.square * v * 0.7; }
      this.ph[0] += d1; if (this.ph[0] >= 1) this.ph[0] -= 1;
      this.ph[1] += d2; if (this.ph[1] >= 1) this.ph[1] -= 1;
      this.ph[2] += d3; if (this.ph[2] >= 1) this.ph[2] -= 1;
      const sub = Math.sin(TAU * this.ph[3]) * p.sub; this.ph[3] += d3 * 0.5; if (this.ph[3] >= 1) this.ph[3] -= 1;
      const x = Math.tanh(mix * 0.5 * drive) / Math.tanh(drive * 0.5);
      let y;
      if (vowel) {
        // the yoi: three formants swept through oo-oh-ah-eh-ee by the wobble
        const pos = Math.min(3.999, w * p.depth * 4 + (p.cutoff > 300 ? Math.log2(p.cutoff / 300) * 0.5 : 0)), k = pos | 0, fr = pos - k;
        const q = 5 + res * 14;
        y = 0;
        for (let j = 0; j < 3; j++) { const fq = VOW[k][j] * Math.pow(VOW[k + 1][j] / VOW[k][j], fr); y += this.f[j].run(x, fq, q) * (j === 0 ? 1 : j === 1 ? 0.7 : 0.35); }
        y *= 1.6;
      } else {
        // 4-pole ladder low-pass, cutoff swept up to six octaves by the wobble (2x oversampled)
        let fc = p.cutoff * Math.pow(2, w * p.depth * 6 + 0.25 * Math.log2(fb / 65.4));
        fc = Math.min(SR * 0.45, Math.max(20, fc));
        const ff = (2 * fc) / (SR * 2), kk = 3.6 * ff - 1.6 * ff * ff - 1, pp = (kk + 1) * 0.5, r = res * Math.exp((1 - pp) * 1.386249);
        for (let s = 0; s < 2; s++) {
          const xx = x - r * this.y4;
          this.y1 = xx * pp + this.ox * pp - kk * this.y1;
          this.y2 = this.y1 * pp + this.o1 * pp - kk * this.y2;
          this.y3 = this.y2 * pp + this.o2 * pp - kk * this.y3;
          this.y4 = this.y3 * pp + this.o3 * pp - kk * this.y4;
          this.y4 -= (this.y4 * this.y4 * this.y4) / 6;
          this.ox = xx; this.o1 = this.y1; this.o2 = this.y2; this.o3 = this.y3;
        }
        y = this.y4 * (1 + res * 0.6);
      }
      const amp = this.env * (0.75 + 0.25 * this.vel) * (1 - p.ampWub * (1 - w));
      let v = Math.tanh((y * 1.4 + sub * 0.9) * amp) * level * 0.85;
      // block DC (the growl and the clip can leave some)
      this.dc = v - this.dcx + 0.9995 * this.dc; this.dcx = v; v = this.dc;
      L[i] = v; R[i] = v;
    }
    return true;
  }
}
registerProcessor('${NAME}', Wobbler);
`;

export default {
  id: 'wobbler',
  name: 'Wobbler',
  family: 'Wobble bass (clock-synced)',
  blurb: 'A wub-wub bass: saws, square and sub into a resonant filter (or a talking vowel filter) that wobbles on the room\'s beat. The key you play picks the speed: an octave up wobbles twice as fast, or each key its own rhythm.',
  params: PARAMS,
  presets: PRESETS,
  presetNames: { classic: 'Classic wub', yoi: 'Yoi growl', reese: 'Reese wobble', drop: 'Slow drop', triplet: 'Triplet chop' },
  divisions: DIVS.map((d) => d[0]),
  async init(ctx) {
    ctx.__jjWorklets = ctx.__jjWorklets || new Set();
    if (ctx.__jjWorklets.has(NAME)) return;
    const url = URL.createObjectURL(new Blob([PROC], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    ctx.__jjWorklets.add(NAME);
  },
  // env: the room clock ({roomTime(t), beatAt(ms), bpm(ms)}); without it the BPM knob runs the wobble
  create(ctx, out, init = {}, env) {
    const params = {};
    for (const d of PARAMS) params[d.id] = init[d.id] ?? d.def;
    const node = new AudioWorkletNode(ctx, NAME, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { params } });
    node.connect(out);
    const at = (t) => Math.round(t * ctx.sampleRate);
    const clocked = !!(env && env.roomTime && env.beatAt && env.bpm);
    // where the room's beat is at audio time t, and how fast it's going
    const anchor = (t) => { if (!clocked) return; const ms = env.roomTime(t); node.port.postMessage([4, at(t), env.beatAt(ms), env.bpm(ms) / 60]); };
    let timer = null;
    if (clocked && typeof OfflineAudioContext !== 'undefined' && !(ctx instanceof OfflineAudioContext)) timer = setInterval(() => anchor(ctx.currentTime + 0.25), 250);
    return {
      noteOn: (note, vel, t) => { anchor(t); node.port.postMessage([1, at(t), note, vel]); },
      noteOff: (note, t) => node.port.postMessage([0, at(t), note, 0]),
      set: (id, v, t) => node.port.postMessage([2, at(t), id, v]),
      allOff: (t) => node.port.postMessage([3, at(t)]),
      dispose: () => { if (timer) clearInterval(timer); node.port.postMessage([9, 0]); node.disconnect(); },
    };
  },
};
