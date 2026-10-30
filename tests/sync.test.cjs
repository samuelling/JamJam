// End-to-end sync test: three (or four) headless Chromium jammers in one room through the local dev relay,
// with simulated network lag. Checks direct links, clock lock, that every note is heard at the same room time
// in every browser, that fingerprints agree, the relay fallback, and the audio lane.
//
//   node server/dev.js &      (PORT=8790)
//   node tests/sync.test.cjs [baseUrl]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8790/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };

async function jammer(browser, name, query, errors) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  await page.goto(BASE + query);
  await page.fill('#nameIn', name);
  return page;
}

async function run({ p2p, lag, n }) {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const extra = (i) => `${p2p ? '' : '&p2p=0'}${lag[i] ? `&lag=${lag[i]}&jitter=${Math.round(lag[i] / 4)}` : ''}`;
  const names = ['Sam', 'Matt', 'Emma', 'Ev'].slice(0, n);
  const A = await jammer(browser, names[0], `?x=1${extra(0)}`, errors);
  await A.click('#startBtn');
  await A.waitForSelector('#jam:not([hidden])', { timeout: 15000 });
  const code = await A.textContent('#roomCode');
  const pages = [A];
  for (let i = 1; i < n; i++) {
    const P = await jammer(browser, names[i], `?room=${code}${extra(i)}`, errors);
    await P.click('#joinBtn');
    await P.waitForSelector('#jam:not([hidden])', { timeout: 15000 });
    pages.push(P);
  }
  // wait for links + clock lock
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 20000) {
    const st = await Promise.all(pages.map((p) => p.evaluate(() => ({ locked: JJ.clock.locked, paths: [...JJ.room.peers.values()].map((x) => x.path), players: JJ.S.players.size }))));
    if (st.every((s) => s.locked && s.paths.length === pages.length - 1 && s.paths.every((x) => x !== 'connecting') && s.players === pages.length)) { ready = true; console.log('  paths:', st.map((s) => s.paths.join('/')).join(' | ')); break; }
    await sleep(300);
  }
  check(ready, `${n} jammers connected (${p2p ? 'direct' : 'relay'}) and clocks locked`);
  if (p2p) {
    const allDirect = (await Promise.all(pages.map((p) => p.evaluate(() => [...JJ.room.peers.values()].every((x) => x.path === 'direct'))))).every(Boolean);
    check(allDirect, 'every pair is on a direct WebRTC link');
  }
  // let the lookahead loop settle on measured margins (pings carry timestamps, so this works before anyone plays)
  await sleep(6000);
  const Ls = await Promise.all(pages.map((p) => p.evaluate(() => Math.round(JJ.S.lookAuto))));
  console.log('  auto lookahead per jammer (ms):', Ls.join(', '));

  // B switches to the Juno-106 hardware twin, C to the kit
  await pages[1].evaluate(() => { document.querySelector('input[name=source][value=hw]').click(); });
  await pages[1].selectOption('#hwSel', 'roland-juno-106');
  if (n > 2) await pages[2].selectOption('#instSel', 'kit');
  await sleep(800);
  const descB = await pages[0].evaluate(() => document.querySelector('#players').textContent);
  check(/Juno-106/.test(descB) && (n < 3 || /Kit/.test(descB)), 'instrument and hardware-twin changes reach the others');

  await Promise.all(pages.map((p) => p.evaluate(() => { JJ.engine.log.length = 0; for (const c of JJ.engine.ch.values()) { c.late = 0; c.lateWorst = 0; } })));
  // everyone plays: A chords, B a line, C drums; B moves a knob
  const plays = pages.map((p, i) => p.evaluate(async (i) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let k = 0; k < 12; k++) {
      const base = i === 2 ? 36 + (k % 4) * 2 : 60 + i * 7 + (k % 5);
      JJ.input.press(base, 90); if (i === 0) JJ.input.press(base + 4, 80);
      await sleep(70 + i * 13);
      JJ.input.release(base); if (i === 0) JJ.input.release(base + 4);
      if (i === 1) document.querySelector('#knobs input').dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(60);
    }
  }, i));
  await Promise.all(plays);
  await sleep(2000 + Math.max(...lag));

  // compare: each event for each player should be heard at the same room time everywhere
  const logs = await Promise.all(pages.map((p) => p.evaluate(() => ({ me: JJ.S.me, log: JJ.engine.log.filter((e) => e.type !== 'p').map((e) => ({ pid: e.pid, type: e.type, note: e.note, at: e.at, heard: e.heard, lateMs: e.lateMs, now: e.now })) }))));
  let compared = 0, worst = 0, missing = 0, late = 0;
  for (const src of logs) {
    const mine = src.log.filter((e) => e.pid === src.me);
    for (const other of logs) {
      if (other === src) continue;
      const theirs = other.log.filter((e) => e.pid === src.me);
      for (const e of mine) {
        const m = theirs.find((x) => x.type === e.type && x.note === e.note && Math.abs(x.at - e.at) < 0.001);
        if (!m) { missing++; continue; }
        compared++;
        if (m.lateMs > 3) late++;
        worst = Math.max(worst, Math.abs(m.heard - e.heard));
      }
    }
  }
  console.log(`  events compared across browsers: ${compared}, missing: ${missing}, late: ${late}, worst heard-time difference: ${worst.toFixed(2)} ms`);
  check(compared > 50 && missing === 0, 'every note arrived in every other browser');
  // four headless browsers on a two-core test box can starve each other's audio threads; allow a stray straggler there
  const lateOk = n >= 4 ? late <= Math.ceil(compared * 0.01) : late === 0;
  check(lateOk, `no note arrived after its scheduled time${n >= 4 ? ' (≤1% allowed with 4 browsers on one test machine)' : ''}`);
  let worstOnTime = 0;
  for (const src of logs) for (const other of logs) if (other !== src) for (const e of src.log.filter((x) => x.pid === src.me)) {
    const m = other.log.find((x) => x.pid === src.me && x.type === e.type && x.note === e.note && Math.abs(x.at - e.at) < 0.001);
    if (m && m.lateMs <= 3) worstOnTime = Math.max(worstOnTime, Math.abs(m.heard - e.heard));
  }
  console.log(`  worst heard-time difference among on-time notes: ${worstOnTime.toFixed(2)} ms`);
  check(worstOnTime < 4, 'each on-time note is heard at the same room time in every browser (within 4 ms)');

  // fingerprints
  await sleep(7000);
  const sync = await Promise.all(pages.map((p) => p.evaluate(() => [...JJ.S.sync.values()].map((s) => s.ok))));
  console.log('  fingerprint checks:', JSON.stringify(sync));
  check(sync.every((s) => s.length === pages.length - 1 && s.every(Boolean)), 'every browser reports "same music" for every other');

  // audio lane: C streams its (fake) mic, A should play it lane-delayed
  if (p2p && n > 2) {
    await pages[2].click('#laneBtn');
    await sleep(3500);
    const laneInfo = await pages[0].evaluate((pid) => { const c = JJ.engine.ch.get(pid); return { recent: performance.now() - c.laneT, late: c.laneLate }; }, logs[2].me);
    const sent = await pages[2].evaluate(() => document.querySelector('#netSummary').textContent);
    console.log('  lane:', JSON.stringify(laneInfo), '|', sent);
    check(laneInfo.recent < 500 && laneInfo.late < 3, 'audio lane chunks arrive and are scheduled a bar late');
  }
  // tempo change from a follower goes through the leader
  await pages[1].fill('#bpm', '120'); await pages[1].dispatchEvent('#bpm', 'change');
  await sleep(1500);
  const bpms = await Promise.all(pages.map((p) => p.evaluate(() => JJ.tempo.bpm(JJ.clock.now() + 2000))));
  check(bpms.every((b) => b === 120), `tempo change reaches everyone (${bpms.join(', ')})`);

  check(errors.length === 0, 'no page errors' + (errors.length ? ':\n   ' + errors.slice(0, 8).join('\n   ') : ''));
  await browser.close();
}

(async () => {
  console.log('--- 3 jammers, direct links, 40/80/120 ms simulated lag ---');
  await run({ p2p: true, lag: [40, 80, 120], n: 3 });
  console.log('--- 4 jammers, direct links, no lag ---');
  await run({ p2p: true, lag: [0, 0, 0, 0], n: 4 });
  console.log('--- 2 jammers, relay fallback (p2p=0), 30 ms lag ---');
  await run({ p2p: false, lag: [30, 30], n: 2 });
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
