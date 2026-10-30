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

const qs = new URLSearchParams(location.search);
const SERVER = qs.get('server') || window.MP_SERVER || 'wss://crush-commando-mp.samuelling.workers.dev';
const MAX = 4;
const COLORS = ['#ff8a5c', '#56c8f0', '#b9e35f', '#c98cff'];
const PARAM_SEND_MS = 30;
const VERSION = '0.1';

const clock = new SharedClock();
const tempo = new Tempo(96);
const engine = new Engine(clock, tempo);
const S = {
  name: '', me: null, cfg: null, source: 'soft',
  hearSelf: false, quant: 0, lookAuto: 0, lookOverride: null, hwLatency: 0, hearTwin: false, midiOut: '',
  players: new Map(), // pid -> {name, cfg, lane, hashes, peerL}
  sync: new Map(),    // pid -> {ok, at, bad}
  stable: new Map(),  // pid -> performance.now() when its channel became comparable
  seq: 0, shifts: new Map(), onAt: new Map(),
  pendingP: new Map(), lastPSend: new Map(),
  lockedAt: 0,
  slackRep: new Map(), loopActive: false,
};
window.JJ = { clock, tempo, engine, S };

// ---------- the room ----------
const room = new Room({
  server: SERVER, maxPeers: MAX, p2p: qs.get('p2p') !== '0',
  handlers: {
    status(kind, text) { setStatus(text, kind); if (kind === 'in') onEntered(); },
    roster() { updateLeader(); renderPlayers(); },
    peerOpen(p) { sayHello(p.id); },
    peerLeft(p) { engine.removeChannel(p.id); S.players.delete(p.id); S.sync.delete(p.id); S.stable.delete(p.id); renderPlayers(); },
    message: onMessage,
    binary(p, buf) { const c = decodeChunk(buf); if (c && clock.locked) engine.laneChunk(p.id, c.start, c.delay, c.rate, c.samples); },
  },
});
window.JJ.room = room;

const lane = new AudioLane(engine, (buf) => room.sendBinary(buf));

function leaderId() {
  let best = { id: room.id, n: room.n };
  for (const p of room.peers.values()) if (p.n && p.n < best.n) best = { id: p.id, n: p.n };
  return best.id;
}
const amLeader = () => leaderId() === room.id;
function updateLeader() {
  const was = clock.isLeader;
  clock.setLeader(amLeader());
  if (clock.isLeader && !was) S.lockedAt = performance.now();
  if (!clock.isLeader) S.lockedAt = 0;
}

function onEntered() {
  if (!room.id || S.me) return;
  S.me = room.id;
  updateLeader();
  if (clock.isLeader) { tempo.start(clock.now(), 96); S.lockedAt = performance.now(); }
  engine.setCfg(S.me, S.cfg, -Infinity);
  S.stable.set(S.me, performance.now());
  S.players.set(S.me, { name: S.name, cfg: S.cfg });
  showJam();
}

function sayHello(id) {
  room.send({ k: 'hello', v: VERSION, name: S.name, cfg: S.cfg, hashes: engine.hashes, lane: { on: lane.on, bars: lane.bars }, L: lookahead() }, id);
  if (clock.isLeader) room.send({ k: 'tempo', segs: tempo.toJSON() }, id);
  startPinging(id);
}

const pingTimers = new Map();
function startPinging(id) {
  clearTimeout(pingTimers.get(id));
  let n = 0;
  const go = () => {
    const p = room.peers.get(id);
    if (!p) return;
    room.send({ k: 'ping', a: performance.now(), at: clock.locked && S.me ? clock.now() + lookahead() : null }, id);
    n++;
    const every = p.path === 'relay' ? 3000 : n < 12 ? 250 : 1000;
    pingTimers.set(id, setTimeout(go, every));
  };
  go();
}

function onMessage(p, m) {
  switch (m.k) {
    case 'ping': room.send({ k: 'pong', a: m.a, b: clock.now() }, p.id); if (m.at != null) noteSlack(p, m.at); break;
    case 'slack': S.slackRep.set(p.id, { s: m.s, t: performance.now() }); break;
    case 'pong': {
      const c = performance.now(), rtt = c - m.a;
      p.rtt.push(rtt); if (p.rtt.length > 30) p.rtt.shift();
      if (p.id === leaderId() && !clock.isLeader) {
        const was = clock.locked;
        clock.sample(m.a, m.b, c);
        if (clock.locked && !was) { S.lockedAt = performance.now(); for (const pid of S.stable.keys()) S.stable.set(pid, S.lockedAt); }
      }
      break;
    }
    case 'hello': {
      const known = S.players.get(p.id);
      S.players.set(p.id, { ...(known || {}), name: m.name, cfg: m.cfg, hashes: m.hashes, lane: m.lane, peerL: m.L, v: m.v });
      if (!known || !known.cfg) { engine.setCfg(p.id, m.cfg, -Infinity); S.stable.set(p.id, performance.now()); applyVolume(p.id); }
      renderPlayers();
      break;
    }
    case 'cfg': {
      const pl = S.players.get(p.id); if (pl) pl.cfg = m.cfg;
      engine.setCfg(p.id, m.cfg, clock.locked ? m.at : -Infinity);
      renderPlayers();
      break;
    }
    case 'ev': {
      if (!S.players.get(p.id)?.cfg) break;
      noteSlack(p, m.ev.at);
      engine.event(p.id, m.ev, { now: !clock.locked });
      const pl = S.players.get(p.id);
      if (m.ev.type === 'p' && pl && pl.cfg && m.ev.id !== 'bend') pl.cfg.params[m.ev.id] = m.ev.v;
      break;
    }
    case 'tempo': if (p.id === leaderId()) { tempo.load(m.segs); engine.metro.next = -1; renderTempo(); } break;
    case 'tempoReq': if (clock.isLeader) setTempo(m.bpm); break;
    case 'lane': { const pl = S.players.get(p.id); if (pl) pl.lane = m.lane; renderPlayers(); break; }
    case 'look': { const pl = S.players.get(p.id); if (pl) pl.peerL = m.L; break; }
    case 'fp': checkFingerprint(p.id, m); break;
  }
}

// ---------- the lookahead: how far ahead every note is scheduled ----------
// It has to cover the trip to the farthest jammer, the jitter on that link, the clock error between you, and that
// jammer's audio output latency (Bluetooth headphones can add 150 ms or more). Rather than guess all of that, every
// listener measures the margin it actually has when your notes (and pings) arrive and reports it back once a second,
// and your lookahead closes in on the smallest value that keeps every listener's margin positive.
const TARGET_MARGIN = 20; // ms of spare time we want every listener to have
function pct(a, q) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }
function noteSlack(p, at) {
  if (!clock.locked || !engine.ctx || at == null) return;
  p.slack = p.slack || [];
  p.slack.push((engine.audioTime(at) - engine.ctx.currentTime) * 1000);
  if (p.slack.length > 80) p.slack.shift();
}
function reportSlack() {
  for (const p of room.peers.values()) {
    if (!p.slack || p.slack.length < 3) continue;
    room.send({ k: 'slack', s: Math.round(Math.min(...p.slack) * 10) / 10 }, p.id);
    p.slack = [];
  }
}
function computeAutoL() {
  if (!room.peers.size) { S.lookAuto = 0; return 0; }
  // before any listener has reported: a cautious estimate from round trips
  let est = 0;
  for (const p of room.peers.values()) est = Math.max(est, p.rtt.length >= 3 ? pct(p.rtt, 0.9) / 2 + 50 : 150);
  if (!S.loopActive) S.lookAuto = Math.max(S.lookAuto, est);
  return S.lookAuto;
}
function adjustL() {
  const now = performance.now();
  const fresh = [...S.slackRep.entries()].filter(([id, r]) => room.peers.has(id) && now - r.t < 2500);
  if (!fresh.length) return;
  S.loopActive = true;
  // positive = a listener needs more time; negative = everyone has room to spare
  const need = Math.max(...fresh.map(([, r]) => TARGET_MARGIN - r.s));
  for (const [id] of fresh) S.slackRep.delete(id);
  S.lookAuto += need > 0 ? need + 3 : need * 0.15; // rise at once, settle gently
  S.lookAuto = Math.min(900, Math.max(5, S.lookAuto));
}
setInterval(() => { reportSlack(); adjustL(); }, 1000);
const lookahead = () => (S.lookOverride != null ? S.lookOverride : Math.round(S.lookAuto));

// ---------- playing ----------
const midiOutPort = () => (S.source === 'hw' && S.midiOut ? input.outputs.find((o) => o.id === S.midiOut) : null);

function sendEvent(ev, { instant }) {
  const solo = room.peers.size === 0;
  if (S.me) engine.event(S.me, ev, { now: instant || solo || !clock.locked });
  if (clock.locked && S.me) room.send({ k: 'ev', ev });
}

function playNote(on, note, vel) {
  if (!S.me) return;
  const now = clock.now(), L = lookahead();
  let at = now + L, shift = 0;
  if (on) {
    if (S.quant && room.peers.size) { const qa = tempo.nextGrid(at, S.quant); shift = qa - at; at = qa; }
    S.shifts.set(note, shift); S.onAt.set(note, at);
  } else {
    at += S.shifts.get(note) || 0; S.shifts.delete(note);
    const onAt = S.onAt.get(note); if (onAt != null && at <= onAt) at = onAt + 5;
  }
  const instant = S.hearSelf && !shift;
  sendEvent({ type: on ? 'on' : 'off', note, vel, at, seq: ++S.seq }, { instant });
  const port = midiOutPort();
  if (port) sendToHardware(port, on ? [0x90, note, vel] : [0x80, note, 0], instant ? performance.now() : clock.toLocal(at) - S.hwLatency);
  flashKey(note, on);
}

function setParam(id, v, { fromUI = false } = {}) {
  if (!S.me) return;
  S.cfg.params[id] = v;
  if (fromUI) renderParamValue(id);
  // coalesce fast knob moves
  S.pendingP.set(id, v);
  const last = S.lastPSend.get(id) || 0, wait = PARAM_SEND_MS - (performance.now() - last);
  if (wait <= 0) flushParam(id); else if (!S.pendingP.timer) S.pendingP.timer = setTimeout(() => { S.pendingP.timer = null; for (const k of [...S.pendingP.keys()]) flushParam(k); }, wait);
}
function flushParam(id) {
  if (!S.pendingP.has(id)) return;
  const v = S.pendingP.get(id); S.pendingP.delete(id);
  S.lastPSend.set(id, performance.now());
  sendEvent({ type: 'p', id, v, at: clock.now() + lookahead(), seq: ++S.seq }, { instant: S.hearSelf });
}

function changeCfg(next) {
  S.cfg = engine.resolve(next);
  S.cfg.source = S.source;
  if (S.cfg.inst === 'kit' && input.octave > 2) input.octave = 2;
  else if (S.cfg.inst !== 'kit' && input.octave < 3) input.octave = 4;
  if (S.me) {
    const at = clock.now() + (room.peers.size ? lookahead() + 20 : 0);
    engine.setCfg(S.me, S.cfg, at);
    room.send({ k: 'cfg', cfg: S.cfg, at });
    S.players.set(S.me, { ...(S.players.get(S.me) || {}), name: S.name, cfg: S.cfg });
    applyVolume(S.me);
  }
  renderMe(); renderPlayers(); renderInputStatus();
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
function stablePids() {
  const now = performance.now(), out = [];
  if (!clock.locked) return out;
  for (const [pid, t] of S.stable) if (now - Math.max(t, S.lockedAt) > 6000) out.push(pid);
  return out;
}
function fingerprintWindow(T) {
  // instrument + parameters as of T, plus the notes in the 4 seconds before T
  const full = engine.fingerprint(T), out = {};
  for (const pid of stablePids()) if (full[pid]) out[pid] = full[pid] + ':' + countNotes(pid, T - 4000, T);
  return out;
}
function countNotes(pid, a, b) { const c = engine.ch.get(pid); if (!c) return 0; let n = 0; for (const t of c.notes) if (t > a && t <= b) n++; return n; }
function sendFingerprint() {
  if (!S.me || !room.peers.size || !clock.locked) return;
  const T = fpTime();
  room.send({ k: 'fp', T, f: fingerprintWindow(T) });
}
function checkFingerprint(from, m) {
  if (!clock.locked) return;
  const mine = fingerprintWindow(m.T), bad = [];
  let compared = 0;
  for (const [pid, hsh] of Object.entries(m.f || {})) {
    if (!mine[pid]) continue;
    compared++;
    if (mine[pid] !== hsh) bad.push(pid);
  }
  if (compared) S.sync.set(from, { ok: bad.length === 0, at: performance.now(), bad });
}
setInterval(sendFingerprint, 2000);

// ---------- input ----------
const input = new Input({
  note: (on, note, vel) => playNote(on, note, vel),
  cc: (cc, val) => {
    const def = engine.defs.get(S.cfg.inst);
    const unit = S.cfg.hw && engine.hardware.hardware.find((x) => x.id === S.cfg.hw);
    let pid = null;
    if (unit && unit.cc) for (const [k, n] of Object.entries(unit.cc)) if (n === cc) pid = k;
    if (!pid) pid = def.params.find((p) => p.cc === cc)?.id;
    if (!pid) return;
    const P = def.params.find((p) => p.id === pid);
    setParam(pid, fromUnit(P, val / 127)); renderParamValue(pid, true);
  },
  bend: (semi) => sendEvent({ type: 'p', id: 'bend', v: semi, at: clock.now() + lookahead(), seq: ++S.seq }, { instant: S.hearSelf }),
  status: (msg) => renderInputStatus(msg),
});
window.JJ.input = input;

const toUnit = (P, v) => P.curve === 'exp' ? Math.log(v / P.min) / Math.log(P.max / P.min) : (v - P.min) / (P.max - P.min);
const fromUnit = (P, u) => {
  let v = P.curve === 'exp' ? P.min * Math.pow(P.max / P.min, u) : P.min + u * (P.max - P.min);
  if (P.step) v = Math.round(v / P.step) * P.step;
  return Math.max(P.min, Math.min(P.max, v));
};
const fmt = (P, v) => {
  if (P.step === 1 && P.max === 1) return v >= 0.5 ? 'on' : 'off';
  if (P.unit === 'Hz') return v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz';
  if (P.unit === 's') return v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(2) + ' s';
  if (P.unit) return (Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + P.unit;
  return P.max <= 1 ? Math.round(v * 100) + '%' : (Math.abs(v) < 10 ? v.toFixed(1) : String(Math.round(v)));
};

// ---------- UI ----------
function setStatus(text, kind = '') { const el = $('#status'); el.textContent = text || ''; el.dataset.kind = kind; }

function showJam() {
  $('#lobby').hidden = true; $('#jam').hidden = false;
  $('#roomCode').textContent = room.code;
  history.replaceState(null, '', `${location.pathname}?room=${room.code}${qs.get('server') ? '&server=' + encodeURIComponent(qs.get('server')) : ''}${qs.get('p2p') === '0' ? '&p2p=0' : ''}`);
  renderMe(); renderPlayers(); renderTempo(); renderKeyboard(); renderInputStatus();
}

const slotOf = (pid) => {
  const all = [{ id: room.id, n: room.n }, ...[...room.peers.values()].map((p) => ({ id: p.id, n: p.n }))].sort((a, b) => a.n - b.n);
  return Math.max(0, all.findIndex((x) => x.id === pid)) % MAX;
};

function describeCfg(cfg) {
  if (!cfg) return 'loading…';
  const def = engine.defs.get(cfg.inst);
  const unit = cfg.hw && engine.hardware.hardware.find((x) => x.id === cfg.hw);
  const patch = cfg.patch ? cfg.patch[0].toUpperCase() + cfg.patch.slice(1) : '';
  if (unit) return `${unit.maker} ${unit.model} · ${patch} → twin: ${def ? def.name : cfg.inst}`;
  return `${def ? def.name : cfg.inst} · ${patch}`;
}

function renderPlayers() {
  const box = $('#players'); if (!box || $('#jam').hidden) return;
  const ids = [S.me, ...[...room.peers.keys()]].filter(Boolean).sort((a, b) => slotOf(a) - slotOf(b));
  const key = ids.join(',') + '|' + ids.map((id) => describeCfg(S.players.get(id)?.cfg)).join('|');
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.replaceChildren(...ids.map((id) => playerCard(id)));
    for (let i = ids.length; i < MAX; i++) box.append(h('div', { class: 'player empty' }, h('div', { class: 'pname' }, 'Open seat'), h('div', { class: 'pmeta' }, 'Send the invite link')));
  }
  updatePlayerStats();
}
function playerCard(id) {
  const pl = S.players.get(id) || {}, mine = id === S.me, slot = slotOf(id), peer = room.peers.get(id);
  const c = engine.ch.get(id);
  const vol = h('input', { type: 'range', min: 0, max: 1.5, step: 0.01, value: c ? c.vol : 1, 'aria-label': 'Volume in your mix', oninput: (e) => { engine.channel(id).vol = +e.target.value; applyVolume(id); } });
  const mute = h('button', { class: 'mini' + (c?.mute ? ' on' : ''), title: 'Mute in your mix', onclick: (e) => { const ch = engine.channel(id); ch.mute = !ch.mute; applyVolume(id); e.target.classList.toggle('on', ch.mute); } }, 'M');
  return h('div', { class: 'player' + (mine ? ' me' : ''), style: `--pc:${COLORS[slot]}`, 'data-pid': id },
    h('div', { class: 'prow' },
      h('span', { class: 'led', 'data-led': id }),
      h('div', { class: 'pname' }, (pl.name || peer?.name || 'Jammer') + (mine ? ' (you)' : '')),
      h('span', { class: 'badge', 'data-path': id }, '')),
    h('div', { class: 'pmeta' }, describeCfg(pl.cfg)),
    h('div', { class: 'pstats', 'data-stats': id }, ''),
    h('div', { class: 'prow mix' }, vol, mute, h('div', { class: 'lanemeter', 'data-lane': id }, h('i'))),
  );
}
function updatePlayerStats() {
  for (const id of [S.me, ...room.peers.keys()]) {
    if (!id) continue;
    const peer = room.peers.get(id), c = engine.ch.get(id), pl = S.players.get(id) || {};
    const led = $(`[data-led="${id}"]`); if (led && c) led.classList.toggle('lit', performance.now() - c.flashT < 140 || c.held.size > 0);
    const badge = $(`[data-path="${id}"]`);
    if (badge) {
      if (id === S.me) { badge.textContent = clock.isLeader ? 'clock leader' : clock.locked ? 'clock synced' : 'syncing clock…'; badge.dataset.kind = clock.locked ? 'ok' : 'wait'; }
      else if (peer) {
        const rtt = peer.rtt.length ? Math.round(pct(peer.rtt, 0.5)) : null;
        badge.textContent = peer.path === 'direct' ? `direct · ${rtt ?? '…'} ms` : peer.path === 'relay' ? `via relay · ${rtt ?? '…'} ms` : 'connecting…';
        badge.dataset.kind = peer.path === 'direct' ? 'ok' : peer.path === 'relay' ? 'warn' : 'wait';
      }
    }
    const st = $(`[data-stats="${id}"]`);
    if (st) {
      const bits = [];
      if (id !== S.me) {
        const sy = S.sync.get(id);
        bits.push(sy && performance.now() - sy.at < 8000 ? (sy.ok ? '✓ same music' : '⚠ out of sync') : 'checking sync…');
        const mism = pl.hashes && Object.entries(engine.hashes).filter(([k, v]) => pl.hashes[k] && pl.hashes[k] !== v).map(([k]) => k);
        if (mism && mism.length) bits.push(`⚠ different ${mism.join(', ')} version — reload both`);
        if (c && c.late) bits.push(`${c.late} late (worst ${Math.round(c.lateWorst)} ms)`);
      }
      if (pl.lane && pl.lane.on) bits.push(`audio lane · ${pl.lane.bars} bar${pl.lane.bars > 1 ? 's' : ''} late`);
      if (id === S.me && lane.on) bits.push(`your audio lane: ${pl.lane?.bars || lane.bars} bar delay`);
      st.textContent = bits.join(' · ');
    }
    const lm = $(`[data-lane="${id}"] i`);
    if (lm) {
      const active = id === S.me ? lane.on : c && performance.now() - c.laneT < 300;
      lm.parentElement.classList.toggle('active', !!active);
      lm.style.width = (id === S.me ? Math.min(1, lane.level * 1.5) : active ? 0.6 : 0) * 100 + '%';
    }
  }
}

function renderTempo() {
  const el = $('#bpm'); if (!el) return;
  if (document.activeElement !== el) el.value = Math.round(tempo.bpm(clock.now()));
  $('#tempoNote').textContent = clock.isLeader ? '' : 'set by the clock leader';
}

let paramEls = new Map();
function renderMe() {
  const box = $('#me'); if (!box || !S.cfg) return;
  const def = engine.defs.get(S.cfg.inst);
  const unit = S.cfg.hw && engine.hardware.hardware.find((x) => x.id === S.cfg.hw);
  $$('input[name=source]').forEach((r) => { r.checked = r.value === S.source; });
  $('#softRow').hidden = S.source !== 'soft';
  $('#hwRow').hidden = S.source !== 'hw';
  const instSel = $('#instSel');
  instSel.replaceChildren(...[...engine.defs.values()].map((d) => h('option', { value: d.id, selected: d.id === S.cfg.inst }, `${d.name} — ${d.family}`)));
  const types = unit ? unit.types.filter((t) => def.presets[t]) : Object.keys(def.presets);
  const patchSel = $('#patchSel');
  patchSel.replaceChildren(...types.map((t) => h('option', { value: t, selected: t === S.cfg.patch }, t[0].toUpperCase() + t.slice(1))));
  $('#patchSel2').replaceChildren(...types.map((t) => h('option', { value: t, selected: t === S.cfg.patch }, t[0].toUpperCase() + t.slice(1))));
  const hwSel = $('#hwSel');
  if (!hwSel.options.length) {
    const groups = {};
    for (const u of engine.hardware.hardware) (groups[engine.hardware.families[u.family]?.label || u.family] ||= []).push(u);
    hwSel.append(h('option', { value: '' }, 'Choose your synth or drum machine…'));
    for (const [label, units] of Object.entries(groups)) hwSel.append(h('optgroup', { label }, ...units.map((u) => h('option', { value: u.id }, `${u.maker} ${u.model}`))));
  }
  hwSel.value = S.cfg.hw || '';
  $('#twinNote').textContent = unit
    ? `Everyone else hears ${def.name}, the ${engine.hardware.families[unit.family].label.toLowerCase()} twin, set up as a ${S.cfg.patch} patch with ${unit.model} character${unit.note ? ' (' + unit.note + ')' : ''}. Shape the knobs below until the twin sounds like your patch.`
    : 'Pick your unit. Other jammers will hear a software twin from the same family.';
  renderMidiOut();
  // knobs
  const knobs = $('#knobs');
  paramEls = new Map();
  knobs.replaceChildren(...def.params.map((P) => {
    const u = toUnit(P, S.cfg.params[P.id] ?? P.def);
    const val = h('span', { class: 'kval' }, fmt(P, S.cfg.params[P.id] ?? P.def));
    const r = h('input', { type: 'range', min: 0, max: 1, step: P.step ? P.step / (P.max - P.min) : 0.001, value: u, 'aria-label': P.name,
      oninput: (e) => setParam(P.id, fromUnit(P, +e.target.value), { fromUI: true }),
      ondblclick: () => { setParam(P.id, def.presets[S.cfg.patch]?.[P.id] ?? P.def, { fromUI: true }); renderParamValue(P.id, true); } });
    paramEls.set(P.id, { r, val, P });
    return h('label', { class: 'knob', title: P.cc ? `MIDI CC ${P.cc} · double-click to reset` : 'Double-click to reset' }, h('span', { class: 'kname' }, P.name), r, val);
  }));
}
function renderParamValue(id, moveSlider = false) {
  const e = paramEls.get(id); if (!e) return;
  const v = S.cfg.params[id];
  e.val.textContent = fmt(e.P, v);
  if (moveSlider) e.r.value = toUnit(e.P, v);
}
function renderMidiOut() {
  const sel = $('#midiOutSel'); if (!sel) return;
  const opts = [h('option', { value: '' }, input.outputs.length ? 'None: I play it directly (local control on)' : 'None (enable MIDI to list outputs)'), ...input.outputs.map((o) => h('option', { value: o.id }, o.name))];
  sel.replaceChildren(...opts); sel.value = S.midiOut;
}
function renderInputStatus(msg) {
  const el = $('#inputStatus'); if (!el) return;
  const midi = input.midi ? `${input.inputs.length} MIDI input${input.inputs.length === 1 ? '' : 's'}` : '';
  el.textContent = msg || [`Octave ${input.octave} (Z X)`, `Velocity ${input.velocity} (C V)`, 'Space: sustain', midi].filter(Boolean).join(' · ');
  if (input.midi) { $('#midiBtn').textContent = 'MIDI on'; $('#midiBtn').classList.add('on'); }
  renderMidiOut();
  renderKeyboard();
}

const DRUMS = { 36: 'Kick', 37: 'Rim', 38: 'Snare', 39: 'Clap', 41: 'Tom', 42: 'Hat', 43: 'Tom', 44: 'Hat', 45: 'Tom', 46: 'Open', 47: 'Tom', 48: 'Tom', 49: 'Crash', 50: 'Tom', 51: 'Ride', 56: 'Bell' };
let keyEls = new Map();
function renderKeyboard() {
  const kb = $('#keyboard'); if (!kb) return;
  const base = 12 * (input.octave + 1), keys = [];
  keyEls = new Map();
  for (let n = base; n < base + 25; n++) {
    const black = [1, 3, 6, 8, 10].includes(n % 12);
    const label = S.cfg && S.cfg.inst === 'kit' ? DRUMS[n] : n % 12 === 0 ? 'C' + (n / 12 - 1) : '';
    const el = h('div', { class: 'key' + (black ? ' black' : ''), 'data-note': n }, label ? h('span', { class: 'klabel' }, label) : null);
    keyEls.set(n, el);
    keys.push(el);
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
    const r = e.target.closest('[data-note]').getBoundingClientRect();
    const vel = Math.round(50 + 77 * Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
    pointers.set(e.pointerId, n); input.press(n, vel);
  });
  kb.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const n = keyFromPoint(e.clientX, e.clientY), was = pointers.get(e.pointerId);
    if (n != null && n !== was) { input.release(was); pointers.set(e.pointerId, n); input.press(n, 90); }
  });
  const up = (e) => { const n = pointers.get(e.pointerId); if (n != null) { pointers.delete(e.pointerId); input.release(n); } };
  kb.addEventListener('pointerup', up); kb.addEventListener('pointercancel', up);
}
function flashKey(note, on) { const el = keyEls.get(note); if (el) el.classList.toggle('down', on); }
function paintRemoteKeys() {
  for (const [n, el] of keyEls) {
    const who = [];
    for (const [pid, c] of engine.ch) if (pid !== S.me && c.held.has(n)) who.push(COLORS[slotOf(pid)]);
    el.style.setProperty('--dots', who.length ? who.map((c, i) => `radial-gradient(circle at ${50 + (i - (who.length - 1) / 2) * 22}% 82%, ${c} 0 5px, transparent 6px)`).join(',') : 'none');
  }
}

function applyVolume(pid) {
  const c = engine.ch.get(pid); if (!c) return;
  const twinMuted = pid === S.me && S.source === 'hw' && !S.hearTwin;
  c.out.gain.setTargetAtTime(c.mute || twinMuted ? 0 : c.vol, engine.ctx.currentTime, 0.02);
}

function renderNet() {
  const tb = $('#netTable'); if (!tb || $('#jam').hidden) return;
  const rows = [h('tr', {}, ...['Jammer', 'Path', 'Round trip', 'Jitter', 'Late notes', 'Their lookahead'].map((t) => h('th', {}, t)))];
  for (const p of room.peers.values()) {
    const pl = S.players.get(p.id) || {}, c = engine.ch.get(p.id);
    const med = p.rtt.length ? pct(p.rtt, 0.5) : null, p90 = p.rtt.length ? pct(p.rtt, 0.9) : null;
    rows.push(h('tr', {}, h('td', {}, pl.name || p.name), h('td', {}, p.path), h('td', {}, med != null ? `${Math.round(med)} ms` : '…'),
      h('td', {}, p90 != null ? `${Math.round(p90 - Math.min(...p.rtt))} ms` : '…'), h('td', {}, c ? String(c.late) : '0'), h('td', {}, pl.peerL != null ? `${pl.peerL} ms` : '…')));
  }
  tb.replaceChildren(...rows);
  $('#netSummary').textContent = `Relay messages sent: ${room.relayed} · clock ${clock.isLeader ? 'leader (you)' : clock.locked ? `synced to within ${clock.errMs.toFixed(1)} ms (worst case)` : 'syncing…'}${lane.on ? ` · audio lane sent ${(lane.sentBytes / 1e6).toFixed(1)} MB` : ''}`;
}

function renderLook() {
  const L = lookahead();
  $('#lookVal').textContent = room.peers.size ? `${L} ms` : '0 ms (solo)';
  $('#lookMode').textContent = S.lookOverride != null ? 'manual' : 'auto';
  const s = $('#lookSlider'); if (document.activeElement !== s) s.value = L;
  $('#lookHelp').textContent = !room.peers.size ? 'Alone in the room, notes play the moment you press them.'
    : S.quant ? `Notes snap to the next ${{ 1: 'beat', 0.5: '8th note', 0.25: '16th note' }[S.quant]} that is at least ${L} ms away, so everyone hears them land together.`
    : S.hearSelf ? `You hear yourself instantly. Everyone else hears your notes ${L} ms after you play them, all at the same moment.`
    : `Every note, yours included, sounds ${L} ms after it's played, at the same instant for everyone in the room. Play slightly ahead, like an organist.`;
}

// ---------- wiring ----------
function randomCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s = ''; for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)]; return s; }

async function enter(code) {
  const name = ($('#nameIn').value || '').trim().slice(0, 16) || 'Jammer';
  code = String(code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (code.length !== 4) { setStatus('Room codes are four letters.', 'error'); return; }
  S.name = name;
  try { localStorage.setItem('jamjam.name', name); } catch (_) {}
  setStatus('Loading instruments…');
  try {
    await engine.start();
    if (!engine.defs.size) await engine.loadInstruments('.');
  } catch (e) { setStatus("Couldn't start audio or load the instruments: " + e.message, 'error'); return; }
  if (!S.cfg) { S.cfg = engine.resolve({ inst: 'poly', patch: 'keys' }); S.cfg.source = 'soft'; }
  room.join(code, name);
}

function leaveRoom() {
  room.leave(); lane.stopLane();
  for (const pid of [...engine.ch.keys()]) engine.removeChannel(pid);
  S.me = null; S.players.clear(); S.sync.clear(); S.stable.clear(); S.slackRep.clear(); S.loopActive = false; S.lookAuto = 0;
  clock.setLeader(true); clock.offset = 0;
  $('#jam').hidden = true; $('#lobby').hidden = false;
  history.replaceState(null, '', location.pathname);
  setStatus('');
}

function wire() {
  try { $('#nameIn').value = localStorage.getItem('jamjam.name') || ''; } catch (_) {}
  const pre = (qs.get('room') || '').toUpperCase();
  if (pre) { $('#codeIn').value = pre; $('#joinBtn').classList.add('primary'); }
  $('#startBtn').onclick = () => enter(randomCode());
  $('#joinBtn').onclick = () => enter($('#codeIn').value);
  $('#codeIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter($('#codeIn').value); });
  $('#leaveBtn').onclick = leaveRoom;
  $('#copyBtn').onclick = async () => {
    const url = `${location.origin}${location.pathname}?room=${room.code}${qs.get('server') ? '&server=' + encodeURIComponent(qs.get('server')) : ''}`;
    try { await navigator.clipboard.writeText(url); $('#copyBtn').textContent = 'Copied'; } catch (_) { prompt('Invite link', url); }
    setTimeout(() => { $('#copyBtn').textContent = 'Copy invite link'; }, 1500);
  };
  $('#bpm').addEventListener('change', (e) => setTempo(+e.target.value));
  $('#metroBtn').onclick = (e) => { engine.metro.on = !engine.metro.on; engine.metro.next = -1; e.target.classList.toggle('on', engine.metro.on); };
  $('#quantSel').onchange = (e) => { S.quant = +e.target.value; renderLook(); };
  $('#selfBtn').onclick = (e) => { S.hearSelf = !S.hearSelf; e.target.classList.toggle('on', S.hearSelf); renderLook(); };
  $('#lookSlider').oninput = (e) => { S.lookOverride = +e.target.value; broadcastLook(); renderLook(); };
  $('#lookAutoBtn').onclick = () => { S.lookOverride = null; broadcastLook(); renderLook(); };
  $$('input[name=source]').forEach((r) => r.onchange = () => {
    S.source = r.value;
    if (S.source === 'soft') changeCfg({ inst: S.cfg.inst, patch: S.cfg.patch }); // keep playing the twin as a soft synth
    else changeCfg({ hw: $('#hwSel').value || engine.hardware.hardware[0].id });
  });
  $('#instSel').onchange = (e) => changeCfg({ inst: e.target.value });
  $('#patchSel').onchange = (e) => changeCfg({ inst: S.cfg.inst, patch: e.target.value });
  $('#patchSel2').onchange = (e) => changeCfg({ hw: S.cfg.hw, patch: e.target.value });
  $('#hwSel').onchange = (e) => { if (e.target.value) changeCfg({ hw: e.target.value }); };
  $('#midiOutSel').onchange = (e) => { S.midiOut = e.target.value; };
  $('#hwLat').oninput = (e) => { S.hwLatency = +e.target.value; $('#hwLatVal').textContent = `${S.hwLatency} ms`; };
  $('#twinBtn').onclick = (e) => { S.hearTwin = !S.hearTwin; e.target.classList.toggle('on', S.hearTwin); applyVolume(S.me); };
  $('#midiBtn').onclick = () => input.enableMIDI();
  $('#panicBtn').onclick = () => { for (const n of [...input.down, ...input.sustained]) input.release(n, true); for (const [, c] of engine.ch) for (const I of c.insts) I.inst.allOff(engine.ctx.currentTime); };
  // audio lane
  $('#laneBtn').onclick = async (e) => {
    if (lane.on) { lane.stopLane(); e.target.textContent = 'Start audio lane'; e.target.classList.remove('on'); }
    else {
      try { await lane.startLane($('#laneDev').value || undefined); }
      catch (err) { $('#laneHelp').textContent = "Couldn't open that input: " + err.message; return; }
      e.target.textContent = 'Stop audio lane'; e.target.classList.add('on');
      const devs = await lane.devices(), cur = $('#laneDev').value;
      $('#laneDev').replaceChildren(h('option', { value: '' }, 'Default input'), ...devs.map((d) => h('option', { value: d.deviceId, selected: d.deviceId === cur }, d.label || 'Input')));
    }
    room.send({ k: 'lane', lane: { on: lane.on, bars: lane.bars } });
    const pl = S.players.get(S.me); if (pl) pl.lane = { on: lane.on, bars: lane.bars };
  };
  $('#laneDev').onchange = async () => { if (lane.on) await lane.startLane($('#laneDev').value || undefined); };
  $('#laneBars').onchange = (e) => { lane.bars = +e.target.value; room.send({ k: 'lane', lane: { on: lane.on, bars: lane.bars } }); const pl = S.players.get(S.me); if (pl) pl.lane = { on: lane.on, bars: lane.bars }; };
  $('#laneQ').onchange = (e) => { lane.quality = e.target.value; };
  $('#laneOff').oninput = (e) => { lane.offsetMs = +e.target.value; $('#laneOffVal').textContent = `${lane.offsetMs > 0 ? '+' : ''}${lane.offsetMs} ms`; };
  wireKeyboard();
}
let lastLookSent = -1;
function broadcastLook() { const L = lookahead(); if (Math.abs(L - lastLookSent) >= 2) { lastLookSent = L; room.send({ k: 'look', L }); } }

setInterval(() => {
  if (!S.me) return;
  computeAutoL();
  updatePlayerStats(); renderLook(); paintRemoteKeys(); renderTempo();
}, 100);
setInterval(() => { if (S.me) { renderNet(); broadcastLook(); } }, 1000);

wire();
