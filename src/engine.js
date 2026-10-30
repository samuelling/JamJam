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

const FILTER_NAME = { ladder: 'ladder filter', ota: 'OTA filter', ssm: 'SSM-type filter', cem: 'Curtis-type filter', sem: 'two-pole SEM filter', diode: 'diode filter', ms20: 'MS-20-type filter', steiner: 'Steiner filter', svf: 'state-variable filter', arp: 'ARP-type filter', digital: 'digital filter' };
// an instrument without declared traits still gets ranked from what its family string says
function guessTraits(def) {
  const f = String(def.family || '').toLowerCase();
  if (def.drums || /drum|perc|kit/.test(f)) return { arch: ['drum'] };
  if (/fm|piano|tine|bell/.test(f)) return { arch: ['fm', 'ep'] };
  if (/mono|bass|lead/.test(f)) return { arch: ['subtractive'], voices: 1 };
  if (/poly|pad|string|analog|synth/.test(f)) return { arch: ['subtractive', 'digital'], voices: 8 };
  return null;
}

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
    this.silent = new URLSearchParams(location.search).get('silent') === '1';
    this.libs = new Map();      // library id -> {id, url, name, by, private, entries}
    this.catalog = new Map();   // "lib/inst" -> what the gear wall shows before the instrument loads
    this.loading = new Map();
  }

  async start() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.knee.value = 6; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.15;
    this.master.connect(comp).connect(ctx.destination);
    this.comp = comp;   // the metronome and the doorbell join after the master, so the tape (which records the master) leaves them out
    this.clickBus = ctx.createGain(); this.clickBus.connect(comp);
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
    // "No twin": a silent stand-in for a part that only plays on external MIDI gear
    this.defs.set('none', { id: 'none', name: 'No twin', family: 'MIDI only', internal: true, params: [], presets: { midi: {} }, hash: 'none',
      create: () => ({ noteOn() {}, noteOff() {}, set() {}, allOff() {}, dispose() {} }) });
    const hwText = await (await fetch(`${base}/instruments/hardware.json`, { cache: 'no-cache' })).text();
    this.hardware = JSON.parse(hwText);
    this.hashes.hardware = await sha(hwText);
  }

  // ---------- libraries: instruments from other places (another GitHub repo, a friend's build on their machine) ----------
  // A library is a folder with a megajam.json (or the older name, jamjam.json):
  //   { "megajam": 1, "id": "namespace", "name": "Shown name", "by": "who", "private": false,
  //     "instruments": [ { "id": "x", "file": "x.js", "name", "family", "blurb", "icon" (svg text), "drums", "arg" }, ... ] }
  // Each file is an ES module whose default export is an instrument (the same contract as instruments/), or a function
  // (arg, {base, ctx, sha}) returning one, so one bridge module can serve many instruments. Modules load only when
  // someone picks them. Instrument ids become "namespace/x". A library marked private never has its address shared:
  // the others load it from their own copy, or hear a stand-in.
  static resolveLibraryUrl(input) {
    let s = String(input || '').trim();
    let m = s.match(/^(?:github:|gh:)([\w.-]+)\/([\w.-]+)(?:@([\w./-]+?))?(\/.*)?$/);
    if (!m) { const g = s.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([\w.-]+))?(\/.*)?$/); if (g) m = [g[0], g[1], g[2], g[3], g[4]]; }
    if (m) s = `https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}${m[3] ? '@' + m[3] : ''}${m[4] || ''}`;
    s = s.replace(/(mega|jam)jam\.json$/, '');
    if (!/^https?:\/\//.test(s)) throw new Error('A library address starts with https://, http://localhost or github:owner/repo');
    return s.endsWith('/') ? s : s + '/';
  }
  async addLibrary(input) {
    const url = Engine.resolveLibraryUrl(input);
    for (const lib of this.libs.values()) if (lib.url === url) return lib;
    let r = await fetch(url + 'megajam.json', { cache: 'no-cache' });
    if (!r.ok) r = await fetch(url + 'jamjam.json', { cache: 'no-cache' });   // libraries made before the rename
    if (!r.ok) throw new Error(`No megajam.json at ${url} (${r.status})`);
    const man = await r.json();
    const id = String(man.id || '').replace(/[^\w.-]/g, '').slice(0, 40);
    if (!id || !Array.isArray(man.instruments)) throw new Error('That megajam.json needs an "id" and an "instruments" list');
    const lib = { id, url, name: man.name || id, by: man.by || '', private: !!man.private, entries: [] };
    for (const it of man.instruments) {
      if (!it || !it.id || !it.file) continue;
      const fullId = `${id}/${it.id}`;
      const meta = { id: fullId, lib: id, file: it.file, arg: it.arg, name: it.name || it.id, family: it.family || lib.name, blurb: it.blurb || '', icon: typeof it.icon === 'string' && it.icon.startsWith('<svg') ? it.icon : null, drums: !!it.drums, presets: it.presets || null };
      this.catalog.set(fullId, meta); lib.entries.push(fullId);
    }
    this.libs.set(id, lib);
    return lib;
  }
  removeLibrary(id) {
    const lib = this.libs.get(id); if (!lib) return;
    for (const k of lib.entries) this.catalog.delete(k);
    this.libs.delete(id);
  }
  // load one library instrument (once); resolves to its def
  ensureDef(fullId) {
    if (this.defs.has(fullId)) return Promise.resolve(this.defs.get(fullId));
    if (this.loading.has(fullId)) return this.loading.get(fullId);
    const meta = this.catalog.get(fullId);
    if (!meta) return Promise.reject(new Error(`${fullId} isn't in any library you've added`));
    const lib = this.libs.get(meta.lib);
    const job = (async () => {
      const src = await (await fetch(new URL(meta.file, lib.url).href, { cache: 'no-cache' })).text();
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      let mod;
      try { mod = await import(url); } finally { URL.revokeObjectURL(url); }
      let def = mod.default;
      if (typeof def === 'function') def = await def(meta.arg, { base: lib.url, ctx: this.ctx, sha });
      if (!def || typeof def.create !== 'function') throw new Error(`${meta.file} didn't give an instrument`);
      def = { ...def, id: fullId, lib: meta.lib, name: def.name || meta.name, family: def.family || meta.family, blurb: def.blurb || meta.blurb, icon: def.icon || meta.icon, drums: def.drums ?? meta.drums };
      def.hash = await sha(src + (def.contentHash || ''));
      if (!def.presets || !Object.keys(def.presets).length) def.presets = { init: {} };
      if (def.init) await def.init(this.ctx);
      this.defs.set(fullId, def);
      this.hashes[fullId] = def.hash;
      return def;
    })();
    this.loading.set(fullId, job);
    job.catch(() => this.loading.delete(fullId));
    return job;
  }
  // the built-in instrument closest to an instrument someone else is playing but this browser can't load
  standIn(meta = {}) {
    const f = `${meta.family || ''} ${meta.name || ''}`.toLowerCase();
    if (meta.drums || /drum|perc|kit|beat/.test(f)) return { inst: 'machina', patch: 'hybrid' };
    if (/mono|bass|acid|lead|303|ladder/.test(f)) return { inst: 'monolith', patch: /bass|acid|303/.test(f) ? 'bass' : 'lead' };
    if (/fm|operator|piano|rhodes|electric|bell|tine|keys|organ|tonewheel/.test(f)) return { inst: 'tine', patch: /bell/.test(f) ? 'bell' : 'keys' };
    if (/string|pad|ensemble|choir/.test(f)) return { inst: 'juniper', patch: 'strings' };
    return { inst: 'juniper', patch: 'keys' };
  }

  // A channel config: {inst, params, patch, hw}. Remote jammers only need inst + params to sound the same.
  // For a hardware unit with no instrument chosen, the best-ranked twin is used.
  resolve({ inst, patch, hw }) {
    const unit = hw ? this.unit(hw) : null;
    if (unit && !inst) inst = this.twinCandidates(unit)[0]?.inst;
    const def = this.defs.get(inst) || this.defs.values().next().value;
    let types = unit ? unit.types.filter((t) => def.presets[t]) : [];
    if (!types.length) types = Object.keys(def.presets);
    if (!patch || !def.presets[patch]) patch = types[0];
    const params = {};
    for (const p of def.params) params[p.id] = p.def;
    Object.assign(params, def.presets[patch] || {});
    if (unit) for (const [k, v] of Object.entries(unit.character || {})) if (k in params) params[k] = v;
    const out = { inst: def.id, patch, hw: unit ? unit.id : null, params };
    if (def.lib) {
      const lib = this.libs.get(def.lib);
      // what the others need to find it: the library, its public address (never for a private one), and enough
      // about it to pick a sensible stand-in
      out.lib = { id: def.lib, name: lib?.name || def.lib, url: lib && !lib.private ? lib.url : null };
      out.meta = { name: def.name, family: def.family, drums: !!def.drums };
    }
    return out;
  }
  unit(id) { return this.hardware.hardware.find((h) => h.id === id) || null; }
  patchTypes(cfg) {
    const def = this.defs.get(cfg.inst), unit = cfg.hw && this.unit(cfg.hw);
    const t = unit ? unit.types.filter((x) => def.presets[x]) : [];
    return t.length ? t : Object.keys(def.presets);
  }
  // ranked software twins for a hardware unit. The family's table gives the base score; circuit traits (oscillator,
  // filter, mono or poly) move it up or down, and any loaded instrument that declares traits (a library's, say)
  // can rank too. Each candidate says why, for the gear wall.
  twinCandidates(unit) {
    const fam = this.hardware.families[unit.family] || {};
    const ARCH = { 'analog-poly': 'subtractive', 'analog-mono': 'subtractive', 'bass-machine': 'subtractive', 'string-machine': 'strings', fm: 'fm', 'electric-piano': 'ep', 'digital-poly': 'digital', organ: 'organ', 'drum-machine': 'drum', groovebox: 'drum' };
    const arch = ARCH[unit.family], table = new Map((fam.twins || []).map(([i, sc]) => [i, sc]));
    const list = [];
    for (const def of this.defs.values()) {
      if (def.internal || def.standin) continue;
      const t = def.traits || this.hardware.traits?.[def.id] || guessTraits(def);
      if (!t) continue;
      const base = table.has(def.id) ? table.get(def.id) : (t.arch || []).includes(arch) ? 0.7 : null;
      if (base == null && unit.twin !== def.id) continue;
      let score = base ?? 0.5; const why = [];
      if (unit.osc && (t.osc || []).includes(unit.osc)) { score += 0.03; why.push(unit.osc.toUpperCase() + ' oscillators'); }
      if (unit.filter && unit.filter !== 'none' && (t.filter || []).includes(unit.filter)) { score += 0.05; why.push(FILTER_NAME[unit.filter] || unit.filter); }
      if (unit.voices && t.voices && arch !== 'drum') {
        if ((unit.voices === 1) === (t.voices === 1)) { score += 0.03; why.push(unit.voices === 1 ? 'mono' : 'polyphonic'); } else score -= 0.08;
      }
      if (unit.twin === def.id) { score = Math.max(score, 0.95); why.unshift(`set up as a ${unit.model}`); }
      if (def.lib && t.models && t.models.includes(unit.id)) { score = Math.max(score, 0.97); why.unshift(`modelled on the ${unit.model}`); }
      list.push({ inst: def.id, score: Math.min(0.99, score), why });
    }
    return list.sort((a, b) => b.score - a.score);
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
    // ?silent=1 (benchmarks): keep all timing and bookkeeping but skip synthesis
    const inst = this.silent ? { noteOn() {}, noteOff() {}, set() {}, allOff() {}, dispose() {} } : def.create(ctx, g, cfg.params, this.env());
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
  event(pid, ev, { now = false, loose = false } = {}) {
    const c = this.channel(pid);
    const I = c.insts[c.insts.length - 1];
    if (!I) return;
    const ctx = this.ctx;
    let t = now ? ctx.currentTime : this.audioTime(ev.at);
    let lateMs = 0;
    if (!now && t < ctx.currentTime) {
      lateMs = (ctx.currentTime - t) * 1000;
      if (lateMs > 3 && !loose) { c.late++; c.lateWorst = Math.max(c.lateWorst, lateMs); }
      t = ctx.currentTime;
    }
    c.events++;
    if (ev.type === 'on') {
      c.notes.push(ev.at); c.flashT = performance.now(); c.held.add(ev.note);
      if (c.notes.length > 6000) { const cut = c.notes.length - 3000; c.noteBase += cut; c.notes.splice(0, cut); }
      I.inst.noteOn(ev.note, ev.vel, t, ev.at);
    } else if (ev.type === 'off') { c.held.delete(ev.note); I.inst.noteOff(ev.note, t, ev.at); }
    else if (ev.type === 'p') {
      I.inst.set(ev.id, ev.v, t, ev.at);
      if (ev.id !== 'bend') {
        c.pLog.push({ at: ev.at, seq: ev.seq || 0, id: ev.id, v: ev.v });
        if (c.pLog.length > 3000) c.pLog.splice(0, 1000);
      }
    }
    this.log.push({ pid, type: ev.type, note: ev.note, id: ev.id, at: ev.at, ctxT: t, heard: this.roomTime(t), lateMs, now, b: ev.b });
    if (this.log.length > this.logMax) this.log.splice(0, this.log.length - this.logMax);
  }

  // A sequencer trig: apply its parameter locks at the trig's own sample, trigger, then put the settings back two
  // samples later, so the lock belongs to that one step (Machina reads a slot's settings at the moment of the hit).
  // what an instrument may ask of the room (4th argument to create): room time <-> this browser's audio time.
  // Each call also gets the event's room stamp (ms) after its audio time, identical in every browser, for anything
  // that must decide the same way everywhere (seeding, a performer model's timing).
  env() { return this._env || (this._env = { audioTime: (ms) => this.audioTime(ms), roomTime: (t) => this.roomTime(t) }); }
  seqTrig(k, note, vel, locks, at, base) {
    const c = this.ch.get(k);
    const I = c && c.insts[c.insts.length - 1];
    if (!I) return;
    const ctx = this.ctx;
    let t = this.audioTime(at), lateMs = 0;
    if (t < ctx.currentTime) { lateMs = (ctx.currentTime - t) * 1000; if (lateMs > 3) { c.late++; c.lateWorst = Math.max(c.lateWorst, lateMs); } t = ctx.currentTime; }
    if (locks) for (const [id, v] of Object.entries(locks)) I.inst.set(id, v, t);
    I.inst.noteOn(note, vel, t, at);
    if (locks) for (const id of Object.keys(locks)) if (base && id in base) I.inst.set(id, base[id], t + 2 / ctx.sampleRate);
    c.notes.push(at); c.flashT = performance.now(); c.events++;
    if (c.notes.length > 6000) { const cut = c.notes.length - 3000; c.noteBase += cut; c.notes.splice(0, cut); }
    this.log.push({ pid: k, type: 'seq', note, at, ctxT: t, heard: this.roomTime(t), lateMs, locks });
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

  // a doorbell (ding-dong, or a single ding for a bandmate walking in): also how you find out your sound is on
  chime(two = true) {
    const ctx = this.ctx; if (!ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime + 0.03, bus = ctx.createGain(); bus.gain.value = 0.16; bus.connect(this.comp || this.master);
    const tone = (f, t) => { for (const [m, a] of [[1, 1], [2.76, 0.35], [5.4, 0.12]]) { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = f * m;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(a, t + 0.004); g.gain.setTargetAtTime(0, t + 0.004, 0.35 / m); o.connect(g).connect(bus); o.start(t); o.stop(t + 2); } };
    tone(784, t0); if (two) tone(622, t0 + 0.38);
    setTimeout(() => bus.disconnect(), 3000);
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
