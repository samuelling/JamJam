// The handshake server going away mid-jam: the band keeps playing over direct links, everyone reconnects by
// themselves under the same jammer ids, nobody appears to leave, and a new jammer can still walk in afterwards.
//   node server/dev.js &  (8787)        node tests/reconnect.test.cjs
const { chromium } = require('playwright');
const http = require('http');
const BASE = process.argv[2] || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
const drop = () => new Promise((res) => http.get(new URL('__drop', BASE), (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d.trim())); }));

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const mk = async (q, name) => { const c = await browser.newContext(); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  const state = (p) => p.evaluate(() => ({ me: JJ.S.me, id: JJ.room.id, rid: JJ.room.rid, peers: [...JJ.room.peers.values()].map((x) => `${x.id}:${x.path}`).sort().join(','), players: JJ.S.players.size, ws: !!(JJ.room.ws && JJ.room.ws.readyState === 1) }));
  const notesHeard = (p, pid) => p.evaluate((pid) => JJ.engine.log.filter((e) => e.pid.startsWith(pid + ':') && e.type === 'on').length, pid);
  const play = (p, n) => p.evaluate(async (n) => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); for (let i = 0; i < n; i++) { JJ.input.press(60 + (i % 5), 100); await s(90); JJ.input.release(60 + (i % 5)); await s(60); } }, n);
  try {
    const A = await mk('?silent=1&lag=20', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&silent=1&lag=20`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1 && [...JJ.room.peers.values()].every((x) => x.path === 'direct')))); if (ok.every(Boolean)) break; await sleep(300); }
    await sleep(1500);
    const a0 = await state(A), b0 = await state(B);

    // 1. one jammer's relay connection drops (a network blip on Sam's side)
    await A.evaluate(() => JJ.room.ws.close());
    await sleep(500);
    const before = await notesHeard(B, a0.me);
    await play(A, 6);
    await sleep(800);
    check((await notesHeard(B, a0.me)) - before === 6, "while Sam's relay is down, his notes still reach Matt over the direct link");
    await sleep(3000);
    const a1 = await state(A), b1 = await state(B);
    check(a1.ws && a1.id === a0.id && a1.rid !== a0.rid, `Sam reconnects by himself with a new relay address but the same jammer id (${a0.rid} → ${a1.rid})`);
    check(b1.players === 1 && b1.peers === b0.peers, `Matt never saw Sam leave (${b1.peers})`);
    await sleep(12000);   // past the grace period for the relay's "leave"
    check((await state(B)).players === 1, 'and still has him after the grace period');

    // 2. the whole relay restarts (every connection drops at once)
    check(/dropped 2/.test(await drop()), 'the relay restarts');
    await sleep(500);
    const before2 = await notesHeard(A, b0.me);
    await play(B, 5);
    await sleep(800);
    check((await notesHeard(A, b0.me)) - before2 === 5, 'the band keeps playing while it is down');
    await sleep(4000);
    const a2 = await state(A), b2 = await state(B);
    check(a2.ws && b2.ws && a2.id === a0.id && b2.id === b0.id, 'both reconnect with their jammer ids');
    check(a2.players === 1 && b2.players === 1 && a2.peers === a0.peers && b2.peers === b0.peers, 'no duplicate or missing jammers');

    // 3. a new jammer can still walk in
    const C = await mk(`?room=${code}&silent=1&lag=20`, 'Maya');
    await C.click('#joinBtn'); await C.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 50; i++) { const ok = await Promise.all([A, B, C].map((p) => p.evaluate(() => JJ.S.players.size === 2 && [...JJ.room.peers.values()].every((x) => x.path === 'direct')))); if (ok.every(Boolean)) break; await sleep(300); }
    const all = await Promise.all([A, B, C].map(state));
    check(all.every((s) => s.players === 2), `a new jammer walks in after the restart (${all.map((s) => s.players).join(', ')} bandmates each)`);
    for (let i = 0; i < 40; i++) { if (await C.evaluate(() => JJ.clock.locked)) break; await sleep(300); }
    await sleep(1500);
    const cHeard0 = await notesHeard(C, a0.me); await play(A, 4); await sleep(900);
    const cHeard = (await notesHeard(C, a0.me)) - cHeard0;
    const dump = await C.evaluate((pid) => JJ.engine.log.filter((e) => e.pid.startsWith(pid + ':') && e.type === 'on').map((e) => e.note + '@' + Math.round(e.at) + (e.now ? 'N' : '')).join(' '), a0.me);
    check(cHeard === 4, `and hears Sam (${cHeard} of 4 notes: ${dump})`);
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } catch (e) { console.error(e); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
