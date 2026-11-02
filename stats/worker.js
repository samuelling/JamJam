// MEGAjam usage stats: a small Cloudflare Worker, separate from the handshake relay (crush-commando-mp), that
// collects the anonymous session reports the app sends (src/stats.js) and serves them to the admin dashboard
// (admin.html). Storage is one D1 table, one row per browser session, replaced by each newer report.
//
//   POST /report      a session report (sent with sendBeacon, so text/plain and no preflight). Cleaned field by
//                     field before it is stored: anything not in the schema below is dropped.
//   GET  /summary     sessions from the last ?days= (max 90), for the dashboard. Needs the ADMIN_KEY secret as a
//                     bearer token.
//   GET  /ping        the app checks this once before it starts reporting.
//   cron (daily)      deletes sessions older than 90 days.
//
// Stored per session: the report itself (numbers, the device kind, instrument ids, error messages), the
// country Cloudflare puts on the request, and the times. No IP address, name, chat or room code is stored (the
// app sends a one-way hash of the room code, so sessions in the same jam can be grouped).
//
// Deploy steps are in stats/README.md.

const KEEP_DAYS = 90;
const MAX_BODY = 16000;
const MIN_GAP_MS = 15000;   // one stored report per session per 15 s at most

const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0; };
const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);
const hist = (h, n) => (Array.isArray(h) ? h.slice(0, n).map((x) => Math.round(num(x, 0, 1e7))) : []);
const ID = /^[a-z0-9]{8,16}$/;
const WORD = /^[\w./:-]{1,40}$/;   // instrument ids (a library's are lib/id) and feature names
const OS = ['ios', 'android', 'mac', 'windows', 'chromeos', 'linux', 'other'], BR = ['chrome', 'safari', 'firefox', 'edge', 'opera', 'other'];

// the report schema: version 1 (src/stats.js builds it)
export function clean(r) {
  if (!r || r.v !== 1 || !ID.test(r.sid)) return null;
  const d = r.dev || {}, n = r.net || {}, a = r.notes || {};
  return {
    v: 1, sid: r.sid,
    room: /^[0-9a-f]{8}$/.test(r.room || '') ? r.room : '',
    dur: num(r.dur, 0, 86400 * 3),           // seconds the page was open
    roomSec: num(r.roomSec, 0, 86400 * 3),   // seconds in a room
    bandSec: num(r.bandSec, 0, 86400 * 3),   // seconds in a room with at least one bandmate
    peak: num(r.peak, 0, 16),                // most bandmates at once
    joinMs: r.joinMs == null ? null : num(r.joinMs, 0, 600000),   // join click to every link ready
    dev: {
      os: OS.includes(d.os) ? d.os : 'other', br: BR.includes(d.br) ? d.br : 'other', mobile: !!d.mobile, cores: num(d.cores, 0, 256), mem: num(d.mem, 0, 1024),
      sr: num(d.sr, 0, 384000), ol: num(d.ol, 0, 2000), app: !!d.app,
    },
    net: {
      directSec: num(n.directSec, 0, 1e6), relaySec: num(n.relaySec, 0, 1e6),
      rttDirect: hist(n.rttDirect, 10), rttRelay: hist(n.rttRelay, 10), rttMax: num(n.rttMax, 0, 60000),
      look: hist(n.look, 10), lookMax: num(n.lookMax, 0, 2000),
      clockErr: hist(n.clockErr, 10), clockErrMax: num(n.clockErrMax, 0, 60000),
      relayLost: num(n.relayLost, 0, 1e5), drops: num(n.drops, 0, 1e5),
    },
    notes: {
      played: num(a.played, 0, 1e8), heard: num(a.heard, 0, 1e8), late: num(a.late, 0, 1e8), lateWorst: num(a.lateWorst, 0, 60000),
    },
    stalls: num(r.stalls, 0, 1e6), stallMs: num(r.stallMs, 0, 1e9),
    inst: Array.isArray(r.inst) ? [...new Set(r.inst.map((x) => str(x, 40)).filter((x) => WORD.test(x)))].slice(0, 24) : [],
    hw: num(r.hw, 0, 64),
    used: Array.isArray(r.used) ? [...new Set(r.used.map((x) => str(x, 16)).filter((x) => WORD.test(x)))].slice(0, 16) : [],
    errors: Array.isArray(r.errors) ? r.errors.slice(0, 20).map((e) => ({ m: str(e?.m, 200), s: str(e?.s, 80), n: num(e?.n, 0, 1e6) })) : [],
  };
}

const ALLOW = (env) => String(env.ORIGINS || 'https://samuelling.github.io').split(',').map((s) => s.trim());
function cors(req, env) {
  const o = req.headers.get('origin') || '';
  const ok = ALLOW(env).includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return ok ? { 'access-control-allow-origin': o, 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', vary: 'origin' } : { vary: 'origin' };
}
const json = (obj, status, h) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...h } });

let ready = false;
async function ensure(db) {
  if (ready) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, first INTEGER, last INTEGER, room TEXT, country TEXT, data TEXT)'),
    db.prepare('CREATE INDEX IF NOT EXISTS sessions_last ON sessions(last)'),
  ]);
  ready = true;
}
// constant-time compare, so the key can't be guessed a character at a time
function same(a, b) { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }

export default {
  async fetch(req, env) {
    const url = new URL(req.url), h = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (url.pathname === '/ping') return json({ ok: true }, 200, h);
    if (url.pathname === '/report' && req.method === 'POST') {
      if (!h['access-control-allow-origin']) return json({ error: 'origin' }, 403, h);
      const text = await req.text();
      if (text.length > MAX_BODY) return json({ error: 'too big' }, 413, h);
      let r; try { r = clean(JSON.parse(text)); } catch (_) { r = null; }
      if (!r) return json({ error: 'bad report' }, 400, h);
      await ensure(env.DB);
      const now = Date.now(), country = str(req.cf?.country || '', 2);
      const prev = await env.DB.prepare('SELECT last FROM sessions WHERE sid = ?').bind(r.sid).first();
      if (prev && now - prev.last < MIN_GAP_MS && !url.searchParams.has('final')) return json({ ok: true, skipped: true }, 200, h);
      await env.DB.prepare('INSERT INTO sessions (sid, first, last, room, country, data) VALUES (?1, ?2, ?2, ?3, ?4, ?5) ON CONFLICT(sid) DO UPDATE SET last = ?2, room = ?3, country = ?4, data = ?5')
        .bind(r.sid, now, r.room, country, JSON.stringify(r)).run();
      return json({ ok: true }, 200, h);
    }
    if (url.pathname === '/summary' && req.method === 'GET') {
      const key = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!env.ADMIN_KEY || !same(key, env.ADMIN_KEY)) return json({ error: 'key' }, 401, h);
      await ensure(env.DB);
      const days = num(url.searchParams.get('days') || 7, 1, KEEP_DAYS), since = Date.now() - days * 86400000;
      const rows = await env.DB.prepare('SELECT first, last, room, country, data FROM sessions WHERE last >= ? ORDER BY last DESC LIMIT 20000').bind(since).all();
      return json({ now: Date.now(), days, sessions: rows.results.map((x) => ({ first: x.first, last: x.last, room: x.room, country: x.country, ...JSON.parse(x.data) })) }, 200, h);
    }
    return new Response('MEGAjam stats\n', { status: url.pathname === '/' ? 200 : 404, headers: { 'content-type': 'text/plain', ...h } });
  },
  async scheduled(_ev, env) {
    await ensure(env.DB);
    await env.DB.prepare('DELETE FROM sessions WHERE last < ?').bind(Date.now() - KEEP_DAYS * 86400000).run();
  },
};
