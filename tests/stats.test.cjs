// Usage stats end to end: two jammers report to the real stats Worker code (stats/worker.js), run here in Node
// behind a small HTTP shim with an in-memory stand-in for its D1 table, and the admin dashboard reads them back.
// Checks what a report holds (and doesn't), that the Worker cleans and gates what it gets, that ?stats=0 and
// automated browsers stay out, and that admin.html renders the real numbers without errors.
//
//   node server/dev.js &      (8787)
//   node tests/stats.test.cjs [baseUrl]
const { chromium } = require('playwright');
const http = require('node:http');
const path = require('node:path');
const BASE = process.argv[2] || 'http://localhost:8787/';
const PORT = 8799, ST = `http://localhost:${PORT}`, KEY = 'test-admin-key';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };

// the D1 calls the Worker makes, kept in a Map
function fakeD1() {
  const rows = new Map();
  return {
    rows,
    async batch() { return []; },
    prepare(sql) {
      const st = { args: [], bind(...a) { st.args = a; return st; },
        async first() { if (/^SELECT last FROM sessions WHERE sid/.test(sql)) { const r = rows.get(st.args[0]); return r ? { last: r.last } : null; } return null; },
        async run() {
          if (/^INSERT INTO sessions/.test(sql)) { const [sid, now, room, country, data] = st.args, r = rows.get(sid); rows.set(sid, { sid, first: r ? r.first : now, last: now, room, country, data }); }
          if (/^DELETE FROM sessions/.test(sql)) for (const [k, r] of rows) if (r.last < st.args[0]) rows.delete(k);
          return {};
        },
        async all() { return { results: [...rows.values()].filter((r) => r.last >= st.args[0]).sort((a, b) => b.last - a.last) }; },
      };
      return st;
    },
  };
}

(async () => {
  const worker = (await import(path.resolve(__dirname, '../stats/worker.js'))).default;
  const env = { DB: fakeD1(), ADMIN_KEY: KEY, ORIGINS: 'https://samuelling.github.io' };
  let reports = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    if (req.url.startsWith('/report')) reports++;
    const r = await worker.fetch(new Request(ST + req.url, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  }).listen(PORT);

  // ---- the Worker on its own ----
  const post = (o, origin = 'http://localhost:8787') => fetch(ST + '/report?final=1', { method: 'POST', headers: { origin }, body: typeof o === 'string' ? o : JSON.stringify(o) });
  check((await post({ v: 1, sid: 'abcdefgh01' }, 'https://evil.example')).status === 403, 'Worker: reports from another site are refused');
  check((await post('nonsense')).status === 400 && (await post({ v: 2, sid: 'abcdefgh01' })).status === 400, 'Worker: junk and unknown versions are refused');
  await post({ v: 1, sid: 'abcdefgh01', name: 'Sam', chat: 'hi', dev: { os: '<img src=x>', br: 'chrome' }, inst: ['juniper', '<b>x</b>'], peak: 99 });
  const stored = JSON.parse(env.DB.rows.get('abcdefgh01').data);
  check(!('name' in stored) && !('chat' in stored) && stored.dev.os === 'other' && stored.inst.join() === 'juniper' && stored.peak === 16, 'Worker: only schema fields are stored, cleaned and clamped');
  check((await fetch(ST + '/summary')).status === 401 && (await fetch(ST + '/summary', { headers: { authorization: 'Bearer wrong' } })).status === 401, 'Worker: the summary needs the admin key');
  env.DB.rows.clear(); reports = 0;

  // ---- two jammers ----
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  const jammer = async (name, q) => { const p = await (await browser.newContext()).newPage(); p.on('pageerror', (e) => { if (!/from the stats test/.test(e.message)) errors.push(`${name}: ${e.message}`); }); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  // an automated browser with no explicit endpoint stays out of the numbers (mp-config's server is not used here)
  const Q = await jammer('Quiet', '');
  check(await Q.evaluate(() => !JJ.stats.report), 'an automated browser without ?stats= sends nothing');
  const A = await jammer('Sam', `?stats=${ST}`);
  await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
  const code = await A.textContent('#roomCode');
  const B = await jammer('Matt', `?room=${code}&stats=${ST}&lag=40&jitter=8`);
  await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && !(await B.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1 && [...JJ.room.peers.values()].every((p) => p.path === 'direct')))) await sleep(300);
  await sleep(6000);
  await A.evaluate(() => JJ.addInstrument('monolith')); await B.evaluate(() => JJ.addInstrument('tine'));
  await sleep(800);
  await Promise.all([A, B].map((p, i) => p.evaluate(async (i) => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); for (let k = 0; k < 16; k++) { JJ.input.press(50 + i * 9 + (k % 4), 100); await s(80); JJ.input.release(50 + i * 9 + (k % 4)); await s(60); } }, i)));
  await B.evaluate(() => setTimeout(() => { throw new Error('boom from the stats test'); }, 0));
  await A.evaluate(() => document.querySelector('[data-room="compose"]')?.click());
  await sleep(5500);
  await Promise.all([A, B].map((p) => p.evaluate(() => JJ.stats.flush())));
  await sleep(1000);
  const S = await (await fetch(ST + '/summary?days=1', { headers: { authorization: 'Bearer ' + KEY } })).json();
  const sa = S.sessions.find((x) => x.sid === (S.sessions.find((y) => y.used.includes('compose')) || {}).sid), sb = S.sessions.find((x) => x !== sa);
  check(S.sessions.length === 2 && sa && sb, `both sessions stored (${S.sessions.length})`);
  check(sa.room && sa.room === sb.room && sa.room !== code && !JSON.stringify(S).includes(code), 'one jam: the same hashed room, and the room code itself never sent');
  check(sa.peak === 1 && sb.peak === 1 && sa.bandSec > 5 && sb.bandSec > 5, `band size and time together (${sa.bandSec} s, ${sb.bandSec} s)`);
  check(sb.joinMs > 0 && sb.joinMs < 20000 && sa.joinMs == null, `join time for the one who joined (${sb.joinMs} ms)`);
  check(sa.net.directSec > 0 && sa.net.rttDirect.reduce((x, y) => x + y) > 0 && sb.net.look.reduce((x, y) => x + y) > 0 && sb.net.clockErr.reduce((x, y) => x + y) > 0, 'link time, round trips, lookahead and clock error sampled');
  check(sa.notes.played === 16 && sb.notes.heard === 16 && sa.notes.heard === 16, `notes played and heard (${sa.notes.played} played, ${sb.notes.heard} and ${sa.notes.heard} heard)`);
  check(sa.inst.includes('monolith') && sb.inst.includes('tine') && sa.used.includes('compose'), 'instruments and features used');
  check(sb.errors.length === 1 && /boom from the stats test/.test(sb.errors[0].m) && !sa.errors.length, 'the error, from the browser that had it');
  check(!JSON.stringify(S).includes('Sam') && !JSON.stringify(S).includes('Matt'), 'no names anywhere');
  check(S.sessions.every((x) => x.dev.os && x.dev.br && x.dev.sr > 0), 'device kind and audio rate');

  // closing the tab sends a last report
  const n0 = reports;
  await A.goto('about:blank'); await B.goto('about:blank'); await sleep(800);
  check(reports >= n0 + 2, `leaving the page sends a last report (${reports - n0})`);
  // ?stats=0 turns it off for this browser for good
  const before = reports;
  const O = await jammer('Off', `?stats=0`);
  const off1 = await O.evaluate(() => !JJ.stats.report && localStorage.getItem('jj:stats') === '0');
  await O.goto(BASE + `?stats=${ST}`); // an explicit endpoint later still respects the browser's choice
  check(off1 && (await O.evaluate(() => !JJ.stats.report)) && reports === before, '?stats=0 turns reporting off in that browser, and it stays off');

  // the dashboard
  const P = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  P.on('pageerror', (e) => errors.push('admin: ' + e.message));
  await P.goto(BASE + 'admin.html?stats=' + ST);
  check(await P.isVisible('form.key input'), 'the dashboard asks for the key');
  await P.fill('form.key input', KEY); await P.click('form.key button');
  await P.waitForSelector('.tile', { timeout: 5000 });
  const tiles = await P.$$eval('.tile', (t) => t.map((x) => x.innerText.replace(/\s+/g, ' ')));
  check(/Sessions 2/.test(tiles[0]) && /Jams 1/.test(tiles[1]) && /Sessions with errors 50/.test(tiles[5]), `the dashboard shows them (${tiles.slice(0, 2).join(' | ')} | ${tiles[5]})`);
  check(await P.$$eval('.card svg', (s) => s.length) >= 7 && await P.$$eval('tbody tr', (r) => r.length) >= 4, 'charts and tables drawn');

  check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await browser.close(); server.close();
  console.log(failures ? `${failures} check(s) failed` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
