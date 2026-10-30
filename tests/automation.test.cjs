// Automation: knob moves are always recorded with a take (each knob starting where it was when the pass began); they
// play back with the take and come out in the stems; hidden unless Show automation is on, then a track's ◇ opens a
// lane per knob, where points can be added (shared with the band) and removed; editing notes keeps the moves.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const errors = [];
  const mk = async (q, name) => { const c = await b.newContext({ viewport: { width: 1400, height: 1000 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  const settle = async (pages) => { for (let i = 0; i < 60; i++) { const ok = await Promise.all(pages.map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size >= 1))); if (ok.every(Boolean)) break; await sleep(300); } await sleep(800); };
  try {
    const A = await mk('?lag=30&empty=1', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    try { await A.evaluate(() => localStorage.removeItem('megajam.auto')); } catch (_) {}
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=30&empty=1`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    await settle([A, B]);
    await A.evaluate(() => JJ.loadSong({ format: 'megajam.song/1', title: 'Auto', bpm: 120, key: { root: 0, mode: 'major' }, meter: 4, order: ['s1'], labels: [], rule: 'newest', variations: {}, sections: { s1: { id: 's1', name: 'Verse', bars: 1, chords: ['C'], notes: '', parts: {} } } }));
    await sleep(500);
    const r = await A.evaluate(() => JJ.addInstrument('monolith', 'bass').r); await sleep(500);
    await A.evaluate((r) => { JJ.select(r); JJ.setParam('cutoff', 300); }, r); await sleep(300);
    // loop the section, play, and sweep the cutoff while playing
    await A.evaluate(() => JJ.play('loop', 's1')); await sleep(1800);
    await A.evaluate(async (r) => {
      JJ.select(r); const s = (ms) => new Promise((q) => setTimeout(q, ms)); const beat = 60000 / JJ.tempo.bpm(JJ.clock.now()), t0 = JJ.clock.now(), end = t0 + beat * 4 * 2.2;
      let i = 0; while (JJ.clock.now() < end) { const n = [36, 43][i++ % 2]; JJ.input.press(n, 100); for (let k = 0; k < 4; k++) { const ph = ((JJ.clock.now() - t0) % (beat * 4)) / (beat * 4); JJ.setParam('cutoff', Math.round(300 + 4000 * ph)); await s(beat * 0.15); } JJ.input.release(n); await s(beat * 0.4); }
    }, r);
    await A.evaluate((r) => JJ.lockIn(r), r); await A.evaluate(() => JJ.stopSong()); await sleep(600);
    const tk = await B.evaluate(() => { const s = JJ.song(), p = Object.values(s.sections.s1.parts)[0], t = p.takes[p.takes.length - 1]; return { lane: p.laneId, ev: t.events.filter((e) => e.type === 'p'), notes: t.events.filter((e) => e.type === 'on').length }; });
    const cut = tk.ev.filter((e) => e.id === 'cutoff');
    check(cut.length >= 6 && tk.notes >= 3, `the take Matt has carries the cutoff sweep with the notes (${cut.length} moves, ${tk.notes} notes)`);
    check(cut[0] && cut[0].b === 0 && cut.slice(1).some((e) => e.v > 2000), `the sweep starts at bar 1 from where the knob was when the pass began (${JSON.stringify(cut.slice(0, 3))})`);

    // hidden by default: no lanes, just a ◇ on the block
    await A.evaluate(() => JJ.goRoom('compose')); await sleep(400);
    await A.evaluate(() => { if (!document.querySelector('.cell.take')) document.querySelector('.lanetoggle').click(); }); await sleep(300);
    check(!(await A.$('.autorow')) && !(await A.$('.msb.autob')) && !!(await A.$('.cell.take .automark')), 'automation is hidden by default; the block shows a small ◇');
    // turn it on, open the track's lanes
    await A.evaluate(() => { if (!document.querySelector('.songopts')) document.querySelector('.moretoggle').click(); }); await sleep(200);
    await A.click('.autotoggle'); await sleep(200);
    await A.click('.msb.autob'); await sleep(300);
    const lanesShown = await A.evaluate(() => [...document.querySelectorAll('.autorow .autohead small')].map((e) => e.textContent));
    check(lanesShown.some((t) => /Cutoff/.test(t)) && !!(await A.$('.autorow .autolane')), `◇ opens a Cutoff lane under the track (${lanesShown.join(', ')})`);
    // add a knob lane and draw a point in it: Matt gets it
    await A.selectOption('.autoadd', 'emphasis'); await sleep(300);
    const box = await A.evaluate(() => { const l = [...document.querySelectorAll('.autolane.compact')].find((e) => e.dataset.auto === 'emphasis'); l.scrollIntoView({ block: 'center' }); const r = l.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    await A.mouse.click(box.x + box.w * 0.5, box.y + box.h * 0.2); await sleep(700);
    let em = await B.evaluate(() => { const p = Object.values(JJ.song().sections.s1.parts)[0], t = p.takes.find((q) => q.id === p.current); return t.events.filter((e) => e.type === 'p' && e.id === 'emphasis'); });
    check(em.length === 1 && Math.abs(em[0].b - 2) < 0.26 && em[0].r === 1 && em[0].v > 0.6, `a click draws an Emphasis point mid-block, high up, and Matt has it (${JSON.stringify(em)})`);
    // double-click removes it
    await A.mouse.dblclick(box.x + box.w * 0.5, box.y + box.h * 0.2); await sleep(900);
    em = await B.evaluate(() => { const p = Object.values(JJ.song().sections.s1.parts)[0], t = p.takes.find((q) => q.id === p.current); return t.events.filter((e) => e.type === 'p' && e.id === 'emphasis'); });
    check(em.length === 0, `double-clicking the point removes it (${em.length} left)`);
    // editing notes keeps the knob moves
    await A.evaluate(() => document.querySelector('.cell.take').click()); await sleep(400);
    await A.evaluate(() => document.querySelector('.lvroll').scrollIntoView({ block: 'center' })); await sleep(150);
    const R = await A.evaluate(() => { const e = document.querySelector('.lvroll').getBoundingClientRect(); return { x: e.left, y: e.top, w: e.width, h: e.height }; });
    const n0 = await A.evaluate(() => { const p = Object.values(JJ.song().sections.s1.parts)[0]; return p.takes.find((q) => q.id === p.current).events.filter((e) => e.type === 'on').length; });
    await A.mouse.click(R.x + R.w * 0.93, R.y + 4); await sleep(600);
    const after = await A.evaluate(() => { const p = Object.values(JJ.song().sections.s1.parts)[0], t = p.takes.find((q) => q.id === p.current); return { on: t.events.filter((e) => e.type === 'on').length, cut: t.events.filter((e) => e.type === 'p' && e.id === 'cutoff').length }; });
    check(after.on === n0 + 1 && after.cut === cut.length, `adding a note in the roll keeps the cutoff moves (${JSON.stringify(after)})`);
    check(!!(await A.$('.lvbody .autolane')), 'the roll shows the same lanes under it, as wide as the roll');

    // the moves are in the sound: the stem with the sweep vs the same take with the moves cleared
    const energyHi = async () => A.evaluate(async () => { await JJ.exportStems({ to: 'memory' }); const w = JJ.readWav24(JJ.lastStems.find((f) => /Stems\/01 /.test(f.name)).data); let d = 0, e = 0; for (let i = 1; i < w.L.length; i++) { const x = w.L[i] - w.L[i - 1]; d += x * x; e += w.L[i] * w.L[i]; } return d / e; });
    // a known sweep on the take (the recorded one depends on where the pass fell): 300 Hz up to 8 kHz across the bar
    await A.evaluate(() => { const s = JJ.song(), p = Object.values(s.sections.s1.parts)[0], t = p.takes.find((q) => q.id === p.current);
      const ev = t.events.filter((e) => !(e.type === 'p' && e.id === 'cutoff')).concat([{ b: 0, type: 'p', id: 'cutoff', v: 300 }, { b: 3.5, type: 'p', id: 'cutoff', v: 8000, r: 1 }]).sort((a, b) => a.b - b.b);
      JJ.setSong(`part:s1:${p.id}`, { ...p, takes: p.takes.map((q) => (q.id === t.id ? { ...q, events: ev } : q)) }); });
    await sleep(500);
    const withMoves = await energyHi();
    await A.evaluate(() => [...document.querySelectorAll('.autorow .autohead')].find((e) => /Cutoff/.test(e.textContent)).querySelector('.msb').click()); await sleep(700);
    const left = await A.evaluate(() => { const p = Object.values(JJ.song().sections.s1.parts)[0], t = p.takes.find((q) => q.id === p.current); return t.events.filter((e) => e.type === 'p').length; });
    const without = await energyHi();
    check(left === 0, 'the lane\'s × clears the knob from the track\'s blocks');
    check(withMoves > without * 1.25, `the sweep opens the filter in the render: brightness ${withMoves.toExponential(2)} with the moves vs ${without.toExponential(2)} without`);
    check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  } finally { await b.close(); }
  console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
