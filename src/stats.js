// Usage stats: anonymous numbers about how real jams go, sent to MEGAjam's own stats Worker (stats/worker.js) for
// the admin dashboard (admin.html). Like the fleet test, but from real use: how long joining takes, direct vs
// relayed links, round trips, the lookahead, clock error, late notes, stalls, devices, how long sessions last and
// where the time goes (playing, Compose Room, Talk, live audio, the song), which instruments get played, and
// JavaScript errors.
//
// What is sent: those numbers, the kind of device and browser, instrument ids, error messages, and a one-way hash
// of the room code (so the sessions of one jam can be grouped). Never names, chat, the notes you play, audio, or
// the room code itself. The Worker adds only the country. Help explains it, and visiting with ?stats=0 turns it
// off in that browser for good (localStorage 'jj:stats' = '0'; ?stats=1 turns it back on).
//
// One report per page load, rebuilt every few seconds and sent each minute and when the page closes; the Worker
// keeps the newest per session.

export const RTT_EDGES = [10, 20, 40, 80, 160, 320, 640, 1280];   // ms; a histogram has one more bucket than edges
export const CLOCK_EDGES = [1, 2, 5, 10, 20, 50, 100];

const bucket = (edges, v) => { let i = 0; while (i < edges.length && v >= edges[i]) i++; return i; };
const add = (h, edges, v) => { h[bucket(edges, v)]++; };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }

function device(ctx) {
  const ua = navigator.userAgent || '';
  const os = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'ios' : /Android/.test(ua) ? 'android' : /Mac OS X/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : /CrOS/.test(ua) ? 'chromeos' : /Linux/.test(ua) ? 'linux' : 'other';
  const br = /Edg\//.test(ua) ? 'edge' : /Firefox\//.test(ua) ? 'firefox' : /OPR\//.test(ua) ? 'opera' : /Chrome\//.test(ua) || /CriOS\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'other';
  return {
    os, br, mobile: /Mobi|Android|iPhone|iPad/.test(ua) || (os === 'ios'),
    cores: navigator.hardwareConcurrency || 0, mem: navigator.deviceMemory || 0,
    sr: ctx?.sampleRate || 0, ol: ctx ? Math.round(((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000) : 0,
    app: matchMedia?.('(display-mode: standalone)').matches || false,
  };
}

// h: { endpoint, room, engine, clock, S, stall, pidOf }
export function startStats(h) {
  const qs = new URLSearchParams(location.search);
  const q = qs.get('stats');
  // ?stats=0 turns reporting off in this browser for good, ?stats=1 back on
  let off = false;
  try {
    if (q === '0') localStorage.setItem('jj:stats', '0'); else if (q === '1') localStorage.removeItem('jj:stats');
    off = localStorage.getItem('jj:stats') === '0';
  } catch (_) { off = q === '0'; }
  const endpoint = q && /^https?:\/\//.test(q) ? q.replace(/\/$/, '') : h.endpoint;
  // automated browsers (our own tests and fleets) stay out of real usage numbers, unless pointed somewhere on purpose
  if (navigator.webdriver && !(q && /^https?:\/\//.test(q))) off = true;
  const api = { use() {}, joining() {}, relayLost() {}, report: null };
  if (off || !endpoint) return api;

  const sid = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join('');
  const t0 = performance.now();
  const R = {
    v: 1, sid, room: '', dur: 0, roomSec: 0, bandSec: 0, peak: 0, joinMs: null, dev: device(null),
    net: { directSec: 0, relaySec: 0, rttDirect: Array(RTT_EDGES.length + 1).fill(0), rttRelay: Array(RTT_EDGES.length + 1).fill(0), rttMax: 0,
      look: Array(RTT_EDGES.length + 1).fill(0), lookMax: 0, clockErr: Array(CLOCK_EDGES.length + 1).fill(0), clockErrMax: 0, relayLost: 0, drops: 0 },
    notes: { played: 0, heard: 0, late: 0, lateWorst: 0 },
    stalls: 0, stallMs: 0, inst: [], hw: 0, used: [], errors: [],
    // where the time goes: seconds playing (a note in that 5 s), in the background, in the Compose Room, with Talk
    // open, sending live audio, with the song playing, listening in
    secs: { active: 0, hidden: 0, compose: 0, talk: 0, lane: 0, song: 0, listen: 0 },
  };
  const seenCh = new Map(), lastPath = new Map(), used = new Set(), inst = new Set();
  let lastTick = performance.now(), joinT = null, stallSeen = 0, dirty = true, live = false, lastPlayed = 0;

  const err = (m, s) => {
    m = String(m || 'error').slice(0, 200); s = String(s || '').replace(location.origin, '').slice(0, 80);
    const e = R.errors.find((x) => x.m === m && x.s === s);
    if (e) e.n++; else if (R.errors.length < 20) R.errors.push({ m, s, n: 1 });
    dirty = true;
  };
  addEventListener('error', (ev) => err(ev.message, ev.filename ? `${ev.filename}:${ev.lineno}` : ''));
  addEventListener('unhandledrejection', (ev) => err('Unhandled: ' + (ev.reason?.message || ev.reason), (ev.reason?.stack || '').split('\n')[1]?.trim()));

  function sample() {
    const now = performance.now(), dt = Math.min(30, (now - lastTick) / 1000); lastTick = now;
    const { room, engine, clock, S } = h;
    R.dur = Math.round((now - t0) / 1000);
    if (!R.dev.sr && engine.ctx) R.dev = device(engine.ctx);
    // the main thread's stalls (the app's own detector logs them)
    for (const [t, ms] of h.stall.log) if (t > stallSeen) { R.stalls++; R.stallMs += Math.round(ms); stallSeen = t; dirty = true; }
    if (document.visibilityState === 'hidden') R.secs.hidden += dt;
    if (!S.me) return;
    R.roomSec += dt;
    if ((S.notesOn || 0) > lastPlayed) { R.secs.active += dt; lastPlayed = S.notesOn; }
    try { const m = h.modes ? h.modes() : {}; for (const k of ['compose', 'talk', 'lane', 'song', 'listen']) if (m[k]) R.secs[k] += dt; } catch (_) {}
    if (room.code && !R.room) R.room = fnv('megajam:' + room.code + ':' + new Date().toISOString().slice(0, 10));
    R.notes.played = S.notesOn || 0;
    for (const e of S.rack) { inst.add(e.cfg.inst); if (e.cfg.hw) R.hw = Math.max(R.hw, S.rack.filter((x) => x.cfg.hw).length); }
    R.inst = [...inst].slice(0, 24);
    const peers = [...room.peers.values()];
    if (peers.length) R.bandSec += dt;
    R.peak = Math.max(R.peak, peers.length);
    for (const p of peers) {
      if (p.path === 'direct') R.net.directSec += dt; else if (p.path === 'relay') R.net.relaySec += dt;
      if (lastPath.get(p.id) === 'direct' && p.path === 'relay') R.net.drops++;
      lastPath.set(p.id, p.path);
      if (p.rtt && p.rtt.length >= 3 && p.path !== 'connecting') {
        const r = med(p.rtt.slice(-5));
        add(p.path === 'relay' ? R.net.rttRelay : R.net.rttDirect, RTT_EDGES, r);
        R.net.rttMax = Math.max(R.net.rttMax, Math.round(r));
      }
    }
    if (peers.length && S.loopActive) { add(R.net.look, RTT_EDGES, S.lookAuto || 0); R.net.lookMax = Math.max(R.net.lookMax, Math.round(S.lookAuto || 0)); }
    if (peers.length && !clock.isLeader && clock.locked && Number.isFinite(clock.errMs)) { add(R.net.clockErr, CLOCK_EDGES, clock.errMs); R.net.clockErrMax = Math.max(R.net.clockErrMax, Math.round(clock.errMs * 10) / 10); }
    // join time: from the join click to every bandmate linked up and introduced
    if (joinT != null && peers.length && peers.every((p) => p.path !== 'connecting') && S.players.size >= peers.length) { R.joinMs = Math.round(now - joinT); joinT = null; }
    // notes heard from bandmates: counted per channel as they grow (a channel goes when its player leaves)
    for (const [k, c] of engine.ch) {
      const pid = h.pidOf(k);
      if (pid === S.me || !S.players.has(pid)) continue;
      const was = seenCh.get(k) || { n: 0, late: 0 }, n = c.noteBase + c.notes.length;
      R.notes.heard += Math.max(0, n - was.n); R.notes.late += Math.max(0, c.late - was.late);
      R.notes.lateWorst = Math.max(R.notes.lateWorst, Math.round(c.lateWorst));
      seenCh.set(k, { n, late: c.late });
    }
    R.used = [...used];
    dirty = true;
  }

  function send(final) {
    if (!live || (!dirty && !final)) return;
    dirty = false;
    const secs = Object.fromEntries(Object.entries(R.secs).map(([k, v]) => [k, Math.round(v)]));
    const body = JSON.stringify({ ...R, secs, roomSec: Math.round(R.roomSec), bandSec: Math.round(R.bandSec), net: { ...R.net, directSec: Math.round(R.net.directSec), relaySec: Math.round(R.net.relaySec) } });
    const url = endpoint + '/report' + (final ? '?final=1' : '');
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }))) return;
      fetch(url, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain' } }).catch(() => {});
    } catch (_) {}
  }

  // only start once the Worker answers, so a missing or moved endpoint costs one failed request, not one a minute
  fetch(endpoint + '/ping', { cache: 'no-store' }).then((r) => { live = r.ok; }).catch(() => { live = false; });
  setInterval(sample, 5000);
  setTimeout(() => { sample(); send(); }, 20000);
  setInterval(() => { sample(); send(); }, 60000);
  let byeAt = -1e9;   // pagehide and the hidden-tab event often come together: one last report, not two
  const bye = () => { if (performance.now() - byeAt < 1500) return; byeAt = performance.now(); sample(); send(true); };
  addEventListener('pagehide', bye);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') bye(); });

  api.use = (name) => { if (!used.has(name)) { used.add(name); dirty = true; } };
  api.joining = () => { joinT = performance.now(); };
  api.relayLost = () => { R.net.relayLost++; dirty = true; };
  api.report = () => JSON.parse(JSON.stringify(R));
  api.flush = () => { sample(); send(true); };
  return api;
}
