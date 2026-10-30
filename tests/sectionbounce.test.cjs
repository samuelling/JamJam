// Rendered audio stays with its section. Imports give a lane the same part id and the take id "seed" in every section,
// so two sections of the same length must still get a render each, not share the first one's.
//   node server/dev.js &  (8787)        node tests/sectionbounce.test.cjs
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
    await A.evaluate(() => {
      const part = (n) => ({ id: 'l-bass', name: 'Bass', lane: 'Bass', role: 'bass line', inst: 'tine', patch: 'bass', drums: false, takes: [{ id: 'seed', events: [{ b: 0, type: 'on', note: n, vel: 100 }, { b: 3, type: 'off', note: n }], by: 'import', byName: 'seed', at: 0 }], current: 'seed', by: 'import' });
      JJ.goRoom('compose');
      JJ.loadSong({ format: 'megajam.song/1', title: 'Two', bpm: 120, key: { root: 0, mode: 'major' }, meter: 4, order: ['a', 'b'], labels: [], rule: 'newest', variations: {}, sections: {
        a: { id: 'a', name: 'Verse', bars: 2, chords: [], notes: '', parts: { 'l-bass': part(40) } }, b: { id: 'b', name: 'Chorus', bars: 2, chords: [], notes: '', parts: { 'l-bass': part(52) } } } });
    });
    await sleep(800);
    await A.click('.playsong');
    await sleep(7000);
    const bounced = await A.evaluate(() => JJ.bounced());
    check(bounced.length === 2 && new Set(bounced).size === 2, `each section gets its own render (${bounced.join(', ')})`);
    check(bounced.every((k) => k.startsWith('l-bass.')), 'a render still names its part first');
    check(!errors.length, `no page errors (${errors.join('; ')})`);
  } catch (e) { check(false, 'threw: ' + e.message); }
  await b.close();
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
