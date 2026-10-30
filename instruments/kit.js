// Kit: synthesized analog-style drum machine on the General MIDI drum map
// (36 kick, 37 rim, 38/40 snare, 39 clap, 41-50 toms, 42/44 closed hat, 46 open hat, 49 crash, 51 ride, 56 cowbell).
// The noise is generated from a fixed seed, so every jammer's kit is identical sample for sample.

const PARAMS = [
  { id: 'tune', name: 'Tune', min: -12, max: 12, def: 0, unit: 'st' },
  { id: 'kickDecay', name: 'Kick decay', min: 0.08, max: 2, def: 0.5, curve: 'exp', unit: 's' },
  { id: 'click', name: 'Kick click', min: 0, max: 1, def: 0.2 },
  { id: 'snappy', name: 'Snappy', min: 0, max: 1, def: 0.55 },
  { id: 'snareTone', name: 'Snare tone', min: 120, max: 320, def: 185, unit: 'Hz' },
  { id: 'hatDecay', name: 'Hat decay', min: 0.02, max: 1.2, def: 0.09, curve: 'exp', unit: 's' },
  { id: 'metal', name: 'Metal ↔ noise', min: 0, max: 1, def: 0.3 },
  { id: 'drive', name: 'Drive', min: 0, max: 1, def: 0.15 },
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.8, cc: 7 },
];

const PRESETS = {
  '808':     { tune: 0, kickDecay: 0.9, click: 0.05, snappy: 0.45, snareTone: 175, hatDecay: 0.07, metal: 0.15, drive: 0.1, level: 0.8 },
  '909':     { tune: 2, kickDecay: 0.35, click: 0.6, snappy: 0.75, snareTone: 200, hatDecay: 0.06, metal: 0.65, drive: 0.35, level: 0.8 },
  '606':     { tune: 4, kickDecay: 0.22, click: 0.3, snappy: 0.85, snareTone: 230, hatDecay: 0.04, metal: 0.1, drive: 0.15, level: 0.8 },
  digital:   { tune: 0, kickDecay: 0.45, click: 0.45, snappy: 0.6, snareTone: 190, hatDecay: 0.08, metal: 0.8, drive: 0.25, level: 0.8 },
  lofi:      { tune: -3, kickDecay: 0.6, click: 0.15, snappy: 0.4, snareTone: 160, hatDecay: 0.12, metal: 0.5, drive: 0.6, level: 0.75 },
};

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function history(init) {
  const h = [{ t: -Infinity, v: init }];
  return {
    at(t) { let v = h[0].v; for (const e of h) { if (e.t <= t) v = e.v; else break; } return v; },
    put(t, v) { let i = h.length; while (i > 0 && h[i - 1].t > t) i--; h.splice(i, 0, { t, v }); if (h.length > 400) h.splice(1, 100); },
  };
}
function tanhCurve() {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * 2) / Math.tanh(2); }
  return c;
}
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800]; // the classic six-square cymbal cluster

export default {
  id: 'kit',
  name: 'Kit',
  family: 'Drum machine',
  drums: true,
  params: PARAMS,
  presets: PRESETS,
  create(ctx, out, init = {}) {
    const H = {};
    for (const d of PARAMS) H[d.id] = history(init[d.id] ?? d.def);
    const v = (id, t) => H[id].at(t);

    const rnd = mulberry32(808909);
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = rnd() * 2 - 1;

    const bus = ctx.createGain(), pre = ctx.createGain(), shaper = ctx.createWaveShaper(), post = ctx.createGain(), level = ctx.createGain();
    shaper.curve = tanhCurve();
    bus.connect(pre).connect(shaper).connect(post).connect(level).connect(out);
    function applyGlobal(id, val, t) {
      if (id === 'drive') { pre.gain.setTargetAtTime(1 + val * 6, t, 0.01); post.gain.setTargetAtTime(1 / (1 + val * 2.5), t, 0.01); }
      if (id === 'level') level.gain.setTargetAtTime(val, t, 0.01);
    }
    for (const id of ['drive', 'level']) applyGlobal(id, v(id, -Infinity), ctx.currentTime);

    const tuneMul = (t) => Math.pow(2, v('tune', t) / 12);
    const env = (g, t, peak, dec, att = 0.001) => { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + att); g.gain.setTargetAtTime(0, t + att, dec / 4); };
    const noiseSrc = (t, dur, offset = 0) => { const s = ctx.createBufferSource(); s.buffer = noise; s.start(t, offset % 1.5, dur); return s; };
    const done = (src, nodes) => { src.onended = () => nodes.forEach((n) => n.disconnect()); };
    let openHat = null;

    function kick(t, k) {
      const m = tuneMul(t), D = v('kickDecay', t), click = v('click', t);
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(160 * m, t); o.frequency.exponentialRampToValueAtTime(48 * m, t + 0.09);
      env(g, t, 0.9 * k, D, 0.002);
      o.connect(g).connect(bus); o.start(t); o.stop(t + D * 2 + 0.05); done(o, [o, g]);
      if (click > 0) {
        const n = noiseSrc(t, 0.02), hp = ctx.createBiquadFilter(), cg = ctx.createGain();
        hp.type = 'highpass'; hp.frequency.value = 1500; env(cg, t, click * 0.5 * k, 0.012);
        n.connect(hp).connect(cg).connect(bus); done(n, [n, hp, cg]);
      }
    }
    function snare(t, k) {
      const m = tuneMul(t), sn = v('snappy', t), tone = v('snareTone', t) * m;
      for (const [f, a] of [[tone, 0.5], [tone * 1.62, 0.25]]) {
        const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'triangle';
        o.frequency.setValueAtTime(f * 1.3, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.03);
        env(g, t, a * k * (1 - sn * 0.5), 0.12); o.connect(g).connect(bus); o.start(t); o.stop(t + 0.5); done(o, [o, g]);
      }
      const n = noiseSrc(t, 0.4, 0.3), hp = ctx.createBiquadFilter(), g = ctx.createGain();
      hp.type = 'highpass'; hp.frequency.value = 1800; env(g, t, sn * 0.55 * k, 0.16);
      n.connect(hp).connect(g).connect(bus); done(n, [n, hp, g]);
    }
    function clap(t, k) {
      const n = noiseSrc(t, 0.5, 0.7), bp = ctx.createBiquadFilter(), g = ctx.createGain();
      bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 1.5;
      g.gain.setValueAtTime(0, t);
      for (const d of [0, 0.011, 0.022]) { g.gain.setValueAtTime(0.6 * k, t + d); g.gain.setTargetAtTime(0.05, t + d + 0.001, 0.004); }
      g.gain.setValueAtTime(0.45 * k, t + 0.033); g.gain.setTargetAtTime(0, t + 0.034, 0.06);
      n.connect(bp).connect(g).connect(bus); done(n, [n, bp, g]);
    }
    function metalVoice(t, k, decay, hpF, peak) {
      const mix = v('metal', t), m = tuneMul(t);
      const sum = ctx.createGain(), bp = ctx.createBiquadFilter(), hp = ctx.createBiquadFilter(), g = ctx.createGain();
      bp.type = 'bandpass'; bp.frequency.value = 10000; bp.Q.value = 0.8; hp.type = 'highpass'; hp.frequency.value = hpF;
      const srcs = [];
      for (const f of METAL) { const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f * m; const og = ctx.createGain(); og.gain.value = (1 - mix) * 0.18; o.connect(og).connect(sum); o.start(t); o.stop(t + decay * 5 + 0.05); srcs.push(o, og); }
      const n = noiseSrc(t, decay * 5 + 0.05, 1.1), ng = ctx.createGain(); ng.gain.value = mix * 0.9; n.connect(ng).connect(sum); srcs.push(n, ng);
      sum.connect(bp).connect(hp).connect(g).connect(bus);
      env(g, t, peak * k, decay);
      done(n, [...srcs, sum, bp, hp, g]);
      return g;
    }
    function tom(t, k, f) {
      const m = tuneMul(t), o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(f * 1.6 * m, t); o.frequency.exponentialRampToValueAtTime(f * m, t + 0.08);
      env(g, t, 0.7 * k, 0.45); o.connect(g).connect(bus); o.start(t); o.stop(t + 1); done(o, [o, g]);
    }
    function rim(t, k) {
      const o = ctx.createOscillator(), bp = ctx.createBiquadFilter(), g = ctx.createGain(); o.type = 'triangle';
      o.frequency.value = 1700 * tuneMul(t); bp.type = 'bandpass'; bp.frequency.value = 1700; env(g, t, 0.6 * k, 0.02);
      o.connect(bp).connect(g).connect(bus); o.start(t); o.stop(t + 0.1); done(o, [o, bp, g]);
    }
    function cowbell(t, k) {
      const m = tuneMul(t), bp = ctx.createBiquadFilter(), g = ctx.createGain(); bp.type = 'bandpass'; bp.frequency.value = 2640; bp.Q.value = 1;
      bp.connect(g).connect(bus); env(g, t, 0.5 * k, 0.25);
      const os = [540, 800].map((f) => { const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f * m; o.connect(bp); o.start(t); o.stop(t + 1); return o; });
      done(os[0], [...os, bp, g]);
    }
    const TOMS = { 41: 82, 43: 98, 45: 110, 47: 131, 48: 147, 50: 165 };

    return {
      noteOn(note, vel, t) {
        const k = Math.pow(vel / 127, 1.2);
        switch (note) {
          case 35: case 36: kick(t, k); break;
          case 37: rim(t, k); break;
          case 38: case 40: snare(t, k); break;
          case 39: clap(t, k); break;
          case 42: case 44:
            if (openHat) { openHat.gain.cancelScheduledValues(t); openHat.gain.setTargetAtTime(0, t, 0.01); openHat = null; }
            metalVoice(t, k, v('hatDecay', t), 7000, 0.5); break;
          case 46: openHat = metalVoice(t, k, v('hatDecay', t) * 5, 7000, 0.45); break;
          case 49: case 57: metalVoice(t, k, 1.4, 4000, 0.4); break;
          case 51: case 59: metalVoice(t, k, 0.9, 5500, 0.25); break;
          case 56: cowbell(t, k); break;
          default: if (TOMS[note]) tom(t, k, TOMS[note]); else if (note < 60) rim(t, k * 0.6); else metalVoice(t, k * 0.6, 0.1, 6000, 0.3);
        }
      },
      noteOff() {},
      set(id, val, t) { if (!H[id]) return; H[id].put(t, val); applyGlobal(id, val, t); },
      allOff() {},
      dispose() { level.disconnect(); },
    };
  },
};
