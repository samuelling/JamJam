import { SharedClock, Tempo } from './clock.js';
import { Room } from './net.js';
import { Engine } from './engine.js';
import { Input, sendToHardware, bendBytes } from './input.js';
import { AudioLane, decodeChunk } from './lane.js';
import { StepSeq } from './seq.js';
import { iconEl, skinOf } from './skins.js';

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
// the display refreshes ten times a second; only touch the DOM when something actually changed
const setText = (el, t) => { if (el && el.textContent !== t) el.textContent = t; };
const setCls = (el, c, on) => { if (el && el.classList.contains(c) !== !!on) el.classList.toggle(c, !!on); };
const setVar = (el, k, v) => { if (el && el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v); };

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
  mdTrack: 0, mdPage: 0, mdLock: false, held: null, hits: new Map(), md: null,
  libTab: 'builtin', standins: new Map(),
  routes: new Map(),                       // a bandmate's part (channel key) -> {port, ch, lat, mute}: played on your MIDI gear
  mclock: { port: '', on: false, lat: 0, next: null },  // MIDI clock out: the room's tempo to your drum machines  // channel key -> {wanted cfg} while a stand-in plays someone's library instrument
};
window.JJ = { clock, tempo, engine, S };
const key = (pid, r) => `${pid}:${r}`;
const pidOf = (k) => k.slice(0, k.indexOf(':'));
const entry = (r) => S.rack.find((e) => e.r === r);
const selEntry = () => entry(S.sel) || S.rack[0];
const outPort = (id) => (id ? input.outputs.find((o) => o.id === id) : null);

// ---------- sequencers (one per drum instrument), running in lockstep in every browser ----------
const SEQ_H = 60;                      // how far ahead (ms) each browser schedules sequencer steps
const seqs = new Map();                // channel key -> StepSeq
function ensureSeq(k, cfg, snap) {
  const def = engine.defs.get(cfg?.inst);
  if (!def?.seq) { seqs.delete(k); return null; }
  let sq = seqs.get(k);
  if (!sq) { sq = new StepSeq(def.seq.tracks.length); seqs.set(k, sq); }
  if (snap) sq.load(snap);
  return sq;
}
function cfgOfKey(k) {
  const pid = pidOf(k), r = +k.slice(k.indexOf(':') + 1);
  return pid === S.me ? entry(r)?.cfg : S.players.get(pid)?.rack.find((x) => x.r === r)?.cfg;
}
// an edit lands past every browser's scheduling horizon, so all of them apply it before the step it touches
const editLead = () => (room.peers.size ? lookahead() + SEQ_H + 15 : SEQ_H + 5);
function seqEdit(e, op) {
  const sq = seqs.get(key(S.me, e.r)); if (!sq) return;
  const at = clock.now() + editLead();
  sq.queue(at, op);
  if (clock.locked) room.send({ k: 'sq', r: e.r, at, op });
  renderMachinaDyn(true);
  if (op[0] === 'l') renderMdEncoders(e, engine.defs.get(e.cfg.inst));
}
setInterval(() => {
  if (!S.me || !engine.ctx) return;
  const now = clock.now();
  for (const [k, sq] of seqs) {
    const cfg = cfgOfKey(k); if (!cfg) continue;
    const def = engine.defs.get(cfg.inst); if (!def?.seq) continue;
    for (const st of sq.due(tempo, now, now + SEQ_H)) for (const tg of st.trigs) {
      engine.seqTrig(k, def.seq.tracks[tg.track].note, 100, tg.locks, st.t, cfg.params);
      if (pidOf(k) !== S.me) { routeOut(k, { type: 'on', note: def.seq.tracks[tg.track].note, vel: 100, at: st.t }); routeOut(k, { type: 'off', note: def.seq.tracks[tg.track].note, at: st.t + 60 }); }
      S.hits.set(k + ':' + tg.track, st.t);
    }
  }
}, 15);

// ---------- the room ----------
const room = new Room({
  server: SERVER, maxPeers: MAX, p2p: qs.get('p2p') !== '0',
  handlers: {
    status(kind, text) { setStatus(text, kind); if (kind === 'in') onEntered(); },
    roster() { updateLeader(); renderCorners(); },
    peerOpen(p) { sayHello(p.id); },
    peerLeft(p) {
      addChat({ sys: true, text: `${S.players.get(p.id)?.name || p.name} left`, t: Date.now() });
      for (const k of [...engine.ch.keys()]) if (pidOf(k) === p.id) { engine.removeChannel(k); seqs.delete(k); }
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
  for (const e of S.rack) { engine.setCfg(key(S.me, e.r), e.cfg, -Infinity); ensureSeq(key(S.me, e.r), e.cfg); S.stable.set(key(S.me, e.r), performance.now()); applyVolume(key(S.me, e.r)); }
  showStudio();
}

const publicRack = (withSeq = false) => S.rack.map((e) => ({ r: e.r, cfg: e.cfg, budget: budgetOf(e), seq: withSeq ? seqs.get(key(S.me, e.r))?.snapshot() : undefined }));
function sayHello(id) {
  room.send({ k: 'hello', v: VERSION, name: S.name, rack: publicRack(true), hashes: engine.hashes, lane: { on: lane.on, bars: lane.bars }, L: lookahead() }, id);
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

function remoteCfg(pid, r, cfg, at, budget, seqSnap) {
  const pl = S.players.get(pid); if (!pl) return;
  const k = key(pid, r);
  const known = pl.rack.find((x) => x.r === r);
  if (known) { known.cfg = cfg; if (budget) known.budget = budget; } else pl.rack.push({ r, cfg, budget });
  if (cfg.lib && !engine.defs.has(cfg.inst)) {
    // someone is playing an instrument from a library this browser hasn't loaded: a stand-in plays until it loads
    S.standins.set(k, { wanted: cfg, at });
    engine.setCfg(k, engine.resolve(engine.standIn(cfg.meta)), at);
    loadWanted(k);
  } else { S.standins.delete(k); engine.setCfg(k, cfg, at); }
  ensureSeq(k, cfg, seqSnap);
  if (!S.stable.has(k)) S.stable.set(k, performance.now());
  applyVolume(k);
}
async function loadWanted(k) {
  const sti = S.standins.get(k); if (!sti) return;
  const cfg = sti.wanted;
  try {
    if (!engine.catalog.has(cfg.inst) && cfg.lib.url && !engine.libs.has(cfg.lib.id)) { await engine.addLibrary(cfg.lib.url); saveLibs(); }
    if (!engine.catalog.has(cfg.inst)) throw new Error('not here');
    await engine.ensureDef(cfg.inst);
  } catch (_) {
    if (!sti.told) { sti.told = true; const who = S.players.get(pidOf(k))?.name || 'A bandmate'; addChat({ sys: true, text: `${who} is playing ${cfg.meta?.name || cfg.inst} from ${cfg.lib.name}. You're hearing a stand-in; add ${cfg.lib.name} in the gear wall to hear the real thing.`, t: Date.now() }); }
    renderCorners(); return;
  }
  if (S.standins.get(k) !== sti) return;                 // changed meanwhile
  S.standins.delete(k);
  // swap in after the stand-in's own start (which can still be in the future)
  engine.setCfg(k, cfg, Math.max(clock.now() + 30, Number.isFinite(sti.at) ? sti.at + 1 : -Infinity));
  applyVolume(k);
  renderCorners();
}
function retryStandins() { for (const k of S.standins.keys()) loadWanted(k); }
function saveLibs() { try { localStorage.setItem('jamjam.libs', JSON.stringify([...engine.libs.values()].map((l) => l.url))); } catch (_) {} }
async function restoreLibs() {
  let urls = [];
  try { urls = JSON.parse(localStorage.getItem('jamjam.libs') || '[]'); } catch (_) {}
  for (const u of urls) { try { await engine.addLibrary(u); } catch (e) { setStatus(`Couldn't reach a library you added (${u}).`, 'error'); } }
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
      for (const x of m.rack || []) remoteCfg(p.id, x.r, x.cfg, -Infinity, x.budget, x.seq);
      if (first) addChat({ sys: true, text: `${m.name} walked in`, t: Date.now() });
      if ($('#status').dataset.kind !== 'error') setStatus('');
      renderCorners(); renderMidiPanel(); break;
    }
    case 'cfg': remoteCfg(p.id, m.r, m.cfg, clock.locked ? m.at : -Infinity, m.budget); renderCorners(); break;
    case 'unrack': {
      const pl = S.players.get(p.id); if (pl) pl.rack = pl.rack.filter((x) => x.r !== m.r);
      const k = key(p.id, m.r);
      setTimeout(() => { engine.removeChannel(k); seqs.delete(k); }, Math.max(0, (m.at || 0) - clock.now()));
      renderCorners(); break;
    }
    case 'ev': if (m.ev) receiveEvent(p, m.r, m.ev); break;
    case 'evs': if (Array.isArray(m.items)) for (const it of [...m.items].sort((a, b) => (a.ev?.seq || 0) - (b.ev?.seq || 0))) if (it && it.ev) receiveEvent(p, it.r, it.ev); break;
    case 'tempo': if (p.id === leaderId()) { tempo.load(m.segs); engine.metro.next = -1; renderTempo(); } break;
    case 'tempoReq': if (clock.isLeader) setTempo(m.bpm); break;
    case 'lane': { const pl = S.players.get(p.id); if (pl) pl.lane = m.lane; renderCorners(); break; }
    case 'look': { const pl = S.players.get(p.id); if (pl) { pl.peerL = m.L; if (m.budgets) for (const x of pl.rack) if (m.budgets[x.r]) x.budget = m.budgets[x.r]; } break; }
    case 'fp': checkFingerprint(p.id, m); break;
    case 'sq': { const sq = seqs.get(key(p.id, m.r)); if (sq && Array.isArray(m.op) && typeof m.at === 'number') sq.queue(m.at, m.op); break; }
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
  routeOut(k, ev);
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
    const port = outPort(e.midiOut), oc = ((e.outCh || 1) - 1) & 15;
    if (port) sendToHardware(port, on ? [0x90 | oc, note, vel] : [0x80 | oc, note, 0], instant ? performance.now() : clock.toLocal(at) - (e.hwLatency || 0));
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
  ensureSeq(key(S.me, e.r), e.cfg);
  if (!S.stable.has(key(S.me, e.r))) S.stable.set(key(S.me, e.r), performance.now());
  room.send({ k: 'cfg', r: e.r, cfg: e.cfg, at, budget: budgetOf(e) });
  applyVolume(key(S.me, e.r));
}
function addEntry({ inst, patch, hw, ext }) {
  if (S.rack.length >= MAX_RACK) { setStatus(`A corner holds up to ${MAX_RACK} instruments.`, 'error'); return null; }
  const cfg = engine.resolve({ inst: ext ? inst || 'none' : inst, patch, hw });
  if (ext) cfg.ext = { name: String(ext.name || 'My synth').slice(0, 24) };
  const def = engine.defs.get(cfg.inst);
  const usedCh = new Set(S.rack.map((e) => e.midiCh));
  const midiCh = def.drums ? 10 : !usedCh.has(0) ? 0 : [1, 2, 3, 4, 5, 6].find((c) => !usedCh.has(c)) || 0;
  const e = { r: S.nextR++, cfg, budget: 'auto', midiCh, midiOut: ext?.port ?? '', outCh: ext?.ch || 1, hwLatency: 0, hearTwin: false };
  S.rack.push(e); S.sel = e.r; S.knobGroup = null;
  publishEntry(e);
  renderRack(); renderDevice(); renderCorners(); renderKeyboard();
  return e;
}
function changeEntry(e, next) {
  const ext = e.cfg.ext;
  e.cfg = engine.resolve({ inst: next.inst ?? e.cfg.inst, patch: next.patch, hw: next.hw === undefined ? e.cfg.hw : next.hw });
  if (ext) e.cfg.ext = ext;
  publishEntry(e);
  renderRack(); renderDevice(); renderCorners(); renderKeyboard();
}
function removeEntry(e) {
  if (S.rack.length <= 1) { setStatus('Keep at least one instrument in your corner.', 'error'); return; }
  S.rack = S.rack.filter((x) => x !== e);
  const k = key(S.me, e.r), at = clock.now() + lookahead() + 20;
  room.send({ k: 'unrack', r: e.r, at });
  setTimeout(() => { engine.removeChannel(k); seqs.delete(k); }, Math.max(0, at - clock.now()));
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
      const port = e.cfg.ext ? outPort(e.midiOut) : null;  // external gear gets your controller's CCs too, in lockstep
      if (port) sendToHardware(port, [0xb0 | (((e.outCh || 1) - 1) & 15), cc, val], selfInstant(e) ? performance.now() : clock.toLocal(clock.now() + partLook(e)) - (e.hwLatency || 0));
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
  bend: (semi, ch) => { for (const e of targetsFor(ch)) { const L = partLook(e);
    const port = e.cfg.ext ? outPort(e.midiOut) : null;
    if (port) sendToHardware(port, bendBytes(e.outCh || 1, semi), selfInstant(e) ? performance.now() : clock.toLocal(clock.now() + L) - (e.hwLatency || 0));
    sendEvent(e, { type: 'p', id: 'bend', v: semi, at: clock.now() + L, seq: ++S.seq, b: BUDGETS[budgetOf(e)].short, o: L - lookahead() }, selfInstant(e)); } },
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
function setStatus(text, kind = '') {
  for (const el of [$('#status'), $('#lobbyStatus')]) { if (!el) continue; el.textContent = text || ''; el.dataset.kind = kind; }
  if (kind === 'error') setTimeout(() => { for (const el of [$('#status'), $('#lobbyStatus')]) if (el && el.textContent === text) el.textContent = ''; }, 5000);
}

function showStudio() {
  $('#lobby').classList.add('hide'); $('#studio').classList.remove('hide');
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
  if (cfg.ext) return short ? cfg.ext.name : `${cfg.ext.name} (MIDI)${cfg.inst !== 'none' ? ' → ' + (def ? def.name : cfg.meta?.name || cfg.inst) : ''}`;
  if (unit) return short ? unit.model : `${unit.maker} ${unit.model} → ${def ? def.name : cfg.meta?.name || cfg.inst}`;
  return `${def ? def.name : cfg.meta?.name || cfg.inst} · ${patchName(def, cfg.patch)}`;
}
const patchName = (def, t) => def?.presetNames?.[t] || cap(t);

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
    h('div', { class: 'gearrow' }, ...rack.map((x) => {
      const def = engine.defs.get(x.cfg?.inst), unit = x.cfg?.hw && engine.unit(x.cfg.hw);
      return h('div', { class: 'gearitem', title: describe(x.cfg) }, iconEl(x.cfg?.ext ? { id: 'midi' } : def), h('span', { class: 'led', 'data-led': key(id, x.r), style: `--c:${c}` }), h('small', { 'data-budget': key(id, x.r) }, x.cfg?.ext ? x.cfg.ext.name : unit ? unit.model : def?.name || '…'));
    })),
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
      if (id === S.me) { setText(tag, clock.isLeader ? 'clock leader' : clock.locked ? 'clock synced' : 'syncing…'); tag.dataset.kind = clock.locked ? 'ok' : 'wait'; }
      else if (peer) {
        const rtt = peer.rtt.length ? Math.round(pct(peer.rtt, 0.5)) : null;
        setText(tag, peer.path === 'direct' ? `direct ${rtt ?? '…'} ms` : peer.path === 'relay' ? `relay ${rtt ?? '…'} ms` : 'connecting…');
        tag.dataset.kind = peer.path === 'direct' ? 'ok' : peer.path === 'relay' ? 'warn' : 'wait';
      }
    }
    const rack = id === S.me ? S.rack : pl.rack || [];
    for (const x of rack) {
      const k = key(id, x.r), c = engine.ch.get(k);
      for (const led of $$(`[data-led="${k}"]`)) if (c) setCls(led, 'lit', now - c.flashT < 120 || c.held.size > 0);
      const b = $(`[data-budget="${k}"]`);
      if (b) { const bb = id === S.me ? budgetOf(x) : x.budget; b.title = room.peers.size && bb ? `${bb} timing · ${id === S.me ? partLook(x) : Math.round(BUDGETS[bb].L(pl.peerL ?? 0))} ms` : ''; }
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
        const st = rack.find((x) => S.standins.has(key(id, x.r)));
        if (st) bits.unshift(`⚠ stand-in for ${st.cfg.meta?.name || st.cfg.inst}: add ${st.cfg.lib?.name} to hear it`);
      } else if (lane.on) bits.push(`your lane +${lane.bars} bar${lane.bars > 1 ? 's' : ''}`);
      setText(st, bits.join(' · '));
    }
    const lm = $(`[data-lane="${id}"] i`);
    if (lm) {
      const lc = engine.ch.get(key(id, 'lane'));
      const active = id === S.me ? lane.on : lc && now - lc.laneT < 300;
      setCls(lm.parentElement, 'active', active);
      const w = Math.round((id === S.me ? Math.min(1, lane.level * 1.5) : active ? 0.7 : 0) * 100) + '%';
      if (lm.style.width !== w) lm.style.width = w;
    }
  }
}

// --- your gear shelf
function renderRack() {
  const box = $('#rackList'); if (!box) return;
  box.replaceChildren(...S.rack.map((e, i) => {
    const def = engine.defs.get(e.cfg.inst), unit = e.cfg.hw && engine.unit(e.cfg.hw);
    return h('button', { class: 'cart' + (e.r === (selEntry() || {}).r ? ' sel' : ''), style: `--k:${RACK_COLORS[i % 4]}`, title: describe(e.cfg), onclick: () => { S.sel = e.r; S.knobGroup = null; S.held = null; renderRack(); renderDevice(); renderKeyboard(); } },
      iconEl(e.cfg.ext ? { id: 'midi' } : def),
      h('b', {}, e.cfg.ext ? e.cfg.ext.name : unit ? unit.model : def.name), h('small', {}, e.cfg.ext ? `MIDI out ${e.midiOut ? 'ch' + (e.outCh || 1) : '—'}` : `${unit ? def.name + ' · ' : ''}${e.cfg.patch} · ${e.midiCh ? 'ch' + e.midiCh : 'any'}`),
      h('span', { class: 'led', 'data-led': key(S.me, e.r), style: `--c:${RACK_COLORS[i % 4]}` }));
  }));
}

// --- the instrument on your desk
let knobEls = new Map();
function configFields(e, def, unit) {
  const sel = (label, options, value, onchange) => h('div', {}, h('label', {}, label),
    h('select', { 'aria-label': label, onchange: (ev) => onchange(ev.target.value) }, ...options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t))));
  const f = [];
  if (unit) f.push(sel('Twin', engine.twinCandidates(unit).map((c) => [c.inst, `${engine.defs.get(c.inst).name} ${Math.round(c.score * 100)}%`]), e.cfg.inst, (v) => changeEntry(e, { inst: v })));
  else f.push(sel('Instrument', [...engine.defs.values()].filter((d) => !d.internal).map((d) => [d.id, d.lib ? `${d.name} (${engine.libs.get(d.lib)?.name || d.lib})` : d.name]), e.cfg.inst, (v) => changeEntry(e, { inst: v, patch: null })));
  f.push(sel(def.drums ? 'Kit' : 'Patch', engine.patchTypes(e.cfg).map((t) => [t, patchName(def, t)]), e.cfg.patch, (v) => changeEntry(e, { patch: v })));
  f.push(sel('Timing', [['auto', `Auto · ${BUDGETS[autoBudget(e.cfg)].label}`], ...Object.entries(BUDGETS).map(([k, b]) => [k, b.label])], e.budget, (v) => { e.budget = v; broadcastLook(true); renderDevice(); renderRack(); }));
  f.push(sel('MIDI in', [[0, 'Any channel'], ...Array.from({ length: 16 }, (_, i) => [i + 1, `Channel ${i + 1}`])], e.midiCh, (v) => { e.midiCh = +v; renderRack(); }));
  if (unit) f.push(sel('Plays my synth via', [['', input.outputs.length ? 'None (I play it)' : 'None · enable MIDI'], ...input.outputs.map((o) => [o.id, o.name])], e.midiOut, (v) => { e.midiOut = v; renderDevice(); }));
  return f;
}
function deviceFoot(e, def, unit) {
  const foot = [h('span', { class: 'help' }, BUDGETS[budgetOf(e)].help), h('button', { class: 'btn small', onclick: () => audition(e.cfg) }, 'Audition')];
  if (unit) {
    foot.push(h('button', { class: 'btn small' + (e.hearTwin ? ' on' : ''), title: 'Also hear the twin yourself, to compare with your hardware', onclick: () => { e.hearTwin = !e.hearTwin; applyVolume(key(S.me, e.r)); renderDevice(); } }, 'Hear twin'));
    if (e.midiOut) {
      const out = h('span', {}, ` ${e.hwLatency} ms`);
      foot.push(h('label', { class: 'help' }, 'Synth latency ', h('input', { type: 'range', min: 0, max: 40, value: e.hwLatency, style: 'width:80px', oninput: (ev) => { e.hwLatency = +ev.target.value; out.textContent = ` ${e.hwLatency} ms`; } }), out));
    }
  }
  foot.push(h('button', { class: 'btn small ghost', onclick: () => removeEntry(e) }, 'Remove'));
  return h('div', { class: 'devfoot' }, ...foot);
}
function renderDevice() {
  const e = selEntry(); if (!e) return;
  const def = engine.defs.get(e.cfg.inst), unit = e.cfg.hw && engine.unit(e.cfg.hw), skin = skinOf(def);
  $('#device').className = 'device ' + skin.cls + (skin.wood ? ' wood' : '');
  knobEls = new Map();
  if (e.cfg.ext) { renderExternal(e, def); return; }
  if (skin.custom === 'machina' && def.seq && seqs.get(key(S.me, e.r))) { renderMachina(e, def, unit); return; }
  S.md = null;
  const wide = unit
    ? `The band hears ${def.name} as your ${unit.model}${unit.note ? ' (' + unit.note.replace(/\.$/, '') + ')' : ''}. Shape the knobs until it sounds like your patch. Pick a MIDI output (with Local Control off) and JamJam plays your synth in lockstep too.`
    : def.blurb || '';
  const shown = def.params.filter((P) => !P.hidden);
  const groups = [...new Set(shown.map((P) => P.group || 'Sound'))];
  if (!groups.includes(S.knobGroup)) S.knobGroup = groups[0];
  const io = (P) => ({ get: () => e.cfg.params[P.id] ?? P.def, set: (v) => setParam(e, P.id, v), reset: () => setParam(e, P.id, def.presets[e.cfg.patch]?.[P.id] ?? P.def), locked: () => false });
  $('#plate').replaceChildren(...[
    h('div', { class: 'devtop' },
      h('div', { class: 'brand' }, h('div', { class: 'name' }, unit ? unit.model : def.name), h('div', { class: 'fam' }, unit ? `${unit.maker} · heard as ${def.name}` : def.lib ? `${engine.libs.get(def.lib)?.name || def.lib} · ${def.family}` : def.family)),
      h('div', { class: 'screen lcd' }, ...configFields(e, def, unit), h('div', { class: 'wide' }, wide))),
    groups.length > 1 ? h('div', { class: 'pages' }, ...groups.map((g) => h('button', { class: 'page' + (g === S.knobGroup ? ' on' : ''), onclick: () => { S.knobGroup = g; renderDevice(); } }, g))) : null,
    h('div', { class: 'encoders' }, ...shown.filter((P) => (P.group || 'Sound') === S.knobGroup).map((P, i) => paramControl(P, KNOB_COLORS[i % 4], io(P), skin))),
    deviceFoot(e, def, unit)].filter(Boolean));
}

// --- external MIDI gear: a synth, drum machine or DAW track on a MIDI port
function renderExternal(e, def) {
  $('#device').className = 'device skin-generic wood';
  const sel = (label, options, value, onchange) => h('div', {}, h('label', {}, label),
    h('select', { 'aria-label': label, onchange: (ev) => onchange(ev.target.value) }, ...options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t))));
  const name = h('input', { type: 'text', value: e.cfg.ext.name, maxlength: 24, 'aria-label': 'Name', style: 'font:800 22px var(--sans);background:transparent;border:0;border-bottom:1px solid #333;color:var(--legend);width:100%;padding:2px 0',
    onkeydown: (ev) => ev.stopPropagation(), onchange: (ev) => { e.cfg.ext.name = ev.target.value.trim().slice(0, 24) || 'My synth'; publishEntry(e); renderRack(); renderCorners(); } });
  const twins = [['none', 'Nothing (bandmates can route it to their own MIDI)'], ...[...engine.defs.values()].filter((d) => !d.internal).map((d) => [d.id, d.name])];
  const fields = [
    sel('Plays out on', [['', input.outputs.length ? 'Choose a MIDI output' : 'Enable MIDI first'], ...input.outputs.map((o) => [o.id, o.name])], e.midiOut, (v) => { e.midiOut = v; renderDevice(); renderRack(); }),
    sel('Out channel', Array.from({ length: 16 }, (_, i) => [i + 1, `Channel ${i + 1}`]), e.outCh || 1, (v) => { e.outCh = +v; renderRack(); }),
    sel('MIDI in', [[0, 'Any channel'], ...Array.from({ length: 16 }, (_, i) => [i + 1, `Channel ${i + 1}`])], e.midiCh, (v) => { e.midiCh = +v; renderRack(); }),
    sel('Timing', [['auto', `Auto · ${BUDGETS[autoBudget(e.cfg)].label}`], ...Object.entries(BUDGETS).map(([k, b]) => [k, b.label])], e.budget, (v) => { e.budget = v; broadcastLook(true); renderDevice(); }),
    sel('The band hears', twins, e.cfg.inst, (v) => changeEntry(e, { inst: v, patch: null })),
  ];
  if (e.cfg.inst !== 'none') fields.push(sel('Twin patch', engine.patchTypes(e.cfg).map((t) => [t, patchName(def, t)]), e.cfg.patch, (v) => changeEntry(e, { patch: v })));
  fields.push(h('div', { class: 'wide' }, `Your notes, sustain, pitch bend and controller knobs go out to this port in lockstep: timestamped to sound at the same moment the band hears your part. ${e.cfg.inst === 'none' ? 'Bandmates hear nothing unless they route it to their own MIDI gear (MIDI panel), or you pick a twin.' : `Bandmates hear ${def.name} unless they route it to their own MIDI gear.`}`));
  const shown = def.params.filter((P) => !P.hidden);
  const io = (P) => ({ get: () => e.cfg.params[P.id] ?? P.def, set: (v) => setParam(e, P.id, v), reset: () => setParam(e, P.id, def.presets[e.cfg.patch]?.[P.id] ?? P.def), locked: () => false });
  knobEls = new Map();
  const out = h('span', {}, ` ${e.hwLatency} ms`);
  $('#plate').replaceChildren(...[
    h('div', { class: 'devtop' },
      h('div', { class: 'brand' }, name, h('div', { class: 'fam' }, `External MIDI${e.midiOut ? ' · ' + (outPort(e.midiOut)?.name || 'port gone') + ' ch ' + (e.outCh || 1) : ' · no output yet'}`)),
      h('div', { class: 'screen lcd' }, ...fields)),
    e.cfg.inst !== 'none' && shown.length ? h('div', { class: 'encoders' }, ...shown.slice(0, 16).map((P, i) => paramControl(P, KNOB_COLORS[i % 4], io(P), skinOf(def)))) : null,
    h('div', { class: 'devfoot' },
      h('span', { class: 'help' }, input.midi ? 'Tip: a virtual MIDI port (IAC on Mac, loopMIDI on Windows) reaches a DAW or soft synth.' : 'Enable MIDI to list your outputs.'),
      input.midi ? null : h('button', { class: 'btn small', onclick: async () => { await input.enableMIDI(); renderDevice(); } }, 'Enable MIDI'),
      h('label', { class: 'help' }, 'Gear latency ', h('input', { type: 'range', min: 0, max: 60, value: e.hwLatency, style: 'width:80px', oninput: (ev) => { e.hwLatency = +ev.target.value; out.textContent = ` ${e.hwLatency} ms`; } }), out),
      e.cfg.inst !== 'none' ? h('button', { class: 'btn small' + (e.hearTwin ? ' on' : ''), onclick: () => { e.hearTwin = !e.hearTwin; applyVolume(key(S.me, e.r)); renderDevice(); } }, 'Hear twin') : null,
      h('button', { class: 'btn small', onclick: () => { const port = outPort(e.midiOut); if (port) { const t = performance.now() + 20, oc = ((e.outCh || 1) - 1) & 15; sendToHardware(port, [0x90 | oc, 60, 100], t); sendToHardware(port, [0x80 | oc, 60, 0], t + 300); } } }, 'Test note'),
      h('button', { class: 'btn small ghost', onclick: () => removeEntry(e) }, 'Remove'))].filter(Boolean));
}

// one control: an encoder, a fader, a stepper or a row of LED buttons, depending on the instrument's faceplate
function paramControl(P, color, io, skin = {}) {
  const label = h('div', { class: 'encname' }, P.name);
  if (!P.options && P.step === 1 && P.min === 0 && P.max === 1) { P = { ...P, options: ['Off', 'On'] }; skin = { ...skin, option: 'buttons' }; }
  if (P.options) {
    if (skin.option === 'buttons' && P.options.length <= 4) {
      const btns = P.options.map((o, i) => h('button', { onclick: () => { io.set(P.min + i); show(); } }, h('i'), o.replace(/ \(.*\)/, '')));
      const show = () => btns.forEach((b, i) => b.classList.toggle('on', Math.round(io.get()) - P.min === i));
      show(); knobEls.set(P.id, { show });
      return h('div', { class: 'encw' }, h('div', { class: 'optbtns' }, ...btns), label);
    }
    const lcd = h('div', { class: 'lcd', title: 'Click or scroll to change' });
    const show = () => { lcd.textContent = P.options[Math.round(io.get()) - P.min] ?? '?'; lcd.parentElement?.classList.toggle('locked', io.locked()); };
    const step = (d) => { const n = P.options.length; const i = ((Math.round(io.get()) - P.min + d) % n + n) % n; io.set(P.min + i); show(); };
    lcd.addEventListener('click', () => step(1));
    lcd.addEventListener('wheel', (ev) => { ev.preventDefault(); step(ev.deltaY > 0 ? -1 : 1); }, { passive: false });
    const wrap = h('div', { class: 'stepper' }, h('button', { 'aria-label': `Previous ${P.name}`, onclick: () => step(-1) }, '◀'), lcd, h('button', { 'aria-label': `Next ${P.name}`, onclick: () => step(1) }, '▶'));
    show(); knobEls.set(P.id, { show });
    return h('div', { class: 'encw' }, wrap, label);
  }
  const fader = skin.knob === 'fader';
  const ctl = fader
    ? h('div', { class: 'fader', tabindex: 0, role: 'slider', 'aria-label': P.name }, h('div', { class: 'fcap' }))
    : h('div', { class: 'enc', tabindex: 0, role: 'slider', 'aria-label': P.name, style: `--c:${color}` }, h('div', { class: 'cap' }));
  ctl.title = (P.cc ? `MIDI CC ${P.cc} · ` : '') + 'drag, scroll or arrow keys · double-click resets';
  ctl.setAttribute('aria-valuemin', 0); ctl.setAttribute('aria-valuemax', 100);
  const val = h('div', { class: 'encval' });
  let u = toUnit(P, io.get());
  const draw = () => { ctl.style.setProperty('--u', u); const v = fromUnit(P, u); val.textContent = fmt(P, v); ctl.setAttribute('aria-valuenow', Math.round(u * 100)); ctl.setAttribute('aria-valuetext', fmt(P, v)); ctl.classList.toggle('locked', io.locked()); };
  const move = (nu) => { nu = Math.max(0, Math.min(1, nu)); if (P.step) nu = toUnit(P, fromUnit(P, nu)); if (nu === u) return; u = nu; io.set(fromUnit(P, u)); draw(); };
  let drag = null;
  ctl.addEventListener('pointerdown', (ev) => { ev.preventDefault(); ctl.setPointerCapture(ev.pointerId); ctl.focus(); drag = { y: ev.clientY, u }; });
  ctl.addEventListener('pointermove', (ev) => { if (drag) move(drag.u + (drag.y - ev.clientY) / (ev.shiftKey ? 800 : fader ? 110 : 180)); });
  const end = () => { drag = null; };
  ctl.addEventListener('pointerup', end); ctl.addEventListener('pointercancel', end);
  ctl.addEventListener('wheel', (ev) => { ev.preventDefault(); move(u - ev.deltaY / (ev.shiftKey ? 4000 : 1200)); }, { passive: false });
  ctl.addEventListener('keydown', (ev) => {
    const d = P.step ? P.step / (P.max - P.min) : ev.shiftKey ? 0.1 : 0.01;
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowRight') { ev.preventDefault(); ev.stopPropagation(); move(u + d); }
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowLeft') { ev.preventDefault(); ev.stopPropagation(); move(u - d); }
  });
  ctl.addEventListener('dblclick', () => { io.reset(); u = toUnit(P, io.get()); draw(); });
  draw();
  knobEls.set(P.id, { show: () => { u = toUnit(P, io.get()); draw(); } });
  return h('div', { class: 'encw' }, ctl, val, label);
}
function knobSet(id) { knobEls.get(id)?.show(); }

// --- Machina: a machine-drum panel with a 16-64 step sequencer and parameter locks
const MD_PARAMS = ['m', 'pitch', 'decay', 'tone', 'snap', 'crush', 'level', 'pan'];
function mdView(sq) { const v = new StepSeq(sq.nt); v.load(sq.snapshot()); v.applyUpTo(Infinity); return v; }
function renderMachina(e, def, unit) {
  const k = key(S.me, e.r), sq = seqs.get(k), tracks = def.seq.tracks;
  if (S.mdTrack == null || S.mdTrack >= tracks.length) S.mdTrack = 0;
  const v = mdView(sq);
  if (S.mdPage * 16 >= v.len) S.mdPage = 0;
  const lcd = h('div', { class: 'md-lcd' });
  const master = h('div', { class: 'md-master' }, ...['drive', 'bits', 'level'].map((id, i) => {
    const P = def.params.find((p) => p.id === id);
    return paramControl(P, '#d9dbe0', { get: () => e.cfg.params[id] ?? P.def, set: (x) => setParam(e, id, x), reset: () => setParam(e, id, def.presets[e.cfg.patch]?.[id] ?? P.def), locked: () => false }, skinOf(def));
  }));
  const trackKeys = tracks.map((t, i) => {
    const P = def.params.find((p) => p.id === `${t.id}.m`);
    const b = h('button', { class: 'md-key' + (i === S.mdTrack ? ' sel' : ''), title: `${t.label}: select track (and hear it)`,
      onclick: () => { S.mdTrack = i; S.held = null; renderMachina(e, def, unit); playNote(true, t.note, 100, 0); setTimeout(() => playNote(false, t.note, 0, 0), 60); } },
      h('i'), t.label, h('small', {}, P.options[Math.round(e.cfg.params[`${t.id}.m`] ?? 0)]));
    return b;
  });
  const encWrap = h('div', { class: 'md-encs' });
  const lenBtns = [16, 32, 48, 64].map((n) => h('button', { class: 'md-btn', onclick: () => seqEdit(e, ['len', n]) }, String(n)));
  const pageBtns = [0, 1, 2, 3].map((p) => h('button', { class: 'md-btn', onclick: () => { S.mdPage = p; renderMachinaDyn(true); } }, String(p + 1)));
  const playBtn = h('button', { class: 'md-btn play', onclick: () => seqEdit(e, ['play', Math.ceil(tempo.beatAt(clock.now() + editLead() + 30) / 4 - 1e-9) * 4]) }, '▶ PLAY');
  const stopBtn = h('button', { class: 'md-btn', onclick: () => seqEdit(e, ['stop', tempo.beatAt(clock.now() + editLead() + 5)]) }, '■ STOP');
  const lockBtn = h('button', { class: 'md-btn lockbtn' + (S.mdLock ? ' on' : ''), title: 'Lock mode: click a trig to lock parameters on it (or just hold a trig and turn a knob)', onclick: () => { S.mdLock = !S.mdLock; S.held = null; renderMachina(e, def, unit); } }, 'LOCK');
  const clrBtn = h('button', { class: 'md-btn', title: 'Clear this track', onclick: () => seqEdit(e, ['clr', S.mdTrack]) }, 'CLR');
  const trigEls = Array.from({ length: 16 }, (_, i) => {
    const el = h('div', { class: 'md-trig', role: 'button', tabindex: 0, 'aria-label': `Step ${i + 1}` }, h('i'), h('span'));
    let holdT = null, down = false;
    el.addEventListener('pointerdown', (ev) => {
      ev.preventDefault(); el.setPointerCapture(ev.pointerId);
      const step = S.mdPage * 16 + i;
      if (S.mdLock || ev.shiftKey) { S.held = S.held && S.held.step === step ? null : { track: S.mdTrack, step }; renderMdEncoders(e, def); renderMachinaDyn(true); return; }
      down = true;
      holdT = setTimeout(() => { S.held = { track: S.mdTrack, step, byHold: true }; renderMdEncoders(e, def); renderMachinaDyn(true); }, 230);
    });
    const up = () => {
      if (!down) return; down = false; clearTimeout(holdT);
      const step = S.mdPage * 16 + i;
      if (S.held && S.held.byHold) { S.held = null; renderMdEncoders(e, def); renderMachinaDyn(true); return; }
      const cur = mdView(sq).trig[S.mdTrack][step];
      seqEdit(e, ['t', S.mdTrack, step, cur ? 0 : 1]);
    };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', () => { down = false; clearTimeout(holdT); });
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); const step = S.mdPage * 16 + i; seqEdit(e, ['t', S.mdTrack, step, mdView(sq).trig[S.mdTrack][step] ? 0 : 1]); } });
    return el;
  });
  const cfg = h('div', { class: 'screen lcd', style: 'grid-template-columns:repeat(5,minmax(0,1fr));min-height:0;padding:6px 10px' }, ...configFields(e, def, unit));
  S.md = { e, def, k, lcd, trackKeys, lenBtns, pageBtns, playBtn, stopBtn, lockBtn, trigEls, encWrap, rev: -1 };
  $('#plate').replaceChildren(
    h('div', { class: 'md-top' }, h('div', { class: 'md-logo' }, unit ? unit.model.toUpperCase() : 'MACHINA', h('small', {}, unit ? 'HEARD AS MACHINA' : 'SYNTHESIS DRUM MACHINE')), lcd, master),
    cfg,
    h('div', { class: 'md-tracks' }, ...trackKeys),
    encWrap,
    h('div', { class: 'md-transport' }, playBtn, stopBtn, h('span', { class: 'md-sep' }), h('span', { class: 'md-hint' }, 'LEN'), ...lenBtns, h('span', { class: 'md-sep' }), h('span', { class: 'md-hint' }, 'PAGE'), ...pageBtns, h('span', { class: 'md-sep' }), lockBtn, clrBtn,
      h('span', { class: 'md-hint', style: 'margin-left:auto' }, 'tap a trig to toggle · hold it (or shift-click, or LOCK) and turn a knob to p-lock')),
    h('div', { class: 'md-trigs' }, ...trigEls),
    deviceFoot(e, def, unit));
  renderMdEncoders(e, def);
  renderMachinaDyn(true);
}
function renderMdEncoders(e, def) {
  if (!S.md) return;
  const t = def.seq.tracks[S.mdTrack], sq = seqs.get(key(S.me, e.r));
  const held = S.held && S.held.track === S.mdTrack ? S.held : null;
  knobEls = new Map();
  S.md.encWrap.replaceChildren(...MD_PARAMS.map((x, i) => {
    const id = `${t.id}.${x}`, P = def.params.find((p) => p.id === id);
    const lockOf = () => (held ? (mdView(sq).locks.get(held.track + ':' + held.step) || {})[id] : undefined);
    const io = {
      get: () => { const l = lockOf(); return l != null ? l : e.cfg.params[id] ?? P.def; },
      set: (v) => { if (held && x !== 'm') seqEdit(e, ['l', held.track, held.step, id, v]); else { setParam(e, id, v); if (x === 'm') renderMachinaDyn(true, true); } },
      reset: () => { if (held) seqEdit(e, ['l', held.track, held.step, id, null]); else setParam(e, id, def.presets[e.cfg.patch]?.[id] ?? P.def); },
      locked: () => lockOf() != null,
    };
    return paramControl({ ...P, name: P.name }, KNOB_COLORS[i % 4], io, skinOf(def));
  }));
}
// the live parts of the Machina panel (playhead, LEDs, pattern), refreshed ten times a second
function renderMachinaDyn(force = false, relabel = false) {
  const md = S.md; if (!md) return;
  const sq = seqs.get(md.k); if (!sq) return;
  const now = clock.now(), v = mdView(sq), tr = S.mdTrack, tracks = md.def.seq.tracks, t = tracks[tr];
  const pages = v.len / 16;
  const head = sq.playing && now >= tempo.timeOf(sq.startBeat) ? Math.floor((tempo.beatAt(now) - sq.startBeat) * 4) % sq.len : -1;
  md.trigEls.forEach((el, i) => {
    const step = S.mdPage * 16 + i;
    el.classList.toggle('on', !!v.trig[tr][step]);
    el.classList.toggle('lk', v.locks.has(tr + ':' + step));
    el.classList.toggle('head', step === head);
    el.classList.toggle('held', !!(S.held && S.held.step === step && S.held.track === tr));
    el.querySelector('span').textContent = String(step + 1);
  });
  md.trackKeys.forEach((b, i) => {
    const ht = S.hits.get(md.k + ':' + i);
    b.classList.toggle('hit', ht != null && now >= ht && now - ht < 110);
    if (relabel) { const P = md.def.params.find((p) => p.id === `${tracks[i].id}.m`); b.querySelector('small').textContent = P.options[Math.round(md.e.cfg.params[`${tracks[i].id}.m`] ?? 0)]; }
  });
  md.lenBtns.forEach((b, i) => b.classList.toggle('on', v.len === (i + 1) * 16));
  md.pageBtns.forEach((b, i) => { b.disabled = i >= pages; b.classList.toggle('on', i === S.mdPage); });
  md.playBtn.classList.toggle('on', v.playing);
  const mP = md.def.params.find((p) => p.id === `${t.id}.m`);
  const held = S.held && S.held.track === tr ? S.held : null;
  md.lcd.replaceChildren(
    h('div', {}, h('b', {}, `TRK ${String(tr + 1).padStart(2, '0')} ${t.label}`), ` · ${mP.options[Math.round(md.e.cfg.params[`${t.id}.m`] ?? 0)]} · ${cap(md.e.cfg.patch)} kit`),
    h('div', { class: 'row2' }, held ? `LOCK  STEP ${held.step + 1}  · turn a knob (double-click clears it)` : `${v.playing ? '▶ PLAY' : '■ STOP'} · ${v.len} STEPS · PAGE ${S.mdPage + 1}/${pages} · ${Math.round(tempo.bpm(now))} BPM${head >= 0 ? ` · STEP ${head + 1}` : ''}`));
}

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

// --- the gear wall (library) and the hardware desk
function openDrawer(id) { $(id).classList.remove('hide'); }
function closeDrawers() { $$('.drawer').forEach((d) => d.classList.add('hide')); }
function libCard(meta, def) {
  const id = meta.id, name = def?.name || meta.name;
  const status = h('span', { class: 'help' });
  const withDef = async (fn) => {
    try { status.textContent = def ? '' : 'Loading…'; const d = await engine.ensureDef(id); status.textContent = ''; fn(d); }
    catch (err) { status.textContent = "Couldn't load it: " + err.message; }
  };
  return h('div', { class: 'card' },
    iconEl(def || { id, icon: meta.icon }), h('div', { class: 'fam' }, def?.family || meta.family), h('div', { class: 'name' }, name), h('p', {}, def?.blurb || meta.blurb || ''),
    def ? h('div', { class: 'chips' }, ...Object.keys(def.presets).slice(0, 8).map((t) => h('span', { class: 'chip' }, patchName(def, t))), Object.keys(def.presets).length > 8 ? h('span', { class: 'chip' }, `+${Object.keys(def.presets).length - 8}`) : null) : null,
    h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: () => withDef((d) => audition(engine.resolve({ inst: d.id }))) }, 'Audition'),
      h('button', { class: 'btn small hot', onclick: () => withDef((d) => { addEntry({ inst: d.id }); closeDrawers(); }) }, 'Put it on my desk')),
    status);
}
function renderLibrary() {
  if (S.libTab !== 'builtin' && S.libTab !== 'add' && !engine.libs.has(S.libTab)) S.libTab = 'builtin';
  const tab = (id, label) => h('button', { class: 'page' + (S.libTab === id ? ' on' : ''), onclick: () => { S.libTab = id; renderLibrary(); } }, label);
  $('#libTabs').replaceChildren(tab('builtin', 'Built in'), ...[...engine.libs.values()].map((l) => tab(l.id, l.name)), tab('add', '+ Add a library'));
  const cards = $('#libCards'), extra = $('#libExtra');
  extra.replaceChildren();
  if (S.libTab === 'builtin') {
    cards.replaceChildren(...[...engine.defs.values()].filter((d) => !d.lib && !d.internal).map((d) => libCard({ id: d.id, name: d.name, family: d.family, blurb: d.blurb }, d)));
  } else if (S.libTab === 'add') {
    cards.replaceChildren();
    const inp = h('input', { type: 'text', placeholder: 'github:owner/repo   or   http://localhost:8780/jamjam/', style: 'flex:1;min-width:260px', onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') add(); } });
    const msg = h('p', { class: 'help', style: 'margin:0' });
    const add = async () => {
      msg.textContent = 'Looking…';
      try { const lib = await engine.addLibrary(inp.value); saveLibs(); S.libTab = lib.id; renderLibrary(); retryStandins(); }
      catch (err) { msg.textContent = err.message; }
    };
    extra.replaceChildren(
      h('div', { class: 'row', style: 'display:flex;gap:8px;flex-wrap:wrap' }, inp, h('button', { class: 'btn hot', onclick: add }, 'Add library')), msg,
      h('p', { class: 'help', style: 'margin:0' }, 'A library is any folder with a jamjam.json listing instruments. Use github:owner/repo (or owner/repo@branch/path) for a public GitHub repo, or the address of a library served from your own machine, such as a private build a friend shared with you. Libraries you add are remembered in this browser.'),
      h('p', { class: 'help', style: 'margin:0' }, 'Public libraries load automatically for your bandmates when you play from them. A private library\'s address is never shared: each jammer adds their own copy, and anyone without it hears the closest built-in stand-in.'));
  } else {
    const lib = engine.libs.get(S.libTab);
    cards.replaceChildren(...lib.entries.map((id) => libCard(engine.catalog.get(id), engine.defs.get(id))));
    extra.replaceChildren(h('div', { class: 'row', style: 'display:flex;gap:10px;align-items:center' },
      h('span', { class: 'help' }, `${lib.name}${lib.by ? ' by ' + lib.by : ''} · ${lib.entries.length} instruments · ${lib.private ? 'private: its address stays in this browser' : 'public'} · ${lib.url}`),
      h('button', { class: 'btn small ghost', onclick: () => { engine.removeLibrary(lib.id); saveLibs(); S.libTab = 'builtin'; renderLibrary(); } }, 'Remove library')));
  }
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
    h('div', { class: 'cards' }, ...cands.map((c) => {
      const d = engine.defs.get(c.inst), cfg = engine.resolve({ hw: unit.id, inst: c.inst });
      return h('div', { class: 'card' },
        iconEl(d),
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
  setText(el, String(Math.round(tempo.bpm(clock.now() + 1000))).padStart(3, '0'));
  setText($('#tempoNote'), room.peers.size && !clock.isLeader ? 'set by the clock leader' : '');
}
function renderLook() {
  const L = lookahead(), e = selEntry();
  setText($('#lookVal'), room.peers.size ? `${L} ms` : 'SOLO');
  const mw = Math.round(Math.min(100, (L / 300) * 100)) + '%'; if ($('#lookMeter').style.width !== mw) $('#lookMeter').style.width = mw;
  setCls($('#lookAutoBtn'), 'on', S.lookOverride == null);
  const s = $('#lookSlider'); if (document.activeElement !== s) s.value = L;
  if (!e) return;
  const b = BUDGETS[budgetOf(e)].label.toLowerCase(), pl = partLook(e);
  setText($('#lookHelp'), !room.peers.size ? 'Alone in the studio: notes play the moment you press them.'
    : S.quant ? `Notes snap to the next ${{ 1: 'beat', 0.5: '8th', 0.25: '16th' }[S.quant]} at least ${pl} ms away, so the band hears them land together.`
    : selfInstant(e) ? `${describe(e.cfg, true)} · ${b} timing: you hear it instantly, the band hears it ${pl} ms later, all together.`
    : `${describe(e.cfg, true)} · ${b} timing: every note, yours included, sounds ${pl} ms after you play it, at the same instant for everyone. Play a touch ahead, like an organist.`);
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
  const held = new Map();
  for (const [k, c] of engine.ch) { const pid = pidOf(k); if (pid === S.me || pid === 'audition' || !c.held.size) continue; for (const n of c.held) (held.get(n) || held.set(n, []).get(n)).push(colorOf(pid)); }
  for (const [n, el] of keyEls) {
    const who = held.get(n) || [];
    setVar(el, '--dots', who.length ? who.map((c, i) => `radial-gradient(circle at ${50 + (i - (who.length - 1) / 2) * 24}% 84%, ${c} 0 4px, transparent 5px)`).join(',') : 'none');
  }
}

function applyVolume(k) {
  const c = engine.ch.get(k); if (!c || !engine.ctx) return;
  const pid = pidOf(k), v = S.vol.get(pid) || { vol: 1, mute: false };
  let twinMuted = false;
  if (pid === S.me) { const e = entry(+k.slice(k.indexOf(':') + 1)); twinMuted = !!(e && (e.cfg.hw || e.cfg.ext) && !e.hearTwin); }
  else if (S.routes.get(k)?.mute && S.routes.get(k)?.port) twinMuted = true;  // you hear it on your own MIDI gear
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

// ---------- MIDI out: a bandmate's part on your gear, and the room's clock ----------
function routeOut(k, ev) {
  const r = S.routes.get(k); if (!r || !r.port) return;
  const port = outPort(r.port); if (!port) return;
  const oc = ((r.ch || 1) - 1) & 15, t = clock.toLocal(ev.at) - (r.lat || 0);
  if (ev.type === 'on') sendToHardware(port, [0x90 | oc, ev.note, ev.vel ?? 100], t);
  else if (ev.type === 'off') sendToHardware(port, [0x80 | oc, ev.note, 0], t);
  else if (ev.type === 'p' && ev.id === 'bend') sendToHardware(port, bendBytes(r.ch || 1, ev.v), t);
  else if (ev.type === 'p') {
    // a knob with a MIDI CC goes out as that CC
    const cfg = cfgOfKey(k), def = cfg && engine.defs.get(cfg.inst), P = def?.params.find((x) => x.id === ev.id);
    if (P && P.cc) sendToHardware(port, [0xb0 | oc, P.cc, Math.round(toUnit(P, ev.v) * 127)], t);
  }
}
function setRoute(k, patch) {
  const was = S.routes.get(k) || { port: '', ch: 1, lat: 0, mute: true };
  const r = { ...was, ...patch };
  if (was.port && (r.port !== was.port || r.ch !== was.ch)) { const p = outPort(was.port); if (p) sendToHardware(p, [0xb0 | ((was.ch - 1) & 15), 123, 0], performance.now()); } // all notes off
  if (r.port) S.routes.set(k, r); else S.routes.delete(k);
  applyVolume(k); renderMidiPanel();
}
// MIDI clock: 24 ticks per beat from the shared tempo, Start on a bar, so every jammer's drum machines run in phase
setInterval(() => {
  const m = S.mclock;
  if (!S.me || !m.on || !m.port) return;
  const port = outPort(m.port); if (!port) return;
  const now = clock.now(), horizon = now + 100;
  if (m.next == null) {
    const bar = Math.ceil(tempo.beatAt(now + 150) / 4 - 1e-9) * 4;
    const t = clock.toLocal(tempo.timeOf(bar)) - m.lat;
    sendToHardware(port, [0xf2, 0, 0], t - 1);   // song position: the top
    sendToHardware(port, [0xfa], t);             // start
    m.next = bar * 24; m.startBar = bar;
  }
  for (let guard = 0; guard < 200; guard++) {
    const t = tempo.timeOf(m.next / 24);
    if (t > horizon) break;
    if (t >= now - 20) sendToHardware(port, [0xf8], clock.toLocal(t) - m.lat);
    m.next++;
  }
}, 20);
function setClock(patch) {
  const m = S.mclock, wasOn = m.on && m.port;
  if (wasOn && (patch.on === false || (patch.port != null && patch.port !== m.port))) { const p = outPort(m.port); if (p) sendToHardware(p, [0xfc], performance.now()); }
  Object.assign(m, patch);
  if (!m.on || !m.port || patch.port != null || patch.on) m.next = null;
  renderMidiPanel();
}
function renderMidiPanel() {
  const box = $('#midiBody'); if (!box) return;
  const ports = input.outputs;
  const portSel = (value, on, label) => h('select', { class: 'lcdsel', 'aria-label': label, onchange: (e) => on(e.target.value) }, h('option', { value: '' }, ports.length ? '— off —' : 'no outputs'), ...ports.map((o) => h('option', { value: o.id, selected: o.id === value }, o.name)));
  const chSel = (value, on) => h('select', { class: 'lcdsel', 'aria-label': 'Channel', onchange: (e) => on(+e.target.value) }, ...Array.from({ length: 16 }, (_, i) => h('option', { value: i + 1, selected: i + 1 === value }, `ch ${i + 1}`)));
  const parts = [];
  for (const [pid, pl] of S.players) for (const x of pl.rack || []) parts.push({ k: key(pid, x.r), who: pl.name, what: describe(x.cfg) });
  const m = S.mclock;
  box.replaceChildren(
    input.midi ? h('p', { class: 'help', style: 'margin:0' }, `${ports.length} MIDI output${ports.length === 1 ? '' : 's'}${input.inputs.length ? ` · ${input.inputs.length} input${input.inputs.length === 1 ? '' : 's'}` : ''}. Everything here is sent ahead and timestamped, so it lands in lockstep with the room.`)
      : h('div', { class: 'row' }, h('button', { class: 'btn small hot', onclick: async () => { await input.enableMIDI(); renderMidiPanel(); renderDevice(); } }, 'Enable MIDI'), h('span', { class: 'help' }, 'Chrome, Edge or Firefox.')),
    h('h3', { class: 'legend', style: 'margin:8px 0 0' }, 'Clock out'),
    h('p', { class: 'help', style: 'margin:0' }, 'Sends the room tempo as MIDI clock (24 per beat) with Start on the next bar, so drum machines and sequencers follow the band.'),
    h('div', { class: 'row' }, portSel(m.port, (v) => setClock({ port: v, on: !!v }), 'Clock output'),
      h('button', { class: 'btn small' + (m.on && m.port ? ' on' : ''), disabled: !m.port, onclick: () => setClock({ on: !m.on }) }, m.on && m.port ? 'Running' : 'Stopped'),
      h('label', { class: 'help' }, 'early ', h('input', { type: 'number', min: 0, max: 80, value: m.lat, style: 'width:52px', onkeydown: (e) => e.stopPropagation(), onchange: (e) => { m.lat = Math.max(0, Math.min(80, +e.target.value || 0)); } }), ' ms')),
    h('h3', { class: 'legend', style: 'margin:8px 0 0' }, "The band's parts on your gear"),
    h('p', { class: 'help', style: 'margin:0' }, parts.length ? "Pick an output and channel to play a bandmate's part (notes, pitch bend, mapped knobs, sequencer hits) on your own synth or DAW, at the moment the room hears it." : 'When bandmates walk in, their parts show up here.'),
    ...parts.map(({ k, who, what }) => {
      const r = S.routes.get(k) || { port: '', ch: 1, mute: true };
      return h('div', { class: 'row', style: 'border-top:1px solid #222428;padding-top:6px' },
        h('span', { style: 'flex:1 1 100%;font-size:12px' }, h('b', {}, who), ' · ', what),
        portSel(r.port, (v) => setRoute(k, { port: v }), `Output for ${who}'s ${what}`), chSel(r.ch || 1, (v) => setRoute(k, { ch: v })),
        h('label', { class: 'help' }, h('input', { type: 'checkbox', checked: r.mute !== false, onchange: (e) => setRoute(k, { mute: e.target.checked }) }), ' mute in browser'));
    }));
}

// ---------- side panels ----------
function closePanels() { $$('.sidepanel').forEach((p) => p.classList.add('hide')); $$('.sidetab').forEach((t) => t.classList.remove('on')); }
function togglePanel(id) {
  const p = $('#' + id), open = p.classList.contains('hide');
  closePanels();
  if (open) { p.classList.remove('hide'); $(`.sidetab[data-panel="${id}"]`).classList.add('on'); if (id === 'panel-chat') { S.unread = 0; $('#chatBadge').classList.add('hide'); setTimeout(() => $('#chatIn').focus(), 30); } if (id === 'panel-wire') renderNet(); if (id === 'panel-midi') renderMidiPanel(); }
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
  if (notify && !item.sys && item.from !== S.me && $('#panel-chat').classList.contains('hide')) { S.unread++; $('#chatBadge').textContent = S.unread; $('#chatBadge').classList.remove('hide'); }
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
  try { await engine.start(); if (!engine.defs.size) { await engine.loadInstruments('.'); await restoreLibs(); } }
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
  seqs.clear(); S.md = null;
  S.me = null; S.players.clear(); S.sync.clear(); S.stable.clear(); S.slackRep.clear(); S.needs.clear();
  S.loopActive = false; S.lookAuto = 0; S.chat = []; $('#chatLog').replaceChildren();
  clock.setLeader(true); clock.offset = 0;
  $('#studio').classList.add('hide'); $('#lobby').classList.remove('hide'); closePanels();
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
  $('#addExtBtn').onclick = async () => { if (!input.midi) await input.enableMIDI(); addEntry({ ext: { name: 'My synth', port: input.outputs[0]?.id || '', ch: 1 } }); };
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
  $$('.sidetab').forEach((t) => t.onclick = () => togglePanel(t.dataset.panel));
  $$('[data-closepanel]').forEach((b) => b.onclick = closePanels);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanels(); });
  wireKeyboard();
}

setInterval(() => {
  if (!S.me) return;
  computeAutoL();
  updateCorners(); renderLook(); paintRemoteKeys(); renderTempo(); renderMachinaDyn();
  setCls($('#onAir'), 'live', [...room.peers.values()].some((p) => p.path !== 'connecting'));
  const now = performance.now();
  for (const e of S.rack) { const c = engine.ch.get(key(S.me, e.r)); for (const led of $$(`#rackList [data-led="${key(S.me, e.r)}"]`)) if (c) setCls(led, 'lit', now - c.flashT < 120 || c.held.size > 0); }
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
  addExternal: async (name, port, ch, twin) => { if (!input.midi) await input.enableMIDI(); return addEntry({ ext: { name, port, ch }, inst: twin })?.r; },
  enableMIDI: () => input.enableMIDI(),
  route: (k, patch) => setRoute(k, patch),
  clockOut: (patch) => setClock(patch),
  midiLog: () => input.mockLog || [],
  addLibrary: async (u) => { const l = await engine.addLibrary(u); saveLibs(); retryStandins(); return l.id; },
  addFromLibrary: async (id, patch) => { await engine.ensureDef(id); return addEntry({ inst: id, patch })?.r; },
});
wire();
