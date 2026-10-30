// The Stem Console: everything the room plays goes through one console. It starts by itself, a preset comes out under
// the ceiling, a live instrument joins its stem, turning it off restores the old path, the panel steers it, the
// settings reach the other jammer, and notes are still heard at the same room time in both browsers.
//   node server/dev.js &  (8787)        node tests/console.test.cjs
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const errors = [];
  const mk = async (q, name) => { const c = await b.newContext({ viewport: { width: 1400, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); p.on('dialog', (d) => d.accept()); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1))); if (ok.every(Boolean)) break; await sleep(300); }
    await sleep(1500);
    const [ca, cb] = await Promise.all([A, B].map((p) => p.evaluate(() => [JJ.console().route, JJ.engine.busLatency])));
    check(ca[0] === 'console' && cb[0] === 'console' && ca[1] > 0.005 && ca[1] < 0.021, `the console runs by itself in both browsers (${ca})`);
    await A.evaluate(() => { const ctx = JJ.engine.ctx, a = ctx.createAnalyser(); a.fftSize = 2048; JJ.engine.songOut.connect(a); window.AN = a; ctx.resume(); JJ.goRoom('compose'); });
    await sleep(400);
    await A.selectOption('select.presets', '3:0'); await sleep(800);
    await A.click('.playsong'); await sleep(1500);
    const peak = (ms) => A.evaluate(async (ms) => { const d = new Float32Array(2048); let p = 0; const t = performance.now(); while (performance.now() - t < ms) { AN.getFloatTimeDomainData(d); for (const v of d) p = Math.max(p, Math.abs(v)); await new Promise((r) => setTimeout(r, 30)); } return p; }, ms);
    const pk = await peak(5000);
    check(pk > 0.05 && pk < 0.95, `a preset comes out of the console, under the ceiling (peak ${pk.toFixed(3)})`);
    await A.click('.masterbtn'); await sleep(300);
    check(await A.$('.masterpanel') != null, 'Mastering opens the console');
    await sleep(500);
    check(await A.evaluate(() => /LUFS/.test(document.querySelector('[data-mm]')?.textContent || '')), 'its meters run');
    await A.click('.masterpanel button[aria-pressed]'); await sleep(600);
    check(await A.evaluate(() => JJ.console().route === 'plain' && JJ.engine.busLatency === 0), 'switched off, the old path is back');
    check(await B.evaluate(() => JJ.console().route === 'plain' && JJ.song().master.on === false), 'for the other jammer too');
    await A.click('.masterpanel button[aria-pressed]'); await sleep(600);
    check(await A.evaluate(() => JJ.console().route === 'console'), 'and back on');
    await A.click('.playsong'); await sleep(500);
    await A.evaluate(() => { JJ.goRoom('jam'); JJ.addInstrument('machina', '909'); }); await sleep(1500);
    check(await A.evaluate(() => [...JJ.engine.ch.values()].some((c) => !c.bus && c.stem === 1)), 'a live drum machine joins the Drums stem');
    const heard = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.engine.log.filter((e) => e.type === 'on' && !e.pid.startsWith('song:')).slice(-1)[0]?.heard)));
    await A.evaluate(() => { JJ.input.press(60, 100, 0); }); await sleep(600); await A.evaluate(() => { JJ.input.release(60, 0); }); await sleep(500);
    const h2 = await Promise.all([A, B].map((p) => p.evaluate(() => { const e = JJ.engine.log.filter((x) => x.type === 'on' && !x.pid.startsWith('song:')).slice(-1)[0]; return e ? [e.at, e.heard] : null; })));
    check(h2[0] && h2[1] && Math.abs(h2[0][1] - h2[1][1]) < 8 && heard.length === 2, `a live note is heard at the same room time in both browsers (${h2[0] && (h2[0][1] - h2[1][1]).toFixed(2)} ms apart)`);
    check(!errors.length, `no page errors (${errors.join('; ')})`);
  } catch (e) { check(false, 'threw: ' + e.message); }
  await b.close();
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
