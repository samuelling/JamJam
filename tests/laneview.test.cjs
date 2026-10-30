// The Compose Room's lane view: click a locked block, or a lane's name, and the section block below shows that
// lane's notes in detail (a roll under the chord chart with names, bars and velocities).
//   node server/dev.js &  (8787)        node tests/laneview.test.cjs
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
      const part = (lane, role, notes, drums) => ({ id: 'l-' + lane.toLowerCase(), name: lane, lane, role, inst: drums ? 'machina' : 'mini', drums: !!drums, by: 'x', byName: 'Sam', takes: [{ id: 't1', events: ev(notes), by: 'x', byName: 'Sam', at: Date.now() }] });
      const sec = (id, name, parts) => ({ id, name, bars: 4, chords: ['Am', 'G', 'F', 'E7'], notes: '', parts });
      JJ.goRoom('compose');
      JJ.loadSong({ format: 'megajam.song/1', title: 'Lanes', bpm: 96, key: { root: 9, mode: 'minor' }, meter: 4, order: ['s1', 's2'], labels: [], rule: 'newest', variations: {}, sections: {
        s1: sec('s1', 'Verse', { 'l-bass': part('Bass', 'bass line', [[33, 0, 2, 90], [40, 4, 2, 100], [38, 8, 2, 110], [36, 12, 2, 120]]) }),
        s2: sec('s2', 'Chorus', { 'l-drums': part('Drums', 'time', [[36, 0, 0.2, 100], [38, 1, 0.2, 110], [42, 2, 0.2, 80]], true) }) } });
    });
    await p.waitForTimeout(1200);
    if (!(await p.$('.cell.take'))) await p.click('.lanetoggle');
    check(!(await p.$('.laneview')), 'nothing picked: no lane view');
    await p.click('.cell.take'); await p.waitForTimeout(300);
    const v = await p.evaluate(() => ({ head: document.querySelector('.laneview .lvhead')?.textContent || '', notes: document.querySelectorAll('.laneview .lvroll rect title').length, bars: document.querySelector('.laneview .lvbars')?.textContent, keys: [...document.querySelectorAll('.lvkeys span')].map((s) => s.textContent).join(' ') }));
    check(v.head.includes('Bass') && v.head.includes('4 notes') && v.head.includes('A1–E2') && v.head.includes('velocity 90–120'), `clicking a block shows the lane's notes in the section block (${v.head.replace('×', '').trim()})`);
    check(v.notes === 4 && v.bars.includes('Am') && v.keys.includes('C2'), `a roll with each note, bars, chords and note names, in a two-octave window to write in (${v.keys})`);
    await p.click('.lhead.pick:has-text("Drums") b'); await p.waitForTimeout(300);
    const d = await p.evaluate(() => ({ sec: document.querySelector('.secname')?.value, head: document.querySelector('.laneview .lvhead')?.textContent || '', keys: [...document.querySelectorAll('.lvkeys span')].map((s) => s.textContent).join(' ') }));
    check(d.head.includes('Drums') && ['Hat', 'Snare', 'Kick'].every((k) => d.keys.split(' ').includes(k)) && d.keys.split(' ').pop() === 'Kick', `clicking a lane's name shows it, drums by voice, with a row for every kit voice to write on (${d.keys})`);
    await p.click('.laneview .gearx'); await p.waitForTimeout(300);
    check(!(await p.$('.laneview')), '× hides it');
    check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  } finally { await b.close(); }
  console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
