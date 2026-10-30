// Listeners: someone joins to hear the band without playing. Their browser runs the band's instruments (so they
// hear the band at full quality from notes alone), they get no corner, never lead the clock, and can applaud.
//   node server/dev.js &  (8787)        node tests/listen.test.cjs
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const mk = async (q, name) => { const c = await browser.newContext(); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?lag=20&silent=1', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const L = await mk(`?lag=20&silent=1`, 'Emma');
    await L.fill('#codeIn', code); await L.click('#listenBtn'); await L.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, L].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1))); if (ok.every(Boolean)) break; await sleep(300); }
    await sleep(1200);
    const a = await A.evaluate(() => ({ corners: document.querySelectorAll('#corners .corner:not(.empty)').length, listeners: document.querySelector('#listeners').textContent, leader: JJ.clock.isLeader }));
    const l = await L.evaluate(() => ({ corners: document.querySelectorAll('#corners .corner:not(.empty)').length, rack: JJ.S.rack.length, desk: getComputedStyle(document.querySelector('.deskrow')).display, leader: JJ.clock.isLeader }));
    check(a.corners === 1 && /1 listening/.test(a.listeners), `the band sees one corner and "${a.listeners}"`);
    check(l.corners === 1 && l.rack === 0 && l.desk === 'none', 'the listener sees the band, has no instruments and no desk');
    check(a.leader && !l.leader, 'the band keeps the clock');
    const before = await L.evaluate(() => JJ.engine.log.filter((e) => e.type === 'on').length);
    await A.evaluate(async () => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); for (let i = 0; i < 6; i++) { JJ.input.press(60 + i, 100); await s(90); JJ.input.release(60 + i); await s(60); } });
    await sleep(800);
    const heard = (await L.evaluate(() => JJ.engine.log.filter((e) => e.type === 'on').length)) - before;
    check(heard === 6, `the listener's browser plays the band's notes (${heard} of 6)`);
    await L.evaluate(() => JJ.react('clap'));
    await sleep(300);
    const clap = await A.evaluate(() => [...document.querySelectorAll('.reaction')].map((e) => e.textContent).join(' '));
    check(/👏/.test(clap) && /Emma/.test(clap), `the band sees the applause (${clap})`);
    // the band can still fill four corners with a listener in the room
    const B = await mk(`?room=${code}&lag=20&silent=1`, 'Matt'); await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    await sleep(3000);
    const corners = await Promise.all([A, B, L].map((p) => p.evaluate(() => document.querySelectorAll('#corners .corner:not(.empty)').length)));
    check(corners.every((n) => n === 2), `a second jammer joins the band, not the audience (${corners.join(', ')} corners)`);
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } catch (e) { console.error(e); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
