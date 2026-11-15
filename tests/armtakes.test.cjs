// Arm takes from the Compose Room: with the music stopped, ⏺ Arm takes starts the picked section looping after a bar
// of count-in that clicks (metronome off), and you stay in the Compose Room; every full pass Sam plays is kept as a
// take; disarming part way through a pass keeps that pass too (he played more than a bar of it) and leaves the music
// playing; the newest take sounds; Matt has them all; stopping the music while armed disarms.
//   node server/dev.js &  (8787)        node tests/armtakes.test.cjs
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const mk = async (q, name) => { const c = await browser.newContext({ viewport: { width: 1400, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); p.on('dialog', (d) => d.accept()); await p.goto('http://localhost:8787/' + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?lag=25', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=25`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1))); if (ok.every(Boolean)) break; await sleep(250); }
    await A.evaluate(() => { JJ.setTempo?.(150); JJ.setSong('sec:v1', { name: 'Verse', bars: 2, chords: ['Dm7', 'G7'], notes: '' }); JJ.setSong('sec:c1', { name: 'Chorus', bars: 2, chords: ['C', 'C'], notes: '' }); JJ.setSong('order', ['v1', 'c1']); });
    await A.evaluate(() => JJ.goRoom('compose')); await sleep(600);
    // pick the Chorus, count the metronome's clicks
    await A.click('.shead[data-col="1"]'); await sleep(200);
    await A.evaluate(() => { const e = JJ.engine; e.metro.on = false; window.__clicks = []; const c = e.click.bind(e); e.click = (t, acc) => { window.__clicks.push(JJ.tempo.beatAt(JJ.clock.now())); return c(t, acc); }; });
    const lab0 = (await A.textContent('#compose .recbtn')).trim();
    await A.click('#compose .recbtn'); await sleep(150);
    const st = await A.evaluate(() => { const tr = JJ.song().transport, b = JJ.tempo.beatAt(JJ.clock.now()); return { on: tr.on, mode: tr.mode, sid: tr.sid, ahead: tr.start - b, where: JJ.S.where, label: document.querySelector('#compose .recbtn').textContent, countTo: JJ.engine.metro.countTo, start: tr.start }; });
    console.log('  ', JSON.stringify(st));
    check(lab0 === '⏺ Arm takes' && st.on && st.mode === 'loop' && st.sid === 'c1' && st.where === 'compose', `⏺ Arm takes in the Compose Room starts the picked section (the Chorus) looping, and you stay in the Compose Room`);
    check(st.ahead > 3.5 && st.ahead <= 8.01 && st.countTo === st.start && /Count in · \d/.test(st.label), `a bar of count-in first, counted on the button ("${st.label.trim()}", ${st.ahead.toFixed(1)} beats)`);
    const beatMs = await A.evaluate(() => 60000 / JJ.tempo.bpm(JJ.clock.now())), passMs = beatMs * 8;
    await sleep(st.ahead * beatMs + 300);
    const clicks = await A.evaluate((s) => ({ before: window.__clicks.filter((b) => b < s).length, after: window.__clicks.filter((b) => b >= s + 0.5).length }), st.start);
    check(clicks.before >= 3, `the count-in clicks with the metronome off (${clicks.before} clicks)`);
    // Sam plays through two full passes and 1.3 bars of a third, then disarms
    const playFor = (ms) => A.evaluate(async (ms) => { const s = (t) => new Promise((r) => setTimeout(r, t)); const end = Date.now() + ms; let i = 0; while (Date.now() < end) { const n = [60, 64, 67, 72][i++ % 4]; JJ.input.press(n, 100); await s(120); JJ.input.release(n); await s(80); } }, ms);
    await playFor(passMs * 2 + beatMs * 5.2);
    const mid = await A.evaluate(() => ({ label: document.querySelector('#compose .recbtn').textContent, n: JJ.song().sections.c1.parts ? Object.values(JJ.song().sections.c1.parts).filter((p) => p.byName === 'Sam').reduce((a, p) => a + p.takes.length, 0) : 0, after: window.__clicks.length }));
    check(/Recording takes · 2 kept/.test(mid.label) && mid.n === 2, `each full pass is kept while armed ("${mid.label.trim()}")`);
    check(clicks.after === 0 && (await A.evaluate((s) => window.__clicks.filter((b) => b >= s + 0.5).length, st.start)) === 0, 'the clicks stop when the loop starts');
    await A.click('#compose .recbtn'); await sleep(500);
    const off = await A.evaluate(() => { const p = Object.values(JJ.song().sections.c1.parts).find((q) => q.byName === 'Sam'); return { n: p.takes.length, rec: p.recording, cur: p.current === p.takes[p.takes.length - 1].id, on: JJ.song().transport.on, label: document.querySelector('#compose .recbtn').textContent, status: document.querySelector('#status').textContent, last: p.takes[p.takes.length - 1].events.filter((e) => e.type === 'on').length }; });
    console.log('  ', JSON.stringify(off));
    check(off.n === 3 && off.last > 0 && /3 takes kept/.test(off.status), `disarming keeps the pass he was in too (${off.n} takes): "${off.status.trim()}"`);
    check(!off.rec && off.cur && off.on && off.label.trim() === '⏺ Arm takes', 'the newest take sounds, the music keeps playing, the button is back to Arm takes');
    const mb = await B.evaluate(() => Object.values(JJ.song().sections.c1.parts).find((q) => q.byName === 'Sam')?.takes.length);
    check(mb === 3, `Matt has all three takes (${mb})`);
    // armed again while it plays: it counts in to the next pass; stopping the music disarms
    await A.click('#compose .recbtn'); await sleep(150);
    const again = await A.evaluate(() => ({ label: document.querySelector('#compose .recbtn').textContent, armed: JJ.recState().armed }));
    check(again.armed && /Count in|Recording takes/.test(again.label), `armed while the music plays, it waits for the next pass ("${again.label.trim()}")`);
    await A.evaluate(() => JJ.stopSong()); await sleep(400);
    check(!(await A.evaluate(() => JJ.recState().armed)) && !(await A.evaluate(() => JJ.song().transport.on)), 'stopping the music disarms');
    check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  } catch (e) { console.log('FAIL', e.message); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
