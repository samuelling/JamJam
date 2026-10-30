// Virtual players: Sam adds a jazz drummer, and both browsers generate and play exactly the same drums (nothing but
// its settings travels). It listens to the band, changes style for everyone at a bar line, follows the song's
// sections, locks a section in as a take (then lays out there), and goes home when removed.
//   node server/dev.js &  (8787)        node tests/virtual.test.cjs
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const mk = async (q, name) => { const c = await browser.newContext(); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto('http://localhost:8787/' + q); await p.fill('#nameIn', name); return p; };
  // the drummer's notes each browser has played before room time T, as one string
  const drums = (p, T0, T) => p.evaluate(({ T0, T }) => JJ.engine.log.filter((e) => e.pid.startsWith('vp:') && e.type === 'on' && e.at >= T0 && e.at < T).map((e) => `${e.note}@${e.at.toFixed(1)}`).sort().join(' '), { T0, T });
  const same = async (A, B, T0, label) => {
    const T = Math.min(...(await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.now()))))) - 50;
    const [a, b] = await Promise.all([drums(A, T0, T), drums(B, T0, T)]);
    const n = a.split(' ').filter(Boolean).length;
    check(n > 8 && a === b, `${label} (${n} hits, ${a === b ? 'identical' : 'DIFFERENT'})`);
    if (a !== b && process.env.DBG) for (const p of [A, B]) console.log(await p.evaluate(() => JSON.stringify({ segs: JJ.tempo.segs, vp: JJ.players(), ch: [...JJ.engine.ch.keys()], plan: Object.keys(JJ.players()).map((id) => JJ.vplan(id) && JJ.vplan(id).start) })));
    if (a !== b) { const x = a.split(' '), y = b.split(' '); console.log('  A only', x.filter((v) => !y.includes(v)).slice(0, 8).join(' ')); console.log('  B only', y.filter((v) => !x.includes(v)).slice(0, 8).join(' ')); }
    return T;
  };
  try {
    const A = await mk('?lag=25', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=25`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1 && [...JJ.room.peers.values()].every((x) => x.path === 'direct')))); if (ok.every(Boolean)) break; await sleep(300); }
    await sleep(600);
    // the offer sits in an empty corner
    check(await A.$('.corner.empty .addvp') !== null, 'an empty corner offers a jazz drummer');
    await A.click('.corner.empty .addvp');
    await sleep(800);
    const vid = await A.evaluate(() => Object.keys(JJ.players())[0]);
    check(!!vid && (await B.evaluate((id) => !!JJ.players()[id], vid)), 'the drummer reaches Matt');
    check((await B.$$('.corner.vp')).length === 1 && (await A.$$('.corner.vp')).length === 1, 'both see it in a corner of its own');
    await sleep(6000);
    const T0 = await A.evaluate(() => JJ.clock.now() - 5000);
    let T = await same(A, B, T0, 'both browsers play the same drums at the same times');
    // the band plays: the drummer listens, in both browsers alike
    const r = await B.evaluate(() => JJ.S.rack[0].r);
    await B.evaluate(async () => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); const end = Date.now() + 6000; let i = 0; while (Date.now() < end) { const n = [60, 64, 67, 71, 72][i++ % 5]; JJ.input.press(n, 100); await s(120); JJ.input.release(n); await s(60); } });
    await sleep(1500);
    T = await same(A, B, T, 'while Matt plays and the drummer listens, still the same in both');
    // Matt switches it to bossa: both change at the same bar
    await B.evaluate((id) => JJ.setVirtual(id, { style: 'bossa' }), vid);
    await sleep(5000);
    const bossaA = await A.evaluate(({ T }) => JJ.engine.log.filter((e) => e.pid.startsWith('vp:') && e.type === 'on' && e.note === 37 && e.at > T).length, { T });
    check(bossaA > 2, `the bossa's cross-stick comes in (${bossaA} hits)`);
    T = await same(A, B, T, 'and the change landed together');
    // follow a song: head, solo, ending, with nothing locked
    await A.evaluate(() => { JJ.setSong('sec:h1', { name: 'Head', bars: 2, chords: ['Dm7', 'G7'], notes: '' }); JJ.setSong('sec:s1', { name: 'Solo', bars: 2, chords: ['Dm7', 'G7'], notes: '' }); JJ.setSong('sec:e1', { name: 'Ending', bars: 1, chords: ['Dm7'], notes: '' }); JJ.setSong('order', ['h1', 's1', 'e1']); });
    await A.evaluate((id) => JJ.setVirtual(id, { style: 'medium' }), vid);
    await sleep(600);
    await A.evaluate(() => JJ.play('song'));
    await sleep(500);
    const tr = await A.evaluate(() => ({ ...JJ.song().transport, beatMs: 60000 / JJ.tempo.bpm(JJ.clock.now()), start0: JJ.tempo.timeOf(JJ.song().transport.start), end: JJ.tempo.timeOf(JJ.song().transport.start + 20) }));
    await sleep(tr.end - (await A.evaluate(() => JJ.clock.now())) + 1500);
    const lastBar = await A.evaluate(({ a, b }) => JJ.engine.log.filter((e) => e.pid.startsWith('vp:') && e.type === 'on' && e.at >= a - 60 && e.at < b).map((e) => e.note).sort().join(','), { a: tr.start0 + tr.beatMs * 16, b: tr.start0 + tr.beatMs * 20 });
    check(lastBar === '36,38,49', `the song's last bar is one big hit, left to ring (${lastBar})`);
    const songDrums = await same(A, B, tr.start0 - 10, 'the song plays the same drums in both');
    void songDrums;
    // loop the solo and lock the drummer in: a take in a lane of its own, and the live drummer lays out there
    await A.evaluate(() => JJ.play('loop', 's1'));
    await sleep(1500);
    await A.evaluate((id) => JJ.lockVirtual(id, 's1'), vid);
    await sleep(800);
    const part = await B.evaluate(() => Object.values(JJ.song().sections.s1.parts).find((p) => p.lane === 'Jazz drummer'));
    const ons = part ? part.takes[0].events.filter((e) => e.type === 'on').length : 0;
    check(part && part.drums && ons > 10, `the drummer's solo section is locked in as a take Matt has too (${ons} hits)`);
    const t1 = await A.evaluate(() => JJ.clock.now() + 2500);
    await sleep(6000);
    const live = await A.evaluate((t1) => JJ.engine.log.filter((e) => e.pid.startsWith('vp:') && e.type === 'on' && e.at > t1).length, t1);
    check(live === 0, `with its drums locked in, the live drummer lays out there (${live} live hits)`);
    await A.evaluate(() => JJ.stopSong());
    // home time
    await B.evaluate((id) => JJ.removeVirtual(id), vid);
    await sleep(1200);
    const gone = await Promise.all([A, B].map((p) => p.evaluate(() => ({ ch: [...JJ.engine.ch.keys()].filter((k) => k.startsWith('vp:')).length, card: document.querySelectorAll('.corner.vp').length }))));
    check(gone.every((g) => g.ch === 0 && g.card === 0), 'removing it sends it home in both browsers');
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } catch (e) { console.error(e); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
