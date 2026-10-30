// Room logic: an exact copy of the relay that runs on Cloudflare as crush-commando-mp (samuelling/crush-commando/server).
// MEGAjam uses that deployed relay only for the WebRTC handshake. This copy powers the local dev server (dev.js).
//
// A room is everyone connected with the same room code. The server is a relay: it remembers each
// player's name, colour, join order and latest state (so late joiners see everyone at once) and
// passes states and game events on to the others. Which player runs the shared enemies is decided
// by the clients: the earliest joiner in a given stage ("n" is the join order).
//
// A handle is { send(text), close(code, reason), meta (get/set plain object) }.

export const MAX_PLAYERS = 8;
export const MAX_MSG = 2048;

const COLS = 8;
const clean = (s) => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯]/g, '').trim().slice(0, 16);
const rid = () => Math.random().toString(36).slice(2, 8);
const pub = (m) => ({ id: m.id, n: m.n, name: m.name, col: m.col, st: m.st || null });

function broadcast(others, obj) {
  const s = JSON.stringify(obj);
  for (const h of others) if (h.meta.hi) h.send(s);
}

export function roomOpen(others, me) {
  if (others.length >= MAX_PLAYERS) { me.close(4001, 'room full'); return false; }
  me.meta = { id: rid(), n: Date.now() * 1000 + Math.floor(Math.random() * 1000), name: '', col: 0, st: null, hi: false };
  return true;
}

export function roomMessage(others, me, raw) {
  if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  if (!msg || typeof msg !== 'object') return;
  const m = me.meta;
  if (!m.id) return;
  switch (msg.t) {
    case 'hi': {
      m.name = clean(msg.name) || 'Player';
      m.col = ((msg.col | 0) % COLS + COLS) % COLS;
      const first = !m.hi;
      m.hi = true;
      me.meta = m;
      me.send(JSON.stringify({ t: 'welcome', id: m.id, n: m.n, peers: others.filter((h) => h.meta.hi).map((h) => pub(h.meta)) }));
      broadcast(others, first ? { t: 'join', ...pub(m) } : { t: 'name', id: m.id, name: m.name, col: m.col });
      break;
    }
    case 'st': {
      if (!m.hi || !msg.s || typeof msg.s !== 'object') return;
      m.st = msg.s;
      me.meta = m;
      broadcast(others, { t: 'st', id: m.id, s: msg.s });
      break;
    }
    case 'ev': {
      if (!m.hi || !msg.e || typeof msg.e !== 'object') return;
      const out = { t: 'ev', id: m.id, e: msg.e };
      if (typeof msg.to === 'string') {
        const h = others.find((o) => o.meta.id === msg.to);
        if (h && h.meta.hi) h.send(JSON.stringify(out));
      } else broadcast(others, out);
      break;
    }
  }
}

export function roomClose(others, me) {
  const m = me.meta;
  if (m && m.id && m.hi) broadcast(others, { t: 'leave', id: m.id });
}
