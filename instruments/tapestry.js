// Tapestry: a tape-replay keyboard, in the spirit of the 1960s-70s keyboards where every key pulled a strip of
// recorded tape across a playback head (lineage: the Chamberlin / Mellotron family), with a second medium in the
// spirit of the 1970s home organs that played looped recordings off spinning optical film discs (the Optigan
// family). No samples: each "recording" is synthesized, then played back through a model of the medium.
//
// Tape: a key press pushes the tape onto the head (a pad attack, with a small pitch scoop while the tape comes up
// to speed), the recording plays (its own bowing, breathing or striking) for at most the tape's length (8 s by
// default: hold a note longer and it runs out), and letting go lifts the pad (a short release). The capstan's
// wow and flutter move every key, each tape a little differently; every key has its own static tuning offset and
// level, more so as the tapes age, with more hiss, duller highs and the odd dropout.
//
// Optical disc: the recordings are short loops, one per turn of the disc, so a held note never runs out but
// shimmers gently once a turn; the optical track is band-limited and a little gritty, with dust crackle, a light
// hiss and an amplitude ripple from the disc's rotation, and a slight speed wobble once a turn. The chord buttons
// of those organs are the Chord setting: one key plays a whole chord.
//
// Deterministic: noise, crackle, dropouts and per-key offsets come from seeded generators.

const NAME = 'jj-tapestry-1';
const VOICES = ['Strings', 'Flute', 'Choir', 'Cello', 'Brass', 'Vibes', 'Organ', 'Guitar'];
const PARAMS = [
  { id: 'voice', name: 'Recording', options: VOICES, min: 0, max: VOICES.length - 1, def: 0, step: 1, group: 'Tape' },
  { id: 'medium', name: 'Medium', options: ['Tape', 'Optical disc'], min: 0, max: 1, def: 0, step: 1, group: 'Tape' },
  { id: 'chord', name: 'Chord', options: ['Single', 'Major', 'Minor', 'Seventh', 'Octaves'], min: 0, max: 4, def: 0, step: 1, group: 'Tape' },
  { id: 'length', name: 'Tape length', min: 2, max: 16, def: 8, unit: 's', group: 'Tape' },
  { id: 'wow', name: 'Wow', min: 0, max: 1, def: 0.3, cc: 1, group: 'Transport' },
  { id: 'flutter', name: 'Flutter', min: 0, max: 1, def: 0.3, group: 'Transport' },
  { id: 'age', name: 'Tape age', min: 0, max: 1, def: 0.35, group: 'Tape' },
  { id: 'attack', name: 'Pad attack', min: 0.005, max: 0.6, def: 0.035, curve: 'exp', unit: 's', group: 'Keys' },
  { id: 'release', name: 'Release', min: 0.02, max: 1.5, def: 0.12, curve: 'exp', unit: 's', cc: 72, group: 'Keys' },
  { id: 'drive', name: 'Saturation', min: 0, max: 1, def: 0.3, group: 'Output' },
  { id: 'tone', name: 'Tone', min: 1500, max: 16000, def: 7000, curve: 'exp', unit: 'Hz', cc: 74, group: 'Output' },
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.75, cc: 7, group: 'Output' },
];
const PRESETS = {
  strings: { voice: 0 },
  flute: { voice: 1, tone: 9000, drive: 0.2 },
  choir: { voice: 2, attack: 0.06, release: 0.25 },
  cello: { voice: 3, tone: 6000 },
  brass: { voice: 4, tone: 9000, drive: 0.45 },
  vibes: { voice: 5, release: 0.45, tone: 10000 },
  worn: { voice: 0, age: 0.85, wow: 0.65, flutter: 0.55, tone: 4500 },
  chordorgan: { voice: 6, medium: 1, chord: 1, attack: 0.012, release: 0.08, age: 0.5, wow: 0.35, tone: 5000, drive: 0.4 },
  lounge: { voice: 5, medium: 1, chord: 3, release: 0.3, age: 0.45, tone: 5500 },
  strum: { voice: 7, medium: 1, chord: 1, attack: 0.008, release: 0.2, age: 0.45, tone: 5000 },
};

// a wooden cabinet with its tape frames showing above the keys, and an optical disc leaning against it
const keysSvg = (x, y, w, h, n) => { let k = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1.2" fill="#ecebe4"/>`; const kw = w / n; for (let i = 1; i < n; i++) k += `<line x1="${x + i * kw}" y1="${y}" x2="${x + i * kw}" y2="${y + h}" stroke="#9c998f" stroke-width=".6"/>`; for (let i = 0; i < n - 1; i++) if ([0, 1, 3, 4, 5].includes(i % 7)) k += `<rect x="${x + (i + 0.65) * kw}" y="${y}" width="${kw * 0.7}" height="${h * 0.6}" fill="#1b1b1d"/>`; return k; };
const ICON = `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
  <path d="M10 70 L10 30 L22 12 L98 12 L110 30 L110 70 Z" fill="#6b4226"/><path d="M22 12 L98 12 L104 22 L16 22 Z" fill="#8a5a34"/>
  <rect x="20" y="24" width="80" height="12" rx="1.5" fill="#1d1a17"/>${Array.from({ length: 13 }, (_, i) => `<rect x="${23 + i * 6}" y="26" width="3.6" height="8" fill="${i % 4 === 1 ? '#c9a14a' : '#5a4a36'}"/>`).join('')}
  <circle cx="30" cy="42" r="2.2" fill="#e9e4d6"/><circle cx="40" cy="42" r="2.2" fill="#e9e4d6"/><rect x="74" y="40" width="22" height="4" rx="1" fill="#e9e4d6"/>
  ${keysSvg(16, 48, 88, 15, 15)}<rect x="10" y="66" width="100" height="4" fill="#4e2f1a"/>
  <circle cx="106" cy="62" r="11" fill="#2a2a2e" stroke="#c9cbd0" stroke-width=".8"/><circle cx="106" cy="62" r="7" fill="none" stroke="#6d6f75" stroke-width=".5"/><circle cx="106" cy="62" r="2" fill="#c9a14a"/></svg>`;

const PROC = `
const SR = sampleRate, TAU = Math.PI * 2, NV = 24, CR = 32, ROT = 1.65;   // ROT: an optical disc's turns a second
// the room each recording was made in: a few broad resonances (a violin's body, a choir's "ah", brass bells),
// added to the dry sound after the voices are summed (they're the same for every key, so once is enough)
const FORM = [
  [0.45, [[300, 1.4, 0.55], [950, 1.6, 0.45], [2700, 2.2, 0.4], [4400, 3, 0.2]]],   // strings
  [1, []],                                                                          // flute
  [0.12, [[720, 4, 1.1], [1240, 5, 0.65], [2650, 6, 0.4], [3350, 7, 0.25]]],       // choir
  [0.4, [[210, 1.3, 0.8], [620, 1.6, 0.5], [1900, 2.2, 0.3]]],                       // cello
  [0.55, [[520, 1.6, 0.55], [1350, 1.8, 0.55], [2900, 2.4, 0.3]]],                   // brass
  [1, []],                                                                          // vibes
  [0.8, [[1600, 1.2, 0.25]]],                                                       // organ
  [0.65, [[110, 1.4, 0.4], [240, 1.6, 0.45], [2400, 1.5, 0.25]]],                    // guitar
];
const LEVEL = [0.34, 0.34, 0.36, 0.42, 0.36, 0.4, 0.3, 0.5].map((x) => x * 0.6);
const CHORDS = [[0], [0, 4, 7], [0, 3, 7], [0, 4, 7, 10], [0, 12]];
function saw(ph, inc) {   // a band-limited saw (polyBLEP)
  let s = 2 * ph - 1;
  if (ph < inc) { const x = ph / inc; s -= x + x - x * x - 1; } else if (ph > 1 - inc) { const x = (ph - 1) / inc; s -= x * x + x + x + 1; }
  return s;
}
class Tapestry extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({ bend: 0 }, o.processorOptions.params);
    this.q = []; this.alive = true; this.clock = 0; this.n = 0;
    this.port.onmessage = (e) => { const m = e.data; if (m[0] === 9) { this.alive = false; return; } let i = this.q.length; while (i > 0 && this.q[i - 1][1] > m[1]) i--; this.q.splice(i, 0, m); };
    this.v = []; for (let i = 0; i < NV; i++) this.v.push({ dead: true, gate: false, note: -1, key: -1, ph: new Float64Array(4), inc: new Float64Array(4), re: new Float64Array(4), im: new Float64Array(4), cr: new Float64Array(4), ci: new Float64Array(4), dm: new Float64Array(4), vph: new Float64Array(4), vr: new Float64Array(4), lp: [0, 0], seed: 1 });
    this.fs = []; this.setForm(this.p.voice | 0);
    this.seed = 0x1234567; this.hp = 0; this.lp1 = 0; this.lp2 = 0; this.cr = 0; this.trem = 1; this.dc = 0; this.hiss = 0; this.flN = 0;
  }
  dropGap(v) { const r = this.p.age * this.p.age * 0.8; return r > 0.001 ? Math.round(-Math.log(0.5 + 0.5 * Math.abs(this.rnd(v)) + 1e-9) / r * SR * 2) + SR * 0.3 : Infinity; }
  // each recording's own envelope (a bow's or a breath's onset, a struck bar's decay, a brass swell, a string's
  // fading highs), every CR samples
  shape(v, ts) {
    const k = v.kind, ex = Math.exp;
    if (k === 0 || k === 2 || k === 3 || k === 4) v.rec = 1 - ex(-ts / (k === 0 ? 0.16 : k === 2 ? 0.22 : k === 3 ? 0.12 : 0.05));
    if (k === 4) { const sw = (1 - ex(-ts / 0.03)) * (0.55 + 0.45 * ex(-ts / 0.35)); v.fg = 2 * Math.sin(Math.PI * Math.min(SR * 0.2, v.f0 * (1.5 + 12 * sw)) / SR); }
    if (k === 2 && ts === 0) v.fg = 1 - ex(-TAU * Math.min(v.f0 * 3, 2200) / SR);
    if (k === 1) { v.rec = 1 - ex(-ts / 0.07); v.a2 = 0.05 + 0.3 * ex(-ts / 0.03); }
    if (k === 5) { v.d0 = ex(-ts / 3); v.d1 = 0.25 * ex(-ts / 0.9); v.d2 = 0.08 * ex(-ts / 0.25); }
    if (k === 7) { v.fg = 2 * Math.sin(Math.PI * Math.min(SR * 0.2, v.f0 * (1.2 + 10 * ex(-ts / 0.15))) / SR); v.rec = ex(-ts / 1.6); }
  }
  rnd(o) { let t = (o.seed = (o.seed + 0x6D2B79F5) | 0); t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1; }
  setForm(k) { const F = FORM[k] || FORM[0]; this.form = k; this.dry = F[0]; this.fs = F[1].map(([f, q, g]) => ({ f: 2 * Math.sin(Math.PI * Math.min(f, SR / 7) / SR), q: 1 / q, g, lo: 0, bp: 0 })); }
  start(v, note, key, vel, delay) {
    const p = this.p, age = p.age, kind = p.voice | 0;
    v.dead = false; v.gate = true; v.note = note; v.key = key; v.kind = kind; v.t = -Math.round(delay * SR); v.age = ++this.clock;
    v.f0 = 440 * Math.pow(2, (note - 69) / 12); v.vel = 0.8 + 0.2 * vel / 127; v.env = 0; v.drop = 1; v.dropT = 0;
    v.seed = 0x9E3779B1 ^ (note * 2654435761) ^ kind * 977;
    const r = (o) => this.rnd(o);
    // each key's own tape: a static tuning offset and level, and its own wow
    v.tune = r(v) * (2 + 14 * age); v.lvl = Math.pow(10, r(v) * (0.5 + 2.5 * age) / 20); v.wr = 0.45 + 0.4 * Math.abs(r(v)); v.wp = Math.abs(r(v)) * TAU;
    const det = kind === 0 ? [-8, 0, 7] : kind === 2 ? [-12, 2, 11] : kind === 3 ? [-5, 5] : kind === 4 ? [-4, 3] : [0];
    const mul = kind === 5 ? [1, 3.93, 9.6] : null;   // vibes: a bar's partials, each with its own phase
    v.ns = mul ? 3 : det.length;
    for (let j = 0; j < 4; j++) { v.dm[j] = mul ? mul[j] || 1 : Math.pow(2, (det[j] || 0) / 1200); v.ph[j] = Math.abs(r(v)); v.vph[j] = Math.abs(r(v)) * TAU; v.vr[j] = 4.8 + 1.4 * Math.abs(r(v)); }
    for (let j = 0; j < 4; j++) { v.re[j] = Math.cos(TAU * v.ph[j]); v.im[j] = Math.sin(TAU * v.ph[j]); }
    v.lp[0] = 0; v.lp[1] = 0; v.nz = 0; v.d0 = 0; v.d1 = 0; v.d2 = 0; v.rec = 0; v.fg = 0; v.a2 = 0;
    v.nextDrop = this.dropGap(v);
  }
  event(m) {
    const [type, , a, b] = m;
    if (type === 1) {
      const ch = CHORDS[this.p.chord | 0] || CHORDS[0], strum = (this.p.voice | 0) === 7 ? 0.022 : 0;
      for (let i = 0; i < ch.length; i++) {
        const note = a + ch[i]; if (note > 120) continue;
        let v = this.v.find((x) => !x.dead && x.note === note && x.key === a);
        if (!v) { const free = this.v.filter((x) => x.dead); v = free.length ? free[0] : this.v.reduce((x, y) => (y.age < x.age ? y : x)); }
        this.start(v, note, a, b, i * strum);
      }
    } else if (type === 0) { for (const v of this.v) if (v.key === a && v.gate) v.gate = false; }
    else if (type === 2) { this.p[a] = b; if (a === 'voice') this.setForm(b | 0); }
    else if (type === 3) { for (const v of this.v) v.gate = false; }
  }
  process(_, outputs) {
    if (!this.alive) return false;
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length, p = this.p, f0 = currentFrame;
    const optical = (p.medium | 0) === 1, age = p.age;
    const aK = 1 - Math.exp(-1 / (p.attack * SR)), rK = 1 - Math.exp(-1 / (p.release * SR)), endK = 1 - Math.exp(-1 / (0.09 * SR));
    const lenS = optical ? Infinity : Math.round(p.length * SR);
    const cut = optical ? Math.min(p.tone, 5200) : p.tone * (1 - 0.55 * age), lpC = 1 - Math.exp(-TAU * cut / SR), hpC = 1 - Math.exp(-TAU * (optical ? 120 : 35) / SR);
    const drv = 1 + p.drive * (optical ? 5 : 3.5), norm = 1 / Math.tanh(drv * 0.5) * 0.5;
    const hissAmt = optical ? 0.006 + 0.01 * age : 0.004 + 0.022 * age, crackRate = optical ? (3 + 25 * age) / SR : 0;
    for (let i = 0; i < n; i++) {
      while (this.q.length && this.q[0][1] <= f0 + i) this.event(this.q.shift());
      const T = (f0 + i) / SR;
      if (this.n % CR === 0) this.trem = 1 - 0.35 * (0.5 + 0.5 * Math.sin(TAU * 4.6 * T));
      const trem = this.trem;
      // the capstan (or the disc's drive): slow wow and fast flutter, the same for every key
      if (this.n % CR === 0) {
        this.flN += (this.rnd(this) - this.flN) * 0.08;
        const wowC = optical ? p.wow * 8 * Math.sin(TAU * ROT * T) : p.wow * 14 * (0.7 * Math.sin(TAU * 0.55 * T) + 0.3 * Math.sin(TAU * 0.83 * T + 1));
        const flC = p.flutter * (optical ? 2.5 : 5) * (0.5 * Math.sin(TAU * 7.3 * T) + 0.3 * Math.sin(TAU * 11.1 * T) + 0.4 * this.flN);
        for (const v of this.v) {
          if (v.dead) continue;
          const ts = Math.max(0, v.t) / SR;
          const scoop = optical ? 0 : -18 * Math.exp(-ts / 0.05);   // the tape coming up to speed
          const own = optical ? 0 : p.wow * 6 * Math.sin(v.wp + TAU * v.wr * T);
          const vibOn = Math.min(1, Math.max(0, (ts - 0.25) / 0.6));
          const vibD = v.kind === 0 ? 5 : v.kind === 3 ? 7 : v.kind === 2 ? 4 : v.kind === 1 ? 6 : 0;
          const base = v.f0 * Math.pow(2, (v.tune + wowC + flC + scoop + own + p.bend * 100) / 1200) / SR;
          for (let j = 0; j < v.ns; j++) {
            v.inc[j] = base * v.dm[j] * (1 + vibD * vibOn * Math.sin(v.vph[j] + TAU * v.vr[j] * ts) / 1731);
            // the sine recordings run as rotating phasors: a multiply-add a sample, no sin()
            v.cr[j] = Math.cos(TAU * v.inc[j]); v.ci[j] = Math.sin(TAU * v.inc[j]);
            const m = 1 / Math.hypot(v.re[j], v.im[j]); v.re[j] *= m; v.im[j] *= m;
          }
        }
      }
      this.n++;
      let s = 0, act = 0;
      for (const v of this.v) {
        if (v.dead) continue;
        if (v.t < 0) { v.t++; continue; }   // a strummed chord's later strings
        const ts = v.t / SR;
        // the pressure pad: on while the key is down and there's tape left; the tape's end fades quickly
        const on = v.gate && v.t < lenS ? 1 : 0;
        v.env += (on - v.env) * (on > v.env ? aK : v.gate ? endK : rK);
        v.t++;
        if (!on && v.env < 1e-4) { v.dead = true; v.gate = false; v.note = -1; v.key = -1; continue; }
        // the recording itself; its envelopes move at control rate
        let x = 0; const k = v.kind;
        if (v.t % CR === 1) this.shape(v, ts);
        if (k === 0 || k === 2 || k === 3 || k === 4) {
          for (let j = 0; j < v.ns; j++) { x += saw(v.ph[j], v.inc[j]); v.ph[j] += v.inc[j]; if (v.ph[j] >= 1) v.ph[j] -= 1; }
          x /= v.ns;
          if (k === 4) { const g = v.fg; v.lp[1] += g * (x - v.lp[0] - 0.9 * v.lp[1]); v.lp[0] += g * v.lp[1]; x = v.lp[0] * 1.2; }   // brass: through a filter that opens with the swell
          if (k === 2) { v.lp[0] += (x - v.lp[0]) * v.fg; v.nz += (this.rnd(v) - v.nz) * 0.12; x = v.lp[0] * 1.5 + v.nz * 0.1; }   // voices: a soft glottal edge, and breath
          x *= v.rec;
        } else if (k === 1) {   // flute: nearly a sine, breath, a chiff as it speaks
          const c = v.re[0], sn = v.im[0]; x = sn + 0.36 * sn * c + 0.06 * sn * (3 - 4 * sn * sn);
          const r0 = c * v.cr[0] - sn * v.ci[0]; v.im[0] = c * v.ci[0] + sn * v.cr[0]; v.re[0] = r0;
          const w = this.rnd(v), br = w - v.nz; v.nz = w;   // breath: the air's hiss across the embouchure, bright
          x = x * v.rec + br * v.a2;
        } else if (k === 5) {   // vibes: struck bars with a motor's tremolo
          x = (v.im[0] * v.d0 + v.im[1] * v.d1 + v.im[2] * v.d2) * (ts < 0.02 ? 1 - Math.exp(-ts / 0.002) : 1) * trem;
          for (let j = 0; j < 3; j++) { const r0 = v.re[j] * v.cr[j] - v.im[j] * v.ci[j]; v.im[j] = v.re[j] * v.ci[j] + v.im[j] * v.cr[j]; v.re[j] = r0; }
        } else if (k === 6) {   // organ: a few drawbars' worth of sines
          const c = v.re[0], sn = v.im[0], s2 = 2 * sn * c, c2 = 1 - 2 * sn * sn, s3 = sn * (3 - 4 * sn * sn), c3 = c * (4 * c * c - 3);
          x = (sn + 0.6 * s2 + 0.35 * s3 + 0.2 * 2 * s2 * c2 + 0.12 * 2 * s3 * c3) * 0.55;
          const r0 = c * v.cr[0] - sn * v.ci[0]; v.im[0] = c * v.ci[0] + sn * v.cr[0]; v.re[0] = r0;
        } else {   // guitar: a plucked string, its highs dying first
          x = saw(v.ph[0], v.inc[0]); v.ph[0] += v.inc[0]; if (v.ph[0] >= 1) v.ph[0] -= 1;
          const g = v.fg; v.lp[1] += g * (x - v.lp[0] - 0.7 * v.lp[1]); v.lp[0] += g * v.lp[1]; x = v.lp[0] * v.rec * (ts < 0.01 ? 1 - Math.exp(-ts / 0.001) : 1);
        }
        // an old tape's dropouts: the oxide thins and the sound ducks for a moment
        if (!optical && v.t >= v.nextDrop) { v.dropT = 0.04 * SR; v.nextDrop = v.t + this.dropGap(v); }
        if (v.dropT > 0) { v.dropT--; v.drop += (0.45 - v.drop) * 0.01; } else v.drop += (1 - v.drop) * 0.003;
        const e = v.env * v.vel * v.lvl * v.drop;
        s += x * e * LEVEL[k] * (k === 2 ? 1.6 : 1); act += v.env;
      }
      // the room the recordings were made in
      let y = s * this.dry;
      for (const f of this.fs) { const hp = s - f.lo - f.q * f.bp; f.bp += f.f * hp; f.lo += f.f * f.bp; y += f.bp * f.g; }
      // the medium: an optical track shimmers once a turn (the loop's highs come and go) and ripples in level
      if (optical) {
        const turn = 0.5 + 0.5 * Math.sin(TAU * ROT * T);
        y *= 1 - 0.1 * turn * (0.5 + age);
        this.hp += (y - this.hp) * 0.35; y = y + (y - this.hp) * 0.6 * (turn - 0.5);
      }
      // hiss from every head in use, an optical disc's dust
      this.hiss += (this.rnd(this) - this.hiss) * 0.5;
      const busy = Math.sqrt(act);
      y += this.hiss * hissAmt * busy;
      if (crackRate && this.rnd(this) * 0.5 + 0.5 < crackRate * Math.min(1, busy)) this.cr = this.rnd(this) * 0.25;
      y += this.cr; this.cr *= 0.6;
      // the playback amp: a gentle saturation, the head's high-frequency loss, no DC
      y = Math.tanh(y * drv) * norm;
      this.lp1 += (y - this.lp1) * lpC; this.lp2 += (this.lp1 - this.lp2) * lpC;
      this.dc += (this.lp2 - this.dc) * hpC;
      const o = (this.lp2 - this.dc) * p.level;
      L[i] = o; R[i] = o;
    }
    return true;
  }
}
registerProcessor('${NAME}', Tapestry);
`;

export default {
  id: 'tapestry',
  name: 'Tapestry',
  family: 'Tape keyboard',
  blurb: 'A tape-replay keyboard in the spirit of the 60s and 70s ones: every key plays a recording (strings, flute, choir, cello, brass, vibes) that runs out after 8 seconds, with wow, flutter, hiss and ageing tapes. Switch the medium to optical disc for the looped, dusty sound of the 70s home organs, chord buttons included.',
  icon: ICON,
  lineage: 'tape-replay keyboards (Chamberlin, Mellotron) and optical-disc organs (Optigan); all synthesized, no samples',
  params: PARAMS,
  presets: PRESETS,
  presetNames: { strings: 'Strings', flute: 'Flute', choir: 'Choir', cello: 'Cello', brass: 'Brass', vibes: 'Vibes', worn: 'Worn strings', chordorgan: 'Chord organ (disc)', lounge: 'Lounge vibes (disc)', strum: 'Guitar strum (disc)' },
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
