// Acid Line Lite: a bass line machine in the 303 tradition, a pared-down take on SynthLand's Acid Line (CrumpLab).
// One oscillator (saw or square) into a resonant three-pole (18 dB) filter that screams as the resonance comes up,
// one decay envelope sweeping it, and the two things that make the sound: accent and slide.
//   Accent: notes played hard (velocity 100 and up) are louder, snap the filter open with a short, strong sweep, and
//   charge a slow "accent sweep" so consecutive accents climb higher and higher.
//   Slide: a note played while the last is still held glides to the new pitch without restarting the envelopes.
// Monophonic, last-note priority. No randomness, so it renders the same in every browser.

const NAME = 'jj-acid-1';
const PARAMS = [
  { id: 'wave', name: 'Wave', options: ['Saw', 'Square'], min: 0, max: 1, def: 0, step: 1, group: 'Sound' },
  { id: 'tune', name: 'Tune', min: -12, max: 12, def: 0, unit: 'st', group: 'Sound' },
  { id: 'cutoff', name: 'Cutoff', min: 60, max: 4000, def: 420, curve: 'exp', unit: 'Hz', cc: 74, group: 'Sound' },
  { id: 'reso', name: 'Resonance', min: 0, max: 1, def: 0.7, cc: 71, group: 'Sound' },
  { id: 'envMod', name: 'Env mod', min: 0, max: 1, def: 0.55, group: 'Sound' },
  { id: 'decay', name: 'Decay', min: 0.08, max: 2.5, def: 0.45, curve: 'exp', unit: 's', group: 'Sound' },
  { id: 'accent', name: 'Accent', min: 0, max: 1, def: 0.6, group: 'Sound' },
  { id: 'slide', name: 'Slide time', min: 0.02, max: 0.3, def: 0.06, curve: 'exp', unit: 's', group: 'Sound' },
  { id: 'drive', name: 'Drive', min: 0, max: 1, def: 0.15, group: 'Sound' },
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.7, cc: 7, group: 'Sound' },
];
const PRESETS = {
  acid: {},
  bass: { cutoff: 260, reso: 0.35, envMod: 0.35, decay: 0.3, accent: 0.4, drive: 0.1 },
  squelch: { cutoff: 300, reso: 0.88, envMod: 0.8, decay: 0.35, accent: 0.85, drive: 0.25 },
  square: { wave: 1, cutoff: 520, reso: 0.6, envMod: 0.5, decay: 0.6, accent: 0.5 },
  rubber: { cutoff: 180, reso: 0.5, envMod: 0.7, decay: 0.18, accent: 0.7, slide: 0.09, drive: 0.05 },
  dirty: { cutoff: 380, reso: 0.8, envMod: 0.65, decay: 0.5, accent: 0.8, drive: 0.8 },
};

const PROC = `
const SR = sampleRate, OS = 2;   // the filter runs at twice the rate, so the resonance stays put up high
class Acid extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({}, o.processorOptions.params);
    this.q = []; this.alive = true;
    this.port.onmessage = (e) => { const m = e.data; if (m[0] === 9) { this.alive = false; return; } let i = this.q.length; while (i > 0 && this.q[i - 1][1] > m[1]) i--; this.q.splice(i, 0, m); };
    this.held = [];              // keys held, oldest first (last-note priority)
    this.f = 0; this.fTarget = 0; this.ph = 0;
    this.gate = false; this.amp = 0; this.fenv = 0; this.accented = false; this.sweep = 0;
    this.s1 = 0; this.s2 = 0; this.s3 = 0; this.dc = 0; this.dcx = 0;
  }
  hz(n) { return 440 * Math.pow(2, (n - 69 + this.p.tune) / 12); }
  event(m) {
    const [type, , a, b] = m;
    if (type === 2) { this.p[a] = b; return; }
    if (type === 3) { this.held = []; this.gate = false; return; }
    if (type === 1) {
      const legato = this.gate && this.held.length > 0;
      this.held = this.held.filter((n) => n !== a); this.held.push(a);
      this.fTarget = this.hz(a);
      this.accented = b >= 100;
      if (legato) return;                     // a slide: the pitch glides there, the envelopes carry on
      this.f = this.fTarget; this.gate = true; this.fenv = 1;
      if (this.accented) this.sweep = Math.min(1.6, this.sweep + 0.55 * this.p.accent);
      return;
    }
    if (type === 0) {
      const top = this.held[this.held.length - 1];
      this.held = this.held.filter((n) => n !== a);
      if (!this.held.length) { this.gate = false; return; }
      if (a === top) this.fTarget = this.hz(this.held[this.held.length - 1]);   // back to the key still held, sliding
    }
  }
  process(_, outputs) {
    if (!this.alive) return false;
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length, p = this.p, f0 = currentFrame;
    const slideK = 1 - Math.exp(-1 / (p.slide * SR / 4)), decK = Math.exp(-1 / (p.decay * SR)), accDecK = Math.exp(-1 / (0.2 * SR));
    const sweepK = Math.exp(-1 / (0.6 * SR)), attK = 1 - Math.exp(-1 / (0.003 * SR)), relK = Math.exp(-1 / (0.008 * SR)), holdK = Math.exp(-1 / (3.5 * SR));
    const k = p.reso * 3.6, drive = 1 + p.drive * 6, accAmt = this.accented ? p.accent : 0;
    for (let i = 0; i < n; i++) {
      while (this.q.length && this.q[0][1] <= f0 + i) this.event(this.q.shift());
      this.f += (this.fTarget - this.f) * slideK;
      // the envelopes: the filter one decays (faster and stronger on an accent); the amp one holds while the key is down
      this.fenv *= this.accented ? accDecK : decK;
      this.sweep *= sweepK;
      if (this.gate) this.amp += (1 - this.amp) * attK, this.amp *= holdK; else this.amp *= relK;
      // the oscillator, band-limited at its edges (polyBLEP)
      const dt = this.f / SR; this.ph += dt; if (this.ph >= 1) this.ph -= 1;
      const blep = (t) => (t < dt ? (t /= dt, t + t - t * t - 1) : t > 1 - dt ? (t = (t - 1) / dt, t * t + t + t + 1) : 0);
      let x;
      if (p.wave < 0.5) x = 2 * this.ph - 1 - blep(this.ph);
      else { x = (this.ph < 0.5 ? 1 : -1) + blep(this.ph) - blep((this.ph + 0.5) % 1); x *= 0.8; }
      // the cutoff: the knob, swept by the envelope, pushed further by the accent and its climbing sweep
      const mod = p.envMod * this.fenv * 3.2 + accAmt * (this.fenv * 2.2 + this.sweep * 1.2);
      const fc = Math.min(SR * OS * 0.42, p.cutoff * Math.pow(2, mod) * (1 + 0.15 * (this.f / 110 - 1)));
      const g = Math.tan(Math.PI * fc / (SR * OS)), G = g / (1 + g);
      let y = 0;
      for (let o = 0; o < OS; o++) {
        // three one-pole stages with the last fed back, softened by tanh: the 18 dB resonant sweep
        const u = Math.tanh((x - k * this.s3) * 0.9);
        let v = (u - this.s1) * G; const a1 = v + this.s1; this.s1 = a1 + v;
        v = (Math.tanh(a1) - this.s2) * G; const a2 = v + this.s2; this.s2 = a2 + v;
        v = (Math.tanh(a2) - this.s3) * G; const a3 = v + this.s3; this.s3 = a3 + v;
        y = a3;
      }
      y *= 1 + k * 0.35;   // the resonance thins the bass: make some of it back
      let s = Math.tanh(y * drive) / Math.tanh(drive) * this.amp * (1 + accAmt * 0.6);
      this.dc += (s - this.dcx) - this.dc * (1 - Math.exp(-2 * Math.PI * 12 / SR)); this.dcx = s; s = this.dc;   // DC block
      L[i] = R[i] = s * p.level * 0.5 / (1 + p.drive * 0.5);   // as loud as the other basses, drive or not
    }
    return true;
  }
}
registerProcessor('${NAME}', Acid);
`;

const ICON = `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
  <rect x="6" y="16" width="108" height="52" rx="3" fill="#cfccc4"/><rect x="6" y="16" width="108" height="12" rx="3" fill="#3a3a3c"/>
  <text x="11" y="25" font-family="Inter Tight,Arial" font-weight="800" font-size="6.5" letter-spacing="1.2" fill="#e9e6dd">ACID LINE</text>
  ${[0, 1, 2, 3, 4, 5].map((i) => `<circle cx="${18 + i * 17}" cy="38" r="5.2" fill="#2a2a2c"/><line x1="${18 + i * 17}" y1="38" x2="${18 + i * 17 + 3}" y2="34" stroke="#e9e6dd" stroke-width="1.1"/>`).join('')}
  ${Array.from({ length: 13 }, (_, i) => `<rect x="${11 + i * 7.6}" y="${52 - (i % 2 ? 3 : 0)}" width="5.6" height="${i % 2 ? 6 : 9}" rx=".8" fill="${i % 2 ? '#2a2a2c' : '#f2efe6'}"/>`).join('')}
  <rect x="96" y="31" width="12" height="4" rx="1" fill="#e2502a"/></svg>`;

export default {
  id: 'acid',
  name: 'Acid Line Lite',
  family: 'Bass line machine',
  blurb: 'A bass line machine in the 303 tradition: saw or square into a squelchy resonant filter with one decay, and a 16-step sequencer with accent and slide on every step. Play hard to accent a note (it punches and climbs when accents follow each other), and play legato to slide between notes.',
  lineage: 'SynthLand (CrumpLab) Acid Line, pared down for MEGAjam',
  by: 'Matt',   // the full SynthLand instrument is Matt's design; this lite one credits him on its tile
  icon: ICON,
  skin: { knob: 'knob', option: 'buttons', wood: false },
  // its bass line sequencer: the pattern lives in MEGAjam (src/acidseq.js) and plays this synth in every browser
  seq: { kind: 'acid' },
  traits: { arch: ['subtractive'], osc: ['vco'], filter: ['diode'], voices: 1, tags: ['acid'] },
  params: PARAMS,
  presets: PRESETS,
  presetNames: { acid: 'Acid', bass: 'Bass', squelch: 'Squelch', square: 'Square', rubber: 'Rubber', dirty: 'Dirty' },
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
