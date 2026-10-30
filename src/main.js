import { SharedClock, Tempo } from './clock.js';
import { Room } from './net.js';
import { Engine } from './engine.js';
import { Input, sendToHardware } from './input.js';
import { AudioLane, decodeChunk } from './lane.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, ''); else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c);
  return el;
};
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

const qs = new URLSearchParams(location.search);
const SERVER = qs.get('server') || window.MP_SERVER || 'wss://crush-commando-mp.samuelling.workers.dev';
const MAX = 4, MAX_RACK = 4;
const PLAYER_COLORS = ['#ff5a1f', '#2f80ff', '#1fc46e', '#e9e9e4'];
const KNOB_COLORS = ['#2f80ff', '#1fc46e', '#e9e9e4', '#ff5a1f'];
const RACK_COLORS = ['#ff5a1f', '#2f80ff', '#1fc46e', '#ffcf26'];
const PARAM_SEND_MS = 30;
const VERSION = '0.2';

const clock = new SharedClock();
const tempo = new Tempo(96);
const engine = new Engine(clock, tempo);
const S = {
  name: '', me: null,
  rack: [], sel: null, nextR: 1,          // your corner: [{r, cfg, budget, midiCh, midiOut, hwLatency, hearTwin}]
  hearSelf: false, quant: 0, lookAuto: 0, lookOverride: null,
  players: new Map(),                     // pid -> {name, rack:[{r, cfg, budget}], hashes, lane, peerL}
  vol: new Map(),                         // pid -> {vol, mute} in your mix
  sync: new Map(), stable: new Map(),     // fingerprints
  seq: 0, route: new Map(), pendingP: new Map(), lastPSend: new Map(),
  lockedAt: 0, slackRep: new Map(), needs: new Map(), loopActive: false,
  chat: [], unread: 0, knobGroup: null,
};
window.JJ = { clock, tempo, engine, S };
const key = (pid, r) => `${pid}:${r}`;
const pidOf = (k) => k.slice(0, k.indexOf(':'));
const entry = (r) => S.rack.find((e) => e.r === r);
const selEntry = () => entry(S.sel) || S.rack[0];

// ---------- the room ----------
const room = new Room({
  server: SERVER, maxPeers: MAX, p2p: qs.get('p2p') !== '0',
  handlers: {
    status(kind, text) { setStatus(text, kind); if (kind === 'in') onEntered(); },
    roster() { updateLeader(); renderCorners(); },
    peerOpen(p) { sayHello(p.id); },
    peerLeft(p) {
      addChat({ sys: true, text: `${S.players.get(p.id)?.name || p.name} left`, t: Date.now() });
      for (const k of [...engine.ch.keys()]) if (pidOf(k) === p.id) engine.removeChannel(k);
      S.players.delete(p.id); S.sync.delete(p.id); S.needs.delete(p.id); S.slackRep.delete(p.id);
      renderCorners();
    },
    message: onMessage,
    binary(p, buf) { const c = decodeChunk(buf); if (c && clock.locked) { engine.laneChunk(key(p.id, 'lane'), c.start, c.delay, c.rate, c.samples); applyVolume(key(p.id, 'lane')); } },
  },
});
window.JJ.room = room;
const lane = new AudioLane(engine, (buf) => room.sendBinary(buf));

function leaderId() {
  let best = { id: room.id, n: room.n };
  for (const p of room.peers.values()) if (p.n && p.n < best.n) best = { id: p.id, n: p.n };
  return best.id;
}
function updateLeader() {
  const was = clock.isLeader;
  clock.setLeader(leaderId() === room.id);
  if (clock.isLeader && !was) S.lockedAt = performance.now();
  if (!clock.isLeader) S.lockedAt = 0;
}

function onEntered() {
  if (!room.id || S.me) return;
  S.me = room.id;
  updateLeader();
  if (clock.isLeader) { tempo.start(clock.now(), 96); S.lockedAt = performance.now(); }
  for (const e of S.rack) { engine.setCfg(key(S.me, e.r), e.cfg, -Infinity); S.stable.set(key(S.me, e.r), performance.now()); applyVolume(key(S.me, e.r)); }
  showStudio();
}

const publicRack = () => S.rack.map((e) => ({ r: e.r, cfg: e.cfg, budget: budgetOf(e) }));
function sayHello(id) {
  room.send({ k: 'hello', v: VERSION, name: S.name, rack: publicRack(), hashes: engine.hashes, lane: { on: lane.on, bars: lane.bars }, L: lookahead() }, id);
  if (clock.isLeader) {
    room.send({ k: 'tempo', segs: tempo.toJSON() }, id);
    const items = S.chat.filter((c) => !c.sys).slice(-50).map(({ name, text, t, from }) => ({ name, text, t, from }));
    if (items.length) room.send({ k: 'chatlog', items }, id);
  }
  startPinging(id);
}

const pingTimers = new Map();
function startPinging(id) {
  clearTimeout(pingTimers.get(id));
  let n = 0;
  const go = () => {
    const p = room.peers.get(id);
    if (!p) return;
    room.sendFast({ k: 'ping', a: performance.now(), at: clock.locked && S.me ? clock.now() + lookahead() : null }, id);
    n++;
    pingTimers.set(id, setTimeout(go, p.path === 'relay' ? 3000 : n < 12 ? 250 : TUNE.ping));
  };
  go();
}

function remoteCfg(pid, r, cfg, at, budget) {
  const pl = S.players.get(pid); if (!pl) return;
  const k = key(pid, r);
  const known = pl.rack.find((x) => x.r === r);
  if (known) { known.cfg = cfg; if (budget) known.budget = budget; } else pl.rack.push({ r, cfg, budget });
  engine.setCfg(k, cfg, at);
  if (!S.stable.has(k)) S.stable.set(k, performance.now());
  applyVolume(k);
}

function onMessage(p, m) {
  switch (m.k) {
    case 'ping': room.sendFast({ k: 'pong', a: m.a, b: clock.now() }, p.id); if (m.at != null) noteSlack(p, m.at); break;
    case 'pong': {
      const c = performance.now(), rtt = c - m.a;
      p.rtt.push(rtt); if (p.rtt.length > 30) p.rtt.shift();
      if (p.id === leaderId() && !clock.isLeader) {
        const was = clock.locked;
        clock.sample(m.a, m.b, c);
        if (clock.locked && !was) { S.lockedAt = performance.now(); for (const k of S.stable.keys()) S.stable.set(k, S.lockedAt); }
      }
      break;
    }
    case 'slack': S.slackRep.set(p.id, { s: m.s, t: performance.now() }); break;
    case 'hello': {
      const first = !S.players.has(p.id);
      S.players.set(p.id, { ...(S.players.get(p.id) || {}), name: m.name, rack: [], hashes: m.hashes, lane: m.lane, peerL: m.L, v: m.v });
      for (const x of m.rack || []) remoteCfg(p.id, x.r, x.cfg, -Infinity, x.budget);
      if (first) addChat({ sys: true, text: `${m.name} walked in`, t: Date.now() });
      if ($('#status').dataset.kind !== 'error') setStatus('');
      renderCorners(); break;
    }
    case 'cfg': remoteCfg(p.id, m.r, m.cfg, clock.locked ? m.at : -Infinity, m.budget); renderCorners(); break;
    case 'unrack': {
      const pl = S.players.get(p.id); if (pl) pl.rack = pl.rack.filter((x) => x.r !== m.r);
      const k = key(p.id, m.r);
      setTimeout(() => engine.removeChannel(k), Math.max(0, (m.at || 0) - clock.now()));
      renderCorners(); break;
    }
    case 'ev': if (m.ev) receiveEvent(p, m.r, m.ev); break;
    case 'evs': if (Array.isArray(m.items)) for (const it of [...m.items].sort((a, b) => (a.ev?.seq || 0) - (b.ev?.seq || 0))) if (it && it.ev) receiveEvent(p, it.r, it.ev); break;
    case 'tempo': if (p.id === leaderId()) { tempo.load(m.segs); engine.metro.next = -1; renderTempo(); } break;
    case 'tempoReq': if (clock.isLeader) setTempo(m.bpm); break;
    case 'lane': { const pl = S.players.get(p.id); if (pl) pl.lane = m.lane; renderCorners(); break; }
    case 'look': { const pl = S.players.get(p.id); if (pl) { pl.peerL = m.L; if (m.budgets) for (const x of pl.rack) if (m.budgets[x.r]) x.budget = m.budgets[x.r]; } break; }
    case 'fp': checkFingerprint(p.id, m); break;
    case 'chat': addChat({ from: p.id, name: S.players.get(p.id)?.name || p.name, text: String(m.text || '').slice(0, 500), t: Date.now() }); break;
    case 'chatlog': if (!S.chat.some((c) => !c.sys) && Array.isArray(m.items)) for (const it of m.items.slice(-50)) addChat({ ...it, text: String(it.text || '').slice(0, 500), old: true }, false); break;
  }
}

// ---------- the lookahead: how far ahead every note is scheduled ----------
// It has to cover the trip to the farthest jammer, the jitter on that link, the clock error between you, and that
// jammer's audio output latency (Bluetooth headphones can add 150 ms or more). Rather than guess, every listener
// measures the spare time it actually has when your notes and pings arrive and reports the worst of each half-second.
// Each report becomes an absolute "lookahead this listener needs"; your lookahead follows the worst need over the
// last few reports, rising at once and settling gently. (Tuned with tests/bench.cjs; see the README.)
const TUNE = {
  tm: +(qs.get('tm') ?? 8),           // ms of spare time we want every listener to have
  settle: +(qs.get('settle') ?? 0.2), // fraction of the surplus given back per report
  rise: +(qs.get('rise') ?? 2),       // extra ms on top of a shortfall
  rep: +(qs.get('rep') ?? 500),       // how often listeners report their margin (ms)
  ping: +(qs.get('ping') ?? 1000),    // steady ping interval on direct links (ms)
  mem: +(qs.get('mem') ?? 12),        // how many reports per listener the lookahead remembers
};
function pct(a, q) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }
function noteSlack(p, at) {
  if (!clock.locked || !engine.ctx || at == null) return;
  (p.slack = p.slack || []).push((engine.audioTime(at) - engine.ctx.currentTime) * 1000);
  if (p.slack.length > 80) p.slack.shift();
}
function reportSlack() {
  for (const p of room.peers.values()) {
    if (!p.slack || p.slack.length < 2) continue;
    room.send({ k: 'slack', s: Math.round(Math.min(...p.slack) * 10) / 10 }, p.id);
    p.slack = [];
  }
}
function computeAutoL() {
  if (!room.peers.size) { S.lookAuto = 0; return 0; }
  let est = 0;
  for (const p of room.peers.values()) est = Math.max(est, p.rtt.length >= 3 ? pct(p.rtt, 0.9) / 2 + 50 : 150);
  if (!S.loopActive) S.lookAuto = Math.max(S.lookAuto, est);
  return S.lookAuto;
}
function adjustL() {
  const now = performance.now();
  for (const [id, r] of S.slackRep) {
    if (!room.peers.has(id)) { S.slackRep.delete(id); S.needs.delete(id); continue; }
    if (r.used) continue;
    r.used = true;
    const hist = S.needs.get(id) || [];
    hist.push({ need: S.lookAuto - r.s + TUNE.tm, t: now });
    while (hist.length > TUNE.mem) hist.shift();
    S.needs.set(id, hist);
  }
  let target = 0, any = false;
  for (const [id, hist] of S.needs) {
    const recent = hist.filter((x) => now - x.t < TUNE.rep * (TUNE.mem + 2));
    if (!recent.length || !room.peers.has(id)) continue;
    any = true; target = Math.max(target, ...recent.map((x) => x.need));
  }
  if (!any) return;
  S.loopActive = true;
  S.lookAuto = target > S.lookAuto ? target + TUNE.rise : S.lookAuto + (target - S.lookAuto) * TUNE.settle;
  S.lookAuto = Math.min(900, Math.max(5, S.lookAuto));
}
setInterval(() => { reportSlack(); adjustL(); }, TUNE.rep);
const lookahead = () => (S.lookOverride != null ? S.lookOverride : Math.round(S.lookAuto));

// ---------- a latency budget per part ----------
const BUDGETS = {
  tight: { label: 'Tight', short: 't', L: (L) => L + 10, help: 'Never late: the safe lookahead plus 10 ms. For drums, bass and plucks.' },
  balanced: { label: 'Balanced', short: 'b', L: (L) => L, help: 'The measured safe lookahead.' },
  loose: { label: 'Loose', short: 'l', L: (L) => Math.round(L * 0.4), help: 'About 40% of the lookahead, and you hear it instantly. A far listener may get a note a touch late; it plays on arrival, hidden by the slow attack.' },
};
function autoBudget(cfg) {
  if (!cfg) return 'balanced';
  const def = engine.defs.get(cfg.inst);
  if (def && def.drums) return 'tight';
  const p = cfg.params || {};
  if (['pad', 'strings'].includes(cfg.patch) || (p.attack != null && p.attack > 0.08)) return 'loose';
  if (['bass', 'pluck', 'acid'].includes(cfg.patch) || (p.mono >= 0.5 && (p.attack ?? 0) < 0.02)) return 'tight';
  return 'balanced';
}
const budgetOf = (e) => (e.budget === 'auto' ? autoBudget(e.cfg) : e.budget);
const partLook = (e) => (room.peers.size ? BUDGETS[budgetOf(e)].L(lookahead()) : 0);
const selfInstant = (e) => S.hearSelf || budgetOf(e) === 'loose';

// ---------- playing ----------
// Notes go out twice: on the fast channel, carrying the previous two events too (so one lost packet is recovered by
// the next, with no retransmission wait), and on the reliable channel as a backup. Receivers drop duplicates by seq.
const recentEv = [];
const REPEAT_MS = +(qs.get('repeat') ?? 20);
let repeatGen = 0;
function sendEvent(e, ev, instant) {
  const k = key(S.me, e.r);
  engine.event(k, ev, { now: instant || room.peers.size === 0 || !clock.locked });
  if (!clock.locked) return;
  recentEv.push({ r: e.r, ev }); if (recentEv.length > 3) recentEv.shift();
  room.sendFast({ k: 'evs', items: recentEv });
  // one quick repeat, so a lost packet in a sparse passage is recovered within ~20 ms rather than at the next note
  const gen = ++repeatGen;
  setTimeout(() => { if (gen === repeatGen) room.sendFast({ k: 'evs', items: recentEv }); }, REPEAT_MS);
  // the reliable backup only goes where the fast channel exists (a relayed pair already got the one copy)
  for (const p of room.peers.values()) if (p.fast && p.fast.readyState === 'open') room.send({ k: 'ev', r: e.r, ev }, p.id);
}
function receiveEvent(p, r, ev) {
  p.seen = p.seen || new Set();
  if (ev.seq != null) {
    if (p.seen.has(ev.seq)) return;
    p.seen.add(ev.seq);
    if (p.seen.size > 3000) { const it = p.seen.values(); for (let i = 0; i < 1000; i++) p.seen.delete(it.next().value); }
  }
  if (!S.players.get(p.id)) return;
  const k = key(p.id, r);
  if (!engine.ch.get(k)?.insts.length) return;
  const loose = ev.b === 'l';
  if (!loose) noteSlack(p, ev.at - (ev.o || 0));
  engine.event(k, ev, { now: !clock.locked, loose });
  if (ev.type === 'p' && ev.id !== 'bend') { const x = S.players.get(p.id).rack.find((y) => y.r === r); if (x) x.cfg.params[ev.id] = ev.v; }
}
function targetsFor(ch) {
  if (ch === 0) return [selEntry()].filter(Boolean);
  const t = S.rack.filter((e) => e.midiCh === ch || e.midiCh === 0);
  return t.length ? t : [selEntry()].filter(Boolean);
}
function playNote(on, note, vel, ch = 0) {
  if (!S.me) return;
  const rk = ch * 128 + note;
  const targets = on ? targetsFor(ch) : (S.route.get(rk) || []).map(entry).filter(Boolean);
  if (on) S.route.set(rk, targets.map((e) => e.r)); else S.route.delete(rk);
  const now = clock.now();
  for (const e of targets) {
    const L = partLook(e);
    let at = now + L, shift = 0;
    e.shifts = e.shifts || new Map(); e.onAt = e.onAt || new Map();
    if (on) {
      if (S.quant && room.peers.size) { const qa = tempo.nextGrid(at, S.quant); shift = qa - at; at = qa; }
      e.shifts.set(note, shift); e.onAt.set(note, at);
    } else {
      shift = e.shifts.get(note) || 0; at += shift; e.shifts.delete(note);
      const onAt = e.onAt.get(note); if (onAt != null && at <= onAt) at = onAt + 5;
    }
    const instant = selfInstant(e) && !shift;
    sendEvent(e, { type: on ? 'on' : 'off', note, vel, at, seq: ++S.seq, b: BUDGETS[budgetOf(e)].short, o: (L - lookahead()) + shift }, instant);
    const port = e.cfg.hw && e.midiOut ? input.outputs.find((o) => o.id === e.midiOut) : null;
    if (port) sendToHardware(port, on ? [0x90, note, vel] : [0x80, note, 0], instant ? performance.now() : clock.toLocal(at) - (e.hwLatency || 0));
  }
  if (ch === 0) flashKey(note, on);
}

function setParam(e, id, v) {
  if (!e) return;
  e.cfg.params[id] = v;
  const k = e.r + '|' + id;
  S.pendingP.set(k, { e, id, v });
  const last = S.lastPSend.get(k) || 0, wait = PARAM_SEND_MS - (performance.now() - last);
  if (wait <= 0) flushParam(k);
  else if (!S.pTimer) S.pTimer = setTimeout(() => { S.pTimer = null; for (const kk of [...S.pendingP.keys()]) flushParam(kk); }, wait);
}
function flushParam(k) {
  const x = S.pendingP.get(k); if (!x || !S.me) return;
  S.pendingP.delete(k); S.lastPSend.set(k, performance.now());
  const L = partLook(x.e);
  sendEvent(x.e, { type: 'p', id: x.id, v: x.v, at: clock.now() + L, seq: ++S.seq, b: BUDGETS[budgetOf(x.e)].short, o: L - lookahead() }, selfInstant(x.e));
}

// add, change or remove an instrument in your corner
function publishEntry(e) {
  if (!S.me) return;
  const at = clock.now() + (room.peers.size ? lookahead() + 20 : 0);
  engine.setCfg(key(S.me, e.r), e.cfg, at);
  if (!S.stable.has(key(S.me, e.r))) S.stable.set(key(S.me, e.r), performance.now());
  room.send({ k: 'cfg', r: e.r, cfg: e.cfg, at, budget: budgetOf(e) });
  applyVolume(key(S.me, e.r));
}
function addEntry({ inst, patch, hw }) {
  if (S.rack.length >= MAX_RACK) { setStatus(`A corner holds up to ${MAX_RACK} instruments.`, 'error'); return null; }
  const cfg = engine.resolve({ inst, patch, hw });
  const def = engine.defs.get(cfg.inst);
  const usedCh = new Set(S.rack.map((e) => e.midiCh));
  const midiCh = def.drums ? 10 : !usedCh.has(0) ? 0 : [1, 2, 3, 4, 5, 6].find((c) => !usedCh.has(c)) || 0;
  const e = { r: S.nextR++, cfg, budget: 'auto', midiCh, midiOut: '', hwLatency: 0, hearTwin: false };
  S.rack.push(e); S.sel = e.r; S.knobGroup = null;
  publishEntry(e);
  renderRack(); renderDevice(); renderCorners(); renderKeyboard();
  return e;
}
function changeEntry(e, next) {
  e.cfg = engine.resolve({ inst: next.inst ?? e.cfg.inst, patch: next.patch, hw: next.hw === undefined ? e.cfg.hw : next.hw });
  publishEntry(e);
  renderRack(); renderDevice(); renderCorners(); renderKeyboard();
}
function removeEntry(e) {
  if (S.rack.length <= 1) { setStatus('Keep at least one instrument in your corner.', 'error'); return; }
  S.rack = S.rack.filter((x) => x !== e);
  const k = key(S.me, e.r), at = clock.now() + lookahead() + 20;
  room.send({ k: 'unrack', r: e.r, at });
  setTimeout(() => engine.removeChannel(k), Math.max(0, at - clock.now()));
  S.sel = S.rack[0].r;
  renderRack(); renderDevice(); renderCorners(); renderKeyboard();
}

function setTempo(bpm) {
  bpm = Math.max(40, Math.min(240, Math.round(bpm)));
  if (!clock.isLeader) { room.send({ k: 'tempoReq', bpm }, leaderId()); return; }
  tempo.change(clock.now() + Math.max(250, lookahead() * 2 + 100), bpm);
  room.send({ k: 'tempo', segs: tempo.toJSON() });
  engine.metro.next = -1;
  renderTempo();
}

// ---------- fingerprints: proof that every browser is making the same music ----------
function fpTime() { return Math.floor((clock.now() - Math.max(1500, lookahead() + 900)) / 500) * 500; }
function stableKeys() {
  const now = performance.now(), out = [];
  if (!clock.locked) return out;
  for (const [k, t] of S.stable) if (engine.ch.has(k) && now - Math.max(t, S.lockedAt) > 6000) out.push(k);
  return out;
}
function countNotes(k, a, b) { const c = engine.ch.get(k); if (!c) return 0; let n = 0; for (const t of c.notes) if (t > a && t <= b) n++; return n; }
function fingerprintAt(T) {
  const full = engine.fingerprint(T), out = {};
  for (const k of stableKeys()) if (full[k]) out[k] = full[k] + ':' + countNotes(k, T - 4000, T);
  return out;
}
function sendFingerprint() {
  if (!S.me || !room.peers.size || !clock.locked) return;
  const T = fpTime();
  room.send({ k: 'fp', T, f: fingerprintAt(T) });
}
function checkFingerprint(from, m) {
  if (!clock.locked) return;
  const mine = fingerprintAt(m.T), bad = [];
  let compared = 0;
  for (const [k, hsh] of Object.entries(m.f || {})) { if (!mine[k]) continue; compared++; if (mine[k] !== hsh) bad.push(k); }
  if (compared) S.sync.set(from, { ok: bad.length === 0, at: performance.now(), bad });
}
setInterval(sendFingerprint, 2000);

// ---------- input ----------
const input = new Input({
  note: (on, note, vel, ch) => playNote(on, note, vel, ch),
  cc: (cc, val, ch) => {
    for (const e of targetsFor(ch)) {
      const def = engine.defs.get(e.cfg.inst), unit = e.cfg.hw && engine.unit(e.cfg.hw);
      let pid = null;
      if (unit && unit.cc) for (const [k, n] of Object.entries(unit.cc)) if (n === cc) pid = k;
      if (!pid) pid = def.params.find((p) => p.cc === cc)?.id;
      const P = pid && def.params.find((p) => p.id === pid);
      if (!P) continue;
      setParam(e, pid, fromUnit(P, val / 127));
      if (e === selEntry()) knobSet(pid);
    }
  },
  bend: (semi, ch) => { for (const e of targetsFor(ch)) { const L = partLook(e); sendEvent(e, { type: 'p', id: 'bend', v: semi, at: clock.now() + L, seq: ++S.seq, b: BUDGETS[budgetOf(e)].short, o: L - lookahead() }, selfInstant(e)); } },
  status: (msg) => renderInputStatus(msg),
});
window.JJ.input = input;

const toUnit = (P, v) => P.curve === 'exp' ? Math.log(v / P.min) / Math.log(P.max / P.min) : (v - P.min) / (P.max - P.min);
const fromUnit = (P, u) => {
  u = Math.max(0, Math.min(1, u));
  let v = P.curve === 'exp' ? P.min * Math.pow(P.max / P.min, u) : P.min + u * (P.max - P.min);
  if (P.step) v = Math.round(v / P.step) * P.step;
  return Math.max(P.min, Math.min(P.max, v));
};
const fmt = (P, v) => {
  if (P.unit === 'Hz') return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + 'k' : Math.round(v) + ' Hz';
  if (P.unit === 's') return v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(2) + ' s';
  if (P.unit === '×') return v.toFixed(2) + '×';
  if (P.unit === 'st') return (v > 0 ? '+' : '') + (Math.abs(v) < 10 ? v.toFixed(2) : Math.round(v)) + ' st';
  if (P.id.endsWith('pan')) return Math.abs(v) < 0.02 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100);
  if (P.unit) return (Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + P.unit;
  return P.max <= 1 && P.min >= 0 ? String(Math.round(v * 100)) : (Math.abs(v) < 10 ? v.toFixed(1) : String(Math.round(v)));
};

// ---------- UI: status, studio ----------
function setStatus(text, kind = '') { const el = $('#status'); el.textContent = text || ''; el.dataset.kind = kind; if (kind === 'error') setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 5000); }

function showStudio() {
  $('#lobby').classList.add('hide'); $('#studio').classList.remove('hide'); $('#leaveBtn').classList.remove('hide');
  $('#roomCode').textContent = room.code;
  history.replaceState(null, '', `${location.pathname}?room=${room.code}${qs.get('server') ? '&server=' + encodeURIComponent(qs.get('server')) : ''}${qs.get('p2p') === '0' ? '&p2p=0' : ''}`);
  renderRack(); renderDevice(); renderCorners(); renderTempo(); renderKeyboard(); renderInputStatus();
}

const slotOf = (pid) => {
  const all = [{ id: room.id, n: room.n }, ...[...room.peers.values()].map((p) => ({ id: p.id, n: p.n }))].sort((a, b) => a.n - b.n);
  return Math.max(0, all.findIndex((x) => x.id === pid)) % MAX;
};
const colorOf = (pid) => PLAYER_COLORS[slotOf(pid)];

function describe(cfg, short = false) {
  if (!cfg) return '…';
  const def = engine.defs.get(cfg.inst), unit = cfg.hw && engine.unit(cfg.hw);
  if (unit) return short ? unit.model : `${unit.maker} ${unit.model} → ${def ? def.name : cfg.inst}`;
  return `${def ? def.name : cfg.inst} · ${cap(cfg.patch)}`;
}

// --- the band: one corner per jammer
function renderCorners() {
  const box = $('#corners'); if (!box || $('#studio').classList.contains('hide')) return;
  const ids = [S.me, ...room.peers.keys()].filter(Boolean).sort((a, b) => slotOf(a) - slotOf(b));
  const rackOf = (id) => (id === S.me ? publicRack() : S.players.get(id)?.rack || []);
  const sig = ids.join(',') + '|' + ids.map((id) => rackOf(id).map((x) => x.r + describe(x.cfg)).join(';')).join('|') + '|' + ids.map((id) => S.players.get(id)?.name || '').join(',');
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.replaceChildren(...ids.map((id) => cornerCard(id, rackOf(id))));
    for (let i = ids.length; i < MAX; i++) box.append(h('div', { class: 'corner empty' }, h('div', { class: 'legend' }, 'Empty corner'), h('div', { class: 'help' }, 'Copy the invite to bring someone in')));
  }
  updateCorners();
}
function cornerCard(id, rack) {
  const pl = S.players.get(id) || {}, mine = id === S.me, peer = room.peers.get(id), c = colorOf(id);
  const v = S.vol.get(id) || { vol: 1, mute: false };
  const vol = h('input', { type: 'range', min: 0, max: 1.5, step: 0.01, value: v.vol, 'aria-label': 'Volume in your mix', oninput: (e) => { S.vol.set(id, { ...(S.vol.get(id) || { mute: false }), vol: +e.target.value }); applyPlayerVolume(id); } });
  const mute = h('button', { class: 'btn small' + (v.mute ? ' on' : ''), title: 'Mute in your mix', onclick: (e) => { const x = S.vol.get(id) || { vol: 1, mute: false }; x.mute = !x.mute; S.vol.set(id, x); applyPlayerVolume(id); e.target.classList.toggle('on', x.mute); } }, 'M');
  return h('div', { class: 'corner' + (mine ? ' me' : ''), style: `--c:${c}` },
    h('div', { class: 'chead' }, h('div', { class: 'cname' }, (mine ? S.name : pl.name || peer?.name || 'Jammer') + (mine ? ' · you' : '')), h('span', { class: 'tag', 'data-path': id })),
    h('div', { class: 'gear' }, ...rack.map((x) => h('div', {}, h('span', { class: 'led', 'data-led': key(id, x.r), style: `--c:${c}` }), h('span', {}, describe(x.cfg)), h('em', { 'data-budget': key(id, x.r) }, '')))),
    h('div', { class: 'cstats', 'data-stats': id }),
    h('div', { class: 'cfoot' }, vol, mute, h('div', { class: 'lanem', 'data-lane': id, title: 'Audio lane' }, h('i'))),
  );
}
function updateCorners() {
  const now = performance.now();
  for (const id of [S.me, ...room.peers.keys()]) {
    if (!id) continue;
    const peer = room.peers.get(id), pl = S.players.get(id) || {};
    const tag = $(`[data-path="${id}"]`);
    if (tag) {
      if (id === S.me) { tag.textContent = clock.isLeader ? 'clock leader' : clock.locked ? 'clock synced' : 'syncing…'; tag.dataset.kind = clock.locked ? 'ok' : 'wait'; }
      else if (peer) {
        const rtt = peer.rtt.length ? Math.round(pct(peer.rtt, 0.5)) : null;
        tag.textContent = peer.path === 'direct' ? `direct ${rtt ?? '…'} ms` : peer.path === 'relay' ? `relay ${rtt ?? '…'} ms` : 'connecting…';
        tag.dataset.kind = peer.path === 'direct' ? 'ok' : peer.path === 'relay' ? 'warn' : 'wait';
      }
    }
    const rack = id === S.me ? S.rack : pl.rack || [];
    for (const x of rack) {
      const k = key(id, x.r), c = engine.ch.get(k);
      for (const led of $$(`[data-led="${k}"]`)) if (c) led.classList.toggle('lit', now - c.flashT < 120 || c.held.size > 0);
      const b = $(`[data-budget="${k}"]`);
      if (b) { const bb = id === S.me ? budgetOf(x) : x.budget; b.textContent = room.peers.size && bb ? `${bb} ${id === S.me ? partLook(x) : Math.round(BUDGETS[bb].L(pl.peerL ?? 0))}ms` : ''; }
    }
    const st = $(`[data-stats="${id}"]`);
    if (st) {
      const bits = [];
      if (id !== S.me) {
        const sy = S.sync.get(id);
        bits.push(sy && now - sy.at < 8000 ? (sy.ok ? '✓ same music' : '⚠ out of sync') : 'checking sync…');
        const mism = pl.hashes && Object.entries(engine.hashes).filter(([k, v]) => pl.hashes[k] && pl.hashes[k] !== v).map(([k]) => k);
        if (mism && mism.length) bits.push(`⚠ different ${mism.join(', ')}: reload`);
        let late = 0; for (const x of rack) late += engine.ch.get(key(id, x.r))?.late || 0;
        if (late) bits.push(`${late} late`);
        if (pl.lane?.on) bits.push(`lane +${pl.lane.bars} bar${pl.lane.bars > 1 ? 's' : ''}`);
      } else if (lane.on) bits.push(`your lane +${lane.bars} bar${lane.bars > 1 ? 's' : ''}`);
      st.textContent = bits.join(' · ');
    }
    const lm = $(`[data-lane="${id}"] i`);
    if (lm) {
      const lc = engine.ch.get(key(id, 'lane'));
      const active = id === S.me ? lane.on : lc && now - lc.laneT < 300;
      lm.parentElement.classList.toggle('active', !!active);
      lm.style.width = (id === S.me ? Math.min(1, lane.level * 1.5) : active ? 0.7 : 0) * 100 + '%';
    }
  }
}

// --- your rack
function renderRack() {
  const box = $('#rackList'); if (!box) return;
  box.replaceChildren(...S.rack.map((e, i) => {
    const def = engine.defs.get(e.cfg.inst), unit = e.cfg.hw && engine.unit(e.cfg.hw);
    return h('button', { class: 'cart' + (e.r === (selEntry() || {}).r ? ' sel' : ''), style: `--k:${RACK_COLORS[i % 4]}`, onclick: () => { S.sel = e.r; S.knobGroup = null; renderRack(); renderDevice(); renderKeyboard(); } },
      h('span', { class: 'stripe' }),
      h('span', {}, h('b', {}, unit ? unit.model : def.name), h('small', {}, `${unit ? 'twin ' + def.name + ' · ' : ''}${e.cfg.patch} · ${e.midiCh ? 'ch ' + e.midiCh : 'any ch'}`)),
      h('span', { class: 'led', 'data-led': key(S.me, e.r), style: `--c:${RACK_COLORS[i % 4]}` }));
  }));
}

// --- the device faceplate for the selected instrument
let knobEls = new Map();
function renderDevice() {
  const e = selEntry(); if (!e) return;
  const def = engine.defs.get(e.cfg.inst), unit = e.cfg.hw && engine.unit(e.cfg.hw);
  $('#devName').textContent = unit ? unit.model : def.name;
  $('#devFam').textContent = unit ? `${unit.maker} · heard as ${def.name}` : def.family;
  const sel = (label, options, value, onchange) => h('div', {}, h('label', {}, label),
    h('select', { 'aria-label': label, onchange: (ev) => onchange(ev.target.value) }, ...options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t))));
  const fields = [];
  if (unit) fields.push(sel('Twin', engine.twinCandidates(unit).map((c) => [c.inst, `${engine.defs.get(c.inst).name} ${Math.round(c.score * 100)}%`]), e.cfg.inst, (v) => changeEntry(e, { inst: v })));
  else fields.push(sel('Instrument', [...engine.defs.values()].map((d) => [d.id, d.name]), e.cfg.inst, (v) => changeEntry(e, { inst: v, patch: null })));
  fields.push(sel('Patch', engine.patchTypes(e.cfg).map((t) => [t, cap(t)]), e.cfg.patch, (v) => changeEntry(e, { patch: v })));
  fields.push(sel('Timing', [['auto', `Auto · ${BUDGETS[autoBudget(e.cfg)].label}`], ...Object.entries(BUDGETS).map(([k, b]) => [k, b.label])], e.budget, (v) => { e.budget = v; broadcastLook(true); renderDevice(); renderRack(); }));
  fields.push(sel('MIDI in', [[0, 'Any channel'], ...Array.from({ length: 16 }, (_, i) => [i + 1, `Channel ${i + 1}`])], e.midiCh, (v) => { e.midiCh = +v; renderRack(); }));
  if (unit) {
    fields.push(sel('Plays my synth via', [['', input.outputs.length ? 'None (I play it)' : 'None · enable MIDI'], ...input.outputs.map((o) => [o.id, o.name])], e.midiOut, (v) => { e.midiOut = v; renderDevice(); }));
    fields.push(h('div', { class: 'wide' }, `The band hears ${def.name} as your ${unit.model}${unit.note ? ' (' + unit.note.replace(/\.$/, '') + ')' : ''}. Shape the knobs until it sounds like your patch. Pick a MIDI output (with Local Control off) and JamJam plays your synth in lockstep too.`));
  } else fields.push(h('div', { class: 'wide' }, def.blurb || ''));
  $('#devScreen').replaceChildren(...fields);
  const groups = [...new Set(def.params.map((P) => P.group || 'Sound'))];
  if (!groups.includes(S.knobGroup)) S.knobGroup = groups[0];
  $('#devPages').replaceChildren(...(groups.length > 1 ? groups.map((g) => h('button', { class: 'page' + (g === S.knobGroup ? ' on' : ''), onclick: () => { S.knobGroup = g; renderDevice(); } }, g)) : []));
  knobEls = new Map();
  $('#devKnobs').replaceChildren(...def.params.filter((P) => (P.group || 'Sound') === S.knobGroup).map((P, i) => paramControl(e, def, P, KNOB_COLORS[i % 4])));
  const foot = [h('span', { class: 'help' }, BUDGETS[budgetOf(e)].help), h('button', { class: 'btn small', onclick: () => audition(e.cfg) }, 'Audition')];
  if (unit) {
    foot.push(h('button', { class: 'btn small' + (e.hearTwin ? ' on' : ''), title: 'Also hear the twin yourself, to compare with your hardware', onclick: () => { e.hearTwin = !e.hearTwin; applyVolume(key(S.me, e.r)); renderDevice(); } }, 'Hear twin'));
    if (e.midiOut) {
      const out = h('span', {}, ` ${e.hwLatency} ms`);
      foot.push(h('label', { class: 'help' }, 'Synth latency ', h('input', { type: 'range', min: 0, max: 40, value: e.hwLatency, style: 'width:80px', oninput: (ev) => { e.hwLatency = +ev.target.value; out.textContent = ` ${e.hwLatency} ms`; } }), out));
    }
  }
  foot.push(h('button', { class: 'btn small ghost', onclick: () => removeEntry(e) }, 'Remove'));
  $('#devFoot').replaceChildren(...foot);
}
function paramControl(e, def, P, color) {
  const cur = () => e.cfg.params[P.id] ?? P.def;
  if (P.options) {
    const lcd = h('div', { class: 'lcd', title: 'Click or scroll to change' });
    const show = () => { lcd.textContent = P.options[Math.round(cur()) - P.min] ?? '?'; };
    const step = (d) => { const n = P.options.length; const i = ((Math.round(cur()) - P.min + d) % n + n) % n; setParam(e, P.id, P.min + i); show(); };
    lcd.addEventListener('click', () => step(1));
    lcd.addEventListener('wheel', (ev) => { ev.preventDefault(); step(ev.deltaY > 0 ? -1 : 1); }, { passive: false });
    show();
    knobEls.set(P.id, { show });
    return h('div', { class: 'encw' }, h('div', { class: 'stepper' }, h('button', { 'aria-label': `Previous ${P.name}`, onclick: () => step(-1) }, '◀'), lcd, h('button', { 'aria-label': `Next ${P.name}`, onclick: () => step(1) }, '▶')), h('div', { class: 'encname' }, P.name));
  }
  const enc = h('div', { class: 'enc', tabindex: 0, role: 'slider', 'aria-label': P.name, 'aria-valuemin': 0, 'aria-valuemax': 100, style: `--c:${color}`, title: (P.cc ? `MIDI CC ${P.cc} · ` : '') + 'drag, scroll or arrow keys · double-click resets' }, h('div', { class: 'cap' }));
  const val = h('div', { class: 'encval' });
  let u = toUnit(P, cur());
  const draw = () => { enc.style.setProperty('--u', u); const v = fromUnit(P, u); val.textContent = fmt(P, v); enc.setAttribute('aria-valuenow', Math.round(u * 100)); enc.setAttribute('aria-valuetext', fmt(P, v)); };
  const move = (nu) => { nu = Math.max(0, Math.min(1, nu)); if (P.step) nu = toUnit(P, fromUnit(P, nu)); if (nu === u) return; u = nu; setParam(e, P.id, fromUnit(P, u)); draw(); };
  let drag = null;
  enc.addEventListener('pointerdown', (ev) => { ev.preventDefault(); enc.setPointerCapture(ev.pointerId); enc.focus(); drag = { y: ev.clientY, u }; });
  enc.addEventListener('pointermove', (ev) => { if (drag) move(drag.u + (drag.y - ev.clientY) / (ev.shiftKey ? 800 : 180)); });
  const end = () => { drag = null; };
  enc.addEventListener('pointerup', end); enc.addEventListener('pointercancel', end);
  enc.addEventListener('wheel', (ev) => { ev.preventDefault(); move(u - ev.deltaY / (ev.shiftKey ? 4000 : 1200)); }, { passive: false });
  enc.addEventListener('keydown', (ev) => {
    const d = P.step ? P.step / (P.max - P.min) : ev.shiftKey ? 0.1 : 0.01;
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowRight') { ev.preventDefault(); ev.stopPropagation(); move(u + d); }
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowLeft') { ev.preventDefault(); ev.stopPropagation(); move(u - d); }
  });
  enc.addEventListener('dblclick', () => { setParam(e, P.id, def.presets[e.cfg.patch]?.[P.id] ?? P.def); u = toUnit(P, cur()); draw(); });
  draw();
  knobEls.set(P.id, { show: () => { u = toUnit(P, cur()); draw(); } });
  return h('div', { class: 'encw' }, enc, val, h('div', { class: 'encname' }, P.name));
}
function knobSet(id) { knobEls.get(id)?.show(); }

// --- audition: a short local phrase through an instrument (only you hear it)
function audition(cfg) {
  if (!engine.ctx) return;
  const k = 'audition:' + Date.now();
  engine.setCfg(k, JSON.parse(JSON.stringify(cfg)), -Infinity);
  const def = engine.defs.get(cfg.inst), t0 = clock.now() + 60, beat = 60000 / 110;
  const phrase = def.drums
    ? [[36, 0, 1], [42, 0.5, 1], [38, 1, 1], [42, 1.5, 1], [36, 2, 1], [36, 2.5, 1], [38, 3, 1], [39, 3, 1], [46, 3.5, 1], [49, 4, 1], [36, 4, 1]]
    : ['bass', 'acid'].includes(cfg.patch) ? [[36, 0, 0.4], [36, 0.5, 0.4], [48, 1, 0.3], [39, 1.5, 0.4], [41, 2, 0.4], [43, 2.5, 0.9], [36, 3.5, 0.9]]
    : ['lead', 'soft'].includes(cfg.patch) ? [[67, 0, 0.45], [70, 0.5, 0.45], [72, 1, 1.4], [75, 2.5, 0.4], [74, 3, 0.4], [72, 3.5, 1]]
    : [[60, 0, 1.8], [64, 0, 1.8], [67, 0, 1.8], [71, 0, 1.8], [57, 2, 1.8], [60, 2, 1.8], [64, 2, 1.8], [72, 2.5, 0.4], [74, 3, 0.4], [76, 3.5, 0.6]];
  for (const [n, b, d] of phrase) {
    engine.event(k, { type: 'on', note: n, vel: 100, at: t0 + b * beat });
    engine.event(k, { type: 'off', note: n, at: t0 + (b + d) * beat });
  }
  setTimeout(() => engine.removeChannel(k), 5 * beat + 3000);
}

// --- library and hardware drawers
function openDrawer(id) { $(id).classList.remove('hide'); }
function closeDrawers() { $$('.drawer').forEach((d) => d.classList.add('hide')); }
function renderLibrary() {
  $('#libCards').replaceChildren(...[...engine.defs.values()].map((d, i) => h('div', { class: 'card', style: `--k:${KNOB_COLORS[i % 4]}` },
    h('div', { class: 'fam' }, d.family), h('div', { class: 'name' }, d.name), h('p', {}, d.blurb || ''),
    h('div', { class: 'chips' }, ...Object.keys(d.presets).map((t) => h('span', { class: 'chip' }, t))),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: () => audition(engine.resolve({ inst: d.id })) }, 'Audition'),
      h('button', { class: 'btn small hot', onclick: () => { addEntry({ inst: d.id }); closeDrawers(); } }, 'Add to my corner')))));
}
let hwPick = null;
function renderHardware() {
  const q = ($('#hwSearch').value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const units = engine.hardware.hardware.filter((u) => !q || (u.maker + u.model + u.family).toLowerCase().replace(/[^a-z0-9]/g, '').includes(q));
  $('#hwList').replaceChildren(...units.map((u) => h('button', { class: u.id === hwPick ? 'on' : '', onclick: () => { hwPick = u.id; renderHardware(); } },
    u.model, h('small', {}, `${u.maker} · ${engine.hardware.families[u.family]?.label || u.family}`))));
  const unit = hwPick && engine.unit(hwPick);
  if (!unit) { $('#twinPick').replaceChildren(h('p', { class: 'help' }, 'Choose your unit above.')); return; }
  const cands = engine.twinCandidates(unit);
  $('#twinPick').replaceChildren(
    h('p', { class: 'help' }, `The band will hear your ${unit.model} as one of these. Best match first.`),
    h('div', { class: 'cards' }, ...cands.map((c, i) => {
      const d = engine.defs.get(c.inst), cfg = engine.resolve({ hw: unit.id, inst: c.inst });
      return h('div', { class: 'card', style: `--k:${KNOB_COLORS[i % 4]}` },
        h('div', { class: 'top' }, h('span', { class: 'fam' }, d.family), h('span', { class: 'score' }, `${Math.round(c.score * 100)}%`)),
        h('div', { class: 'name' }, d.name), h('p', {}, (unit.twin === c.inst ? `Set up with ${unit.model} character. ` : '') + (d.blurb || '')),
        h('div', { class: 'chips' }, ...engine.patchTypes(cfg).map((t) => h('span', { class: 'chip' }, t))),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', onclick: () => audition(cfg) }, 'Audition'),
          h('button', { class: 'btn small hot', onclick: () => { addEntry({ hw: unit.id, inst: c.inst }); closeDrawers(); } }, 'Use this twin')));
    })));
}

// --- tempo, lookahead, keyboard, wiring
function renderTempo() {
  const el = $('#bpmLcd'); if (!el || el.dataset.drag) return;
  el.textContent = String(Math.round(tempo.bpm(clock.now() + 1000))).padStart(3, '0');
  $('#tempoNote').textContent = room.peers.size && !clock.isLeader ? 'set by the clock leader' : '';
}
function renderLook() {
  const L = lookahead(), e = selEntry();
  $('#lookVal').textContent = room.peers.size ? `${L} ms` : 'SOLO';
  $('#lookMeter').style.width = Math.min(100, (L / 300) * 100) + '%';
  $('#lookAutoBtn').classList.toggle('on', S.lookOverride == null);
  const s = $('#lookSlider'); if (document.activeElement !== s) s.value = L;
  if (!e) return;
  const b = BUDGETS[budgetOf(e)].label.toLowerCase(), pl = partLook(e);
  $('#lookHelp').textContent = !room.peers.size ? 'Alone in the studio: notes play the moment you press them.'
    : S.quant ? `Notes snap to the next ${{ 1: 'beat', 0.5: '8th', 0.25: '16th' }[S.quant]} at least ${pl} ms away, so the band hears them land together.`
    : selfInstant(e) ? `${describe(e.cfg, true)} · ${b} timing: you hear it instantly, the band hears it ${pl} ms later, all together.`
    : `${describe(e.cfg, true)} · ${b} timing: every note, yours included, sounds ${pl} ms after you play it, at the same instant for everyone. Play a touch ahead, like an organist.`;
}
function renderInputStatus(msg) {
  const el = $('#inputStatus'); if (!el) return;
  const midi = input.midi ? `${input.inputs.length} MIDI IN` : '';
  el.textContent = msg || [`OCT ${input.octave}`, `VEL ${input.velocity}`, midi].filter(Boolean).join(' · ');
  if (input.midi && !$('#midiBtn').classList.contains('on')) { $('#midiBtn').textContent = 'MIDI on'; $('#midiBtn').classList.add('on'); renderDevice(); }
  renderKeyboard();
}
const DRUMS = { 36: 'KICK', 37: 'RIM', 38: 'SNR', 39: 'CLAP', 41: 'TOM', 42: 'HAT', 43: 'TOM', 44: 'HAT', 45: 'TOM', 46: 'OPEN', 47: 'TOM', 48: 'TOM', 49: 'CRSH', 50: 'TOM', 51: 'RIDE', 56: 'BELL', 60: 'PERC' };
let keyEls = new Map(), kbSig = '';
function renderKeyboard() {
  const kb = $('#keyboard'); if (!kb) return;
  const e = selEntry(), drums = !!(e && engine.defs.get(e.cfg.inst)?.drums);
  if (drums && input.octave > 2) input.octave = 2;
  if (!drums && input.octave < 3) input.octave = 4;
  const sig = input.octave + '|' + drums;
  if (sig === kbSig && keyEls.size) return;
  kbSig = sig;
  const base = 12 * (input.octave + 1);
  keyEls = new Map();
  const keys = [];
  for (let n = base; n < base + 25; n++) {
    const black = [1, 3, 6, 8, 10].includes(n % 12);
    const label = drums ? DRUMS[n] : n % 12 === 0 ? 'C' + (n / 12 - 1) : '';
    const el = h('div', { class: 'key' + (black ? ' black' : ''), 'data-note': n }, label ? h('span', { class: 'klabel' }, label) : null);
    keyEls.set(n, el); keys.push(el);
  }
  kb.replaceChildren(...keys);
}
const pointers = new Map();
function keyFromPoint(x, y) { const el = document.elementFromPoint(x, y)?.closest('[data-note]'); return el ? +el.dataset.note : null; }
function wireKeyboard() {
  const kb = $('#keyboard');
  kb.addEventListener('pointerdown', (e) => {
    const n = keyFromPoint(e.clientX, e.clientY); if (n == null) return;
    e.preventDefault(); kb.setPointerCapture(e.pointerId);
    const r = document.elementFromPoint(e.clientX, e.clientY).closest('[data-note]').getBoundingClientRect();
    const vel = Math.round(50 + 77 * Math.min(1, Math.max(0, (e.clientY - r.top) / Math.max(1, r.height))));
    pointers.set(e.pointerId, n); input.press(n, vel, 0);
  });
  kb.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const n = keyFromPoint(e.clientX, e.clientY), was = pointers.get(e.pointerId);
    if (n != null && n !== was) { input.release(was, 0); pointers.set(e.pointerId, n); input.press(n, 90, 0); }
  });
  const up = (e) => { const n = pointers.get(e.pointerId); if (n != null) { pointers.delete(e.pointerId); input.release(n, 0); } };
  kb.addEventListener('pointerup', up); kb.addEventListener('pointercancel', up);
}
function flashKey(note, on) { const el = keyEls.get(note); if (el) el.classList.toggle('down', on); }
function paintRemoteKeys() {
  for (const [n, el] of keyEls) {
    const who = [];
    for (const [k, c] of engine.ch) { const pid = pidOf(k); if (pid !== S.me && pid !== 'audition' && c.held.has(n)) who.push(colorOf(pid)); }
    el.style.setProperty('--dots', who.length ? who.map((c, i) => `radial-gradient(circle at ${50 + (i - (who.length - 1) / 2) * 24}% 84%, ${c} 0 4px, transparent 5px)`).join(',') : 'none');
  }
}

function applyVolume(k) {
  const c = engine.ch.get(k); if (!c || !engine.ctx) return;
  const pid = pidOf(k), v = S.vol.get(pid) || { vol: 1, mute: false };
  let twinMuted = false;
  if (pid === S.me) { const e = entry(+k.slice(k.indexOf(':') + 1)); twinMuted = !!(e && e.cfg.hw && !e.hearTwin); }
  c.out.gain.setTargetAtTime(v.mute || twinMuted ? 0 : v.vol, engine.ctx.currentTime, 0.02);
}
function applyPlayerVolume(pid) { for (const k of engine.ch.keys()) if (pidOf(k) === pid) applyVolume(k); }

function renderNet() {
  const tb = $('#netTable'); if (!tb || $('#studio').classList.contains('hide')) return;
  const rows = [h('tr', {}, ...['Jammer', 'Path', 'RTT', 'Jitter', 'Late', 'Lookahead'].map((t) => h('th', {}, t)))];
  for (const p of room.peers.values()) {
    const pl = S.players.get(p.id) || {};
    let late = 0; for (const x of pl.rack || []) late += engine.ch.get(key(p.id, x.r))?.late || 0;
    const med = p.rtt.length ? pct(p.rtt, 0.5) : null, p90 = p.rtt.length ? pct(p.rtt, 0.9) : null;
    rows.push(h('tr', {}, h('td', {}, pl.name || p.name), h('td', {}, p.path), h('td', {}, med != null ? `${Math.round(med)}` : '…'),
      h('td', {}, p90 != null ? `${Math.round(p90 - Math.min(...p.rtt))}` : '…'), h('td', {}, String(late)), h('td', {}, pl.peerL != null ? `${pl.peerL}` : '…')));
  }
  tb.replaceChildren(...rows);
  $('#netSummary').textContent = `Relay messages: ${room.relayed} · clock ${clock.isLeader ? 'leader (you)' : clock.locked ? `locked (±${clock.errMs.toFixed(1)} ms worst case)` : 'syncing…'}${lane.on ? ` · lane sent ${(lane.sentBytes / 1e6).toFixed(1)} MB` : ''}`;
}

// ---------- band chat ----------
function addChat(item, notify = true) {
  S.chat.push(item);
  if (S.chat.length > 300) S.chat.splice(0, S.chat.length - 300);
  const log = $('#chatLog'); if (!log) return;
  const time = new Date(item.t || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const color = item.from && (item.from === S.me || room.peers.has(item.from)) ? colorOf(item.from) : '#9b9da3';
  log.append(item.sys ? h('div', { class: 'cmsg sys' }, item.text)
    : h('div', { class: 'cmsg' + (item.old ? ' old' : '') }, h('b', { style: `color:${color}` }, item.name || 'Jammer'), h('span', {}, item.text), h('i', {}, time)));
  log.scrollTop = log.scrollHeight;
  if (notify && !item.sys && item.from !== S.me && document.activeElement !== $('#chatIn')) { S.unread++; $('#chatBadge').textContent = S.unread; $('#chatBadge').classList.remove('hide'); }
}
function sendChat() {
  const el = $('#chatIn'), text = el.value.trim().slice(0, 500);
  if (!text || !S.me) return;
  el.value = '';
  room.send({ k: 'chat', text });
  addChat({ from: S.me, name: S.name, text, t: Date.now() });
}

// ---------- entering and leaving ----------
function randomCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s = ''; for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)]; return s; }
async function enter(code) {
  const name = ($('#nameIn').value || '').trim().slice(0, 16) || 'Jammer';
  code = String(code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (code.length !== 4) { setStatus('Room codes are four letters.', 'error'); return; }
  S.name = name;
  try { localStorage.setItem('jamjam.name', name); } catch (_) {}
  setStatus('Loading the library…');
  try { await engine.start(); if (!engine.defs.size) await engine.loadInstruments('.'); }
  catch (e) { setStatus("Couldn't start audio or load the instruments: " + e.message, 'error'); return; }
  if (!S.rack.length) {
    const cfg = engine.resolve({ inst: 'juniper', patch: 'keys' });
    S.rack.push({ r: S.nextR++, cfg, budget: 'auto', midiCh: 0, midiOut: '', hwLatency: 0, hearTwin: false });
    S.sel = S.rack[0].r;
  }
  renderLibrary();
  room.join(code, name);
}
function leaveRoom() {
  room.leave(); lane.stopLane(); input.panic();
  for (const k of [...engine.ch.keys()]) engine.removeChannel(k);
  S.me = null; S.players.clear(); S.sync.clear(); S.stable.clear(); S.slackRep.clear(); S.needs.clear();
  S.loopActive = false; S.lookAuto = 0; S.chat = []; $('#chatLog').replaceChildren();
  clock.setLeader(true); clock.offset = 0;
  $('#studio').classList.add('hide'); $('#lobby').classList.remove('hide'); $('#leaveBtn').classList.add('hide');
  history.replaceState(null, '', location.pathname);
  setStatus('');
}

let lastLookSent = -1, lastBudgetSig = '';
function broadcastLook(force = false) {
  const L = lookahead(), budgets = {};
  for (const e of S.rack) budgets[e.r] = budgetOf(e);
  const sig = JSON.stringify(budgets);
  if (force || Math.abs(L - lastLookSent) >= 2 || sig !== lastBudgetSig) { lastLookSent = L; lastBudgetSig = sig; room.send({ k: 'look', L, budgets }); }
}

function wire() {
  try { $('#nameIn').value = localStorage.getItem('jamjam.name') || ''; } catch (_) {}
  const pre = (qs.get('room') || '').toUpperCase();
  if (pre) { $('#codeIn').value = pre; $('#joinBtn').classList.add('hot'); $('#startBtn').classList.remove('hot'); }
  $('#startBtn').onclick = () => enter(randomCode());
  $('#joinBtn').onclick = () => enter($('#codeIn').value);
  $('#codeIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter($('#codeIn').value); });
  $('#leaveBtn').onclick = leaveRoom;
  $('#copyBtn').onclick = async () => {
    const url = `${location.origin}${location.pathname}?room=${room.code}${qs.get('server') ? '&server=' + encodeURIComponent(qs.get('server')) : ''}`;
    try { await navigator.clipboard.writeText(url); $('#copyBtn').textContent = 'Copied'; } catch (_) { prompt('Invite link', url); }
    setTimeout(() => { $('#copyBtn').textContent = 'Copy invite'; }, 1500);
  };
  const bpmNow = () => Math.round(tempo.bpm(clock.now() + 1000));
  $('#bpmDown').onclick = () => setTempo(bpmNow() - 1);
  $('#bpmUp').onclick = () => setTempo(bpmNow() + 1);
  const lcd = $('#bpmLcd'); let drag = null;
  lcd.addEventListener('pointerdown', (e) => { lcd.setPointerCapture(e.pointerId); drag = { y: e.clientY, b: bpmNow() }; lcd.dataset.drag = '1'; });
  lcd.addEventListener('pointermove', (e) => { if (drag) lcd.textContent = String(Math.max(40, Math.min(240, Math.round(drag.b + (drag.y - e.clientY) / 4)))).padStart(3, '0'); });
  lcd.addEventListener('pointerup', () => { if (drag) { delete lcd.dataset.drag; setTempo(+lcd.textContent); drag = null; } });
  lcd.addEventListener('wheel', (e) => { e.preventDefault(); setTempo(bpmNow() + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
  lcd.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setTempo(bpmNow() + (e.shiftKey ? 10 : 1)); }
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setTempo(bpmNow() - (e.shiftKey ? 10 : 1)); }
  });
  $('#metroBtn').onclick = (e) => { engine.metro.on = !engine.metro.on; engine.metro.next = -1; e.currentTarget.classList.toggle('on', engine.metro.on); };
  $$('#quantSeg button').forEach((b) => b.onclick = () => { S.quant = +b.dataset.q; $$('#quantSeg button').forEach((x) => x.classList.toggle('on', x === b)); renderLook(); });
  $('#selfBtn').onclick = (e) => { S.hearSelf = !S.hearSelf; e.target.classList.toggle('on', S.hearSelf); renderLook(); };
  $('#lookSlider').oninput = (e) => { S.lookOverride = +e.target.value; broadcastLook(); renderLook(); };
  $('#lookAutoBtn').onclick = () => { S.lookOverride = null; broadcastLook(); renderLook(); };
  $('#addInstBtn').onclick = () => { renderLibrary(); openDrawer('#libDrawer'); };
  $('#addHwBtn').onclick = () => { renderHardware(); openDrawer('#hwDrawer'); setTimeout(() => $('#hwSearch').focus(), 50); };
  $('#hwSearch').addEventListener('input', renderHardware);
  $('#hwSearch').addEventListener('keydown', (e) => e.stopPropagation());
  $$('[data-close]').forEach((b) => b.onclick = closeDrawers);
  $$('.drawer').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) closeDrawers(); }));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawers(); });
  $('#midiBtn').onclick = () => input.enableMIDI();
  $('#panicBtn').onclick = () => { input.panic(); for (const [, c] of engine.ch) for (const I of c.insts) I.inst.allOff(engine.ctx.currentTime); };
  $('#chatIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } e.stopPropagation(); });
  $('#chatIn').addEventListener('keyup', (e) => e.stopPropagation());
  $('#chatIn').addEventListener('focus', () => { S.unread = 0; $('#chatBadge').classList.add('hide'); });
  $('#chatSend').onclick = sendChat;
  $('#laneBtn').onclick = async (e) => {
    const btn = e.currentTarget;
    if (lane.on) { lane.stopLane(); btn.textContent = 'Start audio lane'; btn.classList.remove('on'); }
    else {
      try { await lane.startLane($('#laneDev').value || undefined); }
      catch (err) { $('#laneHelp').textContent = "Couldn't open that input: " + err.message; return; }
      btn.textContent = 'Stop audio lane'; btn.classList.add('on'); $('#laneHelp').textContent = '';
      const devs = await lane.devices(), cur = $('#laneDev').value;
      $('#laneDev').replaceChildren(h('option', { value: '' }, 'Default input'), ...devs.map((d) => h('option', { value: d.deviceId, selected: d.deviceId === cur }, d.label || 'Input')));
    }
    room.send({ k: 'lane', lane: { on: lane.on, bars: lane.bars } });
  };
  $('#laneDev').onchange = async () => { if (lane.on) await lane.startLane($('#laneDev').value || undefined); };
  $('#laneBars').onchange = (e) => { lane.bars = +e.target.value; room.send({ k: 'lane', lane: { on: lane.on, bars: lane.bars } }); };
  $('#laneQ').onchange = (e) => { lane.quality = e.target.value; };
  $('#laneOff').oninput = (e) => { lane.offsetMs = +e.target.value; $('#laneOffVal').textContent = `${lane.offsetMs > 0 ? '+' : ''}${lane.offsetMs} ms`; };
  wireKeyboard();
}

setInterval(() => {
  if (!S.me) return;
  computeAutoL();
  updateCorners(); renderLook(); paintRemoteKeys(); renderTempo();
  const now = performance.now();
  for (const e of S.rack) { const c = engine.ch.get(key(S.me, e.r)); for (const led of $$(`#rackList [data-led="${key(S.me, e.r)}"]`)) if (c) led.classList.toggle('lit', now - c.flashT < 120 || c.held.size > 0); }
}, 100);
setInterval(() => { if (S.me) { renderNet(); broadcastLook(); } }, 1000);

// test hooks
Object.assign(window.JJ, {
  addInstrument: (inst, patch) => addEntry({ inst, patch }),
  addHardware: (hw, inst) => addEntry({ hw, inst }),
  select: (r) => { S.sel = r; renderRack(); renderDevice(); renderKeyboard(); },
  changeEntry: (r, next) => changeEntry(entry(r), next),
  removeEntry: (r) => removeEntry(entry(r)),
  setParam: (id, v) => { setParam(selEntry(), id, v); knobSet(id); },
  setTempo: (b) => setTempo(b),
});
wire();
