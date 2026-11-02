// The arpeggiator (src/arp.js) on Monolith: two jammers in one room. Checks that the arp steps through the held
// notes on the room's 1/16 grid (and 1/8T), that the bandmate hears exactly the same notes at the same room times,
// that a full gate ties notes (each off lands after the next on), that latch keeps it going and turning the arp
// off stops it, that a tempo change mid-arp stays on the grid, and that playing alone still keeps even steps.
//
//   node server/dev.js &      (8787)
//   node tests/arp.test.cjs [baseUrl]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };

async function jammer(browser, name, query, errors) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(BASE + query);
  await page.fill('#nameIn', name);
  return page;
}
// A's own arp notes, from a page's log: [{type, note, at}]
const notesOf = (page, pid) => page.evaluate((pid) => JJ.engine.log.filter((e) => e.pid === pid && (e.type === 'on' || e.type === 'off')).map((e) => ({ type: e.type, note: e.note, at: e.at, lateMs: e.lateMs || 0 })), pid);
const clear = (pages) => Promise.all(pages.map((p) => p.evaluate(() => { JJ.engine.log.length = 0; })));
const onGrid = (page, ons, q) => page.evaluate(([ats, q]) => ats.every((at) => { const b = JJ.tempo.beatAt(at) / q; return Math.abs(b - Math.round(b)) < 1e-3; }), [ons.map((x) => x.at), q]);

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];

  // ---- alone first: even steps with nobody else in the room ----
  const A = await jammer(browser, 'Sam', '?x=1', errors);
  await A.click('#startBtn');
  await A.waitForSelector('#studio:not(.hide)', { timeout: 15000 });
  const r = await A.evaluate(() => JJ.addInstrument('monolith', 'arp')?.r);
  await sleep(800);
  const me = await A.evaluate(() => JJ.S.me), pid = `${me}:${r}`;
  await clear([A]);
  await A.evaluate(() => { JJ.input.press(60, 100, 0); JJ.input.press(64, 90, 0); JJ.input.press(67, 80, 0); });
  await sleep(1500);
  await A.evaluate(() => { JJ.input.release(60, 0); JJ.input.release(64, 0); JJ.input.release(67, 0); });
  await sleep(500);
  let n = await notesOf(A, pid), ons = n.filter((x) => x.type === 'on');
  const solo = ons.map((x) => x.note).join(' ');
  check(ons.length >= 8, `alone: the arp plays (${ons.length} steps in 1.5 s)`);
  check(/^60 64 67 72 76 79 60/.test(solo), `alone: Up over two octaves (${solo.slice(0, 40)}…)`);
  check(await onGrid(A, ons, 0.25), 'alone: every step on the 1/16 grid');
  check(ons.filter((x) => x.lateMs > 3).length === 0, 'alone: no step late');

  // ---- a bandmate joins ----
  const code = await A.textContent('#roomCode');
  const B = await jammer(browser, 'Matt', `?room=${code}&lag=40&jitter=10`, errors);
  await B.click('#joinBtn');
  await B.waitForSelector('#studio:not(.hide)', { timeout: 15000 });
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const ok = await B.evaluate(() => JJ.clock.locked && [...JJ.room.peers.values()].every((p) => p.path === 'direct') && JJ.room.peers.size === 1 && JJ.S.players.size === 1);
    if (ok) break; await sleep(300);
  }
  await sleep(5000);
  await A.evaluate(() => JJ.setTempo(120));
  await sleep(2500);

  // Up-down, 1/16, held; the bandmate hears the same notes at the same times
  await A.evaluate(() => { JJ.setParam('arpMode', 3); JJ.setParam('arpOct', 0); });
  await sleep(400);
  await clear([A, B]);
  await A.evaluate(() => { JJ.input.press(48, 100, 0); JJ.input.press(55, 100, 0); JJ.input.press(60, 100, 0); JJ.input.press(63, 100, 0); });
  await sleep(2000);
  await A.evaluate(() => { for (const k of [48, 55, 60, 63]) JJ.input.release(k, 0); });
  await sleep(1200);
  // (sorted by time: the fast channel may deliver a note's off before its on, and the bandmate logs on arrival)
  const byAt = (l) => l.sort((x, y) => x.at - y.at || (x.type === 'off' ? -1 : 1));
  const a1 = byAt(await notesOf(A, pid)), b1 = byAt(await notesOf(B, pid));
  ons = a1.filter((x) => x.type === 'on');
  check(ons.map((x) => x.note).slice(0, 7).join(' ') === '48 55 60 63 60 55 48', `Up-down turns at the ends without repeating (${ons.map((x) => x.note).slice(0, 8).join(' ')})`);
  check(await onGrid(A, ons, 0.25), 'with a bandmate: every step on the 1/16 grid');
  const same = a1.length === b1.length && a1.every((x, i) => x.type === b1[i].type && x.note === b1[i].note && Math.abs(x.at - b1[i].at) < 0.01);
  if (!same) { console.log('  A', a1.length, 'B', b1.length); for (let i = 0; i < Math.max(a1.length, b1.length); i++) { const x = a1[i], y = b1[i]; if (!x || !y || x.note !== y.note || x.type !== y.type || Math.abs(x.at - y.at) > 0.01) { console.log('  first diff at', i, JSON.stringify(x), JSON.stringify(y)); break; } } }
  check(same && a1.length > 20, `the bandmate hears the same ${a1.length} notes at the same room times`);
  check(b1.filter((x) => x.lateMs > 3).length === 0, 'none of them late for the bandmate');
  const lastOn = Math.max(...ons.map((x) => x.at)), relAt = await A.evaluate(() => JJ.clock.now());
  check(lastOn < relAt, 'letting go stops it');

  // full gate ties: each note's off lands just after the next note's on
  await A.evaluate(() => { JJ.setParam('arpMode', 1); JJ.setParam('arpGate', 1); JJ.setParam('arpRate', 2); });
  await sleep(400);
  await clear([A, B]);
  await A.evaluate(() => { JJ.input.press(60, 100, 0); JJ.input.press(67, 100, 0); });
  await sleep(1500);
  await A.evaluate(() => { JJ.input.release(60, 0); JJ.input.release(67, 0); });
  await sleep(1000);
  const a2 = byAt(await notesOf(B, pid)), on2 = a2.filter((x) => x.type === 'on'), off2 = a2.filter((x) => x.type === 'off');
  const tied = on2.slice(1).every((x, i) => { const off = off2.find((o) => o.note === on2[i].note && o.at > on2[i].at); return off && off.at > x.at && off.at - x.at < 5; });
  check(on2.length >= 4 && tied, `full gate: every note overlaps the next by a hair (${on2.length} notes)`);
  check(await onGrid(B, on2, 1 / 3), '1/8 triplets on their grid');
  check(off2.length === on2.length, 'and the last note still ends');

  // latch keeps it going after letting go; switching the arp off stops it
  await A.evaluate(() => { JJ.setParam('arpGate', 0.5); JJ.setParam('arpRate', 3); JJ.setParam('arpLatch', 1); });
  await sleep(300);
  await A.evaluate(() => { JJ.input.press(62, 100, 0); JJ.input.press(65, 100, 0); });
  await sleep(300);
  await A.evaluate(() => { JJ.input.release(62, 0); JJ.input.release(65, 0); });
  await clear([A, B]);
  await sleep(1000);
  let a3 = (await notesOf(B, pid)).filter((x) => x.type === 'on');
  check(a3.length >= 6 && a3.every((x) => x.note === 62 || x.note === 65), `latch: it keeps playing after you let go (${a3.length} steps in 1 s)`);
  // a new chord after letting go replaces the latched one
  await A.evaluate(() => { JJ.input.press(70, 100, 0); });
  await sleep(150);
  await A.evaluate(() => { JJ.input.release(70, 0); });
  await sleep(600);
  await clear([A, B]);
  await sleep(500);
  a3 = (await notesOf(B, pid)).filter((x) => x.type === 'on');
  check(a3.length >= 3 && a3.every((x) => x.note === 70), 'latch: a fresh chord replaces the held one');

  // a tempo change mid-arp: still on the grid
  await clear([A, B]);
  await A.evaluate(() => JJ.setTempo(97));
  await sleep(2500);
  a3 = (await notesOf(B, pid)).filter((x) => x.type === 'on');
  const bpms = await B.evaluate((ats) => ats.map((at) => JJ.tempo.bpm(at)), a3.map((x) => x.at));
  check(bpms.includes(120) && bpms.includes(97) && await onGrid(B, a3, 0.25), `through a tempo change 120 → 97 every step stays on the grid (${a3.length} steps)`);

  await A.evaluate(() => JJ.setParam('arpMode', 0));
  await sleep(300);
  await clear([A, B]);
  await sleep(800);
  a3 = (await notesOf(B, pid)).filter((x) => x.type === 'on');
  check(a3.length === 0, 'switching the arp off stops it');
  const held = await B.evaluate((pid) => [...(JJ.engine.ch.get(pid)?.held || [])], pid);
  if (held.length) console.log('  B log for', held, JSON.stringify((await B.evaluate(() => JJ.engine.log.slice(-0)))));
  check(held.length === 0, `no note left hanging (${held.join(',')})`);

  check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await browser.close();
  console.log(failures ? `${failures} check(s) failed` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
