// The room's mix and master: SynthLand's Stem Console (vendor/stems, built in SynthLandExplorer, as Ecphory and
// Iterative Composer run it). Eight stereo stems, each ridden to its own loudness target, summed through glue, a
// corrective dynamic EQ, bass mono and a true-peak limiter. Everything that plays goes through one console: the song,
// your desk, the band's desks and the drummers, so they share one mix and one limiter. Voices and the click stay out.
// It adds about 10 ms, which note times allow for (Engine.audioTime), so everyone still hears the room's clock.
//
// Live instruments join by what they are, and song tracks by role. Each stem aims at the song's loudness target plus a level of its own, and a track's
// fader moves that aim, so the rider follows your mix instead of fighting it. Every browser runs its own console from
// the same settings, and the export runs the same engine offline.

export const STYLES = [   // loudness in LUFS, from the Tracker's mastering styles
  { id: 'club', name: 'Club', loudness: -11.5, monoBass: 120, note: 'Techno, house, trap: loud' },
  { id: 'electronic', name: 'Electronic', loudness: -13, monoBass: 120, note: 'A little more room than Club' },
  { id: 'band', name: 'Band', loudness: -13, monoBass: 120, note: 'Rock, pop, funk, blues: punchy and clear' },
  { id: 'jazz', name: 'Jazz', loudness: -16, monoBass: 100, note: 'Dynamic, with room around the notes' },
  { id: 'acoustic', name: 'Acoustic', loudness: -17, monoBass: 100, note: 'Folk, solo and chamber: gentle' },
];
export const STEMS = [
  { k: 1, name: 'Drums', roles: ['time'], level: -4, mono: 1, hpf: 20 },
  { k: 2, name: 'Bass', roles: ['bass line'], level: -6, mono: 1, hpf: 20 },
  { k: 3, name: 'Chords', roles: ['comping'], level: -8, hpf: 90, duckBy: 5, duck: 2 },
  { k: 4, name: 'Pads', roles: ['pad'], level: -12, hpf: 100, duckBy: 5, duck: 3 },
  { k: 5, name: 'Melody', roles: ['melody'], level: -6, hpf: 120 },
  { k: 6, name: 'Solo', roles: ['solo'], level: -5, hpf: 120 },
  { k: 7, name: 'Hits', roles: ['hits', 'backgrounds'], level: -10, hpf: 120 },
  { k: 8, name: 'Texture', roles: ['texture'], level: -12, hpf: 120 },
];
export const stemOf = (t) => (t?.drums ? 1 : STEMS.find((s) => s.roles.includes(t?.role))?.k ?? 5);
const WASM = 'vendor/stems/stems.wasm';

export function masterSettings(song) {
  const m = song?.master || {}, style = STYLES.find((s) => s.id === m.style) || STYLES[2];
  return { on: m.on !== false, style: style.id, target: m.target ?? style.loudness, ceiling: m.ceiling ?? -1.5, glue: m.glue ?? 1.5, ride: m.ride !== false, monoBass: style.monoBass, stems: m.stems || {} };
}
// the console's parameters for a song: its settings, and how its tracks sit in the stems
export function consoleValues(song) {
  const m = masterSettings(song), v = {
    'master.target': m.target, 'master.ride': m.ride ? 1 : 0, 'master.range': 6, 'master.speed': 0,
    'glue.on': m.glue > 1.01 ? 1 : 0, 'glue.ratio': Math.max(1, m.glue), 'glue.threshold': m.target - 2,
    'mix.bass_mono': 1, 'mix.bass_freq': m.monoBass, 'clip.on': 0, 'out.ceiling': m.ceiling, 'out.level': song?.master?.vol ?? 0,
  };
  const tracks = Object.values(song?.lanes || {}).filter((t) => !t.muted);
  for (const s of STEMS) {
    const mine = tracks.filter((t) => stemOf(t) === s.k), fader = mine.length ? Math.max(...mine.map((t) => t.vol ?? 0)) : 0, p = `s${s.k}.`;
    Object.assign(v, { [p + 'ride']: m.ride ? 1 : 0, [p + 'target']: m.target + s.level + (m.stems[s.k] || 0) + fader, [p + 'range']: 9, [p + 'speed']: 0, [p + 'gate']: -50, [p + 'bass_mono']: s.mono || 0, [p + 'hpf']: s.hpf, [p + 'comp']: 0, [p + 'fader']: 0, [p + 'mute']: 0, [p + 'duck_by']: s.duckBy || 0, [p + 'duck_depth']: s.duck || 0 });
  }
  return v;
}
const imports = () => ({
  wasi_snapshot_preview1: { fd_write: () => 0, fd_close: () => 0, fd_seek: () => 0, proc_exit: () => undefined, environ_sizes_get: () => 0, environ_get: () => 0 },
  env: { emscripten_notify_memory_growth: () => undefined, abort: () => { throw new Error('wasm abort'); } },
});
const paramIds = (ex, e) => {
  const mem = new Uint8Array(ex.memory.buffer); let p = ex.sl_param_json(e), s = '';
  while (mem[p]) s += String.fromCharCode(mem[p++]);
  return Object.fromEntries(JSON.parse(s).map((d, i) => [d.id, i]));
};
let bytesP = null;
export function consoleBytes() {
  bytesP = bytesP || fetch(new URL(WASM, location.href)).then((r) => { if (!r.ok) throw new Error('no console engine'); return r.arrayBuffer(); });
  bytesP.catch(() => { bytesP = null; });
  return bytesP;
}

// the console offline: stems [{L, R} or null, one per stem], same length; returns the master, lined up with its input
export async function renderMaster(bytes, stems, sr, values) {
  const { instance } = await WebAssembly.instantiate(bytes, imports()), ex = instance.exports;
  if (ex._initialize) ex._initialize();
  const Q = 128, e = ex.sl_create(); ex.sl_prepare(e, sr, Q);
  const ids = paramIds(ex, e);
  for (const [id, x] of Object.entries(values)) if (id in ids) ex.sl_set_param(e, ids[id], x);
  const n = stems.find(Boolean)?.L.length || 0, lat = ex.sl_latency_samples ? ex.sl_latency_samples(e) : 0, L = new Float32Array(n), R = new Float32Array(n);
  const heap = new Float32Array(ex.memory.buffer), inp = stems.map((_, c) => [ex.sl_in_ptr(e, 2 * c) >> 2, ex.sl_in_ptr(e, 2 * c + 1) >> 2]), oL = ex.sl_out_ptr(e, 0) >> 2, oR = ex.sl_out_ptr(e, 1) >> 2;
  let top = -1; stems.forEach((s, k) => { if (s) top = k; });
  for (let at = 0; at < n + lat; at += Q) {
    stems.forEach((s, k) => { for (let i = 0; i < Q; i++) { heap[inp[k][0] + i] = s && at + i < n ? s.L[at + i] : 0; heap[inp[k][1] + i] = s && at + i < n ? s.R[at + i] : 0; } });
    ex.sl_process(e, 2 * (top + 1), Q);
    for (let i = 0; i < Q; i++) { const o = at + i - lat; if (o >= 0 && o < n) { L[o] = heap[oL + i]; R[o] = heap[oR + i]; } }
  }
  ex.sl_destroy(e);
  return { L, R, latency: lat };
}

const WORKLET = `
const Q = 128;
class JJConsole extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.alive = true; this.ticks = 0;
    this.port.onmessage = (ev) => { const m = ev.data; if (m.t === 'close') { this.alive = false; if (this.ex) this.ex.sl_destroy(this.e); this.ex = null; } else if (this.ex && m.id in this.ids) this.ex.sl_set_param(this.e, this.ids[m.id], m.v); };
    this.boot(o.bytes, o.values).catch((e) => this.port.postMessage({ t: 'error', message: String(e && e.message || e) }));
  }
  async boot(bytes, values) {
    const { instance } = await WebAssembly.instantiate(bytes, {
      wasi_snapshot_preview1: { fd_write: () => 0, fd_close: () => 0, fd_seek: () => 0, proc_exit: () => undefined, environ_sizes_get: () => 0, environ_get: () => 0 },
      env: { emscripten_notify_memory_growth: () => undefined, abort: () => { throw new Error('wasm abort'); } },
    });
    const ex = instance.exports; if (ex._initialize) ex._initialize();
    const e = ex.sl_create(); ex.sl_prepare(e, sampleRate, Q);
    const mem = new Uint8Array(ex.memory.buffer); let p = ex.sl_param_json(e), s = '';
    while (mem[p]) s += String.fromCharCode(mem[p++]);
    this.ids = {}; JSON.parse(s).forEach((d, i) => { this.ids[d.id] = i; });
    for (const id in values) if (id in this.ids) ex.sl_set_param(e, this.ids[id], values[id]);
    this.heap = new Float32Array(ex.memory.buffer);
    this.ins = Array.from({ length: 16 }, (_, c) => ex.sl_in_ptr(e, c) >> 2);
    this.out = [ex.sl_out_ptr(e, 0) >> 2, ex.sl_out_ptr(e, 1) >> 2];
    this.tel = ex.sl_telemetry_ptr ? ex.sl_telemetry_ptr(e) >> 2 : 0;
    this.ex = ex; this.e = e;
    this.port.postMessage({ t: 'ready', latency: ex.sl_latency_samples ? ex.sl_latency_samples(e) : 0 });
  }
  process(inputs, outputs) {
    if (!this.alive) return false;
    if (!this.ex) return true;
    const h = this.heap, out = outputs[0]; let top = -1;
    for (let k = 0; k < 8; k++) {
      const s = inputs[k], l = this.ins[2 * k], r = this.ins[2 * k + 1];
      if (s && s.length) { top = k; const a = s[0], b = s[1] || s[0]; for (let i = 0; i < Q; i++) { h[l + i] = a[i]; h[r + i] = b[i]; } }
      else for (let i = 0; i < Q; i++) { h[l + i] = 0; h[r + i] = 0; }
    }
    this.ex.sl_process(this.e, 2 * (top + 1), Q);
    if (this.tel && ++this.ticks >= 19) { this.ticks = 0; const n = this.ex.sl_telemetry(this.e); if (n > 0) this.port.postMessage({ t: 'tel', v: Array.from(new Float32Array(this.ex.memory.buffer, this.tel * 4, n)) }); }
    const L = out[0], R = out[1] || out[0];
    for (let i = 0; i < Q; i++) { L[i] = h[this.out[0] + i]; R[i] = h[this.out[1] + i]; }
    return true;
  }
}
registerProcessor('jj-console', JJConsole);
`;

// the console in the room's audio: resolves to null if this browser can't run it, and the song plays without it
export async function startConsole(ctx, values, onMeters) {
  try {
    const bytes = await consoleBytes();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const node = new AudioWorkletNode(ctx, 'jj-console', { numberOfInputs: 8, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { bytes: bytes.slice(0), values } });
    return await new Promise((resolve) => {
      const sent = { ...values };
      const api = { node, latency: 0, meters: null, set(next) { for (const [id, v] of Object.entries(next)) if (sent[id] !== v) { sent[id] = v; node.port.postMessage({ id, v }); } } };
      node.port.onmessage = (ev) => {
        const m = ev.data;
        if (m.t === 'ready') { api.latency = m.latency; resolve(api); }
        else if (m.t === 'tel') { const t = m.v; api.meters = { short: t[1], integrated: t[2], peak: t[3], glue: t[4], limiter: t[5], ride: t[7], stems: STEMS.map((s) => { const o = 8 + 6 * (s.k - 1); return { k: s.k, lufs: t[o], ride: t[o + 2], active: t[o + 5] > 0.5 }; }) }; onMeters?.(); }
        else if (m.t === 'error') { console.warn('Stem Console:', m.message); resolve(null); }
      };
    });
  } catch (e) { console.warn('Stem Console unavailable:', e); return null; }
}
