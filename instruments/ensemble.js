// Ensemble: a 70s string machine. Every key sounds (fully polyphonic), each from a perfectly in-tune sawtooth as on
// the divide-down organs these grew out of, in four sections you mix like drawbars: violins (bright, an octave up
// as well), violas, cellos (an octave down) and basses (two down, on the low keys only). One slow swell and fade
// for all of them, a tone control, and the part that makes it a string machine: the ensemble, three short delay
// lines swept by a slow and a fast wobble a third of a cycle apart, so one thin saw becomes a section.
// No randomness, so it renders the same in every browser.

const NAME = 'jj-ensemble-1';
const PARAMS = [
  { id: 'violin', name: 'Violins', min: 0, max: 1, def: 0.8, group: 'Sections' },
  { id: 'viola', name: 'Violas', min: 0, max: 1, def: 0.6, group: 'Sections' },
  { id: 'cello', name: 'Cellos', min: 0, max: 1, def: 0.5, group: 'Sections' },
  { id: 'bass', name: 'Basses', min: 0, max: 1, def: 0.3, group: 'Sections' },
  { id: 'attack', name: 'Crescendo', min: 0.005, max: 3, def: 0.25, curve: 'exp', unit: 's', cc: 73, group: 'Sections' },
  { id: 'release', name: 'Sustain', min: 0.05, max: 5, def: 1.2, curve: 'exp', unit: 's', cc: 72, group: 'Sections' },
  { id: 'tone', name: 'Tone', min: 0, max: 1, def: 0.55, cc: 74, group: 'Ensemble' },
  { id: 'ensemble', name: 'Ensemble', min: 0, max: 1, def: 0.75, group: 'Ensemble' },
  { id: 'speed', name: 'Wobble', min: 0, max: 1, def: 0.5, group: 'Ensemble' },
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.7, cc: 7, group: 'Ensemble' },
];
const PRESETS = {
  strings: {},
  lush: { violin: 0.9, viola: 0.7, cello: 0.6, bass: 0.2, attack: 0.6, release: 2.2, tone: 0.5, ensemble: 1, speed: 0.4 },
  violins: { violin: 1, viola: 0.3, cello: 0, bass: 0, attack: 0.15, release: 0.9, tone: 0.7, ensemble: 0.8 },
  cellos: { violin: 0, viola: 0.4, cello: 1, bass: 0.6, attack: 0.3, release: 1.4, tone: 0.35, ensemble: 0.6 },
  pad: { violin: 0.6, viola: 0.8, cello: 0.7, bass: 0.4, attack: 1.4, release: 3.5, tone: 0.3, ensemble: 0.9, speed: 0.3 },
  dry: { ensemble: 0, tone: 0.65, attack: 0.05, release: 0.5 },
};

const PROC = `
const SR = sampleRate, TAU = Math.PI * 2;
const DMAX = Math.ceil(SR * 0.03);
class Ensemble extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({}, o.processorOptions.params);
    this.q = []; this.alive = true;
    this.port.onmessage = (e) => { const m = e.data; if (m[0] === 9) { this.alive = false; return; } let i = this.q.length; while (i > 0 && this.q[i - 1][1] > m[1]) i--; this.q.splice(i, 0, m); };
    this.v = new Map();            // note -> voice
    this.buf = new Float32Array(DMAX); this.w = 0;
    this.slow = 0; this.fast = 0;
    this.lp1 = 0; this.lp2 = 0; this.hp = 0; this.hpx = 0; this.vb = [0, 0, 0, 0];
  }
  event(m) {
    const [type, , a, b] = m;
    if (type === 2) { this.p[a] = b; return; }
    if (type === 3) { for (const v of this.v.values()) v.gate = false; return; }
    if (type === 1) {
      const f = 440 * Math.pow(2, (a - 69) / 12), old = this.v.get(a);
      // the phases start where a divider chain would be: the same for a key every time, so it renders identically
      this.v.set(a, { note: a, f, gate: true, env: old ? old.env : 0, vel: 0.55 + 0.45 * (b / 127), ph: old ? old.ph : [((a * 0.618) % 1), ((a * 0.317) % 1), ((a * 0.213) % 1), ((a * 0.771) % 1)] });
      return;
    }
    if (type === 0) { const v = this.v.get(a); if (v) v.gate = false; }
  }
  saw(ph, dt) { let x = 2 * ph - 1; if (ph < dt) { const t = ph / dt; x -= t + t - t * t - 1; } else if (ph > 1 - dt) { const t = (ph - 1) / dt; x -= t * t + t + t + 1; } return x; }
  process(_, outputs) {
    if (!this.alive) return false;
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length, p = this.p, f0 = currentFrame;
    const atk = 1 - Math.exp(-1 / (p.attack * SR / 3)), rel = Math.exp(-1 / (p.release * SR / 3));
    // the tone: a low-pass that opens with the knob, and the formant-ish lift of the classic string section
    const lpF = 900 * Math.pow(12, p.tone), lpK = 1 - Math.exp(-TAU * lpF / SR);
    const sR = 0.4 + p.speed * 0.9, fR = 5 + p.speed * 3.5, depth = p.ensemble;
    const mix = [p.violin, p.viola, p.cello, p.bass];
    for (let i = 0; i < n; i++) {
      while (this.q.length && this.q[0][1] <= f0 + i) this.event(this.q.shift());
      let x = 0;
      for (const v of this.v.values()) {
        v.env = v.gate ? v.env + (1 - v.env) * atk : v.env * rel;
        if (!v.gate && v.env < 1e-4) { this.v.delete(v.note); continue; }
        // violins: the key and an octave up, bright; violas: the key; cellos: an octave down; basses: two down, low keys only
        const fr = [v.f, v.f, v.f / 2, v.f / 4];
        let s = 0;
        for (let k = 0; k < 4; k++) {
          if (!mix[k] || (k === 3 && v.note > 60) || (k === 2 && v.note > 84)) continue;
          const dt = fr[k] / SR; v.ph[k] += dt; if (v.ph[k] >= 1) v.ph[k] -= 1;
          let o = this.saw(v.ph[k], dt);
          if (k === 0) { const d2 = dt * 2, p2 = (v.ph[k] * 2) % 1; o = o * 0.6 + this.saw(p2, d2) * 0.4; }
          if (k === 1) o = o * 0.85 + (v.ph[k] < 0.5 ? 0.15 : -0.15);   // a little hollow
          s += o * mix[k] * (k === 3 ? 0.9 : k === 2 ? 0.8 : 0.6);
        }
        x += s * v.env * v.vel;
      }
      x *= 0.22;
      // tone
      this.lp1 += (x - this.lp1) * lpK; this.lp2 += (this.lp1 - this.lp2) * lpK;
      let y = this.lp2 + (this.lp1 - this.lp2) * 0.35;
      this.hp += (y - this.hpx) - this.hp * (1 - Math.exp(-TAU * 60 / SR)); this.hpx = y; y = this.hp;
      // the ensemble: three taps 120 degrees apart on a slow and a fast wobble, spread across the stereo field
      this.buf[this.w] = y;
      this.slow += sR / SR; if (this.slow >= 1) this.slow -= 1; this.fast += fR / SR; if (this.fast >= 1) this.fast -= 1;
      let l = 0, r = 0;
      for (let k = 0; k < 3; k++) {
        const off = k / 3, d = (0.007 + depth * (0.0045 * Math.sin(TAU * (this.slow + off)) + 0.0009 * Math.sin(TAU * (this.fast + off)))) * SR;
        let pos = this.w - d; while (pos < 0) pos += DMAX;
        const i0 = Math.floor(pos), fr = pos - i0, s = this.buf[i0 % DMAX] * (1 - fr) + this.buf[(i0 + 1) % DMAX] * fr;
        const pan = [-0.8, 0, 0.8][k];
        l += s * (1 - pan) * 0.5; r += s * (1 + pan) * 0.5;
      }
      this.w = (this.w + 1) % DMAX;
      const wet = depth, dry = 1 - depth * 0.6;
      L[i] = Math.tanh((y * dry + l * wet * 0.9) * 1.4) * p.level;
      R[i] = Math.tanh((y * dry + r * wet * 0.9) * 1.4) * p.level;
    }
    return true;
  }
}
registerProcessor('${NAME}', Ensemble);
`;

const ICON = `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
  <rect x="5" y="15" width="110" height="54" rx="4" fill="#6b4a2f"/><rect x="9" y="19" width="102" height="22" rx="2" fill="#1c1b1a"/>
  <text x="14" y="28" font-family="Inter Tight,Arial" font-weight="800" font-size="6.5" letter-spacing="1.6" fill="#e8d9b8">ENSEMBLE</text>
  ${['#e2c25a', '#e2c25a', '#c86a3c', '#c86a3c', '#8fb3c9'].map((c, i) => `<rect x="${14 + i * 12}" y="32" width="9" height="5" rx="1" fill="${c}"/>`).join('')}
  <circle cx="92" cy="33" r="4.5" fill="#2e2c2a" stroke="#e8d9b8" stroke-width=".8"/><circle cx="104" cy="33" r="4.5" fill="#2e2c2a" stroke="#e8d9b8" stroke-width=".8"/>
  <rect x="9" y="45" width="102" height="20" rx="1.5" fill="#efece4"/>
  ${Array.from({ length: 16 }, (_, i) => `<line x1="${9 + (i + 1) * 6.4}" y1="45" x2="${9 + (i + 1) * 6.4}" y2="65" stroke="#9c998f" stroke-width=".5"/>`).join('')}
  ${[0, 1, 3, 4, 5, 7, 8, 10, 11, 12, 14].map((i) => `<rect x="${9 + (i + 0.65) * 6.4}" y="45" width="4.4" height="12" fill="#1b1b1d"/>`).join('')}</svg>`;

export default {
  id: 'ensemble',
  name: 'Ensemble',
  family: 'String machine',
  blurb: 'A 70s string machine: every key a perfectly in-tune sawtooth, in four sections you mix like drawbars (violins, violas, cellos, basses), one slow swell and fade, a tone control, and the ensemble chorus that turns a thin saw into a whole string section.',
  lineage: 'The divide-down string machines of the 1970s',
  icon: ICON,
  skin: { knob: 'fader', option: 'buttons', wood: true },
  traits: { arch: ['strings'], osc: ['divide'], voices: 128, tags: ['ensemble'] },
  params: PARAMS,
  presets: PRESETS,
  presetNames: { strings: 'Strings', lush: 'Lush', violins: 'Violins', cellos: 'Cellos', pad: 'Pad', dry: 'Dry' },
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
