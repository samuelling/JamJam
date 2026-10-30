// Changing a lane's instrument in the Compose Room: the notes stay, every section of the lane moves, both browsers
// agree, the part renders again on the new instrument, and two lanes moved to one sound stay two lanes.
//   node server/dev.js &  (8787)        node tests/lanesound.test.cjs
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const errors = [];
  const mk = async (q, name) => { const c = await b.newContext({ viewport: { width: 1400, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1))); if (ok.every(Boolean)) break; await sleep(300); }
    await sleep(800);
    await A.evaluate(() => {
      const part = (id, name, inst, patch, n, drums) => ({ id, name, lane: name, role: 'melody', inst, patch, params: { level: 0.5 }, drums, takes: [{ id: 'seed', events: [{ b: 0, type: 'on', note: n, vel: 100 }, { b: 2, type: 'off', note: n }], by: 'import', byName: 'seed', at: 0 }], current: 'seed', by: 'import' });
      const parts = () => ({ 'l-horn': part('l-horn', 'Trumpet', 'blown', 'reed', 72, false), 'l-keys': part('l-keys', 'Keys', 'tine', 'keys', 60, false), 'l-kit': part('l-kit', 'Drums', 'studio', 'dark', 36, true) });
      JJ.goRoom('compose');
      JJ.loadSong({ format: 'megajam.song/1', title: 'Swap', bpm: 120, key: { root: 0, mode: 'major' }, meter: 4, order: ['a', 'b'], labels: [], rule: 'newest', variations: {}, sections: { a: { id: 'a', name: 'Verse', bars: 2, chords: [], notes: '', parts: parts() }, b: { id: 'b', name: 'Chorus', bars: 2, chords: [], notes: '', parts: parts() } } });
    });
    await sleep(800);
    await A.click('.lanetoggle'); await sleep(200);
    await A.click('.playsong'); await sleep(5000);
    const before = await A.evaluate(() => JJ.song().sections.a.parts['l-horn'].takes[0].events);
    await A.selectOption('select[aria-label="Trumpet\'s instrument"]', 'monolith|lead');
    await sleep(800);
    const seen = (p) => p.evaluate(() => ['a', 'b'].map((s) => { const q = JJ.song().sections[s].parts['l-horn']; return [q.inst, q.patch, q.params, q.lane]; }));
    const [sa, sb] = await Promise.all([seen(A), seen(B)]);
    check(sa.every((q) => q[0] === 'monolith' && q[1] === 'lead' && q[2] == null), `every section of the lane moved, and the old settings went (${JSON.stringify(sa[0])})`);
    check(JSON.stringify(sa) === JSON.stringify(sb), 'both browsers agree');
    check(JSON.stringify(before) === JSON.stringify(await A.evaluate(() => JJ.song().sections.a.parts['l-horn'].takes[0].events)), 'the notes stayed');
    await sleep(4000);
    const n = await A.evaluate(() => JJ.bounced().filter((k) => k.startsWith('l-horn.')).length);
    check(n === 2, `a render per section, not one more for the old sound (${n})`);
    const sound = await A.evaluate(() => JJ.bounceKeys().filter(([k]) => k.startsWith('l-horn.')).map(([, v]) => v));
    check(sound.length && sound.every((v) => v.includes('monolith')), `and it is the new sound (${sound.join(', ')})`);
    await A.selectOption('select[aria-label="Keys\'s instrument"]', 'monolith|lead');
    await sleep(500);
    const lanes = await A.evaluate(() => Object.values(JJ.song().sections.a.parts).map((p) => p.lane));
    check(new Set(lanes).size === 3, `lanes on one sound stay apart (${lanes.join(', ')})`);
    const kit = await A.$$eval('select[aria-label="Drums\'s instrument"] option', (o) => o.map((x) => x.value));
    check(kit.length && kit.every((v) => !v.startsWith('monolith') && !v.startsWith('tine')), 'a drum lane is offered only drums');
    check(!errors.length, `no page errors (${errors.join('; ')})`);
  } catch (e) { check(false, 'threw: ' + e.message); }
  await b.close();
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
