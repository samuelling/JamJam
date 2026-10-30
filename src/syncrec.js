// Sync record: the live jam is the sketch, the record is assembled afterwards from every jammer's true sources.
// While a sync take runs, each browser records what only it has: its own instruments dry (before your mix's
// faders), the audio of any hardware it plays (through an audio input), and every note it sent, all on the room's
// clock. Afterwards the takes are gathered over the direct links into one folder: a WAV stem and a MIDI file per
// part, a rough mix, and session.json. Hardware recorded through an audio input is lined up by matching its note
// onsets to the notes it was sent (input latency is measured, not guessed).
//
// Timing: a stem records audio frames; the room's clock and the audio clock drift a little (tens of ppm), so the
// recorder keeps (frame, room time) anchors every second and the export resamples onto exact room time.

const WORKLET = `
class Stem extends AudioWorkletProcessor {
  constructor() { super(); this.on = false; this.port.onmessage = (m) => { this.on = m.data; }; }
  process(inputs) {
    const i = inputs[0];
    if (this.on && i && i.length) this.port.postMessage([currentFrame, i[0].slice(0), (i[1] || i[0]).slice(0)]);
    return true;
  }
}
registerProcessor('jj-stem', Stem);
`;

export async function ensureStemWorklet(ctx) {
  ctx.__jjWorklets = ctx.__jjWorklets || new Set();
  if (ctx.__jjWorklets.has('jj-stem')) return;
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  ctx.__jjWorklets.add('jj-stem');
}

// one source node -> float chunks stamped with their first audio frame
export class StemRecorder {
  constructor(ctx, src) {
    this.ctx = ctx; this.chunks = []; this.frames = 0; this.first = null;
    this.node = new AudioWorkletNode(ctx, 'jj-stem', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    src.connect(this.node); this.src = src;
    this.node.port.onmessage = (m) => { const [f, L, R] = m.data; if (this.first == null) this.first = f; this.chunks.push([L, R]); this.frames += L.length; };
  }
  start() { this.node.port.postMessage(true); }
  stop() { this.node.port.postMessage(false); try { this.src.disconnect(this.node); } catch (_) {} }
  // the recording as two Float32Arrays starting at audio frame `first`
  data() {
    const L = new Float32Array(this.frames), R = new Float32Array(this.frames); let o = 0;
    for (const [l, r] of this.chunks) { L.set(l, o); R.set(r, o); o += l.length; }
    return { first: this.first ?? 0, L, R };
  }
}

// resample a recording onto exact room time [T0, T1) (ms) at sample rate sr, using (frame, room ms) anchors
export function toRoomTime({ first, L, R }, anchors, T0, T1, sr) {
  const n = Math.max(0, Math.round(((T1 - T0) / 1000) * sr)), oL = new Float32Array(n), oR = new Float32Array(n);
  if (!anchors.length || !L.length) return { L: oL, R: oR };
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = T0 + (i / sr) * 1000;
    while (j < anchors.length - 2 && anchors[j + 1][1] < t) j++;
    const [f0, r0] = anchors[j], [f1, r1] = anchors[Math.min(j + 1, anchors.length - 1)];
    const f = r1 !== r0 ? f0 + ((t - r0) * (f1 - f0)) / (r1 - r0) : f0 + ((t - r0) / 1000) * sr;
    const x = f - first, k = Math.floor(x), a = x - k;
    if (k >= 0 && k + 1 < L.length) { oL[i] = L[k] + (L[k + 1] - L[k]) * a; oR[i] = R[k] + (R[k + 1] - R[k]) * a; }
  }
  return { L: oL, R: oR };
}

// how late an input recording is against the notes it played: onset flux vs the note-ons, best lag in [-50, 300] ms
export function measureLag({ L, R }, noteTimesMs, sr) {
  const hop = Math.round(sr * 0.005), m = Math.floor(L.length / hop);
  if (m < 10 || !noteTimesMs.length) return 0;
  const env = new Float32Array(m);
  let prev = 0;
  for (let i = 0; i < m; i++) { let e = 0; for (let k = i * hop; k < (i + 1) * hop; k++) { const s = (L[k] + R[k]) * 0.5; e += s * s; } e = Math.sqrt(e / hop); env[i] = Math.max(0, e - prev); prev = e; }
  let best = 0, bestScore = -1;
  for (let lag = -10; lag <= 60; lag++) {   // in 5 ms hops
    let sc = 0;
    for (const t of noteTimesMs) { const i = Math.round(t / 5) + lag; if (i >= 1 && i + 1 < m) sc += env[i] + 0.5 * (env[i - 1] + env[i + 1]); }
    if (sc > bestScore) { bestScore = sc; best = lag; }
  }
  return best * 5;
}

export function shiftEarlier({ L, R }, ms, sr) {
  const k = Math.round((ms / 1000) * sr); if (!k) return { L, R };
  const oL = new Float32Array(L.length), oR = new Float32Array(R.length);
  if (k > 0) { oL.set(L.subarray(k)); oR.set(R.subarray(k)); } else { oL.set(L.subarray(0, L.length + k), -k); oR.set(R.subarray(0, R.length + k), -k); }
  return { L: oL, R: oR };
}

export function wav({ L, R }, sr) {
  const n = L.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 4, true);
  for (let i = 0, o = 44; i < n; i++, o += 4) { v.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true); v.setInt16(o + 2, Math.max(-1, Math.min(1, R[i])) * 32767, true); }
  return new Uint8Array(buf);
}
export function readWav(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), sr = v.getUint32(24, true), n = (bytes.byteLength - 44) / 4;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0, o = 44; i < n; i++, o += 4) { L[i] = v.getInt16(o, true) / 32767; R[i] = v.getInt16(o + 2, true) / 32767; }
  return { L, R, sr };
}

// a standard MIDI file (type 0, 480 ppq) of one part, on the room's beat grid from T0 (ms), with its tempo changes
export function midiFile(events, tempo, T0, T1, name, ch = 0) {
  const PPQ = 480, b0 = tempo.beatAt(T0), tick = (ms) => Math.max(0, Math.round((tempo.beatAt(ms) - b0) * PPQ));
  const out = [];
  const meta = (t, type, bytes) => out.push({ t, o: 0, b: [0xff, type, ...vlq(bytes.length), ...bytes] });
  const tempoAt = (ms) => { const us = Math.round(60e6 / tempo.bpm(ms)); return [(us >> 16) & 255, (us >> 8) & 255, us & 255]; };
  meta(0, 0x03, [...new TextEncoder().encode(name)]);
  meta(0, 0x51, tempoAt(T0));
  for (const s of tempo.segs || []) if (s.at > T0 && s.at < T1) meta(tick(s.at), 0x51, tempoAt(s.at));
  const on = new Map();
  for (const e of events) {
    if (e.at < T0 || e.at > T1 + 5000) continue;
    if (e.type === 'on') { out.push({ t: tick(e.at), o: 2, b: [0x90 | ch, e.note & 127, Math.max(1, Math.min(127, e.vel ?? 100))] }); on.set(e.note, (on.get(e.note) || 0) + 1); }
    else if (e.type === 'off' && on.get(e.note)) { out.push({ t: tick(Math.min(e.at, T1)), o: 1, b: [0x80 | ch, e.note & 127, 0] }); on.set(e.note, on.get(e.note) - 1); }
    else if (e.type === 'p' && e.id === 'bend') { const v = Math.max(0, Math.min(16383, Math.round(8192 + (e.v / 2) * 8191))); out.push({ t: tick(e.at), o: 1, b: [0xe0 | ch, v & 127, v >> 7] }); }
  }
  for (const [n, c] of on) for (let i = 0; i < c; i++) out.push({ t: tick(T1), o: 1, b: [0x80 | ch, n, 0] });   // still held at the end
  out.sort((a, b) => a.t - b.t || a.o - b.o);
  const trk = []; let last = 0;
  for (const e of out) { trk.push(...vlq(e.t - last), ...e.b); last = e.t; }
  trk.push(0, 0xff, 0x2f, 0);
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, PPQ >> 8, PPQ & 255];
  const len = trk.length;
  return new Uint8Array([...head, 0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...trk]);
}
function vlq(n) { const b = [n & 127]; n >>>= 7; while (n) { b.unshift((n & 127) | 128); n >>>= 7; } return b; }

// a zip with no compression (WAVs barely compress anyway)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function zip(files) {   // [{name, data: Uint8Array}]
  const parts = [], central = []; let off = 0;
  const u16 = (v) => [v & 255, (v >> 8) & 255], u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  for (const f of files) {
    const name = new TextEncoder().encode(f.name), crc = crc32(f.data), n = f.data.length;
    const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(n), ...u32(n), ...u16(name.length), ...u16(0), ...name]);
    parts.push(local, f.data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(n), ...u32(n), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off), ...name]));
    off += local.length + n;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(off), ...u16(0)]);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

// a rough mix of stems (equal level, gentle limit), for listening before you open a DAW
export function mixStems(stems) {
  const n = Math.max(0, ...stems.map((s) => s.L.length)), L = new Float32Array(n), R = new Float32Array(n);
  for (const s of stems) for (let i = 0; i < s.L.length; i++) { L[i] += s.L[i]; R[i] += s.R[i]; }
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
  const g = pk > 0.95 ? 0.95 / pk : 1; if (g !== 1) for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  return { L, R };
}
