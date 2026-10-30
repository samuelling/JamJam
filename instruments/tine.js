// Tine: two-operator FM keys (electric piano, DX-style bells, FM bass and plucks), with tremolo and drive.
// Same contract as poly.js. Deterministic: no randomness anywhere.

const PARAMS = [
  { id: 'ratio', name: 'Mod ratio', min: 0.5, max: 8, def: 1, step: 0.5 },
  { id: 'bright', name: 'Brightness', min: 0, max: 1, def: 0.45, cc: 74 },
  { id: 'bell', name: 'Bell / tine', min: 0, max: 1, def: 0.35, cc: 71 },
  { id: 'decay', name: 'Decay', min: 0.2, max: 10, def: 2.5, curve: 'exp', unit: 's' },
  { id: 'release', name: 'Release', min: 0.02, max: 3, def: 0.25, curve: 'exp', unit: 's', cc: 72 },
  { id: 'tone', name: 'Tone', min: 400, max: 16000, def: 6000, curve: 'exp', unit: 'Hz' },
  { id: 'trem', name: 'Tremolo', min: 0, max: 1, def: 0.2, cc: 1 },
  { id: 'drive', name: 'Drive', min: 0, max: 1, def: 0.1 },
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.75, cc: 7 },
];

const PRESETS = {
  keys:  { ratio: 1, bright: 0.45, bell: 0.35, decay: 2.5, release: 0.25, tone: 6000, trem: 0.25, drive: 0.12, level: 0.75 },
  bell:  { ratio: 3.5, bright: 0.6, bell: 0.7, decay: 5, release: 1.2, tone: 12000, trem: 0, drive: 0, level: 0.6 },
  bass:  { ratio: 0.5, bright: 0.55, bell: 0.1, decay: 1.2, release: 0.12, tone: 2500, trem: 0, drive: 0.3, level: 0.85 },
  pluck: { ratio: 2, bright: 0.7, bell: 0.4, decay: 0.6, release: 0.15, tone: 9000, trem: 0, drive: 0.1, level: 0.7 },
  pad:   { ratio: 1, bright: 0.25, bell: 0.05, decay: 8, release: 1.8, tone: 4000, trem: 0.45, drive: 0, level: 0.6 },
  wurly: { ratio: 1, bright: 0.65, bell: 0.15, decay: 1.8, release: 0.15, tone: 4500, trem: 0.35, drive: 0.45, level: 0.7 },
};

const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
function history(init) {
  const h = [{ t: -Infinity, v: init }];
  return {
    at(t) { let v = h[0].v; for (const e of h) { if (e.t <= t) v = e.v; else break; } return v; },
    put(t, v) { let i = h.length; while (i > 0 && h[i - 1].t > t) i--; h.splice(i, 0, { t, v }); if (h.length > 400) h.splice(1, 100); },
  };
}
const hold = (p, t) => { if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t); else p.cancelScheduledValues(t); };
function tanhCurve() {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * 1.8) / Math.tanh(1.8); }
  return c;
}

export default {
  id: 'tine',
  name: 'Tine',
  family: 'FM keys',
  blurb: "Two-operator FM keys: electric pianos, bells, FM bass and plucks, with tremolo and drive.",
  params: PARAMS,
  presets: PRESETS,
  create(ctx, out, init = {}) {
    const H = {};
    for (const d of PARAMS) H[d.id] = history(init[d.id] ?? d.def);
    H.bend = history(0);
    const v = (id, t) => H[id].at(t);

    const bus = ctx.createGain();
    const pre = ctx.createGain(), shaper = ctx.createWaveShaper(), post = ctx.createGain();
    shaper.curve = tanhCurve();
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.Q.value = 0.5;
    const pan = ctx.createStereoPanner(), level = ctx.createGain();
    const lfo = ctx.createOscillator(), lfoAmt = ctx.createGain();
    lfo.frequency.value = 4.8; lfo.connect(lfoAmt).connect(pan.pan); lfo.start();
    bus.connect(pre).connect(shaper).connect(post).connect(tone).connect(pan).connect(level).connect(out);

    function applyGlobal(id, val, t) {
      if (id === 'drive') { pre.gain.setTargetAtTime(1 + val * 5, t, 0.01); post.gain.setTargetAtTime(1 / (1 + val * 2), t, 0.01); }
      if (id === 'tone') tone.frequency.setTargetAtTime(val, t, 0.02);
      if (id === 'trem') lfoAmt.gain.setTargetAtTime(val * 0.7, t, 0.02);
      if (id === 'level') level.gain.setTargetAtTime(val, t, 0.01);
    }
    for (const id of ['drive', 'tone', 'trem', 'level']) applyGlobal(id, v(id, -Infinity), ctx.currentTime);

    const voices = [];
    function makeVoice(note, vel, t) {
      const f = mtof(note), k = vel / 127;
      const ratio = v('ratio', t), bright = v('bright', t), bell = v('bell', t), D = v('decay', t), bend = v('bend', t) * 100;
      const car = ctx.createOscillator(), mod = ctx.createOscillator(), tineOsc = ctx.createOscillator();
      const mg = ctx.createGain(), tg = ctx.createGain(), amp = ctx.createGain();
      car.frequency.setValueAtTime(f, t); mod.frequency.setValueAtTime(f * ratio, t); tineOsc.frequency.setValueAtTime(f * 14, t);
      for (const o of [car, mod, tineOsc]) o.detune.setValueAtTime(bend, t);
      const idx = (0.3 + bright * 5) * (0.35 + 0.65 * k);
      mg.gain.setValueAtTime(idx * f * ratio, t);
      mg.gain.setTargetAtTime(idx * f * ratio * 0.2, t, D / 5);
      tg.gain.setValueAtTime(bell * k * f * 2.5, t);
      tg.gain.setTargetAtTime(0, t, 0.025);
      mod.connect(mg).connect(car.frequency);
      tineOsc.connect(tg).connect(car.frequency);
      car.connect(amp).connect(bus);
      const pk = 0.24 * (0.2 + 0.8 * k);
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(pk, t + 0.003);
      amp.gain.setTargetAtTime(0, t + 0.003, D / 3);
      for (const o of [car, mod, tineOsc]) { o.start(t); o.stop(t + D * 3 + 0.1); }
      const voice = { note, t0: t, tOff: Infinity, oscs: [car, mod, tineOsc], amp };
      car.onended = () => { const i = voices.indexOf(voice); if (i >= 0) voices.splice(i, 1); for (const n of [car, mod, tineOsc, mg, tg, amp]) n.disconnect(); };
      voices.push(voice);
    }
    function release(voice, t) {
      if (voice.tOff !== Infinity) return;
      t = Math.max(t, voice.t0 + 0.004);
      voice.tOff = t;
      const R = v('release', t);
      hold(voice.amp.gain, t); voice.amp.gain.setTargetAtTime(0, t, R / 4);
      for (const o of voice.oscs) { try { o.stop(t + R * 2.5 + 0.05); } catch (_) {} }
    }
    return {
      noteOn(note, vel, t) {
        const live = voices.filter((x) => x.tOff === Infinity);
        if (live.length >= 20) release(live[0], t);
        makeVoice(note, vel, t);
      },
      noteOff(note, t) { const x = voices.find((y) => y.note === note && y.tOff === Infinity); if (x) release(x, t); },
      set(id, val, t) {
        if (!H[id]) return;
        H[id].put(t, val);
        applyGlobal(id, val, t);
        if (id === 'bend') for (const x of voices) if (x.tOff === Infinity) for (const o of x.oscs) o.detune.setTargetAtTime(val * 100, t, 0.005);
      },
      allOff(t) { for (const x of [...voices]) release(x, t); },
      dispose() { try { lfo.stop(); } catch (_) {} level.disconnect(); },
    };
  },
};
