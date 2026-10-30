// Match my sound: while you play your hardware, a background fitter morphs its software twin toward what your
// hardware actually sounds like, so the band hears something closer and closer to you.
//
// Every note you play is a free measurement: the browser knows the note, its velocity and how long you held it,
// and hears what your synth did in reply through your audio input (lined up by the note onsets). From each clean
// note it takes the envelope (attack, the level curve over the first second, release) and the harmonic spectrum
// at the onset and in the sustain (brightness, odd/even balance, how the filter closes), plus how noisy it is.
// A fitter then renders twin settings offline, in batches, on the same notes and keeps the closest. It never sits
// in the audio path: renders run on the offline renderer at a low sample rate, one batch at a time, paced, and
// paused when the jam is under strain. Improvements reach the band as ordinary timed parameter glides, so every
// browser morphs the same way at the same moment.

const FIT_SR = 16000;   // harmonics 1-12 of notes up to about G4 fit under 8 kHz; a third of the cost of 48 kHz
const SLOT = 1.25;      // seconds rendered per candidate note
const LEADIN = 0.03;    // notes start after the render's first held moment (see render)
const SKIP = /^(level|velAmt|range|osc\d?Range|glide|priority|mono|lfoRate|lfoDelay|lfoPitch|lfoFilter|vibrato|chorus|trem|kbd|hpf|vca|envPol)$/;

// ---------- features ----------
function goertzel(x, start, n, f, sr) {
  const w = (2 * Math.PI * f) / sr, c = 2 * Math.cos(w); let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); const s = x[start + i] * win + c * s1 - s2; s2 = s1; s1 = s; }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / n;
}
function harmonics(x, sr, f0, at, K = 12) {
  const n = Math.round(sr * 0.064), start = Math.round(at * sr) - (n >> 1);   // the same 64 ms window at any sample rate
  if (start < 0 || start + n > x.length) return null;
  const h = [];
  for (let k = 1; k <= K; k++) { const f = f0 * k; h.push(f < sr * 0.45 ? goertzel(x, start, n, f, sr) : 0); }
  // a sinusoid of amplitude A gives |X|/n = A/4 through a Hann window, so its power A^2/2 is 8 (|X|/n)^2
  let tot = 0; for (let i = 0; i < n; i++) tot += x[start + i] * x[start + i];
  const harmP = h.reduce((a, v) => a + 8 * v * v, 0);
  const ref = Math.max(...h, 1e-9);
  return { db: h.map((v) => Math.max(-60, 20 * Math.log10(Math.max(v, 1e-9) / ref))), noise: Math.max(0, Math.min(1, 1 - harmP / Math.max(tot / n, 1e-12))) };
}
// x: mono samples starting at the note's onset; held: seconds the key was down
export function analyze(x, sr, note, held) {
  // start at the sound's own onset (within the first 100 ms): live notes arrive with a little timing jitter
  { const hop = Math.round(sr * 0.0025), lim = Math.min(x.length, Math.round(sr * 0.1)); let pk = 0; for (let i = 0; i < Math.min(x.length, sr * 0.4); i++) pk = Math.max(pk, Math.abs(x[i]));
    for (let i = 0; i + hop < lim; i += hop) { let a = 0; for (let k = i; k < i + hop; k++) a = Math.max(a, Math.abs(x[k])); if (a > pk * 0.1) { if (i > hop) { x = x.subarray(i - hop); held = Math.max(0.05, held - (i - hop) / sr); } break; } } }
  const f0 = 440 * 2 ** ((note - 69) / 12), hop = Math.round(sr * 0.005), m = Math.floor(x.length / hop);
  const env = new Float32Array(m);
  for (let i = 0; i < m; i++) { let e = 0; for (let k = i * hop; k < (i + 1) * hop; k++) e += x[k] * x[k]; env[i] = Math.sqrt(e / hop); }
  let pk = 0; for (let i = 0; i < m; i++) if (env[i] > pk) pk = env[i];
  if (pk < 1e-4) return null;
  const db = (v) => Math.max(-60, 20 * Math.log10(Math.max(v, 1e-9) / pk));
  let att = 0; for (let i = 0; i < m; i++) if (env[i] >= 0.9 * pk) { att = i * 5; break; }
  const curve = []; for (let t = 0; t < 1200; t += 20) { const i = Math.floor(t / 5); curve.push(i < m ? db(env[i]) : -60); }
  const offI = Math.floor((held * 1000) / 5); let rel = null;
  if (offI < m - 10) { const ref = env[offI]; for (let i = offI; i < m; i++) if (env[i] < ref * 0.1) { rel = (i - offI) * 5; break; } if (rel == null) rel = (m - offI) * 5; }
  const hOn = harmonics(x, sr, f0, Math.min(0.06 + att / 1000, held * 0.5)), hSus = harmonics(x, sr, f0, Math.max(0.1, Math.min(held * 0.8, 0.7)));
  return { note, held, att, curve, rel, hOn: hOn && hOn.db, hSus: hSus && hSus.db, noise: hSus ? hSus.noise : 0 };
}
export function distance(a, b) {
  if (!a || !b) return 99;
  const md = (p, q) => { if (!p || !q) return 2; let s = 0, n = Math.min(p.length, q.length, 10); for (let i = 0; i < n; i++) s += Math.abs(p[i] - q[i]) * (i < 4 ? 1.4 : 1); return s / n / 10; };
  let d = 0;
  d += 1.2 * md(a.hSus, b.hSus);                      // the timbre while held
  d += 0.7 * md(a.hOn, b.hOn);                        // the bite at the start (filter envelope)
  d += 0.6 * Math.abs(Math.log((a.att + 3) / (b.att + 3)));
  const nC = Math.min(a.curve.length, b.curve.length, Math.ceil((Math.min(a.held, b.held) * 1000 + 300) / 20)); let c = 0; for (let i = 0; i < nC; i++) c += Math.abs(a.curve[i] - b.curve[i]);
  d += 1.0 * (c / Math.max(1, nC) / 10);              // the level over time (decay, sustain)
  if (a.rel != null && b.rel != null && Math.abs(a.held - b.held) < 0.02) d += 0.5 * Math.abs(Math.log((a.rel + 10) / (b.rel + 10)));
  d += 0.8 * Math.abs(a.noise - b.noise);
  return d;
}

// ---------- the fitter ----------
const norm = (P, v) => (P.curve === 'exp' ? Math.log(v / P.min) / Math.log(P.max / P.min) : (v - P.min) / (P.max - P.min));
const denorm = (P, u) => { u = Math.max(0, Math.min(1, u)); let v = P.curve === 'exp' ? P.min * (P.max / P.min) ** u : P.min + u * (P.max - P.min); if (P.step) v = Math.round(v / P.step) * P.step; return v; };

export class Fitter {
  // def: the twin's instrument definition; base: its current params; opts.batch: candidates per render
  constructor(def, base, { batch = 8, perBatch = 2, rng = Math.random } = {}) {
    this.perBatch = perBatch;
    this.def = def; this.space = def.params.filter((P) => !SKIP.test(P.id) && !P.hidden && typeof P.min === 'number' && P.max > P.min);
    this.best = { ...base }; this.bestD = Infinity; this.sigma = 0.22; this.batch = batch; this.rng = rng; this.obs = []; this.renders = 0; this.ms = 0;
  }
  observe(o) {
    if (!o || !o.hSus) return;
    // keep up to six, spread over pitch: replace the closest existing one when full
    if (this.obs.length >= 6) { let j = 0, b = 1e9; this.obs.forEach((x, i) => { const dd = Math.abs(x.note - o.note) - i * 0.01; if (dd < b) { b = dd; j = i; } }); this.obs.splice(j, 1); }
    this.obs.push(o); this.bestD = Infinity;   // new evidence: re-score the current best
  }
  propose() {
    const c = { ...this.best }, n = 1 + Math.floor(this.rng() * Math.min(3, this.space.length));
    for (let i = 0; i < n; i++) {
      const P = this.space[Math.floor(this.rng() * this.space.length)];
      // a switch or a choice (waveform on/off, a waveshape) jumps to another of its values; a knob moves by a step
      const choices = P.step ? Math.round((P.max - P.min) / P.step) + 1 : 0;
      if (choices && choices <= 8) { const cur = Math.round(((c[P.id] ?? P.def) - P.min) / P.step); let k = Math.floor(this.rng() * (choices - 1)); if (k >= cur) k++; c[P.id] = P.min + k * P.step; continue; }
      const g = (this.rng() + this.rng() + this.rng() - 1.5) * 2 * this.sigma;
      c[P.id] = denorm(P, norm(P, c[P.id] ?? P.def) + g);
    }
    return c;
  }
  // render candidates on the observed notes. Each candidate gets its own offline context, so every candidate meets
  // its notes at the same moment of the instrument's life (free-running LFOs, chorus) and scores are comparable.
  // One context renders at a time, to keep the cost steady.
  async render(cands, notes) {
    const out = [], t0 = performance.now();
    for (const p of cands) {
      const ctx = new OfflineAudioContext(1, Math.ceil(FIT_SR * SLOT * notes.length), FIT_SR);
      if (this.def.init) await this.def.init(ctx);
      const insts = notes.map((o, ni) => {
        const t = ni * SLOT + LEADIN, g = ctx.createGain(); g.connect(ctx.destination);
        const inst = this.def.create(ctx, g, p);
        inst.noteOn(o.note, o.vel ?? 100, t); inst.noteOff(o.note, t + Math.min(o.held, SLOT - 0.3));
        return inst;
      });
      // a worklet instrument's first messages arrive asynchronously: hold the render a moment at the start so they land
      const hold = ctx.suspend(256 / FIT_SR).then(async () => { await new Promise((r) => setTimeout(r, 30)); ctx.resume(); });
      const x = (await ctx.startRendering()).getChannelData(0); await hold;
      for (const i of insts) { try { i.dispose(); } catch (_) {} }
      out.push(notes.map((o, ni) => { const s = Math.round((ni * SLOT + LEADIN) * FIT_SR); return analyze(x.subarray(s, s + Math.round(SLOT * FIT_SR)), FIT_SR, o.note, Math.min(o.held, SLOT - 0.3)); }));
    }
    this.renders += cands.length * notes.length; this.ms += performance.now() - t0;
    return out;
  }
  // attack, decay, sustain and release estimated from the observed envelopes (the twins' envelopes are exponential
  // segments: an attack toward 1.25 with time constant A/2.2 reaches its peak at about 0.7 A, a release falls
  // 20 dB in about 0.77 R)
  envelopeGuess() {
    const has = (id) => this.space.some((P) => P.id === id), P = (id) => this.space.find((x) => x.id === id);
    if (!has('attack') || !this.obs.length) return null;
    const med = (a) => { const b = a.filter((v) => v != null && isFinite(v)).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : null; };
    const g = { ...this.best }, clamp = (id, v) => Math.max(P(id).min, Math.min(P(id).max, v));
    const att = med(this.obs.map((o) => o.att)); if (att != null) g.attack = clamp('attack', Math.max(0.001, att / 1000 / 0.7));
    if (has('sustain')) { const sus = med(this.obs.map((o) => { const i = Math.min(o.curve.length - 1, Math.floor((o.held * 1000 - 40) / 20)); return i > 5 ? o.curve[i] : null; })); if (sus != null) g.sustain = clamp('sustain', 10 ** (sus / 20)); }
    if (has('decay')) { const dec = med(this.obs.map((o) => { const target = o.curve[Math.min(o.curve.length - 1, Math.floor((o.held * 1000 - 40) / 20))]; const pk = o.curve.indexOf(Math.max(...o.curve)); for (let i = pk; i < o.curve.length; i++) if (o.curve[i] <= target + 1) return (i - pk) * 20; return null; })); if (dec != null) g.decay = clamp('decay', Math.max(0.01, dec / 1000)); }
    if (has('release')) { const rel = med(this.obs.map((o) => o.rel)); if (rel != null) g.release = clamp('release', Math.max(0.005, rel / 1000 / 0.77)); }
    return g;
  }
  score(featsPerNote, notes) { let d = 0; notes.forEach((o, i) => { d += distance(o, featsPerNote[i]); }); return d / notes.length; }
  // one batch: the current best plus perturbations, on two of the observed notes (rotating)
  async step() {
    if (!this.obs.length) return null;
    this.turn = (this.turn || 0) + 1;
    const notes = this.perBatch === 1 || this.obs.length === 1 ? [this.obs[this.turn % this.obs.length]] : this.obs.length <= 2 ? this.obs : [this.obs[this.turn % this.obs.length], this.obs[(this.turn + 1) % this.obs.length]];
    // first, sweep the switches and waveshapes one at a time (a random walk rarely finds "saw off, pulse on");
    // then search the knobs
    if (!this.sweep) { this.sweep = []; for (const P of this.space) { const n = P.step ? Math.round((P.max - P.min) / P.step) + 1 : 0; if (n && n <= 8) for (let k = 0; k < n; k++) this.sweep.push([P.id, P.min + k * P.step]); } }
    const cands = [this.best];
    // and once, a guess read straight off the envelope the notes showed
    if (!this.guessed) { this.guessed = true; const g = this.envelopeGuess(); if (g) cands.push(g); }
    while (this.sweep.length && cands.length < this.batch) { const [id, v] = this.sweep.shift(); if ((this.best[id] ?? null) !== v) cands.push({ ...this.best, [id]: v }); }
    while (cands.length < this.batch) cands.push(this.propose());
    const feats = await this.render(cands, notes);
    const ds = feats.map((f) => this.score(f, notes));
    // the best's score on these notes is the bar to beat (scores on other notes aren't comparable)
    let bi = 0; for (let i = 1; i < ds.length; i++) if (ds[i] < ds[bi]) bi = i;
    const improved = bi !== 0 && ds[bi] < ds[0] * 0.995;
    if (improved) { this.best = cands[bi]; this.sigma = Math.min(0.35, this.sigma * 1.15); } else this.sigma = Math.max(0.03, this.sigma * 0.85);
    this.bestD = Math.min(ds[0], ds[bi]);
    return { improved, d: this.bestD, d0: ds[0], params: this.best };
  }
  // the whole observed set, for reporting
  async scoreAll(p = this.best) { const f = await this.render([p], this.obs); return this.score(f[0], this.obs); }
  similarity(d = this.bestD) { return Math.max(0, Math.min(1, 1 - d / 3)); }
}

// ---------- live capture: the audio input, kept for the last few seconds, stamped with audio frames ----------
const CAPTURE = `
class MatchIn extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; this.f = 0; }
  process(inputs) {
    const i = inputs[0]; if (!i || !i.length) return true;
    const l = i[0], r = i[1] || i[0];
    if (this.n === 0) this.f = currentFrame;
    for (let k = 0; k < l.length; k++) this.buf[this.n + k] = 0.5 * (l[k] + r[k]);
    this.n += l.length;
    if (this.n >= 2048) { this.port.postMessage([this.f, this.buf]); this.buf = new Float32Array(2048); this.n = 0; }
    return true;
  }
}
registerProcessor('jj-matchin', MatchIn);
`;
export class Capture {
  constructor(ctx) { this.ctx = ctx; this.chunks = []; this.keep = 14; }
  async start(stream) {
    if (!this.ctx.__jjWorklets?.has('jj-matchin')) {
      const url = URL.createObjectURL(new Blob([CAPTURE], { type: 'text/javascript' }));
      try { await this.ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      (this.ctx.__jjWorklets = this.ctx.__jjWorklets || new Set()).add('jj-matchin');
    }
    this.stream = stream; this.src = this.ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.ctx, 'jj-matchin', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    this.src.connect(this.node);
    this.node.port.onmessage = (m) => { this.chunks.push(m.data); const old = m.data[0] - this.keep * this.ctx.sampleRate; while (this.chunks.length && this.chunks[0][0] < old) this.chunks.shift(); };
  }
  stop() { try { this.src.disconnect(); } catch (_) {} this.stream?.getTracks().forEach((t) => t.stop()); this.chunks = []; }
  // mono samples for audio frames [f0, f0 + n), or null if not (all) kept
  get(f0, n) {
    if (!this.chunks.length || f0 < this.chunks[0][0]) return null;
    const out = new Float32Array(n); let got = 0;
    for (const [f, d] of this.chunks) { const a = Math.max(f0, f), b = Math.min(f0 + n, f + d.length); if (b > a) { out.set(d.subarray(a - f, b - f), a - f0); got += b - a; } }
    return got >= n * 0.98 ? out : null;
  }
}
