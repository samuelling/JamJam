// Talkback: voice chat for the band, built the way game voice chat feels good.
//  - Voices ride WebRTC audio tracks (Opus with its loss concealment and the browser's adaptive jitter buffer), with
//    echo cancellation, noise suppression and level control on the mic. Talk has no lockstep timing: ~150 ms is fine.
//  - Each bandmate's voice comes from their corner's place in the stereo field, so several people talking at once
//    stay separable (the cocktail-party effect), and a glitch reads as the room rather than the connection.
//  - While anyone talks the music dips a few dB and comes back gently, so speech sits on top of the jam.
//  - Your mic only sends while you're talking: hold the Talk button, or click it to leave it open.
// Voices join after the master bus, so the tape (which records the master) leaves the chatter out.

const SLOTS = [-0.7, -0.25, 0.25, 0.7];
const DUCK = 0.6;        // music level while someone talks (about -4.4 dB)
const TALK_RMS = 0.012;  // above this a voice counts as talking

export class Talk {
  constructor(engine, room) { this.engine = engine; this.room = room; this.voices = new Map(); this.open = false; this.stream = null; this.mine = null; this.ducked = false; }

  // a bandmate's voice track arrived (it arrives whether or not we ever turn our own mic on)
  onTrack(p, track, stream) {
    const ctx = this.engine.ctx; if (!ctx || track.kind !== 'audio') return;
    const old = this.voices.get(p.id); if (old) this.drop(p.id);
    const ms = stream || new MediaStream([track]);
    // Chrome only feeds a remote WebRTC stream to Web Audio while a media element is playing it
    const el = new Audio(); el.muted = true; el.srcObject = ms; el.play?.().catch(() => {});
    const src = ctx.createMediaStreamSource(ms), pan = ctx.createStereoPanner(), gain = ctx.createGain(), an = ctx.createAnalyser();
    an.fftSize = 512; gain.gain.value = 1.4;
    src.connect(an); src.connect(pan).connect(gain).connect(this.engine.comp || this.engine.master);
    const v = { el, src, pan, gain, an, buf: new Float32Array(512), level: 0, track };
    this.voices.set(p.id, v);
    track.onended = () => { if (this.voices.get(p.id) === v) this.drop(p.id); };
  }
  drop(id) { const v = this.voices.get(id); if (!v) return; try { v.src.disconnect(); v.gain.disconnect(); v.el.srcObject = null; } catch (_) {} this.voices.delete(id); }
  // corner order -> stereo position
  place(order) { order.forEach((id, i) => { const v = this.voices.get(id); if (v) v.pan.pan.value = SLOTS[i % SLOTS.length]; }); }
  setVolume(id, vol) { const v = this.voices.get(id); if (v) v.gain.gain.setTargetAtTime(1.4 * vol, this.engine.ctx.currentTime, 0.05); }

  async enable() {
    if (this.stream) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (_) { return false; }
    this.track = this.stream.getAudioTracks()[0];
    this.track.enabled = this.open;
    const ctx = this.engine.ctx, src = ctx.createMediaStreamSource(this.stream), an = ctx.createAnalyser();
    an.fftSize = 512; src.connect(an);
    this.mine = { an, buf: new Float32Array(512), level: 0 };
    this.room.addTrack(this.track, this.stream);
    return true;
  }
  async setOpen(on) {
    if (on && !(await this.enable())) return false;
    this.open = on; if (this.track) this.track.enabled = on;
    return true;
  }

  // levels now (0..1 rms) for each voice and yours, and the music dip; call every ~50 ms
  tick() {
    const rms = (x) => { x.an.getFloatTimeDomainData(x.buf); let e = 0; for (const s of x.buf) e += s * s; x.level = x.level * 0.6 + Math.sqrt(e / x.buf.length) * 0.4; return x.level; };
    let any = false;
    for (const v of this.voices.values()) if (rms(v) > TALK_RMS) any = true;
    if (this.mine && this.open && rms(this.mine) > TALK_RMS) any = true;
    if (any !== this.ducked) {
      this.ducked = any;
      const m = this.engine.master, t = this.engine.ctx.currentTime;
      m.gain.cancelScheduledValues(t); m.gain.setTargetAtTime(any ? 0.9 * DUCK : 0.9, t, any ? 0.04 : 0.35);
    }
  }
  talking(id) { if (id === 'me') return !!(this.mine && this.open && this.mine.level > TALK_RMS); const v = this.voices.get(id); return !!(v && v.level > TALK_RMS); }
}
