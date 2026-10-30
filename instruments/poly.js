// Poly: analog-style subtractive polysynth (two oscillators + sub, resonant low-pass, envelopes, chorus, drive).
// Has a mono/glide mode so it can also stand in for monosynths and bass machines.
//
// JamJam instrument contract (see README "Writing an instrument"):
//   export default { id, name, family, params:[{id,name,min,max,def,curve?,unit?,step?,cc?}], presets:{patchType:{...}},
//                    create(ctx, out, initialParams) -> { noteOn(note,vel,t), noteOff(note,t), set(id,v,t), allOff(t), dispose() } }
// Everything is driven by timestamped calls, and nothing is random, so every jammer's copy makes the same sound.

const PARAMS = [
  { id: 'wave', name: 'Saw ↔ Square', min: 0, max: 1, def: 0.2 },
  { id: 'detune', name: 'Detune', min: 0, max: 30, def: 8, unit: 'ct' },
  { id: 'sub', name: 'Sub osc', min: 0, max: 1, def: 0.2 },
  { id: 'cutoff', name: 'Cutoff', min: 60, max: 16000, def: 1800, curve: 'exp', unit: 'Hz', cc: 74 },
  { id: 'reso', name: 'Resonance', min: 0, max: 20, def: 3, cc: 71 },
  { id: 'env', name: 'Filter env', min: 0, max: 1, def: 0.4 },
  { id: 'attack', name: 'Attack', min: 0.001, max: 4, def: 0.005, curve: 'exp', unit: 's', cc: 73 },
  { id: 'decay', name: 'Decay', min: 0.01, max: 4, def: 0.4, curve: 'exp', unit: 's' },
  { id: 'sustain', name: 'Sustain', min: 0, max: 1, def: 0.6 },
  { id: 'release', name: 'Release', min: 0.01, max: 6, def: 0.35, curve: 'exp', unit: 's', cc: 72 },
  { id: 'mono', name: 'Mono', min: 0, max: 1, def: 0, step: 1 },
  { id: 'glide', name: 'Glide', min: 0, max: 0.5, def: 0, unit: 's', cc: 5 },
  { id: 'chorus', name: 'Chorus', min: 0, max: 1, def: 0.3, cc: 93 },
  { id: 'drive', name: 'Drive', min: 0, max: 1, def: 0.1 },
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.7, cc: 7 },
];

const PRESETS = {
  pad:     { wave: 0.15, detune: 12, sub: 0.15, cutoff: 1400, reso: 2, env: 0.25, attack: 0.9, decay: 1.5, sustain: 0.8, release: 2.2, mono: 0, glide: 0, chorus: 0.6, drive: 0.05, level: 0.6 },
  keys:    { wave: 0.3, detune: 6, sub: 0.2, cutoff: 2200, reso: 3, env: 0.45, attack: 0.004, decay: 0.6, sustain: 0.5, release: 0.4, mono: 0, glide: 0, chorus: 0.35, drive: 0.1, level: 0.7 },
  lead:    { wave: 0.0, detune: 9, sub: 0.1, cutoff: 2600, reso: 6, env: 0.5, attack: 0.005, decay: 0.3, sustain: 0.7, release: 0.25, mono: 1, glide: 0.06, chorus: 0.1, drive: 0.3, level: 0.6 },
  bass:    { wave: 0.5, detune: 4, sub: 0.6, cutoff: 500, reso: 5, env: 0.6, attack: 0.002, decay: 0.25, sustain: 0.4, release: 0.12, mono: 1, glide: 0.02, chorus: 0, drive: 0.35, level: 0.8 },
  pluck:   { wave: 0.2, detune: 5, sub: 0.1, cutoff: 700, reso: 7, env: 0.8, attack: 0.001, decay: 0.22, sustain: 0, release: 0.25, mono: 0, glide: 0, chorus: 0.3, drive: 0.15, level: 0.7 },
  brass:   { wave: 0.0, detune: 10, sub: 0.1, cutoff: 900, reso: 1.5, env: 0.55, attack: 0.06, decay: 0.5, sustain: 0.75, release: 0.3, mono: 0, glide: 0, chorus: 0.25, drive: 0.2, level: 0.65 },
  strings: { wave: 0.05, detune: 16, sub: 0, cutoff: 3200, reso: 1, env: 0.1, attack: 0.5, decay: 1, sustain: 0.9, release: 1.2, mono: 0, glide: 0, chorus: 0.75, drive: 0, level: 0.6 },
  acid:    { wave: 0.0, detune: 0, sub: 0, cutoff: 380, reso: 15, env: 0.85, attack: 0.001, decay: 0.2, sustain: 0.05, release: 0.08, mono: 1, glide: 0.07, chorus: 0, drive: 0.55, level: 0.65 },
};

const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
const MAX_VOICES = 16;

function tanhCurve() {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * 1.5) / Math.tanh(1.5); }
  return c;
}
// A parameter's values over time, so a note that starts at time t uses the setting in force at t,
// whatever order the messages arrived in.
function history(init) {
  const h = [{ t: -Infinity, v: init }];
  return {
    at(t) { let v = h[0].v; for (const e of h) { if (e.t <= t) v = e.v; else break; } return v; },
    put(t, v) { let i = h.length; while (i > 0 && h[i - 1].t > t) i--; h.splice(i, 0, { t, v }); if (h.length > 400) h.splice(1, 100); },
  };
}
const hold = (p, t) => { if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t); else p.cancelScheduledValues(t); };

export default {
  id: 'poly',
  name: 'Poly',
  family: 'Analog subtractive',
  blurb: "A light two-oscillator subtractive poly with a mono/glide mode and chorus. Quick to dial, easy on the CPU.",
  params: PARAMS,
  presets: PRESETS,
  create(ctx, out, init = {}) {
    const H = {};
    for (const d of PARAMS) H[d.id] = history(init[d.id] ?? d.def);
    H.bend = history(0);
    const v = (id, t) => H[id].at(t);

    // shared chain: voices -> drive -> chorus -> level -> out
    const bus = ctx.createGain();
    const pre = ctx.createGain(), shaper = ctx.createWaveShaper(), post = ctx.createGain();
    shaper.curve = tanhCurve(); shaper.oversample = '2x';
    const dry = ctx.createGain(), wet = ctx.createGain(), level = ctx.createGain();
    const merger = ctx.createChannelMerger(2);
    const dl = ctx.createDelay(0.05), dr = ctx.createDelay(0.05);
    dl.delayTime.value = 0.012; dr.delayTime.value = 0.017;
    const lfos = [];
    for (const [d, rate] of [[dl, 0.43], [dr, 0.57]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = rate; g.gain.value = 0.0025; o.connect(g).connect(d.delayTime); o.start(); lfos.push(o);
    }
    bus.connect(pre).connect(shaper).connect(post);
    post.connect(dry).connect(level);
    post.connect(dl).connect(merger, 0, 0);
    post.connect(dr).connect(merger, 0, 1);
    merger.connect(wet).connect(level);
    level.connect(out);

    function applyGlobal(id, val, t) {
      if (id === 'drive') { pre.gain.setTargetAtTime(1 + val * 6, t, 0.01); post.gain.setTargetAtTime(1 / (1 + val * 2.5), t, 0.01); }
      if (id === 'chorus') { wet.gain.setTargetAtTime(val * 0.7, t, 0.01); dry.gain.setTargetAtTime(1 - val * 0.35, t, 0.01); }
      if (id === 'level') level.gain.setTargetAtTime(val, t, 0.01);
    }
    const t0 = ctx.currentTime;
    for (const id of ['drive', 'chorus', 'level']) applyGlobal(id, v(id, -Infinity), t0);

    const voices = [];
    let mono = null, monoStack = [], lastFreq = 0;

    function makeVoice(note, vel, t, fromFreq) {
      const f = mtof(note), k = vel / 127;
      const wave = v('wave', t), det = v('detune', t), sub = v('sub', t), bend = v('bend', t) * 100;
      const A = Math.max(0.001, v('attack', t)), D = v('decay', t), S = v('sustain', t);
      const cut = v('cutoff', t), env = v('env', t);
      const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), os = ctx.createOscillator();
      o1.type = 'sawtooth'; o2.type = 'square'; os.type = 'triangle';
      const g1 = ctx.createGain(), g2 = ctx.createGain(), gs = ctx.createGain();
      g1.gain.value = (1 - wave) * 0.5; g2.gain.value = wave * 0.4; gs.gain.value = sub * 0.6;
      const filt = ctx.createBiquadFilter(), amp = ctx.createGain();
      filt.type = 'lowpass'; filt.Q.setValueAtTime(v('reso', t), t);
      const oscs = [[o1, 1, -det / 2], [o2, 1, det / 2], [os, 0.5, 0]];
      for (const [o, mul, dc] of oscs) {
        if (fromFreq) { o.frequency.setValueAtTime(fromFreq * mul, t); o.frequency.setTargetAtTime(f * mul, t, Math.max(0.003, v('glide', t)) / 3); }
        else o.frequency.setValueAtTime(f * mul, t);
        o.detune.setValueAtTime(dc + bend, t);
      }
      o1.connect(g1).connect(filt); o2.connect(g2).connect(filt); os.connect(gs).connect(filt);
      filt.connect(amp).connect(bus);
      const peakF = Math.min(18000, cut * (1 + env * k * 10));
      const susF = cut + (peakF - cut) * S;
      filt.frequency.setValueAtTime(cut, t);
      filt.frequency.setTargetAtTime(peakF, t, A / 3);
      filt.frequency.setTargetAtTime(susF, t + A, Math.max(0.005, D / 3));
      const pk = 0.22 * (0.25 + 0.75 * k);
      amp.gain.setValueAtTime(0, t);
      amp.gain.setTargetAtTime(pk, t, A / 3);
      amp.gain.setTargetAtTime(pk * S, t + A, Math.max(0.005, D / 3));
      for (const [o] of oscs) o.start(t);
      const voice = { note, k, t0: t, tOff: Infinity, oscs, gains: [g1, g2, gs], filt, amp, f };
      o1.onended = () => { const i = voices.indexOf(voice); if (i >= 0) voices.splice(i, 1); for (const n of [o1, o2, os, g1, g2, gs, filt, amp]) n.disconnect(); };
      voices.push(voice);
      lastFreq = f;
      return voice;
    }
    function release(voice, t) {
      if (voice.tOff !== Infinity) return;
      t = Math.max(t, voice.t0 + 0.002);
      voice.tOff = t;
      const R = v('release', t), cut = v('cutoff', t);
      hold(voice.amp.gain, t); voice.amp.gain.setTargetAtTime(0, t, R / 4);
      hold(voice.filt.frequency, t); voice.filt.frequency.setTargetAtTime(cut, t, R / 4);
      for (const [o] of voice.oscs) o.stop(t + R * 2.5 + 0.05);
    }
    function glideTo(voice, note, t) {
      const f = mtof(note), g = Math.max(0.003, v('glide', t)) / 3;
      voice.oscs[0][0].frequency.setTargetAtTime(f, t, g);
      voice.oscs[1][0].frequency.setTargetAtTime(f, t, g);
      voice.oscs[2][0].frequency.setTargetAtTime(f / 2, t, g);
      voice.note = note; lastFreq = f;
    }

    return {
      noteOn(note, vel, t) {
        if (v('mono', t) >= 0.5) {
          monoStack = monoStack.filter((n) => n !== note); monoStack.push(note);
          if (mono && mono.tOff === Infinity) { glideTo(mono, note, t); return; }
          mono = makeVoice(note, vel, t, v('glide', t) > 0 && lastFreq ? lastFreq : 0);
          return;
        }
        const live = voices.filter((x) => x.tOff === Infinity);
        if (live.length >= MAX_VOICES) release(live[0], t);
        makeVoice(note, vel, t);
      },
      noteOff(note, t) {
        if (mono && monoStack.includes(note)) {
          monoStack = monoStack.filter((n) => n !== note);
          if (mono.note === note) {
            if (monoStack.length) glideTo(mono, monoStack[monoStack.length - 1], t);
            else { release(mono, t); mono = null; }
          }
          return;
        }
        const voice = voices.find((x) => x.note === note && x.tOff === Infinity && x !== mono);
        if (voice) release(voice, t);
      },
      set(id, val, t) {
        if (!H[id]) return;
        H[id].put(t, val);
        applyGlobal(id, val, t);
        for (const x of voices) {
          if (x.tOff !== Infinity || x.t0 > t) continue;
          if (id === 'reso') x.filt.Q.setTargetAtTime(val, t, 0.02);
          if (id === 'cutoff') x.filt.frequency.setTargetAtTime(val * (1 + v('env', t) * x.k * 10 * v('sustain', t)), t, 0.03);
          if (id === 'wave') { x.gains[0].gain.setTargetAtTime((1 - val) * 0.5, t, 0.02); x.gains[1].gain.setTargetAtTime(val * 0.4, t, 0.02); }
          if (id === 'sub') x.gains[2].gain.setTargetAtTime(val * 0.6, t, 0.02);
          if (id === 'bend' || id === 'detune') {
            const det = v('detune', t), b = v('bend', t) * 100;
            x.oscs.forEach(([o, , dc], i) => o.detune.setTargetAtTime((i === 0 ? -det / 2 : i === 1 ? det / 2 : 0) + b, t, 0.005));
          }
        }
      },
      allOff(t) { for (const x of [...voices]) release(x, t); mono = null; monoStack = []; },
      dispose() { for (const o of lfos) { try { o.stop(); } catch (_) {} } level.disconnect(); },
    };
  },
};
