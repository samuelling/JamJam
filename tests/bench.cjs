// Timing benchmark: how small can the lookahead get without notes arriving late, across network profiles.
// Runs silent jammers (?silent=1: full timing and bookkeeping, no synthesis) with simulated one-way delay and
// jitter into each browser, and reports per profile:
//   L       the lookahead each jammer settled on while playing (ms)
//   ideal   the floor for that jammer: worst one-way delay into any listener + that listener's output latency
//   over    L minus ideal: what the technique costs on top of physics
//   late    notes that arrived after their scheduled time (should be 0)
//   clock   true clock error vs the machine's wall clock (all test browsers share one), worst follower (ms)
//   spread  worst difference in when one note is heard across browsers, on-time notes only (ms)
//   node tests/bench.cjs [baseUrl] [extra query, e.g. "tm=15&settle=0.2"]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787/';
const EXTRA = process.argv[3] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROFILES = [
  { name: 'same city', lag: [[8, 3], [8, 3]] },
  { name: 'cross-country', lag: [[35, 8], [35, 8]] },
  { name: 'uneven 3-way', lag: [[20, 5], [60, 15], [100, 25]] },
  { name: 'bad wi-fi', lag: [[25, 60], [20, 10]] },
  { name: 'four players', lag: [[15, 5], [25, 8], [30, 6], [20, 10]] },
  { name: 'lossy 2%', lag: [[30, 8, 0.02], [30, 8, 0.02]] },
];
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;

async function profile(browser, P) {
  const n = P.lag.length, pages = [];
  const q = (i) => `silent=1&lag=${P.lag[i][0]}&jitter=${P.lag[i][1]}${P.lag[i][2] ? '&loss=' + P.lag[i][2] : ''}${EXTRA ? '&' + EXTRA : ''}`;
  const errors = [];
  for (let i = 0; i < n; i++) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    pages.push(page);
  }
  await pages[0].goto(`${BASE}?${q(0)}`);
  await pages[0].fill('#nameIn', 'J0'); await pages[0].click('#startBtn');
  await pages[0].waitForSelector('#studio:not(.hide)');
  const code = await pages[0].textContent('#roomCode');
  for (let i = 1; i < n; i++) {
    await pages[i].goto(`${BASE}?room=${code}&${q(i)}`);
    await pages[i].fill('#nameIn', 'J' + i); await pages[i].click('#joinBtn');
    await pages[i].waitForSelector('#studio:not(.hide)');
  }
  for (let t = 0; t < 60; t++) {
    const ok = await Promise.all(pages.map((p) => p.evaluate((n) => JJ.clock.locked && [...JJ.room.peers.values()].filter((x) => x.path === 'direct').length === n - 1 && JJ.S.players.size === n - 1, n)));
    if (ok.every(Boolean)) break;
    await sleep(300);
  }
  await Promise.all(pages.map((p) => p.evaluate(() => { for (const e of JJ.S.rack) e.budget = 'balanced'; })));
  await sleep(8000); // settle
  const outLat = await Promise.all(pages.map((p) => p.evaluate(() => { const c = JJ.engine.ctx, ts = c.getOutputTimestamp(); return (c.currentTime - ts.contextTime) * 1000 + (performance.now() - ts.performanceTime); })));
  await Promise.all(pages.map((p) => p.evaluate(() => { JJ.engine.log.length = 0; for (const c of JJ.engine.ch.values()) { c.late = 0; c.lateWorst = 0; } JJ.__Ls = []; JJ.__Lt = setInterval(() => JJ.__Ls.push(JJ.S.lookAuto), 200); })));
  // everyone plays ~8 notes a second for 15 s
  await Promise.all(pages.map((p, i) => p.evaluate(async (i) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const end = performance.now() + 15000; let k = 0;
    while (performance.now() < end) {
      const note = 48 + ((k * 7 + i * 5) % 24); k++;
      JJ.input.press(note, 90); await sleep(40 + ((k * 37) % 50)); JJ.input.release(note); await sleep(40 + ((k * 53) % 40));
    }
  }, i)));
  await sleep(1500);
  const clocks = await Promise.all(pages.map((p) => p.evaluate(() => JJ.clock.now() - (performance.timeOrigin + performance.now()))));
  const data = await Promise.all(pages.map((p) => p.evaluate(() => { clearInterval(JJ.__Lt); const Ls = JJ.__Ls; return { me: JJ.S.me, L: Ls.reduce((a, b) => a + b, 0) / Ls.length, log: JJ.engine.log.filter((e) => e.type === 'on').map((e) => ({ pid: e.pid, note: e.note, at: e.at, heard: e.heard, lateMs: e.lateMs })) }; })));
  let late = 0, total = 0, worstLate = 0, spread = 0;
  for (const src of data) for (const dst of data) {
    if (src === dst) continue;
    const mine = src.log.filter((e) => e.pid.startsWith(src.me + ':')), theirs = dst.log.filter((e) => e.pid.startsWith(src.me + ':'));
    for (const e of mine) {
      const m = theirs.find((x) => x.note === e.note && Math.abs(x.at - e.at) < 0.001);
      if (!m) continue;
      total++;
      if (m.lateMs > 3) { late++; worstLate = Math.max(worstLate, m.lateMs); } else spread = Math.max(spread, Math.abs(m.heard - e.heard));
    }
  }
  const clockErr = Math.max(...clocks.map((c) => Math.abs(c - clocks[0])));
  // ideal L for sender i: worst over listeners j != i of (one-way max into j + j's output latency)
  const ideal = data.map((_, i) => Math.max(...P.lag.map((l, j) => (j === i ? -Infinity : l[0] + l[1] + outLat[j]))));
  for (const p of pages) await p.context().close();
  return { L: data.map((d) => d.L), ideal, late, total, worstLate, clockErr, spread, errors };
}

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  console.log(`settings: ${EXTRA || '(defaults)'}`);
  console.log('profile          | L (ms)              | ideal (ms)          | over  | late       | clock err | spread');
  let totOver = 0, totLate = 0;
  const list = PROFILES.filter((P) => !ONLY || ONLY.test(P.name));
  for (const P of list) {
    const r = await profile(browser, P);
    const over = r.L.reduce((a, L, i) => a + (L - r.ideal[i]), 0) / r.L.length;
    totOver += over; totLate += r.late;
    console.log(`${P.name.padEnd(16)} | ${r.L.map((x) => x.toFixed(0)).join('/').padEnd(19)} | ${r.ideal.map((x) => x.toFixed(0)).join('/').padEnd(19)} | ${over.toFixed(0).padStart(5)} | ${String(r.late).padStart(3)}/${String(r.total).padEnd(4)} ${r.worstLate ? '(' + r.worstLate.toFixed(0) + ')' : ''} | ${r.clockErr.toFixed(1).padStart(6)} ms | ${r.spread.toFixed(2)} ms${r.errors.length ? '  ERR ' + r.errors[0] : ''}`);
  }
  console.log(`SUMMARY over=${(totOver / list.length).toFixed(1)} late=${totLate}`);
  await browser.close();
})();
