// Writing a part on an empty piano roll in the Compose Room. From the section's "Write a part for…" picker
// (an instrument on your desk), a click places a note and a drag makes it longer. From an empty block in a lane
// row, the lane's own instrument. The written part is song state like a jammed take, so the other jammer has all
// of it and plays it from the song.
//   node server/dev.js &  (8787)        node tests/writepart.test.cjs
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const errors = [];
  const mk = async (q, name) => { const c = await b.newContext({ viewport: { width: 1400, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?lag=30', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=30`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1))); if (ok.every(Boolean)) break; await sleep(300); }
    await sleep(1200);
    await A.evaluate(() => {
      JJ.goRoom('compose');
      JJ.loadSong({ format: 'megajam.song/1', title: 'Blank', bpm: 100, key: { root: 0, mode: 'major' }, meter: 4, order: ['s1', 's2'], labels: [], rule: 'newest', variations: {}, sections: {
        s1: { id: 's1', name: 'Verse', bars: 2, chords: ['C', 'G'], notes: '', parts: {} }, s2: { id: 's2', name: 'Chorus', bars: 2, chords: ['F', 'C'], notes: '', parts: {} } } });
    });
    await sleep(800);
    await A.click('.shead[data-sec="s1"]'); await sleep(300);
    const opts = await A.$$eval('.writerow select option', (o) => o.map((x) => x.value + '=' + x.textContent));
    check(opts.some((o) => o.startsWith('r:')), `the section offers a part for an instrument on your desk (${opts.join(' | ')})`);
    await A.selectOption('.writerow select', opts.find((o) => o.startsWith('r:')).split('=')[0]); await sleep(300);
    check(!!(await A.$('.lvroll.blank')), 'picking it opens an empty roll');
    await A.evaluate(() => document.querySelector('.laneview').scrollIntoView({ block: 'center' })); await sleep(150);
    const R = await A.evaluate(() => { const e = document.querySelector('.lvroll').getBoundingClientRect(); return { x: e.left, y: e.top, w: e.width, h: e.height }; });
    const beat = R.w / 8, rowH = R.h / 25;
    // three clicks: beat 1, beat 2 and beat 3, on rows 10, 8, 6 from the top; then a dragged note from beat 5 to beat 7
    for (const [k, row] of [[0, 10], [1, 8], [2, 6]]) { await A.mouse.click(R.x + beat * (k + 0.1), R.y + rowH * (row + 0.5)); await sleep(350); }
    await A.mouse.move(R.x + beat * 4.1, R.y + rowH * 12.5); await A.mouse.down();
    for (let s = 1; s <= 8; s++) await A.mouse.move(R.x + beat * (4.1 + (2 * s) / 8), R.y + rowH * 12.5);
    await A.mouse.up(); await sleep(500);
    const part = (p, sid) => p.evaluate((sid) => { const ps = Object.values(JJ.song().sections[sid]?.parts || {}); const pt = ps[0]; if (!pt) return null; const t = pt.takes.find((q) => q.id === pt.current); return { id: pt.id, lane: pt.lane, n: pt.takes.length, written: !!t?.written, on: t.events.filter((e) => e.type === 'on').map((e) => [e.note, +e.b.toFixed(3)]), off: t.events.filter((e) => e.type === 'off').map((e) => [e.note, +e.b.toFixed(3)]) }; }, sid);
    let a = await part(A, 's1');
    check(a && a.written && a.n === 1 && a.on.length === 4, `the notes made one written part (${a && JSON.stringify(a.on)})`);
    check(a && a.on.map(([, b]) => b).join(',') === '0,1,2,4', `clicked notes start on the grid (${a && a.on.map(([, b]) => b).join(', ')})`);
    const pitches = a ? a.on.map(([n]) => n) : [];
    check(pitches[0] < pitches[1] && pitches[1] < pitches[2], `higher rows are higher notes (${pitches.join(', ')})`);
    const long = a && a.off.find(([n]) => n === pitches[3]);
    check(long && long[1] >= 5.9, `dragging while placing makes the note longer (ends at beat ${long && long[1]})`);
    await sleep(1200);
    let bb = await part(B, 's1');
    check(bb && JSON.stringify(bb.on) === JSON.stringify(a.on) && JSON.stringify(bb.off) === JSON.stringify(a.off), "the other jammer's song has the same part, note for note");
    // an empty block in the lane's row opens an empty roll for that lane in another section
    await A.evaluate(() => { if (!document.querySelector('.cell.take')) document.querySelector('.lanetoggle').click(); }); await sleep(300);
    await A.click('.cell.empty'); await sleep(300);
    check(!!(await A.$('.lvroll.blank')), 'an empty block in a lane opens an empty roll for it');
    await A.evaluate(() => document.querySelector('.laneview').scrollIntoView({ block: 'center' })); await sleep(150);
    const R2 = await A.evaluate(() => { const e = document.querySelector('.lvroll').getBoundingClientRect(); return { x: e.left, y: e.top, w: e.width, h: e.height }; });
    await A.mouse.click(R2.x + (R2.w / 8) * 0.1, R2.y + (R2.h / 25) * 12.5); await sleep(500);
    const c2 = await part(A, 's2');
    check(c2 && c2.id === a.id && c2.lane === a.lane && c2.on.length === 1, `the note went into the same lane in the chorus (${c2 && c2.lane})`);
    // delete a note: double-click it
    await A.click('.shead[data-sec="s1"]'); await sleep(200);
    await A.click('.cell.take'); await sleep(300);
    await A.evaluate(() => document.querySelector('.laneview').scrollIntoView({ block: 'center' })); await sleep(150);
    const nb = await A.evaluate(() => { const r = document.querySelectorAll('.lvroll .lvnote')[0].getBoundingClientRect(); return { x: r.left + 3, y: r.top + r.height / 2 }; });
    await A.mouse.dblclick(nb.x, nb.y); await sleep(500);
    a = await part(A, 's1');
    check(a && a.on.length === 3 && a.n === 1, `double-clicking a note deletes it, in the same written part (${a && a.on.length} notes, ${a && a.n} take)`);
    // B plays the song: it renders the written part from the song like any take
    await B.evaluate(() => JJ.play('loop', 's1')); await sleep(4000);
    const bounced = await B.evaluate(() => JJ.bounced());
    check(bounced.some((k) => k.startsWith(a.id + '.')), `the other jammer plays the written part from the song (${bounced.join(', ')})`);
    await B.evaluate(() => JJ.stopSong());
    check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  } finally { await b.close(); }
  console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
