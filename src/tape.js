// The tape: one button records the band's mix as you hear it (every instrument and live audio, not the
// metronome or the doorbell), then plays it back or saves it as a WAV. Kept in memory as 16-bit stereo, about
// 11 MB a minute; a take stops by itself at 30 minutes.

const WORKLET = `
class TapeTap extends AudioWorkletProcessor {
  constructor() { super(); this.on = false; this.port.onmessage = (m) => { this.on = m.data; }; this.L = new Float32Array(4096); this.R = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const i = inputs[0];
    if (!this.on || !i || !i.length) { if (this.n) this.flush(); return true; }
    const l = i[0], r = i[1] || i[0];
    this.L.set(l, this.n); this.R.set(r, this.n); this.n += l.length;
    if (this.n >= 4096) this.flush();
    return true;
  }
  flush() { this.port.postMessage([this.L.slice(0, this.n), this.R.slice(0, this.n)]); this.n = 0; }
}
registerProcessor('jj-tape', TapeTap);
`;

export const MAX_SECONDS = 30 * 60;

export class Tape {
  constructor(engine) { this.engine = engine; this.on = false; this.chunks = []; this.frames = 0; this.peak = 0; this.takes = []; }
  async ensure() {
    if (this.node) return;
    const ctx = this.engine.ctx;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    this.node = new AudioWorkletNode(ctx, 'jj-tape', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    this.engine.master.connect(this.node);
    this.node.port.onmessage = (m) => {
      if (!this.on) return;
      const [L, R] = m.data, n = L.length, pcm = new Int16Array(n * 2);
      for (let i = 0; i < n; i++) {
        const l = Math.max(-1, Math.min(1, L[i])), r = Math.max(-1, Math.min(1, R[i]));
        const a = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r); if (a > this.peak) this.peak = a;
        pcm[2 * i] = l * 32767; pcm[2 * i + 1] = r * 32767;
      }
      this.chunks.push(pcm); this.frames += n;
      if (this.frames >= MAX_SECONDS * this.engine.ctx.sampleRate) this.onLimit?.();
    };
  }
  async start() {
    await this.ensure();
    this.chunks = []; this.frames = 0; this.peak = 0; this.startedAt = Date.now();
    this.on = true; this.node.port.postMessage(true);
  }
  // stop and return the take: {blob (WAV), url, seconds, when}
  stop() {
    if (!this.on) return null;
    this.on = false; this.node.port.postMessage(false);
    const sr = this.engine.ctx.sampleRate, n = this.frames;
    if (!n) return null;
    // bring a quiet take up to about -1 dBFS, never down (the mix is already what you heard)
    const g = this.peak > 0 && this.peak < 0.89 ? 0.89 / this.peak : 1;
    const head = new ArrayBuffer(44), v = new DataView(head), bytes = n * 4;
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, bytes, true);
    const parts = g === 1 ? this.chunks : this.chunks.map((c) => { const o = new Int16Array(c.length); for (let i = 0; i < c.length; i++) o[i] = Math.max(-32768, Math.min(32767, Math.round(c[i] * g))); return o; });
    const blob = new Blob([head, ...parts], { type: 'audio/wav' });
    const take = { blob, url: URL.createObjectURL(blob), seconds: n / sr, when: new Date(this.startedAt) };
    this.takes.push(take); this.chunks = [];
    return take;
  }
  seconds() { return this.on ? this.frames / this.engine.ctx.sampleRate : 0; }
}
