// The audio lane: stream a mic or a line input (a real guitar, a voice, a synth only you own) to the other jammers,
// NINJAM-style. Every chunk is stamped with the room time it was played, and the listeners play it exactly N bars later.
// Pick N to match the loop or chord cycle you're jamming over and the late audio lands on the right chords.
//
// Chunk layout (binary, little-endian): [f64 room start ms][f64 delay ms][u32 sample rate][u32 frames] then int16 PCM.
//
// What streams to the band is always mono (lean, for the trip). What's kept here for locking in can be stereo: with
// `stereo` asked for (a studio set to high fidelity) and an input that has two channels, both are kept too.

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.l = null; this.r = null; this.n = 0; this.start = 0; }
  process(inputs) {
    const a = inputs[0] && inputs[0][0], b = inputs[0] && inputs[0][1];
    if (!a) return true;
    if (this.n === 0) { this.start = currentTime; if (b) { this.l = new Float32Array(2048); this.r = new Float32Array(2048); } }
    if (b && this.l) { this.l.set(a, this.n); this.r.set(b, this.n); for (let i = 0; i < a.length; i++) this.buf[this.n + i] = (a[i] + b[i]) / 2; }
    else this.buf.set(a, this.n);
    this.n += a.length;
    if (this.n >= this.buf.length) { this.port.postMessage({ t: this.start, d: this.buf, l: b ? this.l : null, r: b ? this.r : null }); this.buf = new Float32Array(2048); this.l = this.r = null; this.n = 0; }
    return true;
  }
}
registerProcessor('jj-tap', Tap);
`;

export const HEADER = 24;

export class AudioLane {
  constructor(engine, send) {
    this.engine = engine; this.send = send;
    this.on = false; this.bars = 1; this.quality = 'hi'; this.offsetMs = 0;
    this.level = 0; this.sentBytes = 0; this.stream = null; this.node = null;
    this.hist = []; this.histMs = 0;   // what you played, kept here for two minutes, so a pass can be locked in as an audio take
  }
  delayMs(atRoom) { return this.bars * 4 * this.engine.tempo.beatMs(atRoom); }

  async devices() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch (_) { return []; }
  }

  // stereo: keep both channels of a two-channel input for locking in (the stream stays mono)
  async startLane(deviceId, stereo = false) {
    const ctx = this.engine.ctx;
    this.stopLane();
    this.wantStereo = !!stereo;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: stereo ? { ideal: 2 } : 1 },
    });
    this.stream = stream;
    if (!this.loaded) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url); this.loaded = true;
    }
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'jj-tap', { numberOfInputs: 1, numberOfOutputs: 1 });
    const sink = ctx.createGain(); sink.gain.value = 0; // keeps the tap running without being heard
    src.connect(node).connect(sink).connect(ctx.destination);
    this.src = src; this.node = node;
    const track = stream.getAudioTracks()[0];
    const inLatency = (track.getSettings && track.getSettings().latency) || 0.01;
    node.port.onmessage = ({ data }) => {
      // the block processed at context time t was captured about (output latency + input latency) before it would be heard
      const outLat = ctx.outputLatency || ctx.baseLatency || 0;
      const start = this.engine.roomTime(data.t) - (outLat + inLatency) * 1000 + this.offsetMs;
      let pcm = data.d, rate = ctx.sampleRate;
      if (this.quality === 'lo') { const h = new Float32Array(pcm.length / 2); for (let i = 0; i < h.length; i++) h[i] = (pcm[2 * i] + pcm[2 * i + 1]) / 2; pcm = h; rate /= 2; }
      let peak = 0;
      const buf = new ArrayBuffer(HEADER + pcm.length * 2), dv = new DataView(buf);
      dv.setFloat64(0, start, true); dv.setFloat64(8, this.delayMs(start), true); dv.setUint32(16, rate, true); dv.setUint32(20, pcm.length, true);
      const out = new Int16Array(buf, HEADER);
      for (let i = 0; i < pcm.length; i++) { const s = Math.max(-1, Math.min(1, pcm[i])); out[i] = s * 32767; peak = Math.max(peak, Math.abs(s)); }
      this.level = Math.max(peak, this.level * 0.9);
      this.sentBytes += buf.byteLength;
      this.send(buf);
      this.hist.push({ start, rate: ctx.sampleRate, pcm: Float32Array.from(data.d), l: data.l, r: data.r }); this.histMs += (data.d.length / ctx.sampleRate) * 1000;   // kept at full rate
      while (this.histMs > 120000 && this.hist.length > 1) { const h = this.hist.shift(); this.histMs -= (h.pcm.length / h.rate) * 1000; }
    };
    this.on = true;
  }

  // the audio you played between room times t0 and t1 (ms), mono at `rate` (gaps are silence); null if none of it is here
  slice(t0, t1, rate = 24000, which = 'pcm') {
    const n = Math.max(0, Math.round(((t1 - t0) / 1000) * rate)), out = new Float32Array(n); let got = 0;
    for (const h of this.hist) {
      const x = h[which] || h.pcm, end = h.start + (x.length / h.rate) * 1000; if (end <= t0 || h.start >= t1) continue;
      for (let i = Math.max(0, Math.floor(((h.start - t0) / 1000) * rate)); i < n; i++) {
        const src = ((t0 + (i / rate) * 1000 - h.start) / 1000) * h.rate; if (src < 0) continue; if (src >= x.length - 1) break;
        const a = Math.floor(src), f = src - a; out[i] = x[a] * (1 - f) + x[a + 1] * f; got++;
      }
    }
    return got > n * 0.5 ? out : null;
  }
  // the same, kept for a take: { ch, pcm (interleaved Float32 when ch is 2), mono } — stereo only when it was asked
  // for, the input had two channels, and they really differ (a mono source on both sides stays mono)
  sliceTake(t0, t1, rate, stereo) {
    const mono = this.slice(t0, t1, rate); if (!mono) return null;
    const both = stereo && this.hist.some((h) => h.l && h.start < t1 && h.start + (h.pcm.length / h.rate) * 1000 > t0);
    if (!both) return { ch: 1, pcm: mono, mono };
    const L = this.slice(t0, t1, rate, 'l'), R = this.slice(t0, t1, rate, 'r'); if (!L || !R) return { ch: 1, pcm: mono, mono };
    let diff = 0, peak = 0; for (let i = 0; i < L.length; i++) { diff = Math.max(diff, Math.abs(L[i] - R[i])); peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
    if (diff <= peak * 0.01) return { ch: 1, pcm: mono, mono };   // dual mono
    const pcm = new Float32Array(L.length * 2); for (let i = 0; i < L.length; i++) { pcm[2 * i] = L[i]; pcm[2 * i + 1] = R[i]; }
    return { ch: 2, pcm, mono };
  }
  stopLane() {
    this.on = false;
    if (this.node) { this.node.port.onmessage = null; try { this.src.disconnect(); } catch (_) {} this.node = null; }
    if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); this.stream = null; }
  }
}

export function decodeChunk(buf) {
  if (buf.byteLength < HEADER) return null;
  const dv = new DataView(buf);
  const start = dv.getFloat64(0, true), delay = dv.getFloat64(8, true), rate = dv.getUint32(16, true), n = dv.getUint32(20, true);
  if (buf.byteLength < HEADER + n * 2 || rate < 3000 || rate > 192000) return null;
  const pcm = new Int16Array(buf, HEADER, n), f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = pcm[i] / 32768;
  return { start, delay, rate, samples: f };
}
