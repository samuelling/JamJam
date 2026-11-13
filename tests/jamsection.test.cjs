// "Jam this section" from the Compose Room brings the track you're working on to your desk (no instrument wall):
//   - a first visit that goes straight to the Compose Room, adds a track (Monolith) and presses Jam this section
//     lands in the Jam Room with that section looping and Monolith on the desk, tied to the track; the wall stays
//     shut and the starting placeholder is gone
//   - with another track's block open, Jam this section brings that track instead
//   - a song with no tracks of yours (a preset) still opens the wall on a first visit: nothing's been picked
//   - + Add track also makes: an external synth from the catalogue (played by its twin), any other MIDI synth by name
//     (with a stand-in), and an audio track that Jam this section records into
//   node server/dev.js &  (8787)        node tests/jamsection.test.cjs
const { chromium } = require('playwright');
const BASE = 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) fails++; };
(async () => {
  const b = await chromium.launch(); const errors = [];
  const visit = async () => {
    const p = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(BASE + '?picks=1&doors=1'); await p.fill('#nameIn', 'Sam'); await p.click('#startBtn'); await p.waitForSelector('#studio:not(.hide)'); await sleep(600);
    await p.click('#hall .door2.comp'); await sleep(500);   // straight into the Compose Room
    return p;
  };
  const desk = (p) => p.evaluate(() => ({ where: JJ.S.where, wall: !document.querySelector('#libDrawer').classList.contains('hide'), rack: JJ.S.rack.map((e) => ({ inst: e.cfg.inst, lane: e.laneId || null })), tr: JJ.song().transport, first: !!JJ.S.firstPick }));

  // 1. add a track, then Jam this section
  let p = await visit();
  const before = await desk(p);
  await p.click('.addtrack:not(.open) button'); await p.selectOption('.addtrack.open select[aria-label="Instrument"]', 'monolith'); await p.click('.addtrack.open button.hot'); await sleep(500);
  const lane = await p.evaluate(() => Object.values(JJ.song().lanes).find((t) => t.inst === 'monolith')?.id);
  const sid = await p.evaluate(() => JJ.song().order[0]);
  await p.click('#compose button:has-text("Jam this section")'); await sleep(1200);
  let d = await desk(p);
  console.log('  before:', JSON.stringify(before.rack), 'after:', JSON.stringify(d.rack));
  check(d.where === 'jam' && d.tr?.on && d.tr.mode === 'loop' && d.tr.sid === sid, 'Jam this section: the Jam Room, with that section looping');
  check(!d.wall && !d.first, "the instrument wall doesn't open");
  check(d.rack.length === 1 && d.rack[0].inst === 'monolith' && d.rack[0].lane === lane, 'Monolith is on the desk, tied to the new track (the placeholder is gone)');

  // 2. another track's block open: that track comes instead
  await p.evaluate(() => JJ.goRoom('compose')); await sleep(300);
  await p.click('.addtrack:not(.open) button'); await p.selectOption('.addtrack.open select[aria-label="Instrument"]', 'juniper'); await p.click('.addtrack.open button.hot'); await sleep(500);
  const keys = await p.evaluate(() => Object.values(JJ.song().lanes).find((t) => t.inst === 'juniper')?.id);
  await p.click('#compose button:has-text("Jam this section")'); await sleep(1000);
  d = await desk(p);
  check(d.rack.some((e) => e.inst === 'juniper' && e.lane === keys) && d.rack.some((e) => e.lane === lane), 'a second new track comes onto the desk too, next to the first');
  await p.context().close();

  // 4. external synths and audio, from + Add track
  p = await visit();
  const addTrack = async (fn) => { await p.click('.addtrack:not(.open) button'); await fn(); await p.click('.addtrack.open button.hot'); await sleep(500); };
  await addTrack(async () => { await p.selectOption('.addtrack.open select[aria-label="Instrument"]', '@ext'); await p.fill('.addtrack.open input[aria-label="External synth"]', 'Sequential OB-6'); await sleep(100);
    check(/twin/.test(await p.textContent('.addtrack.open .help')), 'External instrument: a synth from the catalogue says the band hears its twin'); });
  await addTrack(async () => { await p.selectOption('.addtrack.open select[aria-label="Instrument"]', '@ext'); await p.fill('.addtrack.open input[aria-label="External synth"]', 'My weird modular'); await sleep(100);
    check(await p.isVisible('.addtrack.open select[aria-label="Stand-in instrument"]'), 'any other synth asks for a stand-in'); await p.selectOption('.addtrack.open select[aria-label="Stand-in instrument"]', 'monolith'); });
  await addTrack(async () => { await p.selectOption('.addtrack.open select[aria-label="Instrument"]', '@audio'); await p.fill('.addtrack.open input[aria-label="Track name"]', 'Vocals'); });
  const L = await p.evaluate(() => Object.values(JJ.song().lanes).map((t) => ({ id: t.id, name: t.name, inst: t.inst, hw: t.hw, ext: t.ext || null, kind: t.kind })));
  console.log('  tracks:', L.map((t) => `${t.name} [${t.kind}${t.hw ? ' hw ' + t.hw : ''}${t.ext ? ' ext ' + t.ext.name : ''} → ${t.inst}]`).join(' | '));
  const ob6 = L.find((t) => t.hw && /ob-6/i.test(t.hw)), mod = L.find((t) => t.ext?.name === 'My weird modular'), voc = L.find((t) => t.kind === 'audio');
  check(!!ob6 && ob6.inst && ob6.inst !== 'none', `the OB-6 track plays through its twin (${ob6?.inst})`);
  check(!!mod && mod.inst === 'monolith', 'the modular track is heard through Monolith, by name');
  check(!!voc && voc.name === 'Vocals', 'the audio track is called Vocals');
  // Jam this section with the modular's block open: it comes onto the desk as an external synth
  await p.evaluate((id) => JJ.jamLane(id), mod.id); await sleep(1500);
  const ext = await p.evaluate(() => JJ.S.rack.map((e) => ({ inst: e.cfg.inst, ext: e.cfg.ext?.name || null, lane: e.laneId })));
  if (!ext.some((e) => e.ext)) console.log('  rack:', JSON.stringify(ext));
  check(ext.some((e) => e.ext === 'My weird modular' && e.inst === 'monolith' && e.lane === mod.id), 'Jam it puts the modular on the desk as an external MIDI synth, tied to its track');
  await p.evaluate(() => JJ.goRoom('compose')); await sleep(300);
  await p.evaluate(([sid, id]) => JJ.jamThis(sid, id), [await p.evaluate(() => JJ.song().order[0]), voc.id]); await sleep(1000);
  d = await desk(p);
  const live = await p.evaluate(() => ({ target: JJ.audioTarget?.(), panel: !document.querySelector('#panel-lane').classList.contains('hide') }));
  check(d.where === 'jam' && d.tr?.mode === 'loop' && live.panel, 'Jam this section with the Vocals track: the section loops and the Live audio panel opens');
  check(live.target === voc.id, 'and live audio will lock into Vocals');
  await p.context().close();

  // 3. nothing of yours in the song: the wall still opens on a first visit
  p = await visit();
  await p.evaluate(() => JJ.loadSong(JJ.presetSong ? JJ.presetSong(0, 0) : JJ.song())); await sleep(300);
  const hasPreset = await p.evaluate(() => Object.keys(JJ.song().lanes || {}).length);
  await p.click('#compose button:has-text("Jam this section")'); await sleep(1200);
  d = await desk(p);
  check(d.where === 'jam' && d.wall, `with no track of yours${hasPreset ? ' (a preset with ' + hasPreset + ' tracks)' : ''}, the wall still asks what you want to play`);
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})();
