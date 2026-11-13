// The studios' HTTP API, apart from Cloudflare's runtime so it can be tested in Node (tests/studio.test.cjs).
// stubOf(id) gives the studio's store (a Durable Object stub in production); env.CLIPS is an R2 bucket. env.FETCH
// stands in for fetch (the band's Dropbox) in tests.

import { officialFile, WAV_HEADER } from './home.js';

const ID = /^[a-z0-9]{16}$/, CLIP = /^[a-z0-9]{8}$/;
const MAX_CLIP = 40 * 1024 * 1024;

const ALLOW = (env) => String(env.ORIGINS || 'https://samuelling.github.io').split(',').map((s) => s.trim());
function cors(req, env) {
  const o = req.headers.get('origin') || '';
  const ok = ALLOW(env).includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return { ok, h: ok ? { 'access-control-allow-origin': o, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS', 'access-control-expose-headers': 'x-sr, x-format', vary: 'origin' } : { vary: 'origin' } };
}
const json = (obj, status, h) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...h } });
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

export async function handle(req, env, stubOf) {
  const url = new URL(req.url), { ok, h } = cors(req, env), p = url.pathname.split('/').filter(Boolean);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  const write = req.method === 'POST' || req.method === 'PUT';
  if (write && !ok) return json({ error: 'origin' }, 403, h);
  if (p[0] !== 'studios') return new Response('MEGAjam studios\n', { status: p.length ? 404 : 200, headers: { 'content-type': 'text/plain', ...h } });

  if (p.length === 1 && req.method === 'POST') {
    let body = {}; try { body = await req.json(); } catch (_) {}
    const id = newId(), r = await stubOf(id).init(body.name, id);
    return r.error ? json(r, 409, h) : json({ id, name: r.meta.name }, 200, h);
  }
  const id = p[1]; if (!ID.test(id || '')) return json({ error: 'no such studio' }, 404, h);
  const stub = stubOf(id);

  if (p.length === 2 && req.method === 'GET') { const s = await stub.state(); return s ? json(s, 200, h) : json({ error: 'no such studio' }, 404, h); }
  if (p[2] === 'ops' && req.method === 'POST') {
    const text = await req.text(); if (text.length > 8_000_000) return json({ error: 'too big' }, 413, h);
    let body; try { body = JSON.parse(text); } catch (_) { return json({ error: 'bad json' }, 400, h); }
    const r = await stub.ops(body.ops, !!body.whole);
    return r.error ? json(r, r.status || 400, h) : json(r, 200, h);
  }
  if (p[2] === 'backups' && req.method === 'GET') {
    if (!(await stub.exists())) return json({ error: 'no such studio' }, 404, h);
    if (p[3]) { const b = await stub.backup(p[3]); return b ? json({ day: p[3], song: b }, 200, h) : json({ error: 'no backup' }, 404, h); }
    return json({ days: await stub.backups() }, 200, h);
  }
  if (p[2] === 'home' && req.method === 'POST' && p.length === 3) {
    let body; try { body = await req.json(); } catch (_) { return json({ error: 'bad json' }, 400, h); }
    const r = await stub.setHomeInfo(body.home ?? null);
    return r.error ? json(r, r.status || 400, h) : json(r, 200, h);
  }
  if (p[2] === 'clips') {
    if (p.length === 3 && req.method === 'GET') {
      const c = await stub.clips(); return c ? json(c, 200, h) : json({ error: 'no such studio' }, 404, h);
    }
    const clip = p[3]; if (!CLIP.test(clip || '')) return json({ error: 'bad clip id' }, 400, h);
    const k = `c/${id}/${clip}`;
    // POST /studios/:id/clips/:clip/home { url }: the take is in the band's Dropbox now, at this share link
    if (p[4] === 'home' && req.method === 'POST') {
      let body; try { body = await req.json(); } catch (_) { return json({ error: 'bad json' }, 400, h); }
      const r = await stub.setHome(clip, body.url);
      return r.error ? json(r, r.status || 400, h) : json(r, 200, h);
    }
    if (p.length !== 4) return json({ error: 'not found' }, 404, h);
    if (req.method === 'GET') {
      const o = await env.CLIPS.get(k);
      if (o) return new Response(o.body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable', 'x-sr': o.customMetadata?.sr || '24000', 'x-format': 'pcm16', ...h } });
      const rec = await stub.clip(clip);
      if (!rec) return json({ error: 'no such clip' }, 404, h);
      if (!rec.home) return json({ error: 'not here yet' }, 404, h);
      // its parked copy has gone: the browser tries the band's Dropbox itself, or asks us to fetch it (?via=home)
      if (url.searchParams.get('via') !== 'home') return json({ error: 'in the band\'s Dropbox', home: rec.home }, 404, h);
      const get = env.FETCH || fetch;
      let r; try { r = await get(officialFile(rec.home), { redirect: 'follow' }); } catch (_) { return json({ error: 'the band\'s Dropbox is unreachable' }, 502, h); }
      const len = +(r.headers.get('content-length') || 0);
      if (!r.ok || (len && len !== WAV_HEADER + rec.bytes)) { try { await r.body?.cancel(); } catch (_) {} return json({ error: 'the take is missing from the band\'s Dropbox' }, 410, h); }
      return new Response(r.body, { headers: { 'content-type': 'audio/wav', 'cache-control': 'private, max-age=86400', 'x-format': 'wav', 'x-sr': String(rec.sr), ...h } });
    }
    if (req.method === 'PUT') {
      const sr = Math.round(+url.searchParams.get('sr') || 0); if (!(sr >= 8000 && sr <= 96000)) return json({ error: 'bad sample rate' }, 400, h);
      const buf = await req.arrayBuffer(); if (!buf.byteLength || buf.byteLength % 2 || buf.byteLength > MAX_CLIP) return json({ error: 'bad clip size' }, 400, h);
      const room = await stub.park(clip, buf.byteLength, sr); if (room.error) return json(room, room.status, h);
      if (room.exists) return json({ ok: true, exists: true }, 200, h);
      await env.CLIPS.put(k, buf, { customMetadata: { sr: String(sr) } });
      return json({ ok: true }, 200, h);
    }
  }
  return json({ error: 'not found' }, 404, h);
}

