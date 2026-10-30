// Pads: an MPC-style sampler. Sixteen pads on notes 36 to 51, each playing a sample from its start to its end
// point at its own tune and gain, one shot, with choke groups (a pad in a group cuts the others in it).
//
// The kit travels with the instrument's settings (params.kit: one entry per pad), but the audio doesn't: a pad
// names its sample by a content address (pad.id) that MEGAjam shares between browsers once and keeps
// (src/blobs.js), reachable here through globalThis.MEGAJAM_SAMPLES; the starter kit's pads name files on this
// site instead (pad.src). Until a pad's sample has arrived, the pad plays a stand-in made from the little
// description analysed when the sample was loaded (pad.recipe: what kind of hit, its pitch, decay and brightness),
// so a bandmate hears something close at once.
//
// Deterministic: playback is plain sample playback from the event's time; the stand-in's noise is a fixed buffer.

const N = 16, BASE = 36;
const studio = (file, name, recipe, o = {}) => ({ src: `instruments/studio/${file}.mp3`, name, start: 0, end: 1, tune: 0, gain: 0, choke: 0, recipe, ...o });
const CHOPS = [
  studio('kick_3_1', 'Kick', { kind: 'kick', f: 55, decay: 0.35, bright: 0.2 }), studio('snare_4', 'Snare', { kind: 'snare', f: 190, decay: 0.3, bright: 0.6 }),
  studio('xstick_2', 'Stick', { kind: 'click', f: 900, decay: 0.08, bright: 0.7 }), studio('rimshot_2', 'Rim', { kind: 'snare', f: 300, decay: 0.25, bright: 0.8 }),
  studio('hhclosed_3_1', 'Hat', { kind: 'hat', decay: 0.08, bright: 0.9 }, { choke: 1 }), studio('hhpedal_2', 'Foot', { kind: 'hat', decay: 0.06, bright: 0.8 }, { choke: 1 }),
  studio('hhopen_2', 'Open', { kind: 'hat', decay: 0.6, bright: 0.85 }, { choke: 1 }), studio('ride_2_1', 'Ride', { kind: 'hat', decay: 1.2, bright: 0.7 }),
  studio('tomlo_2', 'Lo tom', { kind: 'tom', f: 90, decay: 0.5, bright: 0.3 }), studio('tomhi_2', 'Hi tom', { kind: 'tom', f: 150, decay: 0.4, bright: 0.35 }),
  studio('crash_2', 'Crash', { kind: 'hat', decay: 2, bright: 0.75 }), studio('bell_2', 'Bell', { kind: 'tone', f: 600, decay: 1, bright: 0.6 }),
  studio('kick_1_1', 'Soft kick', { kind: 'kick', f: 55, decay: 0.3, bright: 0.1 }, { gain: 3 }), studio('snare_1', 'Ghost', { kind: 'snare', f: 190, decay: 0.2, bright: 0.4 }, { gain: 6 }),
  studio('snare_6', 'Crack', { kind: 'snare', f: 200, decay: 0.3, bright: 0.8 }, { tune: 2 }), studio('kick_4_1', 'Boom', { kind: 'kick', f: 50, decay: 0.6, bright: 0.25 }, { tune: -5 }),
];
const EMPTY = Array.from({ length: N }, () => null);
const PARAMS = [
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.85, cc: 7, group: 'Pads' },
  { id: 'tone', name: 'Tone', min: 1000, max: 20000, def: 20000, curve: 'exp', unit: 'Hz', cc: 74, group: 'Pads' },
];
const PRESETS = { chops: { kit: CHOPS }, empty: { kit: EMPTY } };

const noiseBuf = new WeakMap();
const srcCache = new Map();   // file -> Promise<ArrayBuffer>
const decoded = new WeakMap(); // ctx -> Map(key -> AudioBuffer | Promise)
function bufMap(ctx) { return decoded.get(ctx) || decoded.set(ctx, new Map()).get(ctx); }
function fromPcm(ctx, c) {
  const b = ctx.createBuffer(1, Math.max(1, c.pcm16.length), c.sr), ch = b.getChannelData(0);
  for (let i = 0; i < c.pcm16.length; i++) ch[i] = c.pcm16[i] / 32768;
  return b;
}
// the pad's sample as an AudioBuffer in this context, if it's here yet (starts loading it if not)
function bufferFor(ctx, pad) {
  const m = bufMap(ctx);
  if (pad.id) {
    const hit = m.get('id:' + pad.id); if (hit) return hit;
    const c = globalThis.MEGAJAM_SAMPLES?.pcm(pad.id); if (!c) return null;
    const b = fromPcm(ctx, c); m.set('id:' + pad.id, b); return b;
  }
  if (pad.src) {
    const k = 'src:' + pad.src, hit = m.get(k);
    if (hit instanceof AudioBuffer) return hit;
    if (!hit) {
      if (!srcCache.has(pad.src)) srcCache.set(pad.src, fetch(new URL(pad.src, globalThis.location?.href || 'http://localhost/')).then((r) => r.arrayBuffer()));
      m.set(k, srcCache.get(pad.src).then((ab) => ctx.decodeAudioData(ab.slice(0))).then((b) => { m.set(k, b); return b; }).catch(() => { m.delete(k); }));
    }
    return null;
  }
  return null;
}
function noise(ctx) {
  if (noiseBuf.has(ctx)) return noiseBuf.get(ctx);
  const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = b.getChannelData(0);
  let s = 12345; for (let i = 0; i < d.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = s / 0x3fffffff - 1; }
  noiseBuf.set(ctx, b); return b;
}
// the stand-in: a few nodes shaped like the recipe
function standIn(ctx, out, r, t, g) {
  const env = ctx.createGain(), dec = Math.max(0.03, r.decay || 0.2);
  env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(g, t + 0.002); env.gain.setTargetAtTime(0, t + 0.004, dec / 3);
  env.connect(out);
  const stop = t + dec * 3 + 0.05;
  if (r.kind === 'kick' || r.kind === 'tom' || r.kind === 'tone') {
    const o = ctx.createOscillator(); o.type = r.kind === 'tone' ? 'triangle' : 'sine';
    const f = r.f || 60; o.frequency.setValueAtTime(r.kind === 'tone' ? f : f * 3, t); if (r.kind !== 'tone') o.frequency.exponentialRampToValueAtTime(f, t + 0.06);
    o.connect(env); o.start(t); o.stop(stop);
  }
  if (r.kind !== 'kick' && r.kind !== 'tone') {
    const n = ctx.createBufferSource(); n.buffer = noise(ctx);
    const f = ctx.createBiquadFilter(); f.type = r.kind === 'hat' ? 'highpass' : 'bandpass'; f.frequency.value = r.kind === 'hat' ? 6000 + 3000 * (r.bright || 0.5) : 800 + 3000 * (r.bright || 0.5);
    const ng = ctx.createGain(); ng.gain.value = r.kind === 'tom' ? 0.15 : 0.8;
    n.connect(f).connect(ng).connect(env); n.start(t, (t * 7.3) % 0.5); n.stop(stop);
  }
}

export default {
  id: 'pads',
  name: 'Pads',
  family: 'Sample pads',
  blurb: "Sixteen sample pads, MPC style. Drop a sound on a pad (or sample your live audio), trim it, tune it, choke the hats. Your samples reach the band once and stay; until they arrive, a pad plays a quick sketch of its sound.",
  drums: true,
  seq: { tracks: Array.from({ length: 16 }, (_, i) => ({ id: 'p' + (i + 1), label: String(i + 1), note: BASE + i })) },
  params: PARAMS,
  presets: PRESETS,
  presetNames: { chops: 'Studio chops', empty: 'Empty kit' },
  create(ctx, out, init = {}) {
    const P = { level: init.level ?? 0.85, tone: init.tone ?? 20000 }, kit = Array.isArray(init.kit) ? init.kit : CHOPS;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = P.tone; lp.Q.value = 0.5;
    const master = ctx.createGain(); master.gain.value = P.level; lp.connect(master); master.connect(out);
    // start loading the starter kit's files now, so the first hits aren't stand-ins
    for (const pad of kit) if (pad) bufferFor(ctx, pad);
    const live = new Set(), groups = new Map();
    const stop = (v, t) => { try { v.g.gain.setTargetAtTime(0, t, 0.006); v.src?.stop(t + 0.05); } catch (_) {} };
    return {
      noteOn(note, vel, t) {
        const i = note - BASE, pad = i >= 0 && i < N ? kit[i] : null; if (!pad) return;
        const g = Math.pow(Math.max(1, vel) / 127, 1.2) * Math.pow(10, (pad.gain || 0) / 20);
        if (pad.choke) { for (const v of groups.get(pad.choke) || []) stop(v, t); groups.set(pad.choke, new Set()); }
        const buf = bufferFor(ctx, pad);
        if (!buf) { if (pad.recipe) standIn(ctx, lp, pad.recipe, t, g * 0.8); return; }
        const src = ctx.createBufferSource(), gn = ctx.createGain(); src.buffer = buf; src.playbackRate.value = Math.pow(2, (pad.tune || 0) / 12);
        const a = Math.max(0, Math.min(1, pad.start || 0)) * buf.duration, z = Math.max(a + 0.005, Math.min(1, pad.end ?? 1) * buf.duration);
        gn.gain.value = g; src.connect(gn).connect(lp);
        src.start(t, a, z - a);
        // a short fade at a trimmed end, so it doesn't click
        if ((pad.end ?? 1) < 1) { const te = t + (z - a) / src.playbackRate.value; gn.gain.setValueAtTime(g, Math.max(t, te - 0.006)); gn.gain.linearRampToValueAtTime(0, te); }
        const v = { src, g: gn }; live.add(v); if (pad.choke) groups.get(pad.choke).add(v);
        src.onended = () => { live.delete(v); for (const s of groups.values()) s.delete(v); gn.disconnect(); };
      },
      noteOff() {},
      set(id, v, t) { P[id] = v; if (id === 'level') master.gain.setTargetAtTime(v, t, 0.02); else if (id === 'tone') lp.frequency.setTargetAtTime(v, t, 0.02); },
      allOff(t) { for (const v of live) stop(v, t ?? ctx.currentTime); },
      dispose() { for (const v of live) stop(v, ctx.currentTime); master.disconnect(); },
    };
  },
  // offline renders (bounces): wait for the starter kit's files
  async init(ctx) {
    if (typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext) {
      await Promise.all(CHOPS.map((pad) => { bufferFor(ctx, pad); return bufMap(ctx).get('src:' + pad.src); }));
    }
  },
};
