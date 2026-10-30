// Step entry in the Compose Room: with a lane's roll open, MIDI notes land at a cursor, a chord lands whole, a rest
// skips a step, and the other jammer gets the part with the song. With it off, MIDI plays your desk as before.
//   node server/dev.js &  (8787)        node tests/stepentry.test.cjs
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
const midi = (p, on, n) => p.evaluate(([on, n]) => JJ.input.onMIDI({ data: [on ? 0x90 : 0x80, n, on ? 90 : 0], target: { id: 'kb' } }), [on, n]);
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const errors = [];
  const mk = async (q, name) => { const c = await b.newContext({ viewport: { width: 1400, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?midimock=1', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1))); if (ok.every(Boolean)) break; await sleep(300); }
    await sleep(800);
    await A.evaluate(() => {
      JJ.goRoom('compose');
      JJ.loadSong({ format: 'megajam.song/1', title: 'Steps', bpm: 100, key: { root: 0, mode: 'major' }, meter: 4, order: ['s'], labels: [], rule: 'newest', variations: {}, sections: { s: { id: 's', name: 'Verse', bars: 2, chords: [], notes: '', parts: { 'l-horn': { id: 'l-horn', name: 'Horn', lane: 'Horn', role: 'melody', inst: 'blown', patch: 'reed', drums: false, takes: [{ id: 'seed', events: [{ b: 6, type: 'on', note: 62, vel: 80 }, { b: 7, type: 'off', note: 62 }], by: 'import', byName: 'seed', at: 0 }], current: 'seed', by: 'import' } } } } });
    });
    await sleep(600);
    await A.click('.lanetoggle'); await sleep(200);
    await A.click('.lhead.pick'); await sleep(200);
    await A.click('button[aria-pressed]'); await sleep(200);
    check(await A.$('.lvcursor') != null, 'a cursor shows on the roll');
    const notes = (p) => p.evaluate(() => { const q = JJ.song().sections.s.parts['l-horn'], ev = q.takes.find((t) => t.id === q.current).events; return ev.filter((e) => e.type === 'on').map((e) => [e.b, e.note]).sort((x, y) => x[0] - y[0] || x[1] - y[1]); });
    await A.selectOption('select[aria-label="Step length"]', '1'); await sleep(100);
    await A.click('text=◀ Back'); await A.click('text=◀ Back'); await A.click('text=◀ Back'); await A.click('text=◀ Back'); await A.click('text=◀ Back'); await A.click('text=◀ Back'); await A.click('text=◀ Back'); await sleep(100);
    await midi(A, true, 60); await sleep(50); await midi(A, false, 60); await sleep(100);
    await midi(A, true, 64); await midi(A, true, 67); await sleep(50); await midi(A, false, 64); await midi(A, false, 67); await sleep(100);
    await A.click('text=Rest ▶'); await sleep(50);
    await midi(A, true, 69); await midi(A, false, 69); await sleep(100);
    const n1 = await notes(A);
    check(JSON.stringify(n1) === JSON.stringify([[0, 60], [1, 64], [1, 67], [3, 69], [6, 62]]), `a note, a chord, a rest, a note, and the old note kept (${JSON.stringify(n1)})`);
    await A.click('text=↶ Undo'); await sleep(150);
    check(!(await notes(A)).some(([, n]) => n === 69), 'Undo takes the last step out');
    await A.click('text=↷ Redo'); await sleep(150);
    check((await notes(A)).some(([, n]) => n === 69), 'Redo puts it back');
    await A.click('text=Clear notes'); await sleep(150);
    check(!(await notes(A)).length, 'Clear notes empties the roll');
    await A.click('text=↶ Undo'); await A.click('text=↶ Undo'); await sleep(150);
    await sleep(600);
    check(JSON.stringify(await notes(B)) === JSON.stringify(await notes(A)), 'the other jammer has the same notes');
    const desk = () => A.evaluate(() => JJ.engine.log.filter((e) => e.type === 'on' && e.pid.startsWith(JJ.S.me)).length);
    const d0 = await desk();
    check(d0 === 0, `step entry stays off the desk (${d0})`);
    await A.click('button[aria-pressed]'); await sleep(150);
    const n2 = JSON.stringify(await notes(A));
    await A.evaluate(() => JJ.addEntry?.({ inst: 'tine' }));
    await midi(A, true, 72); await midi(A, false, 72); await sleep(200);
    check(JSON.stringify(await notes(A)) === n2, 'with it off, MIDI writes nothing');
    check(!errors.length, `no page errors (${errors.join('; ')})`);
  } catch (e) { check(false, 'threw: ' + e.message); }
  await b.close();
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
