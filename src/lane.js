// The audio lane: stream a mic or a line input (a real guitar, a voice, a synth only you own) to the other jammers,
// NINJAM-style. Every chunk is stamped with the room time it was played, and the listeners play it exactly N bars later.
// Pick N to match the loop or chord cycle you're jamming over and the late audio lands on the right chords.
//
// Chunk layout (binary, little-endian): [f64 room start ms][f64 delay ms][u32 sample rate][u32 frames] then int16 PCM.

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; this.start = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.n === 0) this.start = currentTime;
    this.buf.set(ch, this.n); this.n += ch.length;
    if (this.n >= this.buf.length) { this.port.postMessage({ t: this.start, d: this.buf }); this.buf = new Float32Array(2048); this.n = 0; }
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

  async startLane(deviceId) {
    const ctx = this.engine.ctx;
    this.stopLane();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
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
      this.hist.push({ start, rate, pcm: Float32Array.from(pcm) }); this.histMs += (pcm.length / rate) * 1000;
      while (this.histMs > 120000 && this.hist.length > 1) { const h = this.hist.shift(); this.histMs -= (h.pcm.length / h.rate) * 1000; }
    };
    this.on = true;
  }

  // the audio you played between room times t0 and t1 (ms), mono at `rate` (gaps are silence); null if none of it is here
  slice(t0, t1, rate = 24000) {
    const n = Math.max(0, Math.round(((t1 - t0) / 1000) * rate)), out = new Float32Array(n); let got = 0;
    for (const h of this.hist) {
      const end = h.start + (h.pcm.length / h.rate) * 1000; if (end <= t0 || h.start >= t1) continue;
      for (let i = Math.max(0, Math.floor(((h.start - t0) / 1000) * rate)); i < n; i++) {
        const src = ((t0 + (i / rate) * 1000 - h.start) / 1000) * h.rate; if (src < 0) continue; if (src >= h.pcm.length - 1) break;
        const a = Math.floor(src), f = src - a; out[i] = h.pcm[a] * (1 - f) + h.pcm[a + 1] * f; got++;
      }
    }
    return got > n * 0.5 ? out : null;
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
