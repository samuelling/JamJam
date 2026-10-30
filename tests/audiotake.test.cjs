// Audio takes: Sam goes live (a fake microphone's tone), loops a section, and locks a pass of his live audio in.
// The take lands in Matt's song, the audio itself reaches Matt once, both browsers play it from the song on the
// next pass, a bandmate who joins later asks for it and gets it, and the arrangement draws it as a waveform.
//   node server/dev.js &  (8787)        node tests/audiotake.test.cjs
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const errors = [];
  const mk = async (q, name) => { const c = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['microphone'] }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto('http://localhost:8787/' + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?lag=25', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=25`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1 && [...JJ.room.peers.values()].every((x) => x.path === 'direct')))); if (ok.every(Boolean)) break; await sleep(300); }
    await A.evaluate(() => { JJ.setSong('sec:v1', { name: 'Verse', bars: 2, chords: ['Dm7', 'G7'], notes: '' }); JJ.setSong('order', ['v1']); });
    await sleep(500);
    // go live from the shelf, then loop the verse
    await A.click('#addLiveBtn'); await A.click('#laneBtn'); await sleep(800);
    check(await A.evaluate(() => JJ.lane().on), 'Sam goes live from the shelf');
    await A.evaluate(() => JJ.play('loop', 'v1'));
    const passMs = await A.evaluate(() => 8 * 60000 / JJ.tempo.bpm(JJ.clock.now()));
    await sleep(passMs * 2.3 + 1000);
    check((await A.$('#secbar button >> text=Lock in my live audio')) !== null, 'the section bar offers to lock in his live audio');
    await A.evaluate(() => JJ.lockAudio());
    await sleep(600);
    const part = await B.evaluate(() => Object.values(JJ.song().sections.v1.parts).find((p) => p.kind === 'audio'));
    const take = part && part.takes.find((t) => t.id === part.current);
    check(!!(take && take.audio && take.audio.frames > 20000), `an audio take lands in Matt's song (${take ? (take.audio.frames / take.audio.sr).toFixed(1) + ' s' : 'none'})`);
    const peak = take ? Math.max(...take.audio.peaks) : 0;
    check(peak > 0.05, `it holds what Sam played (peak ${peak.toFixed(2)})`);
    let got = false;
    for (let i = 0; i < 20 && !got; i++) { await sleep(400); got = (await B.evaluate((id) => JJ.audio().have.includes(id), take.audio.id)); }
    check(got, 'the audio itself reaches Matt');
    await sleep(passMs + 800);
    const started = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.audio().started)));
    check(started[0] > 0 && started[1] > 0, `both play it from the song on the next pass (${started.join(' and ')} starts)`);
    // someone joins later: they ask for the audio and get it
    const C = await mk(`?room=${code}&lag=25`, 'Pat');
    await C.click('#joinBtn'); await C.waitForSelector('#studio:not(.hide)');
    let late = false;
    for (let i = 0; i < 40 && !late; i++) { await sleep(500); late = await C.evaluate((id) => JJ.audio().have.includes(id), take.audio.id); }
    check(late, 'a bandmate who joins later gets the audio too');
    // the arrangement draws it as a waveform
    await A.evaluate(() => JJ.goRoom('compose')); await sleep(500);
    await A.evaluate(() => { if (!document.querySelector('#compose .cell.take')) document.querySelector('#compose .lanetoggle')?.click(); });
    await sleep(300);
    check((await A.$$('#compose .cell.take svg polygon')).length === 1, 'the arrangement draws the audio take as a waveform');
    await A.screenshot({ path: '/tmp/audiotake.png' });
    await A.evaluate(() => JJ.stopSong());
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } catch (e) { console.error(e); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
