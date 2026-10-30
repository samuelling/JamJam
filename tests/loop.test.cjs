// Dragging a loop over the arrangement: draw it across the loop strip, crop it from either end, move it, all with the
// mouse. Both browsers loop the same bars, only the looped part of each section sounds, and locking in a pass
// that crosses a section line makes a take on each side of it.
//   node server/dev.js &  (8787)        node tests/loop.test.cjs [tracker-song.json]
const { chromium } = require('playwright');
const fs = require('fs');
const SONG = process.argv[2] || '/tmp/songs/blue-dorian.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const mk = async (q, name) => { const c = await browser.newContext({ viewport: { width: 1400, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto('http://localhost:8787/' + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?lag=25', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=25`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1 && [...JJ.room.peers.values()].every((x) => x.path === 'direct')))); if (ok.every(Boolean)) break; await sleep(300); }
    await A.evaluate((t) => { JJ.goRoom('compose'); JJ.loadSong(JJ.songFromTracker(t)); }, JSON.parse(fs.readFileSync(SONG, 'utf8')));
    await sleep(2000);
    const meter = await A.evaluate(() => JJ.song().meter || 4);
    const tl = await A.evaluate(() => { const s = JJ.song(); let b = 0; return s.order.map((id) => { const t = { id, name: s.sections[id].name, start: b, beats: s.sections[id].bars * (s.meter || 4) }; b += t.beats; return t; }); });
    // where a song beat sits on screen: the same mapping the strip uses (section headers scaled by their bars)
    const xOf = async (beat) => A.evaluate(({ beat, tl }) => { const heads = [...document.querySelectorAll('#compose .shead')]; for (let i = 0; i < tl.length; i++) { const t = tl[i]; if (beat <= t.start + t.beats) { const r = heads[i].getBoundingClientRect(); return r.left + (beat - t.start) / t.beats * r.width; } } return 0; }, { beat, tl });
    const trackY = await A.evaluate(() => { const r = document.querySelector('#compose .looptrack').getBoundingClientRect(); return r.top + r.height / 2; });
    const drag = async (x0, x1, y = trackY) => { await A.mouse.move(x0, y); await A.mouse.down(); for (let i = 1; i <= 8; i++) await A.mouse.move(x0 + ((x1 - x0) * i) / 8, y); await A.mouse.up(); await sleep(700); };
    const trOf = (p) => p.evaluate(() => JSON.stringify(JJ.song().transport));
    // draw a loop from bar 3 of the first section into the second (it crosses a section line)
    const i0 = tl[0].start + 2 * meter, i1 = tl[1].start + 2 * meter;
    await drag(await xOf(i0), await xOf(i1));
    let tr = JSON.parse(await trOf(A));
    check(tr.on && tr.mode === 'range' && tr.a === i0 && tr.b === i1, `dragging across the strip loops bars ${i0 / meter + 1} to ${i1 / meter} (${tr.mode} ${tr.a}..${tr.b})`);
    check((await trOf(B)) === JSON.stringify(tr), 'and Matt loops the same bars');
    check((await A.$$('#compose .shead.live')).length === 2, 'both sections under the loop light up');
    // crop it from the right end, then the left
    const handleB = await A.evaluate(() => { const r = document.querySelector('#compose .looptrack .lh.b').getBoundingClientRect(); return r.left + r.width / 2; });
    await drag(handleB, await xOf(i1 - meter));
    tr = JSON.parse(await trOf(A));
    check(tr.a === i0 && tr.b === i1 - meter, `dragging the end crops it to bar ${tr.b / meter}`);
    const handleA = await A.evaluate(() => { const r = document.querySelector('#compose .looptrack .lh.a').getBoundingClientRect(); return r.left + r.width / 2; });
    await drag(handleA, await xOf(i0 + meter));
    tr = JSON.parse(await trOf(A));
    check(tr.a === i0 + meter && tr.b === i1 - meter, `dragging the start crops it from bar ${tr.a / meter + 1}`);
    // move the whole loop one bar later by its middle
    const mid = await A.evaluate(() => { const r = document.querySelector('#compose .looptrack .band').getBoundingClientRect(); return r.left + r.width / 2; });
    const len = tr.b - tr.a;
    await drag(mid, mid + ((await xOf(tr.a + meter)) - (await xOf(tr.a))));
    tr = JSON.parse(await trOf(A));
    check(tr.b - tr.a === len && tr.a === i0 + 2 * meter, `dragging the middle moves it, same length (${tr.a / meter + 1}..${tr.b / meter})`);
    check((await trOf(B)) === JSON.stringify(tr), 'Matt follows every change');
    // only the looped bars sound: every live song note falls inside a pass of the loop
    await sleep(5000);
    const notes = await A.evaluate((tr) => { const L = tr.b - tr.a; return JJ.engine.log.filter((e) => e.pid.startsWith('song:') && e.type === 'on' && e.at > JJ.tempo.timeOf(tr.start)).map((e) => { const b = JJ.tempo.beatAt(e.at), x = ((b - tr.start) % L + L) % L; return x; }); }, tr);
    const outside = notes.filter((x) => x < -0.05 || x > tr.b - tr.a + 0.05).length;
    check(notes.length > 0 && outside === 0, `the song's notes play only inside the loop (${notes.length} notes, ${outside} outside)`);
    // Matt locks in a pass that crosses the section line: a take on each side
    await A.evaluate((p) => JJ.loopRange(p.a, p.b), { a: tl[1].start - 2 * meter, b: tl[1].start + 2 * meter });
    await B.evaluate(() => JJ.goRoom('jam'));
    const r = await B.evaluate(() => JJ.S.rack[0].r);
    await B.evaluate(async () => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); const tr = JJ.song().transport; const beatMs = 60000 / JJ.tempo.bpm(JJ.clock.now()); const end = JJ.clock.now() + beatMs * (tr.b - tr.a) * 2.3; let i = 0; while (JJ.clock.now() < end) { const n = [62, 65, 69, 67][i++ % 4]; JJ.input.press(n, 100); await s(beatMs * 0.8); JJ.input.release(n); await s(beatMs * 0.2); } });
    await B.evaluate((r) => JJ.lockIn(r), r);
    await sleep(800);
    const got = await A.evaluate(({ s0, s1 }) => [s0, s1].map((sid) => { const p = Object.values(JJ.song().sections[sid].parts).find((q) => q.byName === 'Matt'); const t = p && p.takes.find((x) => x.id === p.current); return t ? t.events.filter((e) => e.type === 'on').map((e) => e.b) : null; }), { s0: tl[0].id, s1: tl[1].id });
    const okA = got[0] && got[0].length && got[0].every((b) => b >= tl[0].beats - 2 * meter - 0.05), okB = got[1] && got[1].length && got[1].every((b) => b < 2 * meter + 0.05);
    check(okA && okB, `a pass across the line becomes a take at the end of ${tl[0].name} and the start of ${tl[1].name} (${got[0]?.length || 0} + ${got[1]?.length || 0} notes)`);
    await A.evaluate(() => JJ.stopSong());
    await sleep(600);
    // rearrange: drag the third section's header to the front
    const before = await A.evaluate(() => JJ.song().order.slice());
    const h3 = await A.evaluate(() => { const r = document.querySelectorAll('#compose .shead')[2].getBoundingClientRect(); return [r.left + 30, r.top + 12]; });
    const h1 = await A.evaluate(() => { const r = document.querySelectorAll('#compose .shead')[0].getBoundingClientRect(); return [r.left + 5, r.top + 12]; });
    await drag(h3[0], h1[0], h3[1]);
    const after = await B.evaluate(() => JJ.song().order.slice());
    check(after[0] === before[2] && after[1] === before[0] && after[2] === before[1] && after.length === before.length, `dragging a section's header moves it in the song, for Matt too (${after.slice(0, 3).map((id) => tl.find((t) => t.id === id)?.name).join(', ')})`);
    // and removing one is one click on its ×
    A.on('dialog', (d) => d.accept());
    await A.hover('#compose .shead >> nth=1');
    await A.click('#compose .shead >> nth=1 >> .secx');
    await sleep(700);
    const removed = await B.evaluate(() => JJ.song().order.slice());
    check(removed.length === after.length - 1 && !removed.includes(after[1]), `the × on a section removes it (${removed.length} sections left)`);
    await A.screenshot({ path: '/tmp/loop.png' });
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } catch (e) { console.error(e); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
