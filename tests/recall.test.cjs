// Record every pass: Matt arms it and jams over a looping section; every full pass he plays becomes a take without
// a click, his lane stays quiet in the song while he records (nobody hears old takes over him), and when he stops,
// the newest take sounds for both of them. Sam sees all the takes.
//   node server/dev.js &  (8787)        node tests/recall.test.cjs
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const mk = async (q, name) => { const c = await browser.newContext({ viewport: { width: 1400, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto('http://localhost:8787/' + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?lag=25', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=25`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1 && [...JJ.room.peers.values()].every((x) => x.path === 'direct')))); if (ok.every(Boolean)) break; await sleep(300); }
    await A.evaluate(() => { JJ.setTempo?.(140); JJ.setSong('sec:v1', { name: 'Verse', bars: 1, chords: ['Dm7'], notes: '' }); JJ.setSong('order', ['v1']); });
    await sleep(500);
    await A.evaluate(() => JJ.play('loop', 'v1'));
    await sleep(1500);
    await B.click('#secbar button.recall'); await sleep(200);
    check(await B.evaluate(() => /Recording every pass/.test(document.querySelector('#secbar .recall').textContent)), 'Matt arms Record every pass from the section bar');
    const passMs = await B.evaluate(() => 4 * 60000 / JJ.tempo.bpm(JJ.clock.now()));
    // he plays for about four passes
    await B.evaluate(async (ms) => { const s = (t) => new Promise((r) => setTimeout(r, t)); const end = Date.now() + ms; let i = 0; while (Date.now() < end) { const n = [62, 65, 69, 72, 74][i++ % 5]; JJ.input.press(n, 100); await s(180); JJ.input.release(n); await s(60); } }, passMs * 4.4);
    await sleep(passMs + 600);
    const part = await A.evaluate(() => Object.values(JJ.song().sections.v1.parts).find((p) => p.byName === 'Matt'));
    const n = part ? part.takes.length : 0;
    check(n >= 3, `every full pass became a take without a click (${n} takes)`);
    check(part && part.recording, 'his lane is marked as being recorded');
    const t0 = await A.evaluate(() => JJ.clock.now());
    await sleep(passMs * 1.5);
    const quiet = await A.evaluate(({ t0 }) => JJ.engine.log.filter((e) => e.pid.startsWith('song:') && e.at > t0).length, { t0 });
    check(quiet === 0, `while he records, his takes stay quiet in the song (${quiet} song notes)`);
    await B.click('#secbar button.recall'); await sleep(600);
    const after = await A.evaluate(() => Object.values(JJ.song().sections.v1.parts).find((p) => p.byName === 'Matt'));
    check(after && !after.recording && after.current === after.takes[after.takes.length - 1].id, 'stopping makes the newest take the one that sounds');
    const t1 = await A.evaluate(() => JJ.clock.now());
    await sleep(passMs * 2 + 1500);
    const plays = await Promise.all([A, B].map((p) => p.evaluate(({ t1 }) => JJ.engine.log.filter((e) => e.pid.startsWith('song:') && e.type === 'on' && e.at > t1).length + JJ.bounced().length, { t1 })));
    check(plays.every((x) => x > 0), `then it plays from the song for both (${plays.join(' / ')})`);
    await A.evaluate(() => JJ.stopSong());
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } catch (e) { console.error(e); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
