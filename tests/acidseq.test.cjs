// Acid Line Lite's 303-style sequencer (src/acidseq.js). First the pattern logic on its own (slides, ties, accents,
// rests, transposition), then three browsers: the bass line plays identically everywhere, edits (RANDOM, a
// written note) reach everyone, a jammer who walks in mid-pattern hears the same notes, and STOP leaves nothing
// hanging.
//
//   node server/dev.js &      (8787)
//   node tests/acidseq.test.cjs [baseUrl]
const { chromium } = require('playwright');
const path = require('node:path');
const BASE = process.argv[2] || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };

(async () => {
  // ---- the pattern logic, against a 120 bpm tempo map (a beat is 500 ms, a step 125 ms) ----
  const { AcidSeq, BASE: B0 } = await import(path.resolve(__dirname, '../src/acidseq.js'));
  const tempo = { beatAt: (t) => t / 500, timeOf: (b) => b * 500 };
  const run = (steps, len = 4, tr = 0) => {
    const sq = new AcidSeq();
    sq.apply(['pat', [...steps, ...Array(16 - steps.length).fill({ g: 0 })], len]); sq.apply(['tr', tr]); sq.apply(['play', 0]);
    return sq.due(tempo, 0, 125 * len - 1);
  };
  const fmt = (evs) => evs.map((e) => `${e.type}${e.note - B0}@${Math.round(e.at)}${e.type === 'on' ? '/' + e.vel : ''}`).join(' ');
  let ev = run([{ n: 0, g: 1 }, { n: 3, g: 1, a: 1 }, { g: 0 }, { n: 7, g: 1 }]);
  check(fmt(ev) === 'on0@0/80 off0@69 on3@125/120 off3@194 on7@375/80 off7@444', `notes, an accent and a rest (${fmt(ev)})`);
  ev = run([{ n: 0, g: 1, s: 1 }, { n: 5, g: 1 }, { g: 0 }, { g: 0 }]);
  check(fmt(ev) === 'on0@0/80 on5@125/80 off0@127 off5@194', `a slide holds into the next note and ends just after it starts (${fmt(ev)})`);
  ev = run([{ n: 0, g: 1 }, { g: 2 }, { g: 2 }, { g: 0 }]);
  check(fmt(ev) === 'on0@0/80 off0@319', `ties hold the note across steps (${fmt(ev)})`);
  ev = run([{ n: 2, g: 1, s: 1 }, { n: 2, g: 1 }, { g: 0 }, { g: 0 }]);
  check(fmt(ev) === 'on2@0/80 off2@194', `a slide into the same note just carries on (${fmt(ev)})`);
  ev = run([{ n: 0, o: 1, g: 1 }, { n: 0, o: -1, g: 1 }], 2, 5);
  check(ev[0].note === B0 + 17 && ev[2].note === B0 - 7, 'octave switches and transposition');
  ev = run([{ n: 0, g: 1, s: 1 }, { n: 7, g: 1, s: 1 }], 2);
  const sq2 = new AcidSeq(); sq2.apply(['pat', [{ n: 0, g: 1, s: 1 }, { n: 7, g: 1, s: 1 }, ...Array(14).fill({ g: 0 })], 2]); sq2.apply(['play', 0]);
  const loop = sq2.due(tempo, 0, 999);
  check(loop.filter((e) => e.type === 'on').length === 8 && loop.filter((e) => e.type === 'off').length === 7, 'a two-step pattern sliding round and round: each note ends as the next starts');

  // ---- three browsers ----
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  const jammer = async (name, q) => { const p = await (await browser.newContext()).newPage(); p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`)); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  const A = await jammer('Sam', '?x=1');
  await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
  const code = await A.textContent('#roomCode');
  const Bp = await jammer('Matt', `?room=${code}&lag=50&jitter=10`);
  await Bp.click('#joinBtn'); await Bp.waitForSelector('#studio:not(.hide)');
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && !(await Bp.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1))) await sleep(300);
  await sleep(4000);
  await A.evaluate(() => JJ.setTempo(126)); await sleep(2500);
  const r = await A.evaluate(() => JJ.addInstrument('acid', 'acid')?.r);
  await sleep(1000);
  const me = await A.evaluate(() => JJ.S.me), pid = `${me}:${r}`;
  check(await A.isVisible('.acid-seq'), 'the sequencer panel is under the knobs');
  await A.click('.acid-btn.play');
  await sleep(4500);
  const notes = (p) => p.evaluate((pid) => JJ.engine.log.filter((e) => e.pid === pid && (e.type === 'on' || e.type === 'off')).map((e) => ({ type: e.type, note: e.note, vel: e.vel, at: Math.round(e.at * 10) / 10, late: e.lateMs > 3, lm: Math.round(e.lateMs) })).sort((x, y) => x.at - y.at || x.type.localeCompare(y.type)), pid);
  const same = (a, b) => a.length === b.length && a.every((x, i) => x.type === b[i].type && x.note === b[i].note && x.at === b[i].at);
  // (compared up to a little before now: each browser schedules its own steps up to 100 ms ahead, so the newest
  // steps may be in one log and not yet in the other)
  const upTo = (await A.evaluate(() => JJ.clock.now())) - 200;
  let a1 = (await notes(A)).filter((x) => x.at < upTo), b1 = (await notes(Bp)).filter((x) => x.at < upTo);
  check(a1.filter((x) => x.type === 'on').length >= 20 && same(a1, b1), `the bass line plays the same in both browsers (${a1.length} events)`);
  check(!b1.some((x) => x.late) && !a1.some((x) => x.late), `no step late (${a1.filter((x) => x.late).length} here, ${b1.filter((x) => x.late).length} at the bandmate: ${[...a1, ...b1].filter((x) => x.late).map((x) => x.type + x.lm).join(' ')})`);
  const onBeat = await A.evaluate((ats) => ats.every((at) => { const s = JJ.tempo.beatAt(at) * 4; return Math.abs(s - Math.round(s)) < 1e-3; }), a1.filter((x) => x.type === 'on').map((x) => x.at));
  check(onBeat, 'every note starts on a 16th of the room grid');
  const firstOn = a1.find((x) => x.type === 'on');
  check(await A.evaluate((at) => Math.abs(JJ.tempo.beatAt(at) % 4) < 1e-3 || Math.abs(JJ.tempo.beatAt(at) % 4 - 4) < 1e-3, firstOn.at), 'it starts on a bar line');

  // a newcomer mid-pattern
  const C = await jammer('Ev', `?room=${code}`);
  await C.click('#joinBtn'); await C.waitForSelector('#studio:not(.hide)');
  const t1 = Date.now();
  while (Date.now() - t1 < 20000 && !(await C.evaluate(() => JJ.clock.locked && JJ.S.players.size === 2))) await sleep(300);
  await sleep(2000);
  // RANDOM and a written note reach everyone
  await A.click('.acid-btn:text("RANDOM")');
  await A.click('.acid-btn:text("WRITE")');
  await A.click('.acid-step:nth-child(3) .acid-note');
  await A.evaluate(() => { JJ.input.press(41, 100, 0); JJ.input.release(41, 0); });
  await sleep(1500);
  const views = await Promise.all([A, Bp, C].map((p) => p.evaluate(([me, r]) => JJ.seqView(me, r), [me, r])));
  check(JSON.stringify(views[0].st) === JSON.stringify(views[1].st) && JSON.stringify(views[0].st) === JSON.stringify(views[2].st), 'RANDOM and edits give everyone the same pattern, the newcomer too');
  check(views[0].st[2][0] === 5 && views[0].st[2][2] === 1, 'WRITE: the key played went into the selected step (F)');
  await Promise.all([A, Bp, C].map((p) => p.evaluate(() => { JJ.engine.log.length = 0; })));
  await sleep(3000);
  const [a2, b2, c2] = await Promise.all([A, Bp, C].map(notes));
  const lo = Math.max(a2[0]?.at, b2[0]?.at, c2[0]?.at) + 1, hi = Math.min(a2.at(-1)?.at, b2.at(-1)?.at, c2.at(-1)?.at) - 1;
  const win = (l) => l.filter((x) => x.at >= lo && x.at <= hi);
  check(win(a2).length > 10 && same(win(a2), win(b2)) && same(win(a2), win(c2)), `after the edits, all three hear the same notes (${win(a2).length} events)`);
  // stop
  await A.click('.acid-btn:text("STOP")');
  await sleep(1500);
  await Promise.all([A, Bp, C].map((p) => p.evaluate(() => { JJ.engine.log.length = 0; })));
  await sleep(1000);
  const after = await Promise.all([A, Bp, C].map(notes));
  check(after.every((l) => !l.some((x) => x.type === 'on')), 'STOP stops it for everyone');
  const held = await Promise.all([A, Bp, C].map((p) => p.evaluate((pid) => [...(JJ.engine.ch.get(pid)?.held || [])], pid)));
  check(held.every((x) => !x.length), `nothing left hanging (${held.map((x) => x.join(',')).join(' | ')})`);
  check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await browser.close();
  console.log(failures ? `${failures} check(s) failed` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
