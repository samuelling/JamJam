// A live song note always gets its end: when the part goes over to its render just after the note started, and when
// the ticks come late (a throttled tab). Otherwise a sustaining instrument drones on after the song stops.
//   node server/dev.js &  (8787)        node tests/stucknote.test.cjs
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const errors = [];
  try {
    const A = await (await b.newContext()).newPage(); A.on('pageerror', (e) => errors.push(e.message));
    await A.goto(BASE); await A.fill('#nameIn', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    await sleep(1500);
    const held = () => A.evaluate(() => [...(JJ.engine.ch.get('song:l-x')?.held || [])]);
    const load = (bars, bpm, len, tk) => A.evaluate(([bars, bpm, len, tk]) => {
      const ev = []; for (let i = 0; i < bars * 4; i += 1) ev.push({ b: i, type: 'on', note: 60 + (i % 8), vel: 100 }, { b: i + len, type: 'off', note: 60 + (i % 8) });
      JJ.goRoom('compose');
      JJ.loadSong({ format: 'megajam.song/1', title: 'T', bpm, key: { root: 0, mode: 'major' }, meter: 4, order: ['a'], labels: [], rule: 'newest', variations: {}, sections: { a: { id: 'a', name: 'Verse', bars, chords: [], notes: '', parts: { 'l-x': { id: 'l-x', name: 'Horn', lane: 'Horn', role: 'melody', inst: 'blown', patch: 'reed', drums: false, takes: [{ id: tk, events: ev, by: 'import', byName: 'seed', at: 0 }], current: tk, by: 'import' } } } } });
    }, [bars, bpm, len, tk]);
    await load(2, 120, 0.5, 't1'); await sleep(500);
    await A.click('text=Loop it'); await sleep(4000); await A.click('#compose .details button.on'); await sleep(2500);
    check(!(await held()).length, 'a note started just before the render takes over gets its end');
    await load(30, 60, 0.5, 't2'); await sleep(500);
    await A.click('text=Loop it'); await sleep(2500);
    await A.evaluate(() => { const t = performance.now(); while (performance.now() - t < 1800); });
    await sleep(300); await A.click('#compose .details button.on'); await sleep(2500);
    check(!(await held()).length, 'so does one whose end falls in a gap between ticks');
    check(!errors.length, `no page errors (${errors.join('; ')})`);
  } catch (e) { check(false, 'threw: ' + e.message); }
  await b.close();
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
