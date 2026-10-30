// The Compose Room: a shared song. Sam brings in one of Matt's SynthLand Tracker songs, both see the same board,
// simultaneous edits agree, a looping section plays its locked parts identically in both browsers (rendered to
// audio once where it can), Matt locks in a part from the Jam Room and Sam gets it, and the song exports as MIDI.
//   node server/dev.js &  (8787)        node tests/compose.test.cjs [tracker-song.json]
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = 'http://localhost:8787/';
const SONG = process.argv[2] || '/tmp/songs/blue-dorian.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const mk = async (q, name) => { const c = await browser.newContext(); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?lag=25', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=25`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1 && [...JJ.room.peers.values()].every((x) => x.path === 'direct')))); if (ok.every(Boolean)) break; await sleep(300); }
    await sleep(800);
    // a sketch walks in
    const tracker = JSON.parse(fs.readFileSync(SONG, 'utf8'));
    await A.evaluate((t) => { JJ.goRoom('compose'); JJ.loadSong(JJ.songFromTracker(t)); }, tracker);
    await sleep(2500);
    const sum = (p) => p.evaluate(() => { const s = JJ.song(); return JSON.stringify({ t: s.title, o: s.order.map((id) => [s.sections[id].name, s.sections[id].bars, s.sections[id].chords.join(','), Object.keys(s.sections[id].parts).length]) }); });
    const [sa, sb] = await Promise.all([sum(A), sum(B)]);
    check(sa === sb && JSON.parse(sa).o.length >= 4, `both see the same song (${JSON.parse(sb).t}: ${JSON.parse(sb).o.map((x) => x[0]).join(', ')})`);
    const kb = await B.evaluate(() => [JJ.S.key.root, JJ.S.key.mode, Math.round(JJ.tempo.bpm(JJ.clock.now() + 1000))]);
    check(kb[1] === (tracker.meta?.jam?.mode || '').toLowerCase() && kb[2] === Math.round(tracker.transport.bpm), `and its key and tempo (${kb.join(' ')})`);
    // both edit the first section's title at once: they end up agreeing
    await Promise.all([A.evaluate(() => JJ.setSong('title', 'Sam title')), B.evaluate(() => JJ.setSong('title', 'Matt title'))]);
    await sleep(800);
    const titles = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.song().title)));
    check(titles[0] === titles[1], `simultaneous edits agree (${titles[0]})`);
    // Matt writes a chord chart from the key while Sam renames a section
    const sid = await A.evaluate(() => JJ.song().order[0]);
    await B.evaluate((sid) => { const s = JJ.song().sections[sid]; JJ.setSong('sec:' + sid, { name: s.name, bars: 4, chords: ['Dm', 'G', 'Dm', 'A'], notes: 'slow build' }); }, sid);
    await sleep(600);
    check((await A.evaluate((sid) => JJ.song().sections[sid].chords.join(' '), sid)) === 'Dm G Dm A', "Matt's chord chart reaches Sam");
    // loop that section: its locked parts play in both browsers, identically
    await A.evaluate((sid) => JJ.play('loop', sid), sid);
    await sleep(6000);
    const playing = await Promise.all([A, B].map((p) => p.evaluate(() => ({ tr: JSON.stringify(JJ.song().transport), bounced: JJ.bounced().length, live: JJ.engine.log.filter((e) => e.pid.startsWith('song:') && e.type === 'on').map((e) => e.pid.slice(5, 9) + e.note + '@' + Math.round(e.at)).join(' ') }))));
    check(playing[0].tr === playing[1].tr, 'both run the same transport');
    check(playing[0].bounced > 0 && playing[0].bounced === playing[1].bounced, `locked parts were rendered to audio once in each browser (${playing[0].bounced} and ${playing[1].bounced})`);
    check(playing[0].live === playing[1].live, `anything still playing live plays the same notes at the same times (${playing[0].live.split(' ').filter(Boolean).length} notes)`);
    // Matt jams a part in the Jam Room and locks it in
    await B.evaluate(() => JJ.goRoom('jam'));
    const r = await B.evaluate(() => JJ.S.rack[0].r);
    const L = await B.evaluate((sid) => JJ.song().sections[sid].bars * 4, sid);
    await B.evaluate(async ({ L }) => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); const beatMs = 60000 / JJ.tempo.bpm(JJ.clock.now()); const end = JJ.clock.now() + beatMs * L * 2.2; let i = 0; while (JJ.clock.now() < end) { const n = [62, 65, 69, 67][i++ % 4]; JJ.input.press(n, 100); await s(beatMs * 0.8); JJ.input.release(n); await s(beatMs * 0.2); } }, { L });
    await B.evaluate((r) => JJ.lockIn(r), r);
    await sleep(800);
    const got = await A.evaluate((sid) => Object.values(JJ.song().sections[sid].parts).find((p) => p.byName === 'Matt'), sid);
    check(got && got.events.filter((e) => e.type === 'on').length >= 4, `Matt's locked part reaches Sam (${got ? got.name + ', ' + got.events.filter((e) => e.type === 'on').length + ' notes' : 'missing'})`);
    check(got && got.events.every((e) => e.b >= 0 && e.b < L), 'its notes sit inside the section');
    await A.evaluate(() => JJ.stopSong());
    // export
    const mid = await A.evaluate(() => JJ.songMidi());
    const back = await A.evaluate((m) => { const s = JJ.songFromMidi(new Uint8Array(m)); return { n: s.order.length, names: s.order.map((id) => s.sections[id].name) }; }, mid);
    check(String.fromCharCode(...mid.slice(0, 4)) === 'MThd' && back.n === JSON.parse(sa).o.length, `the song exports as a MIDI file that reads back with its sections (${back.names.join(', ')})`);
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } catch (e) { console.error(e); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
