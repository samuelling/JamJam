// "Jam with a friend": Robin, a pretend bandmate (this app in a hidden frame, ?bot=1), walks into your room as a real
// second player 60 ms away. The tour shows notes travelling (Robin's bass played by your browser), the shared clock
// and lookahead, Hear myself, the chat (Robin says hi; you answer), Talk, ways to jam, a hardware twin (Robin links
// an OB-6; you hear its twin), I have one too, Match my sound, Sync take, and Robin leaving.
//   node server/dev.js &  (8787)        node tests/tutorial-friends.test.cjs
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const errors = [];
  try {
    const cx = await b.newContext({ viewport: { width: 1400, height: 1000 } });
    // like iPhone Safari: a frame nobody has tapped can't start audio, and resume() never settles. Robin must still walk in.
    await cx.addInitScript(() => { if (!/[?&]bot=1/.test(location.search)) return; Object.defineProperty(BaseAudioContext.prototype, 'state', { get: () => 'suspended' }); AudioContext.prototype.resume = () => new Promise(() => {}); });
    const p = await cx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    const name0 = 'Sam';
    await p.goto(BASE + '?lag=30'); await p.fill('#nameIn', name0); await p.click('#startBtn'); await p.waitForSelector('#studio:not(.hide)'); await sleep(1200);
    const step = () => p.evaluate(() => JJ.tours.active()?.step || null);
    const waitStep = async (id, ms = 10000) => { for (let t = 0; t < ms; t += 150) { if ((await step()) === id) return true; await sleep(150); } return false; };
    const card = () => p.textContent('.tour-card');
    const next = async () => { await p.click('.tour-card .tour-next'); await sleep(250); };
    await p.click('#helpBtn'); await sleep(200);
    const items = await p.$$eval('.tour-menu button', (bs) => bs.map((x) => x.textContent));
    check(items.length === 3 && items.some((t) => /Jam with a friend/.test(t)), `? Tours lists three tours (${items.join(' | ')})`);
    await p.evaluate(() => [...document.querySelectorAll('.tour-menu button')].find((x) => /Jam with a friend/.test(x.textContent)).click());
    check(await waitStep('hello') && /Robin/.test(await card()), 'the tour introduces Robin');
    await next();
    check(await waitStep('listen', 25000), 'Robin walks in: a corner of their own');
    const corner = await p.evaluate(() => [...document.querySelectorAll('.corner .cname')].map((c) => c.textContent));
    check(corner.some((t) => /^Robin/.test(t)), `Robin's corner is there (${corner.join(', ')})`);
    const robinId = await p.evaluate(() => [...JJ.S.players.entries()].find(([, v]) => v.name === 'Robin')?.[0]);
    await sleep(3000);
    const heard = await p.evaluate((rid) => JJ.engine.log.filter((e) => e.type === 'on' && String(e.pid).startsWith(rid + ':')).length, robinId);
    check(heard >= 4, `your browser plays Robin's bass from Robin's notes (${heard} notes heard in 3 s)`);
    const name1 = await p.evaluate(() => localStorage.getItem('megajam.name'));
    check(name1 === name0, `Robin doesn't overwrite your saved name (${name1})`);
    await next();
    check(await waitStep('together'), 'then: play along');
    await p.mouse.click(700, 5); for (const k of ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'j']) { await p.keyboard.down(k); await sleep(80); await p.keyboard.up(k); await sleep(60); }
    check(await waitStep('clock'), 'playing along moves it on to the shared clock');
    await p.click('#techBtn');
    check(await waitStep('look'), 'the gear shows the timing; on to the lookahead');
    await sleep(1500);
    const look = +((await card()).match(/right now it's (\d+) ms/) || [])[1];
    check(look >= 40, `the card reads the live lookahead with Robin ~60 ms away (${look} ms)`);
    await next(); check(await waitStep('feel'), 'Hear myself'); await next();
    check(await waitStep('chat'), 'then: the chat');
    await sleep(1500);
    check(/Robin here/.test(await p.textContent('#chatLog')), "Robin's hello arrives in the band chat");
    await p.click('.sidetab[data-panel="panel-chat"]'); await p.fill('#chatIn', 'hi Robin!'); await p.click('#chatSend');
    check(await waitStep('talk'), 'saying hi back moves it on');
    await sleep(1500);
    check(/glad you made it/.test(await p.textContent('#chatLog')), 'and Robin answers');
    await next(); check(await waitStep('styles'), 'ways to jam'); await next();
    check(await waitStep('twin'), 'then: twins');
    for (let t = 0; t < 40 && !(await p.evaluate(() => /OB-6/.test([...document.querySelectorAll('.corner')].map((c) => c.textContent).join(' ')))); t++) await sleep(250);
    const twin = await p.evaluate((rid) => (JJ.S.players.get(rid)?.rack || []).find((x) => x.cfg?.hw)?.cfg, robinId);
    check(twin && twin.hw === 'sequential-ob-6', `Robin links an OB-6 (${JSON.stringify(twin && { hw: twin.hw, inst: twin.inst })})`);
    check(/OB-6/.test(await p.evaluate(() => [...document.querySelectorAll('.corner')].map((c) => c.textContent).join(' '))) && /twin/.test(await card()), "Robin's corner shows the OB-6, and the card explains its twin");
    await next(); check(await waitStep('onetoo'), 'I have one too'); await next();
    check(await waitStep('match'), 'Match my sound'); await next();
    check(await waitStep('sync'), 'Sync take'); await next();
    check(await waitStep('bye'), 'Robin heads home');
    // the room drops a bandmate whose direct link is still open after it's sure they've gone (up to 12 s); the frame goes 0.8 s after
    let gone = false; for (let t = 0; t < 70 && !gone; t++) { await sleep(250); gone = !(await p.$('iframe.tour-friend')) && !(await p.evaluate(() => [...document.querySelectorAll('.corner .cname')].some((c) => /^Robin/.test(c.textContent)))); }
    check(gone, 'Robin leaves: the corner empties, the hidden frame is gone');
    await next();
    check(await waitStep('end') && /all set/i.test(await card()), '"You\'re all set!"');
    await p.click('.tour-card .btn.hot'); await sleep(300);
    check((await p.evaluate(() => localStorage.getItem('megajam.tour.friends'))) === '1', 'the friend tour is marked done');
    check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  } catch (e) { console.error(e); failures++; }
  await b.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
