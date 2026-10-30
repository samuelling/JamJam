// Talkback: a bandmate's voice arrives as a WebRTC audio track after the jam has started (renegotiated over the
// direct link), comes from their corner's side of the stereo field, dips the music while they talk, and the jam's
// notes keep flowing throughout. Chromium's fake microphone (a beeping tone) stands in for a voice.
//   node server/dev.js &  (8787)        node tests/talk.test.cjs
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const mk = async (q, name) => { const c = await browser.newContext({ permissions: ['microphone'] }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?lag=20', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=20`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1 && [...JJ.room.peers.values()].every((x) => x.path === 'direct')))); if (ok.every(Boolean)) break; await sleep(300); }
    await sleep(1000);
    const sam = await A.evaluate(() => JJ.S.me);

    // Sam opens his mic mid-jam
    check(await A.evaluate(() => JJ.talk(true)), 'Sam opens his mic');
    let v = [];
    for (let i = 0; i < 40; i++) { v = await B.evaluate(() => JJ.voices()); if (v.length && v[0].level > 0.012) break; await sleep(250); }
    check(v.length === 1 && v[0].id === sam, "Matt receives Sam's voice track (added after the link was up)");
    check(v[0] && v[0].level > 0.012, `and hears it (level ${(v[0]?.level ?? 0).toFixed(3)})`);
    check(v[0] && Math.abs(v[0].pan + 0.25) < 0.01, `from Sam's corner's side (pan ${v[0]?.pan})`);
    // the fake mic beeps on and off, so watch for a couple of seconds
    let duck = { minGain: 1, mark: false };
    for (let i = 0; i < 30; i++) { const d = await B.evaluate(() => ({ gain: JJ.engine.master.gain.value, mark: document.querySelector(`[data-talk="${JJ.S.players.keys().next().value}"]`)?.classList.contains('on') })); duck.minGain = Math.min(duck.minGain, d.gain); duck.mark ||= d.mark; await sleep(80); }
    check(duck.minGain < 0.6, `the music dips while he talks (master down to ${duck.minGain.toFixed(2)} from 0.90)`);
    check(duck.mark, "and Sam's corner shows he's talking");

    // the jam's notes still flow (and the data links survived the renegotiation)
    const before = await B.evaluate((pid) => JJ.engine.log.filter((e) => e.pid.startsWith(pid + ':') && e.type === 'on').length, sam);
    await A.evaluate(async () => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); for (let i = 0; i < 5; i++) { JJ.input.press(60 + i, 100); await s(100); JJ.input.release(60 + i); await s(50); } });
    await sleep(800);
    const after = await B.evaluate((pid) => JJ.engine.log.filter((e) => e.pid.startsWith(pid + ':') && e.type === 'on').length, sam);
    check(after - before === 5, `notes keep flowing while talking (${after - before} of 5)`);
    const paths = await Promise.all([A, B].map((p) => p.evaluate(() => [...JJ.room.peers.values()].map((x) => x.path).join())));
    check(paths.every((x) => x === 'direct'), 'links stay direct');

    // Sam stops: the mic stops sending and the music comes back
    await A.evaluate(() => JJ.talk(false));
    await sleep(1600);
    const back = await B.evaluate(() => ({ ducked: JJ.ducked(), gain: JJ.engine.master.gain.value, level: JJ.voices()[0]?.level ?? 0 }));
    check(!back.ducked && back.gain > 0.85 && back.level < 0.012, `when he stops, the music comes back (master ${back.gain.toFixed(2)}, voice ${back.level.toFixed(4)})`);
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } catch (e) { console.error(e); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
