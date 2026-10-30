// The sound side: loads the shared instruments, keeps one channel per jammer, and plays every timestamped event at its
// room time. Each jammer's browser runs every jammer's instrument, so nobody's audio crosses the network
// (except the optional audio lane, which is played back a fixed number of bars late).

const sha = async (text) => {
  if (!crypto.subtle) return 'nohash';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
};
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); };
const r4 = (x) => Math.round(x * 1e4) / 1e4;

export class Engine {
  constructor(clock, tempo) {
    this.clock = clock;
    this.tempo = tempo;
    this.ctx = null;
    this.defs = new Map();
    this.hashes = {};
    this.hardware = { families: {}, hardware: [] };
    this.ch = new Map();
    this.metro = { on: false, level: 0.5, next: -1 };
    this.log = [];        // recent scheduled events, for the latency view and the tests
    this.logMax = 4000;
  }

  async start() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.knee.value = 6; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.15;
    this.master.connect(comp).connect(ctx.destination);
    this.clickBus = ctx.createGain(); this.clickBus.connect(this.master);
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    this.tick = setInterval(() => this.metronome(), 25);
  }

  async loadInstruments(base = '.') {
    const man = await (await fetch(`${base}/instruments/index.json`, { cache: 'no-cache' })).json();
    for (const it of man.instruments) {
      const src = await (await fetch(`${base}/instruments/${it.file}`, { cache: 'no-cache' })).text();
      const hash = await sha(src);
      // run exactly the text we hashed
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const mod = await import(url);
      URL.revokeObjectURL(url);
      const def = { ...mod.default, hash, file: it.file };
      if (def.init) await def.init(this.ctx);
      this.defs.set(it.id, def);
      this.hashes[it.id] = hash;
    }
    const hwText = await (await fetch(`${base}/instruments/hardware.json`, { cache: 'no-cache' })).text();
    this.hardware = JSON.parse(hwText);
    this.hashes.hardware = await sha(hwText);
  }

  // A channel config: {inst, params, patch, hw, source}. Remote jammers only need inst + params to sound the same.
  resolve({ inst, patch, hw }) {
    const unit = hw ? this.hardware.hardware.find((h) => h.id === hw) : null;
    if (unit) inst = this.hardware.families[unit.family]?.twin || inst;
    const def = this.defs.get(inst) || this.defs.values().next().value;
    const types = unit ? unit.types : Object.keys(def.presets);
    if (!patch || !def.presets[patch]) patch = types.find((t) => def.presets[t]) || Object.keys(def.presets)[0];
    const params = {};
    for (const p of def.params) params[p.id] = p.def;
    Object.assign(params, def.presets[patch] || {}, unit ? unit.character || {} : {});
    return { inst: def.id, patch, hw: unit ? unit.id : null, params };
  }

  channel(pid) {
    let c = this.ch.get(pid);
    if (c) return c;
    const out = this.ctx.createGain();
    const lane = this.ctx.createGain();
    out.connect(this.master); lane.connect(out);
    c = { pid, out, lane, vol: 1, mute: false, insts: [], cfgLog: [], pLog: [], notes: [], noteBase: 0, late: 0, lateWorst: 0, events: 0, flashT: 0, laneNext: 0, laneLate: 0, laneT: 0, held: new Set() };
    this.ch.set(pid, c);
    return c;
  }
  removeChannel(pid) {
    const c = this.ch.get(pid); if (!c) return;
    const t = this.ctx.currentTime;
    for (const I of c.insts) { try { I.inst.allOff(t); } catch (_) {} }
    c.out.gain.setTargetAtTime(0, t + 0.5, 0.2);
    setTimeout(() => { for (const I of c.insts) { try { I.inst.dispose(); } catch (_) {} } c.out.disconnect(); }, 2500);
    this.ch.delete(pid);
  }
  setVolume(pid, vol, mute) {
    const c = this.channel(pid); c.vol = vol; c.mute = !!mute;
    c.out.gain.setTargetAtTime(c.mute ? 0 : vol, this.ctx.currentTime, 0.02);
  }

  // room time (ms) -> AudioContext time (s), including the device's output latency
  audioTime(roomMs) {
    const local = this.clock.toLocal(roomMs), ctx = this.ctx;
    const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (ts && ts.performanceTime > 0 && ts.contextTime > 0) return ts.contextTime + (local - ts.performanceTime) / 1000;
    return ctx.currentTime + (local - performance.now()) / 1000 - (ctx.outputLatency || ctx.baseLatency || 0);
  }
  // AudioContext time (s) -> room time (ms) of when that sample is heard
  roomTime(ctxT) {
    const ctx = this.ctx, ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    let local;
    if (ts && ts.performanceTime > 0 && ts.contextTime > 0) local = ts.performanceTime + (ctxT - ts.contextTime) * 1000;
    else local = performance.now() + (ctxT - ctx.currentTime + (ctx.outputLatency || ctx.baseLatency || 0)) * 1000;
    return local + this.clock.offset;
  }

  // switch a jammer's instrument at room time `at` (-Infinity: from the start)
  setCfg(pid, cfg, at = -Infinity) {
    const c = this.channel(pid);
    const def = this.defs.get(cfg.inst);
    if (!def) return;
    if (c.insts.length && c.insts[c.insts.length - 1].from >= at && at !== -Infinity) return; // stale
    const ctx = this.ctx, now = ctx.currentTime;
    const t = at === -Infinity ? now : Math.max(now, this.audioTime(at));
    const g = ctx.createGain();
    g.gain.setValueAtTime(c.insts.length ? 0 : 1, now);
    g.gain.setValueAtTime(1, t);
    g.connect(c.out);
    const inst = def.create(ctx, g, cfg.params);
    for (const old of c.insts) {
      try { old.inst.allOff(t); } catch (_) {}
      old.gain.gain.setTargetAtTime(0, t + 1.2, 0.3);
      setTimeout(() => { try { old.inst.dispose(); } catch (_) {} old.gain.disconnect(); }, Math.max(0, (t - now) * 1000) + 4000);
    }
    c.insts = [{ from: at, inst, def, gain: g, cfg }];
    c.cfgLog.push({ at, cfg: JSON.parse(JSON.stringify(cfg)) });
    if (c.cfgLog.length > 20) c.cfgLog.splice(0, c.cfgLog.length - 20);
  }

  // one timestamped event for a jammer's channel: {type:'on'|'off'|'p', at, seq, note?, vel?, id?, v?}
  event(pid, ev, { now = false } = {}) {
    const c = this.channel(pid);
    const I = c.insts[c.insts.length - 1];
    if (!I) return;
    const ctx = this.ctx;
    let t = now ? ctx.currentTime : this.audioTime(ev.at);
    let lateMs = 0;
    if (!now && t < ctx.currentTime) {
      lateMs = (ctx.currentTime - t) * 1000;
      if (lateMs > 3) { c.late++; c.lateWorst = Math.max(c.lateWorst, lateMs); }
      t = ctx.currentTime;
    }
    c.events++;
    if (ev.type === 'on') {
      c.notes.push(ev.at); c.flashT = performance.now(); c.held.add(ev.note);
      if (c.notes.length > 6000) { const cut = c.notes.length - 3000; c.noteBase += cut; c.notes.splice(0, cut); }
      I.inst.noteOn(ev.note, ev.vel, t);
    } else if (ev.type === 'off') { c.held.delete(ev.note); I.inst.noteOff(ev.note, t); }
    else if (ev.type === 'p') {
      I.inst.set(ev.id, ev.v, t);
      if (ev.id !== 'bend') {
        c.pLog.push({ at: ev.at, seq: ev.seq || 0, id: ev.id, v: ev.v });
        if (c.pLog.length > 3000) c.pLog.splice(0, 1000);
      }
    }
    this.log.push({ pid, type: ev.type, note: ev.note, id: ev.id, at: ev.at, ctxT: t, heard: this.roomTime(t), lateMs, now });
    if (this.log.length > this.logMax) this.log.splice(0, this.log.length - this.logMax);
  }

  // A fingerprint of each jammer's channel as of room time T: the instrument and every parameter.
  // (The app adds a count of the notes in the seconds before T.) Two browsers that agree are making the same music.
  fingerprint(T) {
    const out = {};
    for (const [pid, c] of this.ch) {
      let cfg = null, from = -Infinity;
      for (const e of c.cfgLog) if (e.at <= T) { cfg = e.cfg; from = e.at; }
      if (!cfg) continue;
      const params = { ...cfg.params };
      const ps = c.pLog.filter((p) => p.at > from && p.at <= T).sort((a, b) => a.at - b.at || a.seq - b.seq);
      for (const p of ps) params[p.id] = p.v;
      const keys = Object.keys(params).sort();
      out[pid] = fnv(cfg.inst + '|' + keys.map((k) => k + '=' + r4(params[k])).join(','));
    }
    return out;
  }

  metronome() {
    if (!this.ctx) return;
    const m = this.metro, now = this.clock.now(), horizon = now + 140;
    if (!m.on) { m.next = -1; return; }
    let b = m.next >= 0 ? m.next : Math.ceil(this.tempo.beatAt(now + 30));
    for (;;) {
      const at = this.tempo.timeOf(b);
      if (at > horizon) break;
      if (at >= now) this.click(this.audioTime(at), b % 4 === 0);
      b++;
    }
    m.next = b;
  }
  click(t, accent) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(this.metro.level * (accent ? 0.35 : 0.22), t + 0.001); g.gain.setTargetAtTime(0, t + 0.001, 0.012);
    o.connect(g).connect(this.clickBus); o.start(t); o.stop(t + 0.1);
    o.onended = () => { o.disconnect(); g.disconnect(); };
  }

  // audio lane: a chunk of another jammer's audio, captured at room time `start`, to be heard `delay` ms later
  laneChunk(pid, start, delay, rate, samples) {
    const c = this.channel(pid), ctx = this.ctx;
    let t = this.audioTime(start + delay);
    if (c.laneNext && Math.abs(t - c.laneNext) < 0.006) t = c.laneNext; // keep chunks seamless
    if (t < ctx.currentTime) { c.laneLate++; c.laneNext = 0; return; }
    const buf = ctx.createBuffer(1, samples.length, rate);
    buf.getChannelData(0).set(samples);
    const s = ctx.createBufferSource(); s.buffer = buf; s.connect(c.lane); s.start(t);
    s.onended = () => s.disconnect();
    c.laneNext = t + samples.length / rate;
    c.laneT = performance.now();
  }
}
