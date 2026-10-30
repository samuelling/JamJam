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
    const playing = await Promise.all([A, B].map((p) => p.evaluate(() => ({ tr: JSON.stringify(JJ.song().transport), bounced: JJ.bounced().length, live: JJ.engine.log.filter((e) => e.pid.startsWith('song:') && e.type === 'on').map((e) => e.pid.slice(5, 9) + e.note + '@' + Math.round(e.at)).sort().join(' ') }))));
    check(playing[0].tr === playing[1].tr, 'both run the same transport');
    check(playing[0].bounced > 0 && playing[0].bounced === playing[1].bounced, `locked parts were rendered to audio once in each browser (${playing[0].bounced} and ${playing[1].bounced})`);
    if (playing[0].live !== playing[1].live) { const x = playing[0].live.split(' '), y = playing[1].live.split(' '); console.log('A:', x.length, x.filter((v, i) => v !== y[i]).slice(0, 12).join(' ')); console.log('B:', y.length, y.filter((v, i) => v !== x[i]).slice(0, 12).join(' ')); }
    check(playing[0].live === playing[1].live, `anything still playing live plays the same notes at the same times (${playing[0].live.split(' ').filter(Boolean).length} notes)`);
    // Matt jams a part in the Jam Room and locks it in; meanwhile Sam's arrangement shows him working on it
    await B.evaluate(() => JJ.goRoom('jam'));
    const r = await B.evaluate(() => JJ.S.rack[0].r);
    const L = await B.evaluate((sid) => JJ.song().sections[sid].bars * 4, sid);
    const jam = (notes) => B.evaluate(async ({ L, notes }) => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); const beatMs = 60000 / JJ.tempo.bpm(JJ.clock.now()); const end = JJ.clock.now() + beatMs * L * 2.2; let i = 0; const pressed = [];
      while (JJ.clock.now() < end) { const n = notes[i++ % notes.length]; pressed.push(JJ.tempo.beatAt(JJ.clock.now())); JJ.input.press(n, 100); await s(beatMs * 0.8); JJ.input.release(n); await s(beatMs * 0.2); } return { pressed, start: JJ.song().transport.start }; }, { L, notes });
    const jamming = jam([62, 65, 69, 67]);
    await sleep(3500);
    const seen = await A.evaluate(() => ({ working: document.querySelectorAll('#compose .cell.working, #compose .retaking').length, who: [...document.querySelectorAll('#compose .shead .herein i')].map((i) => i.title).join(', ') }));
    check(seen.working > 0, `while Matt plays, Sam's arrangement marks it as being worked on, not locked (${seen.who || 'no one'})`);
    const played = await jamming;
    await B.evaluate((r) => JJ.lockIn(r), r);
    await sleep(800);
    const partOf = (p) => p.evaluate((sid) => Object.values(JJ.song().sections[sid].parts).find((q) => q.byName === 'Matt'), sid);
    let got = await partOf(A);
    const cur = got && got.takes.find((t) => t.id === got.current);
    check(cur && cur.events.filter((e) => e.type === 'on').length >= 4, `Matt's take reaches Sam (${got ? got.lane + ', ' + (cur ? cur.events.filter((e) => e.type === 'on').length : 0) + ' notes' : 'missing'})`);
    check(cur && cur.events.every((e) => e.b >= 0 && e.b < L), 'its notes sit inside the section');
    // placed where Matt heard himself play them, not where they sounded after the lookahead
    const want = played.pressed.map((b) => (((b - played.start) % L) + L) % L), ons = cur ? cur.events.filter((e) => e.type === 'on').map((e) => e.b) : [];
    const off = ons.map((b) => Math.min(...want.map((w) => Math.min(Math.abs(w - b), L - Math.abs(w - b)))));
    check(ons.length && Math.max(...off) < 0.12, `each note lands on the beat Matt played it (worst ${Math.max(...off).toFixed(3)} beats out)`);
    const folded = await A.evaluate(async () => { JJ.goRoom('compose'); await new Promise((r) => setTimeout(r, 300)); return { sum: document.querySelectorAll('#compose .cell.sum').length, take: document.querySelectorAll('#compose .cell.take').length }; });
    check(folded.sum > 0 && folded.take === 0, `the lanes start folded into one row (${folded.sum} sections with locked parts)`);
    await A.screenshot({ path: '/tmp/arranger-folded.png' });
    for (const p of [A, B]) await p.evaluate(() => { if (!document.querySelector('#compose .cell.take')) document.querySelector('#compose .lanetoggle')?.click(); });
    const blocks = await Promise.all([A, B].map((p) => p.evaluate(async () => { JJ.goRoom('compose'); await new Promise((r) => setTimeout(r, 300)); return { takes: document.querySelectorAll('#compose .cell.take').length, empty: document.querySelectorAll('#compose .cell.empty').length, lanes: document.querySelectorAll('#compose .arow:not(.ruler):not(.ghost) .lhead:not(.addl)').length }; })));
    check(blocks[0].takes > 0 && JSON.stringify(blocks[0]) === JSON.stringify(blocks[1]), `both arrangements show the same locked blocks (${blocks[0].takes} locked, ${blocks[0].empty} empty, ${blocks[0].lanes} lanes)`);
    await A.screenshot({ path: '/tmp/arranger.png' });
    // a second take: newest wins under the default rule, from the next pass
    await B.evaluate(() => JJ.goRoom('jam'));
    await jam([69, 72, 74, 72]);
    await B.evaluate((r) => JJ.lockIn(r), r);
    await sleep(800);
    got = await partOf(A);
    const t2 = got.takes[got.takes.length - 1];
    check(got.takes.length === 2 && got.current === t2.id && got.prev === got.takes[0].id, `a second take lands in the same lane and takes over (${got.takes.length} takes)`);
    const nowB = await A.evaluate(() => JJ.tempo.beatAt(JJ.clock.now()));
    const tr = await A.evaluate(() => JJ.song().transport);
    check(got.switchAt > nowB - 0.5 && Math.abs(((got.switchAt - tr.start) % L + L) % L) < 1e-6, `the switch waits for the top of the next pass (beat ${got.switchAt.toFixed(1)})`);
    // Sam would rather keep the first one
    await A.evaluate(({ sid, pid, t }) => JJ.choose(sid, pid, t), { sid, pid: got.id, t: got.takes[0].id });
    await sleep(600);
    check((await partOf(B)).current === got.takes[0].id, 'Sam picks the first take back and Matt gets the pick too');
    // under the vote rule, a take needs the band
    await A.evaluate(() => JJ.setSong('rule', 'vote'));
    await A.evaluate(({ sid, pid, t }) => JJ.vote(sid, pid, t), { sid, pid: got.id, t: t2.id });
    await B.evaluate(({ sid, pid, t }) => JJ.vote(sid, pid, t), { sid, pid: got.id, t: t2.id });
    await sleep(800);
    const voted = await partOf(A);
    check(voted.current === t2.id && (voted.votes[t2.id] || []).length === 2, `two votes put the second take in (${JSON.stringify(Object.fromEntries(Object.entries(voted.votes).map(([k, v]) => [k, v.length])))})`);
    // a named version keeps the picks; going back restores them
    await A.evaluate(() => JJ.saveVar('with take 2'));
    await A.evaluate(({ sid, pid, t }) => { JJ.setSong('rule', 'newest'); JJ.choose(sid, pid, t); }, { sid, pid: got.id, t: got.takes[0].id });
    await sleep(500);
    await B.evaluate(() => JJ.restoreVar('with take 2'));
    await sleep(800);
    check((await partOf(A)).current === t2.id, 'a saved version brings its takes back for everyone');
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
