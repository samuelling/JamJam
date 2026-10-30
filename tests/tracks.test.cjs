// Tracks in the Compose Room, like a DAW's: + Add track with any instrument (it opens on an empty roll), notes written
// into it, Jam it (its instrument on your desk, takes locked into the same track), swapping a desk slot's instrument
// makes a new track rather than changing the old one's sound, rejoining keeps you on your tracks (no second block),
// the track's instrument and name in its settings, mute (for everyone) and solo (just you), removing a track, and an
// older song's label-named lanes (with a rejoin's duplicate blocks) becoming tracks.
//   node server/dev.js &  (8787)        node tests/tracks.test.cjs
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const errors = [];
  const mk = async (q, name) => { const c = await b.newContext({ viewport: { width: 1400, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  const settle = async (pages) => { for (let i = 0; i < 60; i++) { const ok = await Promise.all(pages.map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size >= 1))); if (ok.every(Boolean)) break; await sleep(300); } await sleep(800); };
  try {
    let A = await mk('?lag=30&empty=1', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=30&empty=1`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    await settle([A, B]);
    await A.evaluate(() => {
      JJ.goRoom('compose');
      JJ.loadSong({ format: 'megajam.song/1', title: 'Tracks', bpm: 120, key: { root: 0, mode: 'major' }, meter: 4, order: ['s1', 's2'], labels: [], rule: 'newest', variations: {}, sections: {
        s1: { id: 's1', name: 'Verse', bars: 1, chords: ['C'], notes: '', parts: {} }, s2: { id: 's2', name: 'Chorus', bars: 1, chords: ['F'], notes: '', parts: {} } } });
    });
    await sleep(600);
    await A.click('.shead[data-sec="s1"]'); await sleep(200);
    // + Add track: Monolith, named Bass
    await A.click('.addtrack button'); await sleep(200);
    await A.selectOption('.addtrack.open select[aria-label="Instrument"]', 'monolith');
    await A.fill('.addtrack.open input', 'Bass');
    await A.click('.addtrack.open button.hot'); await sleep(400);
    const lanes = (p) => p.evaluate(() => Object.values(JJ.song().lanes || {}).map((t) => ({ id: t.id, name: t.name, inst: t.inst, patch: t.patch, owner: t.ownerName, muted: !!t.muted })));
    let la = await lanes(A);
    const bass = la.find((t) => t.name === 'Bass');
    check(bass && bass.inst === 'monolith' && bass.owner === 'Sam', `+ Add track makes a track with any instrument (${JSON.stringify(la)})`);
    check(!!(await A.$('.lvroll.blank')) && !!(await A.$('.trackbar')), 'it opens on an empty roll, with the track\'s settings above');
    // write a note in it
    await A.evaluate(() => document.querySelector('.laneview').scrollIntoView({ block: 'center' })); await sleep(150);
    const R = await A.evaluate(() => { const e = document.querySelector('.lvroll').getBoundingClientRect(); return { x: e.left, y: e.top, w: e.width, h: e.height }; });
    await A.mouse.click(R.x + 3, R.y + R.h * 0.6); await sleep(500);
    const partOf = (p, sid, lid) => p.evaluate(([sid, lid]) => { const ps = Object.values(JJ.song().sections[sid].parts || {}); const mine = ps.filter((q) => q.laneId === lid); return { blocks: mine.length, takes: mine[0] ? mine[0].takes.length : 0, all: ps.length, key: mine[0]?.id }; }, [sid, lid]);
    let pa = await partOf(A, 's1', bass.id);
    check(pa.blocks === 1 && pa.takes === 1 && pa.key === bass.id, `a written note goes into the track's block in the Verse (${JSON.stringify(pa)})`);
    await sleep(800);
    check((await lanes(B)).some((t) => t.id === bass.id && t.name === 'Bass'), 'Matt has the track too');

    // Jam it: Monolith on Sam's desk, a take locked in the Verse goes into the Bass track
    await A.evaluate(() => [...document.querySelectorAll('.trackbar button')].find((x) => x.textContent === 'Jam it').click()); await sleep(400);
    const r = await A.evaluate((lid) => JJ.S.rack.find((e) => e.laneId === lid)?.r, bass.id);
    check(!!r, 'Jam it puts the track\'s instrument on the desk, tied to the track');
    const jam = async (P, r, notes) => {
      await P.evaluate(() => JJ.play('loop', 's1')); await sleep(1800);
      await P.evaluate(async ([r, notes]) => { JJ.select(r); const s = (ms) => new Promise((q) => setTimeout(q, ms)); const beat = 60000 / JJ.tempo.bpm(JJ.clock.now()), end = JJ.clock.now() + beat * 4 * 2.2; let i = 0; while (JJ.clock.now() < end) { const n = notes[i++ % notes.length]; JJ.input.press(n, 100); await s(beat * 0.6); JJ.input.release(n); await s(beat * 0.4); } }, [r, notes]);
      const n = await P.evaluate((r) => JJ.lockIn(r), r); await P.evaluate(() => JJ.stopSong()); await sleep(400); return n;
    };
    await jam(A, r, [36, 43, 41, 38]);
    pa = await partOf(A, 's1', bass.id);
    check(pa.blocks === 1 && pa.takes === 2, `the jammed take lands in the same track, same block (${JSON.stringify(pa)})`);

    // swapping that desk slot to another instrument: a new track; the Bass track keeps its instrument
    await A.evaluate((r) => JJ.changeEntry(r, { inst: 'juniper' }), r); await sleep(300);
    const before = (await lanes(A)).length;
    await jam(A, r, [60, 64, 67, 72]);
    la = await lanes(A);
    const keys = la.find((t) => t.inst === 'juniper' && t.owner === 'Sam');
    check(la.length === before + 1 && keys && la.find((t) => t.id === bass.id).inst === 'monolith', `a different instrument in the slot makes its own track; Bass is still Monolith (${la.map((t) => t.name + ':' + t.inst).join(', ')})`);

    // rejoining: Sam leaves and walks back in with a Juniper; a new take joins the same Juniper track, no second block
    await A.close();
    A = await mk(`?room=${code}&lag=30&empty=1`, 'Sam');
    await A.click('#joinBtn'); await A.waitForSelector('#studio:not(.hide)');
    await settle([A, B]); await sleep(1500);
    const r2 = await A.evaluate(() => JJ.addInstrument('juniper', 'keys').r);
    await jam(A, r2, [62, 65, 69, 72]);
    pa = await partOf(A, 's1', keys.id);
    check(pa.blocks === 1 && pa.takes === 2, `after rejoining, Sam's Juniper takes still go into his Juniper track, in one block (${JSON.stringify(pa)})`);

    // the track's settings: rename, change its instrument; mute (for everyone) and solo (just you)
    await A.evaluate(() => JJ.goRoom('compose')); await sleep(300);
    await A.evaluate(() => { if (!document.querySelector('.cell.take')) document.querySelector('.lanetoggle').click(); }); await sleep(300);
    await A.evaluate((lid) => [...document.querySelectorAll('.arow')].find((row) => row.querySelector('.lhead b')?.textContent === 'Bass').querySelector('.cell.take').click(), bass.id); await sleep(300);
    await A.fill('.trackbar .tname', 'Low end'); await A.press('.trackbar .tname', 'Enter'); await sleep(300);
    await A.selectOption('.trackbar select[aria-label="Instrument"]', 'tine'); await sleep(400);
    la = await lanes(B);
    const be = la.find((t) => t.id === bass.id);
    check(be && be.name === 'Low end' && be.inst === 'tine', `renaming the track and changing its instrument reach Matt (${JSON.stringify(be)})`);
    await A.evaluate(() => [...document.querySelectorAll('.arow')].find((row) => row.querySelector('.lhead b')?.textContent === 'Low end').querySelector('.msb:not(.solo)').click()); await sleep(600);
    check((await lanes(B)).find((t) => t.id === bass.id)?.muted === true, 'M mutes the track for everyone');
    await A.evaluate(() => [...document.querySelectorAll('.arow')].find((row) => row.querySelector('.lhead b')?.textContent === 'Low end').querySelector('.msb.solo').click()); await sleep(300);
    const solo = await A.evaluate(() => [...(JJ.S.solo || [])]);
    const bSolo = await B.evaluate(() => [...(JJ.S.solo || [])]);
    check(solo.includes(bass.id) && bSolo.length === 0, 'S solos it for Sam only');

    // remove the track: it and its blocks go
    A.on('dialog', (d) => d.accept());
    await A.evaluate(() => [...document.querySelectorAll('.trackbar button')].find((x) => x.textContent === 'Remove track').click()); await sleep(600);
    const gone = await B.evaluate((lid) => !JJ.song().lanes[lid] && !Object.values(JJ.song().sections).some((s) => s.parts[lid]), bass.id);
    check(gone, 'Remove track takes the track and its blocks out of the song');

    // an older song: label-named lanes, and a rejoin's two blocks for the same lane in one section
    await A.evaluate(() => {
      const ev = [{ b: 0, type: 'on', note: 60, vel: 100 }, { b: 1, type: 'off', note: 60 }];
      JJ.loadSong({ format: 'megajam.song/1', title: 'Old', bpm: 100, key: { root: 0, mode: 'major' }, meter: 4, order: ['o1', 'o2'], labels: [], rule: 'newest', variations: {}, sections: {
        o1: { id: 'o1', name: 'A', bars: 1, chords: [], notes: '', parts: {
          'x1-1': { id: 'x1-1', name: 'Juniper · Keys', lane: 'Sam · Juniper · Keys', inst: 'juniper', patch: 'keys', by: 'x1', byName: 'Sam', takes: [{ id: 'a', events: ev, by: 'x1', byName: 'Sam', at: 1 }], current: 'a' },
          'x2-1': { id: 'x2-1', name: 'Juniper · Keys', lane: 'Sam · Juniper · Keys', inst: 'juniper', patch: 'keys', by: 'x2', byName: 'Sam', takes: [{ id: 'b', events: ev, by: 'x2', byName: 'Sam', at: 2 }], current: 'b' } } },
        o2: { id: 'o2', name: 'B', bars: 1, chords: [], notes: '', parts: { 'x1-2': { id: 'x1-2', name: 'Bass', lane: 'Matt · Bass', inst: 'monolith', patch: 'bass', by: 'x3', byName: 'Matt', takes: [{ id: 'c', events: ev, by: 'x3', byName: 'Matt', at: 3 }], current: 'c' } } } } });
    });
    await sleep(800);
    const old = await B.evaluate(() => { const s = JJ.song(); return { lanes: Object.values(s.lanes).map((t) => t.name).sort(), o1: Object.values(s.sections.o1.parts).map((p) => ({ lane: p.laneId, takes: p.takes.map((t) => t.id).join(''), current: p.current })) }; });
    check(old.lanes.join('|') === 'Matt · Bass|Sam · Juniper · Keys' && old.o1.length === 1 && old.o1[0].takes === 'ab' && old.o1[0].current === 'b', `an older song's lanes become tracks, the two blocks merged, the newest take sounding (${JSON.stringify(old)})`);
    check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  } finally { await b.close(); }
  console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
