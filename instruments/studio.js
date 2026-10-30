// Studio Kit: a recorded acoustic drum kit (Virtuosity Drums by Versilian Studios, CC0), a curated handful of
// velocity layers per drum from the overhead pair with the kick and snare close mics, built by
// tools/build_studio_kit.py into instruments/studio/. Plays the General MIDI drum map.
//
// Deterministic: the velocity picks the layer, and the round robin is picked from the note's room stamp, which is
// the same in every browser. The samples load in the background the first time (about 1.2 MB); until they have,
// hits are silent here only. Offline renders (bounces, Match) wait for them.

const PARAMS = [
  { id: 'tone', name: 'Tone', min: 1500, max: 20000, def: 16000, curve: 'exp', unit: 'Hz', cc: 74, group: 'Kit' },
  { id: 'tune', name: 'Tune', min: -6, max: 6, def: 0, unit: 'st', group: 'Kit' },
  { id: 'cymbals', name: 'Cymbals', min: 0, max: 1.5, def: 1, group: 'Kit' },
  { id: 'level', name: 'Level', min: 0, max: 1, def: 0.8, cc: 7, group: 'Kit' },
];
const PRESETS = { sticks: {}, dark: { tone: 6000, cymbals: 0.8 }, tight: { tune: 2, tone: 12000 }, fat: { tune: -3, tone: 9000 } };
const CYMBALS = new Set(['ride', 'bell', 'crash', 'hhopen']);
// the overheads caught the cymbals and hats quieter than the drums: a mix balance, as an engineer would set it
const BAL = { ride: 2.6, bell: 2, crash: 1.7, hhclosed: 1.6, hhpedal: 1.8, hhopen: 1.4, xstick: 1.3 };

let kitP = null;   // { map, raw: Map(file -> ArrayBuffer) }, fetched once per page
function base() { return new URL('instruments/studio/', globalThis.location?.href || 'http://localhost/'); }
function fetchKit() {
  if (kitP) return kitP;
  kitP = (async () => {
    const b = base(), map = await (await fetch(new URL('kit.json', b))).json(), raw = new Map();
    const files = Object.values(map.voices).flatMap((v) => v.layers.flatMap((l) => l.files));
    await Promise.all(files.map(async (f) => { raw.set(f, await (await fetch(new URL(f, b))).arrayBuffer()); }));
    return { map, raw };
  })();
  kitP.catch(() => { kitP = null; });
  return kitP;
}
const decoded = new WeakMap(), ready = new WeakMap();   // ctx -> Promise<{ map, bufs: Map(file -> AudioBuffer), byNote: Map(note -> voice) }>
function decodeFor(ctx) {
  if (decoded.has(ctx)) return decoded.get(ctx);
  const p = (async () => {
    const { map, raw } = await fetchKit(), bufs = new Map(), byNote = new Map();
    await Promise.all([...raw].map(async ([f, ab]) => { bufs.set(f, await ctx.decodeAudioData(ab.slice(0))); }));
    for (const [name, v] of Object.entries(map.voices)) for (const n of v.notes) if (!byNote.has(n)) byNote.set(n, { name, ...v });
    const k = { map, bufs, byNote }; ready.set(ctx, k); return k;
  })();
  decoded.set(ctx, p);
  return p;
}

export default {
  id: 'studio',
  name: 'Studio Kit',
  family: 'Recorded acoustic drums',
  blurb: 'A real jazz-club drum kit, recorded: kick, snare, cross-stick, two toms, hi-hat, ride, bell and crash, several layers each. Plays the General MIDI drum map.',
  drums: true,
  seq: { tracks: [
    { id: 'kick', label: 'BD', note: 36 }, { id: 'snare', label: 'SD', note: 38 }, { id: 'xstick', label: 'XS', note: 37 },
    { id: 'chh', label: 'CH', note: 42 }, { id: 'ped', label: 'PH', note: 44 }, { id: 'ohh', label: 'OH', note: 46 },
    { id: 'tom', label: 'TT', note: 48 }, { id: 'ftom', label: 'FT', note: 45 }, { id: 'ride', label: 'RD', note: 51 }, { id: 'crash', label: 'CY', note: 49 },
  ] },
  params: PARAMS,
  presets: PRESETS,
  async init(ctx) {
    const p = decodeFor(ctx);
    // a live context gets its samples in the background; an offline render waits for them
    if (typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext) await p.catch(() => {});
    else p.catch(() => {});
  },
  create(ctx, out, init = {}) {
    const P = {}; for (const d of PARAMS) P[d.id] = init[d.id] ?? d.def;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5; lp.frequency.value = P.tone;
    const master = ctx.createGain(); master.gain.value = P.level; lp.connect(master); master.connect(out);
    let kit = ready.get(ctx) || null; if (!kit) decodeFor(ctx).then((k) => { kit = k; }).catch(() => {});
    const live = new Set(), hats = new Set();
    const stop = (v, t) => { try { v.g.gain.setTargetAtTime(0, t, 0.012); v.src.stop(t + 0.08); } catch (_) {} };
    return {
      noteOn(note, vel, t, at = 0) {
        if (!kit) return;
        const voice = kit.byNote.get(note); if (!voice) return;
        const layer = voice.layers.find((l) => vel <= l.top) || voice.layers[voice.layers.length - 1];
        const file = layer.files[Math.abs(Math.floor(at)) % layer.files.length], buf = kit.bufs.get(file); if (!buf) return;
        if (voice.choke === 'hh' && voice.name !== 'hhopen') for (const v of hats) { stop(v, t); hats.delete(v); }
        const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = Math.pow(2, P.tune / 12);
        const g = ctx.createGain(); g.gain.value = Math.pow(Math.max(1, vel) / layer.top, 0.7) * (CYMBALS.has(voice.name) ? P.cymbals : 1) * (BAL[voice.name] || 1) * 1.8;   // the recordings sit well below a synth drum machine's level
        src.connect(g).connect(lp); src.start(t);
        const v = { src, g }; live.add(v); if (voice.name === 'hhopen') hats.add(v);
        src.onended = () => { live.delete(v); hats.delete(v); g.disconnect(); };
      },
      noteOff() {},
      set(id, v, t) {
        P[id] = v;
        if (id === 'tone') lp.frequency.setTargetAtTime(v, t, 0.02);
        else if (id === 'level') master.gain.setTargetAtTime(v, t, 0.02);
      },
      allOff(t) { for (const v of live) stop(v, t ?? ctx.currentTime); },
      dispose() { for (const v of live) stop(v, ctx.currentTime); master.disconnect(); },
    };
  },
};
