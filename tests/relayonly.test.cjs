// A jammer who can only use the relay, in a room where the others link directly: within a few seconds of walking
// in, their clock locks and everyone hears everyone. (Before, the others dropped every message to them while their
// own direct attempt ran its 8 s course, so the newcomer's clock couldn't lock and their notes never went out;
// they heard the band, but the band heard nothing from them for 15 s or more.)
//
//   node server/dev.js &      (8787)
//   node tests/relayonly.test.cjs [baseUrl]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };

(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  const mk = async (name, q) => { const p = await (await b.newContext()).newPage(); p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`)); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  const A = await mk('Sam', '?x=1');
  await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
  const code = await A.textContent('#roomCode');
  const B = await mk('Matt', `?room=${code}`); await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
  await sleep(3000);
  const C = await mk('Ev', `?room=${code}&p2p=0`);
  const t0 = Date.now();
  await C.click('#joinBtn'); await C.waitForSelector('#studio:not(.hide)');
  let lockMs = null;
  while (Date.now() - t0 < 15000) { if (await C.evaluate(() => JJ.clock.locked && JJ.S.players.size === 2)) { lockMs = Date.now() - t0; break; } await sleep(200); }
  check(lockMs != null && lockMs < 5000, `the relay-only newcomer's clock locks and they meet both (${lockMs} ms)`);
  await Promise.all([A, B, C].map((p, i) => p.evaluate(async (i) => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); JJ.addInstrument('poly'); await s(800); for (let k = 0; k < 10; k++) { JJ.input.press(48 + i * 7, 100); await s(90); JJ.input.release(48 + i * 7); await s(60); } }, i)));
  await sleep(1500);
  const heard = await Promise.all([A, B, C].map((p) => p.evaluate(() => { const out = {}; for (const [k, c] of JJ.engine.ch) { const pid = k.split(':')[0]; out[pid] = (out[pid] || 0) + c.noteBase + c.notes.length; } return { me: JJ.S.me, out }; })));
  const ids = heard.map((x) => x.me);
  for (const [i, x] of heard.entries()) check(ids.every((id) => x.out[id] === 10), `${['Sam', 'Matt', 'Ev (relay only)'][i]} hears all three play (${ids.map((id) => x.out[id] || 0).join(', ')})`);
  await sleep(Math.max(0, 9500 - (Date.now() - t0)));
  const paths = await A.evaluate(() => [...JJ.room.peers.values()].map((p) => p.path).sort().join('/'));
  check(paths === 'direct/relay', `Sam is direct to Matt and relayed to Ev (${paths})`);
  check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await b.close();
  console.log(failures ? `${failures} check(s) failed` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
