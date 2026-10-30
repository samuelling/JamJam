// Correcting a take in the Compose Room's lane view: drag a note later (it snaps to the grid), drag its end to
// lengthen it, click (or double-click) to add one, double-click to delete, and Quantize pulls sloppy starts onto the grid. Every change is
// an edited copy of the take; the original stays and "Back to the original" returns to it.
//   node server/dev.js &  (8787)        node tests/noteedit.test.cjs
const { chromium } = require('playwright');
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const b = await chromium.launch(); const errors = [];
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  try {
    await p.goto('http://localhost:8787/'); await p.fill('#nameIn', 'Sam'); await p.click('#startBtn'); await p.waitForSelector('#studio:not(.hide)');
    await p.evaluate(() => {
      const ev = (notes) => notes.flatMap(([n, b, d, v]) => [{ b, type: 'on', note: n, vel: v }, { b: b + d, type: 'off', note: n }]);
      JJ.goRoom('compose');
      JJ.loadSong({ format: 'megajam.song/1', title: 'Fix', bpm: 96, key: { root: 9, mode: 'minor' }, meter: 4, order: ['s1'], labels: [], rule: 'newest', variations: {}, sections: {
        s1: { id: 's1', name: 'Verse', bars: 2, chords: ['Am', 'E7'], notes: '', parts: { 'l-keys': { id: 'l-keys', name: 'Keys', lane: 'Keys', role: 'comping', inst: 'juniper', patch: 'keys', by: 'x', byName: 'Sam',
          takes: [{ id: 't1', events: ev([[57, 0.07, 0.9, 100], [60, 1.1, 0.8, 100], [64, 1.94, 0.9, 100], [62, 3.12, 0.8, 100]]), by: 'x', byName: 'Sam', at: Date.now() }], current: 't1' } } } } });
    });
    await p.waitForTimeout(1000);
    if (!(await p.$('.cell.take'))) await p.click('.lanetoggle');
    await p.click('.cell.take'); await p.waitForTimeout(300);
    await p.evaluate(() => document.querySelector('.laneview').scrollIntoView({ block: 'center' })); await p.waitForTimeout(150);
    const take = () => p.evaluate(() => { const pt = JJ.song().sections.s1.parts['l-keys']; const t = pt.takes.find((q) => q.id === pt.current); return { n: pt.takes.length, edit: !!t.edit, on: t.events.filter((e) => e.type === 'on').map((e) => [e.note, +e.b.toFixed(3)]), off: t.events.filter((e) => e.type === 'off').map((e) => [e.note, +e.b.toFixed(3)]) }; });
    const box = async (i) => p.evaluate((i) => { const r = document.querySelectorAll('.lvroll .lvnote')[i].getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width, right: r.right }; }, i);
    const rollW = await p.evaluate(() => document.querySelector('.lvroll').getBoundingClientRect().width), beatPx = rollW / 8;
    // drag the first note one beat later: it lands on the grid
    let nb = await box(0);
    await p.mouse.move(nb.x + 3, nb.y); await p.mouse.down(); for (let k = 1; k <= 6; k++) await p.mouse.move(nb.x + 3 + (beatPx * k) / 6, nb.y); await p.mouse.up(); await p.waitForTimeout(400);
    let t = await take();
    check(t.edit && t.n === 2 && t.on.some(([n, b]) => n === 57 && b === 1), `dragging a note moves it a beat later, snapped (${JSON.stringify(t.on[0])}), as an edited copy (${t.n} takes)`);
    // lengthen a note by its right end
    const idx = await p.evaluate(() => [...document.querySelectorAll('.lvroll .lvnote')].findIndex((r) => /E4/.test(r.textContent)));
    nb = await box(idx);
    await p.mouse.move(nb.right - 2, nb.y); await p.mouse.down(); for (let k = 1; k <= 6; k++) await p.mouse.move(nb.right - 2 + beatPx * k / 6, nb.y); await p.mouse.up(); await p.waitForTimeout(400);
    t = await take();
    const e4 = t.off.find(([n]) => n === 64);
    check(t.n === 2 && e4 && e4[1] > 3.5, `dragging a note's end lengthens it (E4 now ends at beat ${e4 && e4[1]}), still one edited copy`);
    // quantize: every start onto the 1/16 grid
    await p.click('.lvtools button >> text=Quantize'); await p.waitForTimeout(400);
    t = await take();
    check(t.on.every(([, b]) => Math.abs(b * 4 - Math.round(b * 4)) < 1e-6), `Quantize puts every start on the grid (${t.on.map(([, b]) => b).join(', ')})`);
    // double-click an empty spot adds a note; double-click a note deletes it
    const r = await p.evaluate(() => { const e = document.querySelector('.lvroll').getBoundingClientRect(); return { x: e.left, y: e.top, w: e.width, h: e.height }; });
    const before = t.on.length;
    await p.mouse.dblclick(r.x + r.w * 0.8, r.y + 3); await p.waitForTimeout(400);
    t = await take();
    check(t.on.length === before + 1, `double-clicking an empty spot adds a note (${before} → ${t.on.length})`);
    nb = await box(0); await p.mouse.dblclick(nb.x + 3, nb.y); await p.waitForTimeout(400);
    t = await take();
    check(t.on.length === before, `double-clicking a note deletes it (${t.on.length})`);
    await p.click('.lvtools button >> text=Back to the original'); await p.waitForTimeout(400);
    t = await take();
    check(!t.edit && t.on[0][1] === 0.07, 'Back to the original brings the untouched take back');
    check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  } finally { await b.close(); }
  console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
