// Big Macro: a six-voice macro oscillator: twenty-four synthesis models behind three knobs (harmonics, timbre, morph),
// each voice through a pinged low-pass gate.
//
// The DSP is Plaits by Émilie Gillet (Mutable Instruments), MIT license, compiled unchanged to WebAssembly (the
// sources, their license and what was changed for the browser are in third_party/plaits; tools/build_bigmacro.sh
// builds instruments/bigmacro.wasm). This file is MEGAjam's wrapper: six complete voices, note allocation, and an
// AudioWorklet that runs the module's 12-sample blocks at 48 kHz on a grid fixed to the audio clock and resamples
// to the context's rate when it isn't 48 kHz. Every note seeds the module's random generator from the note and
// its room time, so noisy models sound the same in every browser.

const NAME = 'jj-bigmacro-1';
const WASM = 'instruments/bigmacro.wasm';
const WASM_SHA = 'ff519575baefb05c73de98cd5e91b783eb35f93d9a1d192b092fa40211a82b8e';

// the models in the order shown, each with the module's engine number and what its three knobs do
const MODELS = [
  ['Virtual analog', 8], ['Waveshaper', 9], ['Two-op FM', 10], ['Formant / grain', 11], ['Harmonic (additive)', 12], ['Wavetable', 13],
  ['Chords', 14], ['Speech', 15], ['Swarm', 16], ['Filtered noise', 17], ['Particle noise', 18], ['Plucked string', 19], ['Modal resonator', 20],
  ['Bass drum', 21], ['Snare drum', 22], ['Hi-hat', 23],
  ['Analog + filter', 0], ['Phase distortion', 1], ['Six-op FM bank A', 2], ['Six-op FM bank B', 3], ['Six-op FM bank C', 4], ['Wave terrain', 5], ['String machine', 6], ['Chiptune', 7],
];
// the heaviest models play fewer voices at once (a modal voice costs about four virtual-analog ones)
const MAX_VOICES = { 14: 3, 18: 4, 20: 3, 21: 4 };

const PARAMS = [
  { id: 'model', name: 'Model', options: MODELS.map((m) => m[0]), min: 0, max: MODELS.length - 1, def: 0, step: 1, group: 'Oscillator' },
  { id: 'harmonics', name: 'Harmonics', min: 0, max: 1, def: 0.5, cc: 70, group: 'Oscillator' },
  { id: 'timbre', name: 'Timbre', min: 0, max: 1, def: 0.5, cc: 74, group: 'Oscillator' },
  { id: 'morph', name: 'Morph', min: 0, max: 1, def: 0.5, cc: 71, group: 'Oscillator' },
  { id: 'aux', name: 'Aux out', min: 0, max: 1, def: 0, group: 'Oscillator' },
  { id: 'transpose', name: 'Transpose', min: -24, max: 24, def: 0, step: 1, unit: 'st', group: 'Oscillator' },
  { id: 'gate', name: 'Gate', options: ['Ping', 'Hold'], min: 0, max: 1, def: 0, step: 1, group: 'Low-pass gate' },
  { id: 'decay', name: 'Decay', min: 0, max: 1, def: 0.5, cc: 72, group: 'Low-pass gate' },
  { id: 'colour', name: 'Colour', min: 0, max: 1, def: 0.5, group: 'Low-pass gate' },
  { id: 'envPitch', name: 'Env → pitch', min: -1, max: 1, def: 0, group: 'Envelope' },
  { id: 'envTimbre', name: 'Env → timbre', min: -1, max: 1, def: 0, group: 'Envelope' },
  { id: 'envMorph', name: 'Env → morph', min: -1, max: 1, def: 0, group: 'Envelope' },
  { id: 'velAmt', name: 'Velocity', min: 0, max: 1, def: 0.5, group: 'Output' },
  { id: 'spread', name: 'Stereo spread', min: 0, max: 1, def: 0.3, group: 'Output' },
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.7, cc: 7, group: 'Output' },
];
const model = (name) => MODELS.findIndex((m) => m[0] === name);
const PRESETS = {
  pluck:    { model: model('Virtual analog'), harmonics: 0.35, timbre: 0.55, morph: 0.4, decay: 0.45, colour: 0.6, envTimbre: 0.3 },
  pad:      { model: model('Wavetable'), harmonics: 0.3, timbre: 0.45, morph: 0.6, gate: 1, decay: 0.8, colour: 0.2, spread: 0.6 },
  bell:     { model: model('Two-op FM'), harmonics: 0.62, timbre: 0.45, morph: 0.35, decay: 0.7, colour: 0.4, envTimbre: 0.4 },
  chords:   { model: model('Chords'), harmonics: 0.35, timbre: 0.4, morph: 0.45, gate: 1, decay: 0.6, colour: 0.3, spread: 0.5 },
  string:   { model: model('Plucked string'), harmonics: 0.4, timbre: 0.6, morph: 0.65, decay: 0.6, level: 1 },
  marimba:  { model: model('Modal resonator'), harmonics: 0.3, timbre: 0.55, morph: 0.4, decay: 0.5 },
  voice:    { model: model('Speech'), harmonics: 0.55, timbre: 0.5, morph: 0.3, gate: 1, decay: 0.6, colour: 0.3 },
  dx:       { model: model('Six-op FM bank A'), harmonics: 0.15, timbre: 0.5, morph: 0.5, gate: 1, decay: 0.5 },
  bass:     { model: model('Analog + filter'), harmonics: 0.2, timbre: 0.35, morph: 0.25, transpose: -12, decay: 0.45, colour: 0.8, envTimbre: 0.35, level: 1 },
  chip:     { model: model('Chiptune'), harmonics: 0.5, timbre: 0.5, morph: 0.3, gate: 1, decay: 0.4, colour: 0.1, level: 0.4 },
  kick:     { model: model('Bass drum'), harmonics: 0.4, timbre: 0.45, morph: 0.55, decay: 0.5, transpose: -24 },
  swarm:    { model: model('Swarm'), harmonics: 0.4, timbre: 0.5, morph: 0.5, gate: 1, decay: 0.75, colour: 0.3, spread: 0.7 },
};
const PRESET_NAMES = { pluck: 'Analog pluck', pad: 'Wavetable pad', bell: 'FM bell', chords: 'Chord stack', string: 'Plucked string', marimba: 'Modal marimba', voice: 'Speaking voice', dx: 'Six-op keys', bass: 'Filter bass', chip: 'Chiptune', kick: 'Pitched kick', swarm: 'Swarm drone' };

const PROC = `
const MODELS = ${JSON.stringify(MODELS.map((m) => m[1]))};
const MAX_VOICES = ${JSON.stringify(MAX_VOICES)};
const PID = { harmonics: 1, timbre: 2, morph: 3, decay: 4, colour: 5, envPitch: 6, envTimbre: 7, envMorph: 8, aux: 9, gate: 10 };
const R = 48000 / sampleRate, RING = 512;
const soft = (x) => (x > 3 ? 1 : x < -3 ? -1 : (x * (27 + x * x)) / (27 + 9 * x * x));
const mix32 = (a) => { a = Math.imul(a ^ (a >>> 16), 0x7feb352d); a = Math.imul(a ^ (a >>> 15), 0x846ca68b); return (a ^ (a >>> 16)) >>> 0; };
let MOD = null;
class BigMacro extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const opt = o.processorOptions;
    MOD = opt.module || MOD || new WebAssembly.Module(opt.bytes);
    const w = new WebAssembly.Instance(MOD, {}).exports; this.w = w;
    w.__wasm_call_ctors(); w.mo_init(0x21);
    this.NV = w.mo_voices(); this.B = w.mo_block();
    this.oL = new Float32Array(w.memory.buffer, w.mo_out_l(), this.B); this.oR = new Float32Array(w.memory.buffer, w.mo_out_r(), this.B);
    this.ringL = new Float32Array(RING); this.ringR = new Float32Array(RING);
    this.p = { ...opt.params }; this.voices = Array.from({ length: this.NV }, (_, i) => ({ i, note: -1, held: false, age: 0 })); this.age = 0;
    this.q = []; this.blk = -1; this.done = false;
    for (const k of Object.keys(this.p)) this.apply(k, this.p[k]);
    this.port.onmessage = (m) => { const d = m.data; if (d[0] === 9) { this.done = true; return; } this.q.push(d); this.q.sort((a, b) => a[1] - b[1]); };
  }
  apply(id, v) {
    this.p[id] = v;
    if (id === 'model') { const e = MODELS[Math.max(0, Math.min(MODELS.length - 1, Math.round(v)))]; this.w.mo_param(0, e); this.engine = e; }
    else if (PID[id] !== undefined) this.w.mo_param(PID[id], v);
  }
  pan(i) { return [-1, 1, -0.6, 0.6, -0.25, 0.25][i % 6] * (this.p.spread ?? 0.3); }
  noteOn(note, vel, seedAt) {
    const w = this.w, cap = Math.min(this.NV, MAX_VOICES[this.engine] || this.NV), pool = this.voices.slice(0, cap);
    let v = pool.find((x) => x.note === note && x.held) || pool.find((x) => !w.mo_active(x.i)) || pool.filter((x) => !x.held).sort((a, b) => a.age - b.age)[0] || pool.slice().sort((a, b) => a.age - b.age)[0];
    for (const x of this.voices.slice(cap)) if (w.mo_active(x.i)) { w.mo_kill(x.i); x.held = false; }
    const va = this.p.velAmt ?? 0.5, g = ((1 - va) + va * Math.pow(Math.max(0, Math.min(127, vel)) / 127, 1.5)) * 0.62;
    v.note = note; v.held = true; v.age = ++this.age;
    w.mo_note_on(v.i, note + (this.p.transpose || 0), g, this.pan(v.i), mix32((note * 40503) ^ Math.round(seedAt)));
  }
  noteOff(note) { for (const v of this.voices) if (v.note === note && v.held) { v.held = false; this.w.mo_note_off(v.i); } }
  event(d) {
    if (d[0] === 1) this.noteOn(d[2], d[3], d[4]);
    else if (d[0] === 0) this.noteOff(d[2]);
    else if (d[0] === 2) this.apply(d[2], d[3]);
    else if (d[0] === 3) for (const v of this.voices) { v.held = false; this.w.mo_note_off(v.i); }
  }
  // one module block: events due by its end, then 12 samples into the ring at their absolute 48 kHz frame
  block() {
    const B = this.B, s = this.blk * B, end = s + B;
    while (this.q.length && this.q[0][1] * R < end) this.event(this.q.shift());
    this.w.mo_render();
    for (let j = 0; j < B; j++) { const k = (s + j) & (RING - 1); this.ringL[k] = this.oL[j]; this.ringR[k] = this.oR[j]; }
    this.blk++;
  }
  process(_in, outs) {
    if (this.done) return false;
    const L = outs[0][0], Rr = outs[0][1] || outs[0][0], n = L.length, lvl = this.p.level ?? 0.7;
    if (this.blk < 0) this.blk = Math.floor((currentFrame * R) / this.B);
    for (let i = 0; i < n; i++) {
      const x = (currentFrame + i) * R, i0 = Math.floor(x), fr = x - i0;
      while ((this.blk * this.B) <= i0 + 2) this.block();
      let l, r;
      if (fr === 0) { l = this.ringL[i0 & (RING - 1)]; r = this.ringR[i0 & (RING - 1)]; }
      else {   // 4-point Hermite between module samples
        const a = (i0 - 1) & (RING - 1), b = i0 & (RING - 1), c = (i0 + 1) & (RING - 1), d = (i0 + 2) & (RING - 1);
        const hm = (ym, y0, y1, y2) => { const c1 = 0.5 * (y1 - ym), c2 = ym - 2.5 * y0 + 2 * y1 - 0.5 * y2, c3 = 0.5 * (y2 - ym) + 1.5 * (y0 - y1); return ((c3 * fr + c2) * fr + c1) * fr + y0; };
        l = hm(this.ringL[a], this.ringL[b], this.ringL[c], this.ringL[d]); r = hm(this.ringR[a], this.ringR[b], this.ringR[c], this.ringR[d]);
      }
      L[i] = soft(l * lvl); Rr[i] = soft(r * lvl);
    }
    return true;
  }
}
registerProcessor('${NAME}', BigMacro);
`;

// the module, fetched and compiled once per page; every audio context (live, and each offline bounce) shares it
let wasmJob = null;
function loadWasm() {
  if (!wasmJob) wasmJob = (async () => {
    const bytes = await (await fetch(new URL(WASM, globalThis.location?.href || 'http://localhost/'), { cache: 'no-cache' })).arrayBuffer();
    try {
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (sha !== WASM_SHA) console.warn(`Big Macro: ${WASM} isn't the build this file expects (run tools/build_bigmacro.sh)`);
    } catch (_) { /* no crypto.subtle off a secure origin: skip the check */ }
    return { bytes, module: await WebAssembly.compile(bytes) };
  })();
  return wasmJob;
}

export default {
  id: 'bigmacro',
  name: 'Big Macro',
  family: 'Macro oscillator',
  blurb: 'Twenty-four synthesis models behind three knobs, harmonics, timbre and morph, each of six voices pinging its own low-pass gate: analog, waveshaping, FM, formants, additive, wavetables, chords, speech, swarms, noise, strings, modal bells, drums and more. DSP from Plaits by Émilie Gillet / Mutable Instruments (MIT license).',
  lineage: 'DSP from Plaits by Émilie Gillet / Mutable Instruments, MIT license (third_party/plaits)',
  by: 'Émilie Gillet',   // credited on the tile: the sound is her design, run unchanged
  icon: `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <rect x="30" y="3" width="60" height="74" rx="3" fill="#1d2026"/><rect x="30" y="3" width="60" height="6" fill="#2c3038"/>
    <g transform="translate(60 26)">${[0, 60, 120, 180, 240, 300].map((a, i) => `<path d="M0 0 L9 -15.6 L-9 -15.6 Z" transform="rotate(${a})" fill="${['#2f80ff', '#ffcf26', '#e5383b', '#2f80ff', '#ffcf26', '#e5383b'][i]}" opacity="0.85"/>`).join('')}<circle r="3" fill="#1d2026"/></g>
    ${[44, 60, 76].map((x) => `<circle cx="${x}" cy="54" r="5.5" fill="#3b3e44" stroke="#111"/><line x1="${x}" y1="54" x2="${x}" y2="49.5" stroke="#efeee8" stroke-width="1.2"/>`).join('')}
    ${[42, 54, 66, 78].map((x) => `<circle cx="${x}" cy="69" r="2.6" fill="#0d0e10" stroke="#777"/>`).join('')}</svg>`,
  skin: { knob: 'knob', option: 'stepper' },
  params: PARAMS,
  presets: PRESETS,
  presetNames: PRESET_NAMES,
  async init(ctx) {
    const w = await loadWasm();
    ctx.__jjWorklets = ctx.__jjWorklets || new Set();
    if (ctx.__jjWorklets.has(NAME)) return;
    const url = URL.createObjectURL(new Blob([PROC], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    ctx.__jjWorklets.add(NAME);
    ctx.__bigmacro = w;
  },
  create(ctx, out, init = {}) {
    const params = {};
    for (const d of PARAMS) params[d.id] = init[d.id] ?? d.def;
    const w = ctx.__bigmacro;
    const make = (opts) => new AudioWorkletNode(ctx, NAME, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { params, ...opts } });
    let node;
    try { node = make({ module: w.module }); } catch (_) { node = make({ bytes: w.bytes }); }   // a browser that can't hand a compiled module to the audio thread gets the bytes
    node.connect(out);
    const at = (t) => Math.round(t * ctx.sampleRate);
    return {
      // room time (ms) seeds the note's randomness, so it matches in every browser; offline renders use their own clock
      noteOn: (note, vel, t, roomAt) => node.port.postMessage([1, at(t), note, vel, roomAt ?? t * 1000]),
      noteOff: (note, t) => node.port.postMessage([0, at(t), note, 0]),
      set: (id, v, t) => node.port.postMessage([2, at(t), id, v]),
      allOff: (t) => node.port.postMessage([3, at(t)]),
      dispose: () => { node.port.postMessage([9, 0]); node.disconnect(); },
    };
  },
};
