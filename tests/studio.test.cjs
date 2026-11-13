// Studios end to end: the studio server's real code (studio/api.js + core.js) runs in Node behind a small HTTP shim,
// with in-memory stand-ins for its Durable Object storage and R2 bucket, and browsers walk in and out:
//   - Sam walks into a new studio alone, writes a section and leaves an audio take, and goes;
//   - Matt walks in alone later (a fresh browser: nothing cached) and finds the song and hears the take, from the
//     server, with Sam gone; he renames the section and adds a part, and goes;
//   - Sam comes back and finds Matt's changes;
//   - Sam and Ev in at once: Ev gets the song from Sam; Sam leaves, Ev takes over saving, and Ev's edit is kept;
//   - a plain jam turned into a studio ("Keep as a studio"): everyone in the room attaches, the song is saved;
//   - leaving a studio and starting a plain jam starts clean.
//   - the band's Dropbox (a stand-in, below): Sam links it, his browser carries the take there; two weeks on the
//     parked copy goes, and later visitors hear the take from Dropbox, straight or through the studio server;
//     a take whose Dropbox file has gone keeps its parked copy.
// Plus the server on its own: origins, bad keys, an empty song never wiping a studio, daily backups.
//
//   node server/dev.js &      (8787)
//   node tests/studio.test.cjs [baseUrl]
const { chromium } = require('playwright');
const http = require('node:http');
const path = require('node:path');
const BASE = process.argv[2] || 'http://localhost:8787/';
const PORT = 8790, SV = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };

// a Durable Object's storage, in a Map
function memStorage() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async put(k, v) { if (typeof k === 'object') { const e = Object.entries(k); if (e.length > 128) throw new Error('too many keys'); for (const [a, b] of e) m.set(a, structuredClone(b)); } else m.set(k, structuredClone(v)); },
    async delete(k) { if (Array.isArray(k)) { if (k.length > 128) throw new Error('too many keys'); for (const x of k) m.delete(x); } else m.delete(k); },
    async list({ prefix = '' } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, structuredClone(v)])); },
  };
}
// an R2 bucket, in a Map
function memR2() {
  const m = new Map();
  return {
    m,
    async list({ prefix }) { return { objects: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; },
    async head(k) { return m.has(k) ? { key: k } : null; },
    async get(k) { const o = m.get(k); return o ? { body: o.buf.slice(0), customMetadata: o.meta } : null; },
    async put(k, buf, opt = {}) { m.set(k, { buf: buf.slice(0), meta: opt.customMetadata || {} }); },
    async delete(k) { m.delete(k); },
  };
}
// the band's Dropbox: files by path, share links, and whether browsers may fetch the direct form
const ACCOUNT = 'dbid:AAH4testaccount0001';
function memDropbox() {
  const files = new Map(), links = new Map(), hits = { direct: 0, official: 0 };
  const rnd = (n) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
  const fileOf = (u) => { const m = new URL(u).pathname.match(/^\/scl\/fi\/([a-z0-9]+)\//); return m && links.has(m[1]) ? files.get(links.get(m[1])) : null; };
  const serve = (buf, range, cors) => {
    const h = cors ? { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Content-Length, Content-Range' } : {};
    const m = range && range.match(/bytes=(\d+)-(\d+)/);
    if (m) { const a = +m[1], b = Math.min(+m[2], buf.length - 1); return { status: 206, headers: { ...h, 'content-range': `bytes ${a}-${b}/${buf.length}`, 'content-length': String(b - a + 1) }, body: buf.subarray(a, b + 1) }; }
    return { status: 200, headers: { ...h, 'content-length': String(buf.length) }, body: buf };
  };
  return { files, links, hits, directCors: true, fileOf, serve, rnd };
}

(async () => {
  const { handle } = await import(path.resolve(__dirname, '../studio/api.js'));
  const { StudioCore } = await import(path.resolve(__dirname, '../studio/core.js'));
  const stores = new Map(), env = { CLIPS: memR2(), ORIGINS: 'https://samuelling.github.io' };
  const { clearParking } = await import(path.resolve(__dirname, '../studio/home.js'));
  const dbx = memDropbox();
  // the studio server fetching from the band's Dropbox (the official link, dl=1)
  env.FETCH = async (u, init = {}) => {
    dbx.hits.official++;
    const f = new URL(u).hostname === 'www.dropbox.com' && dbx.fileOf(u); if (!f) return new Response('not found', { status: 404 });
    const r = dbx.serve(f, init.headers?.range, false); return new Response(r.body, { status: r.status, headers: r.headers });
  };
  const stubOf = (id) => { if (!stores.has(id)) stores.set(id, new StudioCore(memStorage())); const c = stores.get(id); return { init: (n, i) => c.init(n, i), state: () => c.state(), ops: (l, w) => c.ops(l, w), backups: () => c.backups(), backup: (d) => c.backup(d), exists: () => c.meta().then(Boolean),
    park: (cl, n, sr) => c.park(cl, n, sr), clip: (cl) => c.clip(cl), clips: () => c.clips(), setHomeInfo: (hm) => c.setHomeInfo(hm), setHome: (cl, u) => c.setHome(cl, u) }; };
  let opsSeen = 0, viaHome = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.url.includes('/ops')) opsSeen++;
    if (req.url.includes('via=home')) viaHome++;
    const r = await handle(new Request(SV + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env, stubOf);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  }).listen(PORT);
  const api = (p, o = {}) => fetch(SV + p, { ...o, headers: { origin: 'http://localhost:8787', 'content-type': 'application/json', ...(o.headers || {}) } });

  // ---- the server on its own ----
  check((await api('/studios', { method: 'POST', body: '{}', headers: { origin: 'https://evil.example' } })).status === 403, 'server: a studio can only be made from the site');
  const t1 = await (await api('/studios', { method: 'POST', body: JSON.stringify({ name: 'Test' }) })).json();
  check(/^[a-z0-9]{16}$/.test(t1.id), 'server: a new studio gets a 16-character id');
  check((await api('/studios/zzzzzzzzzzzzzzzz')).status === 404 && (await api('/studios/../etc')).status === 404, 'server: unknown or malformed ids are not found');
  check((await api(`/studios/${t1.id}/ops`, { method: 'POST', body: JSON.stringify({ ops: [['evil', 1]] }) })).status === 400, 'server: only song keys are stored');
  await api(`/studios/${t1.id}/ops`, { method: 'POST', body: JSON.stringify({ ops: [['title', 'One'], ['sec:a', { name: 'A', bars: 4 }]] }) });
  await api(`/studios/${t1.id}/ops`, { method: 'POST', body: JSON.stringify({ ops: [['title', 'Two']], whole: true }) });
  let st = await (await api(`/studios/${t1.id}`)).json();
  check(st.song.title === 'Two' && !st.song['sec:a'], 'server: a whole song replaces what was there');
  const days = await (await api(`/studios/${t1.id}/backups`)).json();
  const bk = days.days[0] && await (await api(`/studios/${t1.id}/backups/${days.days[0]}`)).json();
  check(days.days.length === 1 && bk.song.title === 'One' && bk.song['sec:a'], 'server: the first change of the day keeps a backup of the song before it');
  const pcm = new Int16Array(2400).map((_, i) => Math.round(Math.sin(i / 5) * 8000));
  check((await api(`/studios/${t1.id}/clips/abcd1234?sr=24000`, { method: 'PUT', body: Buffer.from(pcm.buffer) })).ok, 'server: a clip goes in');
  const back = await api(`/studios/${t1.id}/clips/abcd1234`), bb = new Int16Array(await back.arrayBuffer());
  check(back.headers.get('x-sr') === '24000' && bb.length === 2400 && bb[100] === pcm[100], 'server: and comes back the same, with its sample rate');
  await api(`/studios/${t1.id}/clips/abcd1234?sr=24000`, { method: 'PUT', body: Buffer.from(new Int16Array(10).buffer) });
  check(new Int16Array(await (await api(`/studios/${t1.id}/clips/abcd1234`)).arrayBuffer()).length === 2400, 'server: a clip is never replaced');

  // ---- browsers ----
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  const json = (route, obj, status = 200) => route.fulfill({ status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(obj) });
  // Dropbox, as each browser sees it
  const dropboxRoutes = async (ctx) => {
    await ctx.route(/^https:\/\/(www\.dropbox\.com|api\.dropboxapi\.com|content\.dropboxapi\.com|dl\.dropboxusercontent\.com)\//, async (route) => {
      const rq = route.request(), u = new URL(rq.url());
      if (rq.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' } });
      if (u.hostname === 'www.dropbox.com' && u.pathname === '/oauth2/authorize') return route.fulfill({ status: 302, headers: { location: new URL(`dropbox.html?code=c0de&state=${u.searchParams.get('state')}`, BASE).href } });
      if (u.hostname === 'www.dropbox.com') return route.fulfill({ status: 302, headers: { location: 'https://uc0.dl.dropboxusercontent.com/cd/0/inline/x/file' } });   // no CORS: blocked
      if (u.pathname === '/oauth2/token') { const b = new URLSearchParams(rq.postData() || ''); return b.get('client_id') === 'testkey' && (b.get('code') === 'c0de' || b.get('refresh_token') === 'rt') ? json(route, { access_token: 'at', expires_in: 14400, refresh_token: 'rt', account_id: ACCOUNT }) : json(route, { error: 'invalid_grant' }, 400); }
      if (rq.headers().authorization !== 'Bearer at' && u.hostname !== 'dl.dropboxusercontent.com') return json(route, { error_summary: 'invalid_access_token/' }, 401);
      if (u.pathname === '/2/users/get_current_account') return json(route, { account_id: ACCOUNT, name: { display_name: 'Sam Ling' } });
      if (u.pathname === '/2/files/upload') {
        const arg = JSON.parse(rq.headers()['dropbox-api-arg']);
        if (dbx.files.has(arg.path)) return json(route, { error_summary: 'path/conflict/file/..' }, 409);
        dbx.files.set(arg.path, Buffer.from(rq.postDataBuffer())); return json(route, { path_display: arg.path });
      }
      if (u.pathname === '/2/sharing/create_shared_link_with_settings') {
        const { path: fp } = JSON.parse(rq.postData()); if (!dbx.files.has(fp)) return json(route, { error_summary: 'path/not_found/' }, 409);
        const there = [...dbx.links].find(([, v]) => v === fp), url = (id) => `https://www.dropbox.com/scl/fi/${id}/${encodeURIComponent(fp.split('/').pop())}?rlkey=${'k' + id}&dl=0`;
        if (there) return json(route, { error_summary: 'shared_link_already_exists/..', error: { '.tag': 'shared_link_already_exists', shared_link_already_exists: { metadata: { url: url(there[0]) } } } }, 409);
        const id = dbx.rnd(15); dbx.links.set(id, fp); return json(route, { url: url(id) });
      }
      if (u.pathname === '/2/auth/token/revoke') return json(route, null);
      if (u.hostname === 'dl.dropboxusercontent.com') {
        dbx.hits.direct++; const f = dbx.fileOf(rq.url()); if (!f) return route.fulfill({ status: 404, body: 'gone' });
        if (!dbx.directCors) return route.abort('failed');   // what a page sees when CORS blocks it (Playwright's fulfill skips CORS)
        const r = dbx.serve(f, rq.headers().range, dbx.directCors); return route.fulfill({ status: r.status, headers: r.headers, body: Buffer.from(r.body) });
      }
      return json(route, { error_summary: 'unknown ' + u.pathname }, 400);
    });
  };
  const person = async (name) => {
    const ctx = await browser.newContext(); await dropboxRoutes(ctx); const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await p.goto(BASE + `?studios=${SV}&dropbox=testkey`); await p.fill('#nameIn', name);
    return p;
  };
  const walkIn = async (p, id) => { await p.evaluate((id) => JJ.enterStudio(id), id); await p.waitForSelector('#studio:not(.hide)', { timeout: 20000 }); };
  const song = (p) => p.evaluate(() => JSON.parse(JSON.stringify(JJ.song())));
  const until = async (p, fn, arg, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return true; await sleep(250); } return false; };
  const saved = async (id) => (await (await api(`/studios/${id}`)).json()).song;
  const settle = async (id, pred, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred(await saved(id))) return true; await sleep(300); } return false; };

  // Sam walks in alone
  const made = await (await api('/studios', { method: 'POST', body: JSON.stringify({ name: 'Garage' }) })).json();
  const id = made.id;
  const sam = await person('Sam');
  await walkIn(sam, id);
  check((await sam.textContent('#roomCode')) === 'Garage' && sam.url().includes('studio=' + id), 'Sam walks into Garage: the readout shows its name, the address is its link');
  await until(sam, () => JJ.studio.loaded);
  await sam.evaluate(() => {
    JJ.setSong('sec:v1', { name: 'Verse', bars: 4, chords: ['Am', 'F', 'C', 'G'], notes: '' }); JJ.setSong('order', ['v1']);
    // an audio take of Sam's synth: the clip in this browser, and the part that plays it
    const n = 24000, pcm = new Int16Array(n); for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin(i * 2 * Math.PI * 220 / 24000) * 9000);
    JJ.blobs.put('samtake1', pcm, 24000);
    JJ.setSong('lane:tsam', { id: 'tsam', name: 'Sam · Live audio', ownerName: 'Sam', inst: 'audio', kind: 'audio', role: 'texture' });
    JJ.setSong('part:v1:tsam', { id: 'tsam', name: 'Sam · Live audio', kind: 'audio', inst: 'audio', takes: [{ id: 'k1', events: [], audio: { id: 'samtake1', sr: 24000, frames: n, from: 0, beats: 2, bpm: 96, peaks: Array(120).fill(0.3) }, by: JJ.S.me, byName: 'Sam', at: 1 }], current: 'k1', by: JJ.S.me });
  });
  check(await settle(id, (s) => s['sec:v1']?.name === 'Verse' && s['part:v1:tsam']?.takes?.length === 1 && s.order?.[0] === 'v1'), 'what Sam writes is saved to the studio within moments');
  await sam.evaluate(() => JJ.studio.syncClips());
  check(await (async () => { for (let i = 0; i < 20; i++) { if (env.CLIPS.m.has(`c/${id}/samtake1`)) return true; await sleep(300); } return false; })(), "and the take's audio goes up to the studio's store");
  await sam.evaluate(() => JJ.leave()); await sleep(500);
  check((await song(sam)).order.length === 0 && !(await sam.evaluate(() => JJ.studio.id)), 'leaving, Sam lets go of the studio (and its song)');

  // Matt walks in alone later, in a fresh browser
  const matt = await person('Matt');
  await walkIn(matt, id);
  check(await until(matt, () => JJ.song().sections.v1?.name === 'Verse' && JJ.song().sections.v1.parts?.tsam?.takes?.[0]?.audio?.id === 'samtake1'), 'Matt walks in alone and finds the Verse and Sam\'s take');
  check(await until(matt, () => JJ.blobs.has('samtake1'), null, 12000), "and hears it: the audio comes from the studio, with Sam gone");
  const tempo0 = await matt.evaluate(() => Math.round(JJ.tempo.target()));
  await matt.evaluate(() => {
    JJ.setSong('sec:v1', { name: 'Verse 1', bars: 4, chords: ['Am', 'F', 'C', 'E'], notes: 'darker ending' });
    JJ.setSong('sec:c1', { name: 'Chorus', bars: 4, chords: ['F', 'G', 'C', 'C'], notes: '' }); JJ.setSong('order', ['v1', 'c1']);
    JJ.setTempo(108);
  });
  check(await settle(id, (s) => s['sec:v1']?.name === 'Verse 1' && s['sec:c1'] && s.order?.length === 2 && s.bpm === 108), `Matt's rename, new Chorus and tempo (${tempo0} → 108) are saved`);
  await matt.evaluate(() => JJ.leave()); await sleep(400);

  // Sam comes back
  await walkIn(sam, id);
  check(await until(sam, () => JJ.song().sections.v1?.name === 'Verse 1' && JJ.song().order.join() === 'v1,c1' && JJ.song().sections.v1.chords[3] === 'E'), 'Sam comes back and finds what Matt left');
  check(await until(sam, () => Math.round(JJ.tempo.target()) === 108), 'at the tempo Matt set');

  // Ev joins Sam: gets the song from Sam; Sam goes, Ev keeps saving
  const ev = await person('Ev');
  await walkIn(ev, id);
  check(await until(ev, () => JJ.S.players.size === 1 && JJ.song().order.join() === 'v1,c1'), 'Ev walks in on Sam and gets the song from him');
  await sam.evaluate(() => JJ.setSong('sec:c1', { name: 'Big Chorus', bars: 8, chords: [], notes: '' }));
  check(await settle(id, (s) => s['sec:c1']?.name === 'Big Chorus') && await until(ev, () => JJ.song().sections.c1?.name === 'Big Chorus'), 'together: an edit reaches Ev and the studio');
  await sam.evaluate(() => JJ.leave());
  check(await until(ev, () => JJ.S.players.size === 0 && JJ.clock.isLeader), 'Sam leaves; Ev is in charge now');
  await ev.evaluate(() => JJ.setSong('sec:b1', { name: 'Bridge', bars: 4, chords: [], notes: '' }));
  await ev.evaluate(() => JJ.setSong('order', ['v1', 'c1', 'b1']));
  check(await settle(id, (s) => s['sec:b1']?.name === 'Bridge' && s.order?.join() === 'v1,c1,b1' && s['sec:v1']?.name === 'Verse 1'), "Ev's Bridge is saved, and nothing else was lost in the handover");
  await ev.evaluate(() => JJ.leave()); await sleep(300);

  // a plain jam made into a studio
  const a = await person('Ana'), b = await person('Bo');
  await a.click('#startBtn'); await a.waitForSelector('#studio:not(.hide)');
  const code = await a.textContent('#roomCode');
  await b.goto(BASE + `?room=${code}&studios=${SV}`); await b.fill('#nameIn', 'Bo'); await b.click('#joinBtn'); await b.waitForSelector('#studio:not(.hide)');
  await until(b, () => JJ.S.players.size === 1);
  await a.evaluate(() => { JJ.setSong('sec:x1', { name: 'Riff', bars: 2, chords: ['E'], notes: '' }); JJ.setSong('order', ['x1']); });
  await until(b, () => JJ.song().order.length === 1);
  const kept = await a.evaluate(() => JJ.keepAsStudio('Ana & Bo'));
  check(/studio=[a-z0-9]{16}/.test(kept.link), `"Keep as a studio" makes one and gives its link`);
  check(await until(b, (sid) => JJ.studio.id === sid, kept.id), 'Bo, in the room, is in the studio too');
  check(await settle(kept.id, (s) => s['sec:x1']?.name === 'Riff' && s.order?.[0] === 'x1'), 'the song they had is saved to it');
  check((await a.textContent('#roomCode')) === 'Ana & Bo', 'the readout shows the studio');

  // leaving a studio and starting a plain jam starts clean
  await a.evaluate(() => JJ.leave()); await a.click('#startBtn'); await a.waitForSelector('#studio:not(.hide)');
  const fresh = await song(a);
  check(!fresh.order.length && !fresh.studio && !(await a.evaluate(() => JJ.studio.id)), 'a plain jam after a studio starts clean, attached to nothing');

  // Save song with audio: a .zip of the song and its takes' WAVs, and it comes back in a fresh browser
  await a.evaluate(() => {
    const n = 12000, pcm = new Int16Array(n); for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin(i / 7) * 7000);
    JJ.blobs.put('anatake1', pcm, 24000);
    JJ.setSong('sec:z1', { name: 'Hook', bars: 2, chords: ['C'], notes: '' }); JJ.setSong('order', ['z1']);
    JJ.setSong('part:z1:tana', { id: 'tana', name: 'Ana · Live audio', kind: 'audio', inst: 'audio', takes: [{ id: 'q1', events: [], audio: { id: 'anatake1', sr: 24000, frames: n, from: 0, beats: 1, bpm: 96, peaks: Array(120).fill(0.2) }, by: JJ.S.me, byName: 'Ana', at: 1 }], current: 'q1', by: JJ.S.me });
  });
  const [dl] = await Promise.all([a.waitForEvent('download'), a.evaluate(() => JJ.exportSong())]);
  const zipPath = await dl.path(), zbytes = require('node:fs').readFileSync(zipPath);
  check(dl.suggestedFilename().endsWith('.megajam.zip') && (await a.evaluate(() => JJ.lastSongZip.join())) === 'song.megajam.json,audio/anatake1.wav', `Save song with an audio take makes a .zip of the song and its WAV (${dl.suggestedFilename()})`);
  const c = await person('Cy');
  await c.click('#startBtn'); await c.waitForSelector('#studio:not(.hide)');
  await c.evaluate(async (b64) => { const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)); await JJ.importFile(new File([bin], 'hook.megajam.zip')); }, zbytes.toString('base64'));
  check(await until(c, () => JJ.song().sections.z1?.name === 'Hook' && JJ.blobs.has('anatake1') && JJ.blobs.pcm('anatake1').pcm16.length === 12000), 'and a fresh browser imports it: the song and the take\'s audio, sample for sample');

  // ---- the band's Dropbox ----
  const band = (await (await api('/studios', { method: 'POST', body: JSON.stringify({ name: 'Band Room' }) })).json()).id;
  const sam2 = await person('Sam');
  await walkIn(sam2, band); await until(sam2, () => JJ.studio.loaded);
  const tone = (f, n) => Array.from({ length: n }, (_, i) => Math.round(Math.sin(i * 2 * Math.PI * f / 24000) * 9000));
  await sam2.evaluate(([a, b]) => {
    JJ.blobs.put('drtake01', Int16Array.from(a), 24000); JJ.blobs.put('drtake02', Int16Array.from(b), 24000);
    JJ.setSong('sec:d1', { name: 'Verse', bars: 4, chords: ['C'], notes: '' }); JJ.setSong('order', ['d1']);
    const take = (id, k, n) => ({ id: k, events: [], audio: { id, sr: 24000, frames: n, from: 0, beats: 2, bpm: 96, peaks: Array(120).fill(0.3) }, by: JJ.S.me, byName: 'Sam', at: 1 });
    JJ.setSong('part:d1:tsam', { id: 'tsam', name: 'Sam · Live audio', kind: 'audio', inst: 'audio', takes: [take('drtake01', 'k1', a.length), take('drtake02', 'k2', b.length)], current: 'k2', by: JJ.S.me });
  }, [tone(330, 24000), tone(440, 12000)]);
  await settle(band, (s) => s['part:d1:tsam']); await sam2.evaluate(() => JJ.studio.syncClips());
  check(await (async () => { for (let i = 0; i < 30; i++) { if (env.CLIPS.m.has(`c/${band}/drtake01`) && env.CLIPS.m.has(`c/${band}/drtake02`)) return true; await sleep(300); } return false; })(), 'Dropbox: two new takes are parked in the studio first, as always');
  const songOpts = async (pg, shot) => {
    await pg.evaluate(() => JJ.goRoom('compose')); await sleep(300);
    if ((await pg.getAttribute('.moretoggle', 'aria-expanded')) !== 'true') await pg.click('.moretoggle');
    await sleep(300); if (process.env.SHOTS) await pg.locator('.songopts').screenshot({ path: `/tmp/shot-${shot}.png` });
    const t = (await pg.textContent('.songopts')) || ''; await pg.evaluate(() => JJ.goRoom('stage')).catch(() => {}); return t;
  };
  check((await songOpts(sam2, '1-before')).includes('Keep takes in Dropbox'), 'Song options offers "Keep takes in Dropbox…"');
  const linked = await sam2.evaluate(async () => { const r = await JJ.dropbox.connect(); const home = await JJ.studio.keepInDropbox(); return { r, home }; });
  check(linked.r.account === ACCOUNT && linked.r.name === 'Sam Ling' && linked.home.folder.startsWith('Band Room (') && linked.home.by === 'Sam Ling', `Sam links the band's Dropbox in a pop-up, and the studio keeps its takes there (folder "${linked.home.folder}")`);
  check(!(await sam2.evaluate(() => JSON.stringify(localStorage)).then((t) => t.includes('"at"') || t.includes('c0de'))), 'only a refresh token stays in his browser (no access token, no sign-in code)');
  await sam2.evaluate(() => JJ.studio.portTakes());
  check((await songOpts(sam2, '2-mine')).includes('Takes go to your Dropbox (Apps folder › Band Room ('), 'and then says where they go');
  let homes = (await (await api(`/studios/${band}/clips`)).json()).homes;
  const paths = [...dbx.files.keys()];
  check(Object.keys(homes).sort().join() === 'drtake01,drtake02' && paths.length === 2 && paths.every((p) => p.startsWith(`/${linked.home.folder}/Verse - Sam - Live audio - take `)), `his browser carries both takes to the Dropbox folder: ${paths.map((p) => p.split('/').pop()).join(' | ')}`);
  const w1 = dbx.files.get(paths.find((p) => p.includes('drtake01')));
  check(w1.subarray(0, 4).toString() === 'RIFF' && w1.length === 44 + 48000 && w1.readInt16LE(44 + 400) === tone(330, 201)[200], 'as real WAVs, sample for sample (a DAW opens them)');
  check(env.CLIPS.m.has(`c/${band}/drtake01`), 'and the parked copies stay for now');
  await sam2.evaluate(() => JJ.studio.portTakes());
  check(dbx.files.size === 2 && dbx.links.size === 2, 'carrying again changes nothing (no duplicates)');
  check((await (await api(`/studios/${band}/clips/drtake01/home`, { method: 'POST', body: JSON.stringify({ url: 'https://evil.example/x.wav' }) })).status) === 400, 'the studio only takes Dropbox share links');
  await sam2.evaluate(() => JJ.leave());

  // two weeks on: the parked copies go, once their links check out; a take whose file has gone keeps its copy
  dbx.files.delete(paths.find((p) => p.includes('drtake02')));
  const core = stores.get(band), later = Date.now() + 15 * 86400_000;
  const early = await clearParking(core, env.CLIPS, band, env.FETCH, Date.now() + 3 * 86400_000);
  check(early.cleared === 0 && env.CLIPS.m.has(`c/${band}/drtake01`), 'nothing leaves parking before two weeks');
  const cl = await clearParking(core, env.CLIPS, band, env.FETCH, later);
  check(cl.cleared === 1 && cl.kept === 1 && !env.CLIPS.m.has(`c/${band}/drtake01`) && env.CLIPS.m.has(`c/${band}/drtake02`), 'after two weeks the take that checks out in Dropbox leaves parking; the one missing from Dropbox stays parked');
  check(cl.next > later && cl.next <= later + 86400_000 + 1000, 'and the missing one is checked again a day later');
  const left = await (await api(`/studios/${band}/clips`)).json();
  check(left.ids.join() === 'drtake02' && left.bytes === 24000, `the studio counts only what's parked (${left.bytes} bytes)`);

  // Matt, fresh, no Dropbox of his own: hears the take that went home, straight from the band's Dropbox
  const matt2 = await person('Matt');
  await walkIn(matt2, band);
  const d0 = dbx.hits.direct;
  check(await until(matt2, () => JJ.blobs.has('drtake01') && JJ.blobs.pcm('drtake01').pcm16.length === 24000, null, 15000) && dbx.hits.direct > d0, 'Matt walks in later and hears the take from the band\'s Dropbox, without signing in');
  check(await until(matt2, () => JJ.blobs.has('drtake02'), null, 8000), 'and the still-parked one from the studio');
  check((await songOpts(matt2, '3-bandmate')).includes("Takes are kept in Sam Ling's Dropbox"), "Matt's Song options says the takes are kept in Sam Ling's Dropbox");
  check((await matt2.evaluate(() => JJ.studio.takesHome)).home?.by === 'Sam Ling' && !(await matt2.evaluate(() => JJ.studio.takesHome.mine)), "his studio shows the takes are kept in Sam Ling's Dropbox, and his browser doesn't carry them");
  await matt2.evaluate(() => JJ.leave());

  // if Dropbox stops letting browsers fetch directly, the studio server fetches the take instead
  dbx.directCors = false;
  const zoe = await person('Zoe'), v0 = viaHome;

  await walkIn(zoe, band);
  check(await until(zoe, () => JJ.blobs.has('drtake01') && JJ.blobs.pcm('drtake01').pcm16[200] !== 0, null, 15000) && viaHome > v0, `with the direct route blocked, Zoe still hears it, through the studio server (${viaHome - v0} fetch)`);
  check((await zoe.evaluate(() => Array.from(JJ.blobs.pcm('drtake01').pcm16.slice(0, 300)))).every((v, i) => v === tone(330, 300)[i]), 'sample for sample');
  await zoe.evaluate(() => JJ.leave()); dbx.directCors = true;

  // Sam stops sending takes to Dropbox: new takes stay parked
  await walkIn(sam2, band); await until(sam2, () => JJ.studio.loaded);
  await sam2.evaluate(() => JJ.studio.stopDropbox());
  check(!(await (await api(`/studios/${band}/clips`)).json()).home, 'Sam stops: the studio no longer sends takes to Dropbox');
  await sam2.evaluate(() => JJ.leave());

  // the studio can never be wiped by someone arriving with an empty song
  const before = Object.keys(await saved(id)).length;
  const zed = await person('Zed');
  await walkIn(zed, id); await sleep(3500);
  const after = await saved(id);
  check(Object.keys(after).length >= before && after['sec:b1'], `walking in and out leaves the song whole (${Object.keys(after).length} keys)`);

  check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await browser.close(); server.close();
  console.log(failures ? `${failures} check(s) failed` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
