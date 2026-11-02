// The beta-tester fleet: real multi-browser jams across a grid of scenarios, measured in true (wall-clock) time.
//
// Every scenario opens 2-4 headless Chromium jammers in one room through the local relay (server/dev.js), each with
// its own simulated network (?lag, &jitter, &loss: what that browser receives is delayed, jittered and dropped, so a
// pair's round trip is the sum of both sides), lets the lookahead settle, has everyone play, and optionally runs a
// "flow" script during the jam (a join, the leader leaving, tempo changes, a latency spike...).
//
// All the browsers share this machine's clock, so the harness can measure what no jammer can: each one's true clock
// error (its room time against the leader's at the same wall-clock instant), and the true spread of a note (when each
// browser actually heard it, in wall-clock time). Per scenario it writes one JSON line with:
//   ready        ms from the first click until every pair is linked and every clock locked
//   L            each jammer's auto lookahead while playing: median, max, last (ms); floor = the physics minimum
//   pairs        per sender -> listener: notes sent, missing, late (> 3 ms after their scheduled time), worst late,
//                true spread p50/p95/max (ms), on-time notes only and all notes
//   clockErr     each follower's true clock error: median and worst |error| (ms)
//   fp           fingerprint agreement ("same music") per browser
//   cpu          worst main-thread stall per browser while playing (ms): how starved the test box was
//   errors       page errors and console errors
//   flow         whatever the scenario's flow script measured
//
//   node server/dev.js &      node tests/fleet/fleet.cjs [scenario-id-regex] [out.jsonl]
// The flow-relay-dies scenarios stop and restart server/dev.js (as a Cloudflare restart would); run them with the dev
// server started from the repo root as "node server/dev.js".
const { chromium } = require('playwright');
const fs = require('fs');
const SCEN = require('./scenarios.cjs');
const BASE = process.env.BASE || 'http://localhost:8787/';
const ONLY = process.argv[2] ? new RegExp(process.argv[2]) : null;
const OUT = process.argv[3] || '/tmp/fleet/results.jsonl';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * (b.length - 1) + 0.5))]; };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const ARGS = ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'];

// one jammer's query string
function query(sc, i, extra = '') {
  const [lag = 0, jit = 0, loss = 0] = sc.lag[i] || [];
  const q = [];
  if (sc.silent !== false) q.push('silent=1');
  if (lag || loss) q.push(`lag=${lag}`, `jitter=${jit}`); else if (jit) q.push('lag=0', `jitter=${jit}`);
  if (loss) q.push(`loss=${loss}`);
  if (sc.p2p === false) q.push('p2p=0');
  if (sc.empty) q.push('empty=1');
  if (sc.query) q.push(sc.query);
  if (extra) q.push(extra);
  return q.join('&');
}

async function openJammer(H, i, code, extra) {
  const ctx = await H.browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone'] });
  if (H.sc.init && H.sc.init[i]) await ctx.addInitScript(H.sc.init[i]);
  const page = await ctx.newPage();
  const name = ['Ana', 'Ben', 'Cy', 'Dee', 'Eve'][i];
  page.on('pageerror', (e) => H.errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) H.errors.push(`${name} console: ${m.text().slice(0, 200)}`); });
  await page.goto(`${BASE}?${code ? 'room=' + code + '&' : ''}${query(H.sc, i, extra)}`);
  await page.fill('#nameIn', name);
  await page.click(code ? '#joinBtn' : '#startBtn');
  await page.waitForSelector('#studio:not(.hide)', { timeout: 20000 });
  page.__i = i; page.__name = name;
  return page;
}

// everyone linked (the path the scenario asks for) and every clock locked
async function waitReady(pages, p2p, ms = 30000) {
  const n = pages.length, t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = await Promise.all(pages.map((p) => p.evaluate(() => ({ locked: JJ.clock.locked, me: JJ.S.me, players: JJ.S.players.size, paths: [...JJ.room.peers.values()].map((x) => x.path) })).catch(() => null)));
    if (st.every((s) => s && s.locked && s.me && s.players === n - 1 && s.paths.length === n - 1 && s.paths.every((x) => (p2p === false ? x === 'relay' : x === 'direct')))) return { ok: true, ms: Date.now() - t0, paths: st.map((s) => s.paths) };
    await sleep(200);
  }
  const st = await Promise.all(pages.map((p) => p.evaluate(() => ({ locked: JJ.clock.locked, players: JJ.S.players.size, paths: [...JJ.room.peers.values()].map((x) => x.path) })).catch(() => null)));
  return { ok: false, ms: Date.now() - t0, paths: st };
}

// in each page: a sampler of [wall, room - wall, lookAuto, leader?] every 100 ms, and the worst main-thread stall
const INSTALL = () => {
  clearInterval(JJ.__ft); clearInterval(JJ.__et);
  JJ.__fs = []; JJ.__el = 0; let last = performance.now();
  JJ.__me = JJ.S.me;
  JJ.__ft = setInterval(() => { const w = performance.timeOrigin + performance.now(); JJ.__fs.push([w, JJ.clock.now() - w, JJ.S.lookAuto, JJ.clock.isLeader && JJ.S.me ? 1 : 0, JJ.clock.locked ? 1 : 0]); }, 100);
  JJ.__et = setInterval(() => { const t = performance.now(); JJ.__el = Math.max(JJ.__el, t - last - 50); last = t; }, 50);
  JJ.engine.log.length = 0; JJ.engine.logMax = 200000;
  for (const c of JJ.engine.ch.values()) { c.late = 0; c.lateWorst = 0; }
};
// someone playing: `rate` notes a second for `sec` seconds, notes held 40-60% of the gap, a seeded walk over two octaves
const PLAY = async ({ i, rate, sec, chord }) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const gap = 1000 / rate, end = performance.now() + sec * 1000; let k = 0;
  while (performance.now() < end && JJ.S.me) {
    const note = 48 + ((k * 7 + i * 5) % 24), notes = chord ? [note, note + 4, note + 7] : [note]; k++;
    for (const n of notes) JJ.input.press(n, 70 + (k % 5) * 10);
    await sleep(gap * (0.4 + ((k * 37) % 20) / 100));
    for (const n of notes) JJ.input.release(n);
    await sleep(gap * (0.6 - ((k * 37) % 20) / 100));
  }
};
const COLLECT = () => ({
  me: JJ.S.me || JJ.__me, leader: JJ.clock.isLeader, origin: performance.timeOrigin,
  log: JJ.engine.log.filter((e) => e.type === 'on' || e.type === 'off' || e.type === 'seq').map((e) => [e.pid, e.type, e.note, e.at, e.heard, e.lateMs, e.b || '']),
  fs: JJ.__fs, el: JJ.__el,
  sync: [...JJ.S.sync.entries()].filter(([id]) => JJ.room.peers.has(id) && JJ.S.players.get(id)?.role !== 'listener').map(([id, s]) => [id, !!s.ok]),
  rtt: [...JJ.room.peers.values()].map((p) => ({ id: p.id, path: p.path, rtt: p.rtt.length ? [...p.rtt].sort((a, b) => a - b)[p.rtt.length >> 1] : null })),
  segs: JJ.tempo.toJSON(), L: JJ.S.lookAuto,
  outLat: (() => { try { const c = JJ.engine.ctx, ts = c.getOutputTimestamp(); return Math.round(((c.currentTime - ts.contextTime) * 1000 + (performance.now() - ts.performanceTime)) * 10) / 10; } catch (_) { return null; } })(),
});

// the physics floor for a sender's lookahead: the worst one-way trip into any listener (lag + its jitter) - the
// listener's own share; with loss, the fast channel's redundancy means a lost note is recovered from the next packet
function floorFor(sc, i, n) { let f = 0; for (let j = 0; j < n; j++) if (j !== i) { const [lag = 0, jit = 0] = sc.lag[j] || []; f = Math.max(f, lag + jit); } return f; }

function analyse(sc, data, n, playStart, playEnd, win = {}) {
  const out = { pairs: [], L: [], clockErr: [], fp: [], cpu: [] };
  // each page's room-minus-wall over time; the leader's defines truth (it can change when the leader leaves)
  const eAt = (d, w) => { const fs = d.fs; if (!fs.length) return null; let lo = 0, hi = fs.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (fs[m][0] < w) lo = m + 1; else hi = m; } return fs[lo][1]; };
  const leaderAt = (w) => { for (const d of data) { if (!d || !d.fs.length) continue; let lo = 0, hi = d.fs.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (d.fs[m][0] < w) lo = m + 1; else hi = m; } if (d.fs[lo][3] && Math.abs(d.fs[lo][0] - w) < 300) return d; } return null; };
  // true clock error of every follower during the play window
  data.forEach((d, i) => {
    if (!d) { out.clockErr.push(null); return; }
    const errs = [];
    for (const s of d.fs) { if (s[0] < playStart || s[0] > playEnd || s[3]) continue; const ld = leaderAt(s[0]); if (!ld || ld === d) continue; const el = eAt(ld, s[0]); if (el != null) errs.push(s[1] - el); }
    out.clockErr.push(errs.length ? { med: r1(pct(errs.map(Math.abs), 0.5)), max: r1(Math.max(...errs.map(Math.abs))), signed: r1(pct(errs, 0.5)) } : { leader: true });
    const Ls = d.fs.filter((s) => s[0] >= playStart && s[0] <= playEnd).map((s) => s[2]);
    let fl = 0; for (let j = 0; j < n; j++) if (j !== i && data[j]) { const [lag = 0, jit = 0] = sc.lag[j] || []; fl = Math.max(fl, lag + jit + (data[j].outLat || 0)); }
    out.L.push({ med: r1(pct(Ls, 0.5)), max: r1(Math.max(...Ls)), last: r1(d.L), floor: r1(fl), outLat: d.outLat });
    out.fp.push(d.me && d.sync.length ? d.sync.every((x) => x[1]) : null);
    out.cpu.push(r1(d.el));
  });
  // wall-clock moment a page heard something at room time `heard`
  const wallOf = (d, heard) => { const e0 = eAt(d, heard - (d.fs[0] ? d.fs[0][1] : 0)); return heard - (e0 ?? 0); };
  for (let s = 0; s < n; s++) for (let t = 0; t < n; t++) {
    if (s === t || !data[s] || !data[t]) continue;
    const src = data[s], dst = data[t], pre = src.me + ':';
    const mine = src.log.filter((e) => e[0].startsWith(pre) && (e[1] === 'on' || e[1] === 'off'));
    const idx = new Map(); for (const e of dst.log) if (e[0].startsWith(pre)) { const k = `${e[0]}|${e[1]}|${e[2]}|${Math.round(e[3])}`; if (!idx.has(k)) idx.set(k, []); idx.get(k).push(e); }
    let missing = 0, late = 0, lateWorst = 0, looseLate = 0; const spreadOn = [], spreadAll = [];
    const [lo, hi] = win[t] || [-Infinity, Infinity], [slo, shi] = win[s] || [-Infinity, Infinity];
    for (const e of mine) {
      if (e[3] < lo || e[3] > hi || e[3] < slo || e[3] > shi) continue;
      const cands = idx.get(`${e[0]}|${e[1]}|${e[2]}|${Math.round(e[3])}`) || [];
      const m = cands.find((x) => Math.abs(x[3] - e[3]) < 0.01);
      if (!m) { missing++; continue; }
      const sp = Math.abs(wallOf(dst, m[4]) - wallOf(src, e[4]));
      spreadAll.push(sp);
      if (m[5] > 3) { if (e[6] === 'l') looseLate++; else { late++; lateWorst = Math.max(lateWorst, m[5]); } } else spreadOn.push(sp);
    }
    out.pairs.push({ from: s, to: t, sent: mine.filter((e) => e[3] >= Math.max(lo, slo) && e[3] <= Math.min(hi, shi)).length, missing, late, lateWorst: r1(lateWorst), looseLate,
      spreadOn: { p50: r1(pct(spreadOn, 0.5)), p95: r1(pct(spreadOn, 0.95)), max: r1(spreadOn.length ? Math.max(...spreadOn) : null) },
      spreadAll: { p95: r1(pct(spreadAll, 0.95)), max: r1(spreadAll.length ? Math.max(...spreadAll) : null) } });
  }
  return out;
}

async function runScenario(browser, sc) {
  const H = { browser, sc, errors: [], flow: {}, notes: [], pages: [], win: {}, sleep, openJammer: (i, code, extra) => openJammer(H, i, code, extra) };
  const n = sc.lag.length, t0 = Date.now();
  const A = await openJammer(H, 0, null);
  const code = await A.textContent('#roomCode'); H.code = code; H.pages.push(A);
  const join0 = Date.now();
  for (let i = 1; i < (sc.startN || n); i++) H.pages.push(await openJammer(H, i, code));
  const ready = await waitReady(H.pages, sc.p2p);
  H.ready = { ok: ready.ok, ms: ready.ms + (Date.now() - join0 - ready.ms > 0 ? 0 : 0), firstClickToReady: Date.now() - t0, paths: ready.paths };
  if (sc.budget !== 'auto') await Promise.all(H.pages.map((p) => p.evaluate((b) => { for (const e of JJ.S.rack) e.budget = b; }, sc.budget || 'balanced')));
  if (sc.setup) await sc.setup(H);
  await sleep((sc.settle ?? 8) * 1000);
  await Promise.all(H.pages.map((p) => p.evaluate(INSTALL)));
  const playStart = Date.now();
  const players = sc.players || H.pages.map((_, i) => i);
  const play = Promise.all(players.map((i) => H.pages[i] && H.pages[i].evaluate(PLAY, { i, rate: sc.rate ?? 8, sec: sc.sec ?? 12, chord: !!sc.chord }).catch((e) => H.errors.push('play: ' + e.message.slice(0, 120)))));
  const flow = sc.flow ? sc.flow(H).catch((e) => { H.flow.error = e.message.slice(0, 300); }) : null;
  await play; if (!players.length && !sc.flow) await sleep((sc.sec ?? 12) * 1000); if (flow) await flow;
  const playEnd = Date.now();
  const maxLag = Math.max(...sc.lag.map((x) => (x[0] || 0) + (x[1] || 0)));
  await sleep(1500 + maxLag * 2 + 600);
  const data = await Promise.all(H.pages.map((p) => (p.isClosed() ? null : p.evaluate(COLLECT).catch(() => null))));
  if (sc.post) await sc.post(H, data);
  const res = analyse(sc, data, H.pages.length, playStart, playEnd, H.win || {});
  return { id: sc.id, group: sc.group, title: sc.title, n: H.pages.length, lag: sc.lag, p2p: sc.p2p !== false, silent: sc.silent !== false, rate: sc.rate ?? 8, sec: sc.sec ?? 12,
    ready: H.ready, ...res, flow: H.flow, errors: H.errors.slice(0, 20), errorCount: H.errors.length, wall: Math.round((Date.now() - t0) / 1000) };
}

(async () => {
  fs.mkdirSync(require('path').dirname(OUT), { recursive: true });
  const list = SCEN.filter((s) => !ONLY || ONLY.test(s.id));
  console.log(`fleet: ${list.length} scenarios -> ${OUT}`);
  for (const sc of list) {
    const browser = await chromium.launch({ args: ARGS });
    let res;
    try { res = await Promise.race([runScenario(browser, sc), sleep((sc.timeout || 240) * 1000).then(() => { throw new Error('scenario timed out'); })]); }
    catch (e) { res = { id: sc.id, group: sc.group, title: sc.title, crashed: e.message.slice(0, 300) }; }
    await browser.close().catch(() => {});
    fs.appendFileSync(OUT, JSON.stringify(res) + '\n');
    const pr = res.pairs || [];
    const sum = (k) => pr.reduce((a, p) => a + (p[k] || 0), 0);
    console.log(`${sc.id.padEnd(22)} ${res.crashed ? 'CRASHED ' + res.crashed : `ready ${res.ready?.ok ? res.ready.firstClickToReady + 'ms' : 'NO'} | L ${res.L.map((x) => x.med).join('/')} (floor ${res.L.map((x) => x.floor).join('/')}) | sent ${sum('sent')} miss ${sum('missing')} late ${sum('late')} | spread p95 ${Math.max(0, ...pr.map((p) => p.spreadOn.p95 || 0))} max ${Math.max(0, ...pr.map((p) => p.spreadAll.max || 0))} | clk ${res.clockErr.map((c) => (c && c.max != null ? c.max : '-')).join('/')} | fp ${res.fp.map((x) => (x == null ? '-' : x ? '✓' : '✗')).join('')} | cpu ${res.cpu.join('/')} | err ${res.errorCount}${Object.keys(res.flow || {}).length ? ' | flow ' + JSON.stringify(res.flow).slice(0, 300) : ''}`}`);
  }
})();
