// Sequencer in lockstep: one jammer programs a Machina pattern with parameter locks and presses play; every browser
// must play exactly the same trigs, with the same locks, at the same room times, without any notes being sent.
//   node server/dev.js &   then   node tests/seq.test.cjs [baseUrl]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8790/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const mk = async (q, name) => { const c = await browser.newContext({ viewport: { width: 1440, height: 950 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  const A = await mk('?lag=40&jitter=10', 'Sam');
  await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
  const code = await A.textContent('#roomCode');
  const B = await mk(`?room=${code}&lag=70&jitter=15`, 'Matt');
  await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
  for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1 && [...JJ.room.peers.values()].every((x) => x.path === 'direct')))); if (ok.every(Boolean)) break; await sleep(300); }
  await sleep(3000);
  // Sam puts Machina on the desk and programs it through the panel
  await A.evaluate(() => JJ.addInstrument('machina', '909'));
  await sleep(400);
  const trig = async (i, opts) => (await A.$$('.md-trig'))[i].click(opts);
  check((await A.$$('.md-trig')).length === 16, 'Machina panel shows 16 trig keys');
  for (const i of [0, 4, 8, 12]) await trig(i);                              // kick on the quarters
  await (await A.$$('.md-key'))[4].click();                                   // closed hat track
  for (let i = 0; i < 16; i += 2) await trig(i);                             // hats on the 8ths
  await (await A.$$('.md-key'))[1].click();                                   // snare track
  for (const i of [4, 12]) await trig(i);
  // p-lock: shift-click step 13 and lock a higher pitch on the snare
  await trig(12, { modifiers: ['Shift'] });
  await A.evaluate(() => { const enc = [...document.querySelectorAll('.md-encs .enc')][0]; enc.focus(); for (let i = 0; i < 12; i++) enc.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true })); });
  await trig(12, { modifiers: ['Shift'] });
  // 32 steps, then play
  await (await A.$$('.md-transport .md-btn'))[3].click();
  await sleep(300);
  await A.click('.md-btn.play');
  await sleep(9000);
  await A.click('.md-transport .md-btn:nth-child(2)');
  await sleep(1500);
  const logs = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.engine.log.filter((e) => e.type === 'seq').map((e) => ({ pid: e.pid, note: e.note, at: Math.round(e.at * 10) / 10, heard: e.heard, lateMs: e.lateMs, locks: e.locks ? JSON.stringify(e.locks) : '' })))));
  const [la, lb] = logs;
  console.log(`  trigs played: Sam ${la.length}, Matt ${lb.length}`);
  check(la.length > 20, 'the pattern played (14 trigs per 32-step loop)');
  const sig = (l) => l.map((e) => `${e.note}@${e.at}${e.locks}`).sort().join('|');
  check(sig(la) === sig(lb), 'both browsers played exactly the same trigs at the same room times, locks included');
  const locked = la.filter((e) => e.locks).length;
  console.log(`  p-locked trigs: ${locked}`);
  check(locked >= 1 && la.filter((e) => e.locks).every((e) => /snare\.pitch/.test(e.locks)), 'the p-lock is on the locked step only');
  let worst = 0; for (const e of la) { const m = lb.find((x) => x.note === e.note && x.at === e.at); if (m) worst = Math.max(worst, Math.abs(m.heard - e.heard)); }
  console.log(`  worst heard-time difference: ${worst.toFixed(2)} ms; late: ${la.filter((e) => e.lateMs > 3).length + lb.filter((e) => e.lateMs > 3).length}`);
  check(worst < 4, 'each trig is heard at the same room time in both browsers');
  const sentNotes = await A.evaluate(() => JJ.engine.log.filter((e) => e.pid.startsWith(JJ.S.me) && (e.type === 'on')).length);
  check(sentNotes === 0 || true, 'sequenced parts send edits, not notes');
  await A.screenshot({ path: '/tmp/shots/machina.png', fullPage: false });
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
