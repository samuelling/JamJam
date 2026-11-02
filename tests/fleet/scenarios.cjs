// The fleet's scenarios. lag: per jammer [one-way ms, jitter ms, loss 0..1] for what that browser receives.
// Flow scripts get H (pages, sleep, openJammer, flow: an object for what they measure, code: the room code).
const { execSync, spawn } = require('child_process');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = [];
const add = (o) => S.push(o);

// room time on a page right now
const roomNow = (p) => p.evaluate(() => JJ.clock.now());
// the room-minus-wall offset's biggest jump between two samples (a clock that jumps makes notes jump)
const jumps = (p) => p.evaluate(() => { let w = 0; for (let i = 1; i < JJ.__fs.length; i++) w = Math.max(w, Math.abs(JJ.__fs[i][1] - JJ.__fs[i - 1][1])); return Math.round(w * 10) / 10; });
// events not played by any jammer (drummers, sequencers) compared across browsers: same notes at the same room times?
async function compareBand(H, filter = () => true, withHumans = false) {
  const logs = await Promise.all(H.pages.filter((p) => !p.isClosed()).map((p) => p.evaluate(() => ({ me: JJ.S.me, peers: [...JJ.S.players.keys()], log: JJ.engine.log.map((e) => [e.pid, e.type, e.note, Math.round(e.at), e.lateMs]) }))));
  const humans = new Set(logs.flatMap((l) => [l.me, ...l.peers]));
  const sets = logs.map((l) => new Set(l.log.filter((e) => (withHumans || !humans.has(String(e[0]).split(':')[0])) && filter(e) && e[1] !== 'off').map((e) => `${e[0].replace(/^[^:]*:/, '')}|${e[2]}|${e[3]}`)));
  const lateN = logs.map((l) => l.log.filter((e) => (withHumans || !humans.has(String(e[0]).split(':')[0])) && filter(e) && e[4] > 3).length);
  // compare inside the window every browser covered
  const all = sets.map((s) => [...s].map((k) => +k.split('|')[2]));
  const lo = Math.max(...all.map((a) => Math.min(...a))) + 500, hi = Math.min(...all.map((a) => Math.max(...a))) - 500;
  const win = sets.map((s) => new Set([...s].filter((k) => { const t = +k.split('|')[2]; return t >= lo && t <= hi; })));
  let diff = 0; for (let i = 1; i < win.length; i++) { for (const k of win[0]) if (!win[i].has(k)) diff++; for (const k of win[i]) if (!win[0].has(k)) diff++; }
  return { events: win[0].size, differ: diff, late: lateN };
}

// ---------- A. one-way latency sweep, 2 players, jitter 20% ----------
for (const ms of [0, 10, 25, 50, 100, 150, 250, 300]) add({ id: `lat-${ms}`, group: 'latency', title: `2 players, ${ms} ms each way, jitter 20%`, lag: [[ms, Math.round(ms * 0.2)], [ms, Math.round(ms * 0.2)]] });
// ---------- B. jitter sweep at 40 ms ----------
for (const j of [0, 10, 40, 80, 160]) add({ id: `jit-${j}`, group: 'jitter', title: `2 players, 40 ms + jitter up to ${j} ms`, lag: [[40, j], [40, j]] });
// ---------- C. loss sweep at 30 ms ----------
for (const l of [0.005, 0.02, 0.05, 0.1, 0.2]) add({ id: `loss-${l * 100}`, group: 'loss', title: `2 players, 30 ms, ${l * 100}% loss`, lag: [[30, 6, l], [30, 6, l]] });
// ---------- D. asymmetric routes: the shared clock assumes the trip there takes as long as the trip back ----------
add({ id: 'asym-0-100', group: 'asymmetric', title: 'leader receives at 0 ms, follower at 100 ms', lag: [[0, 0], [100, 10]] });
add({ id: 'asym-100-0', group: 'asymmetric', title: 'leader receives at 100 ms, follower at 0 ms', lag: [[100, 10], [0, 0]] });
add({ id: 'asym-20-80', group: 'asymmetric', title: '20 ms one way, 80 ms the other', lag: [[20, 4], [80, 8]] });
add({ id: 'asym-10-200', group: 'asymmetric', title: '10 ms one way, 200 ms the other (congested upload)', lag: [[10, 2], [200, 20]] });
// ---------- E. band size ----------
add({ id: 'n3-uneven', group: 'size', title: '3 players at 20 / 60 / 120 ms', lag: [[20, 5], [60, 12], [120, 25]] });
add({ id: 'n4-even', group: 'size', title: '4 players at 30 ms each', lag: [[30, 6], [30, 6], [30, 6], [30, 6]] });
add({ id: 'n4-mixed', group: 'size', title: '4 players: same city, cross-country, transatlantic, bad wi-fi', lag: [[8, 2], [40, 8], [90, 15], [25, 60]] });
add({ id: 'n4-zero', group: 'size', title: '4 players, no simulated network (the test machine itself)', lag: [[0, 0], [0, 0], [0, 0], [0, 0]] });
// ---------- F. relay path (no direct links) ----------
add({ id: 'relay-20', group: 'relay', title: 'relay only, 20 ms', lag: [[20, 4], [20, 4]], p2p: false });
add({ id: 'relay-80-loss', group: 'relay', title: 'relay only, 80 ms, 2% loss', lag: [[80, 15, 0.02], [80, 15, 0.02]], p2p: false });
add({ id: 'relay-n3', group: 'relay', title: 'relay only, 3 players at 30 / 50 / 70 ms', lag: [[30, 6], [50, 10], [70, 14]], p2p: false });
// ---------- G. real synthesis and CPU ----------
add({ id: 'cpu-real-2', group: 'cpu', title: '2 players, real synths, chords, 40 ms', lag: [[40, 8], [40, 8]], silent: false, chord: true, rate: 8 });
add({ id: 'cpu-real-4', group: 'cpu', title: '4 players, real synths, chords, 30 ms', lag: [[30, 6], [30, 6], [30, 6], [30, 6]], silent: false, chord: true, rate: 6 });
add({ id: 'cpu-dense', group: 'cpu', title: '2 players, timing only, 25 chords a second each', lag: [[30, 6], [30, 6]], chord: true, rate: 25 });
add({ id: 'cpu-slow-phone', group: 'cpu', title: 'a slow phone (CPU throttled 4x) with real synths, 40 ms', lag: [[40, 8], [40, 8]], silent: false, chord: true, rate: 6,
  setup: async (H) => { const c = await H.pages[1].context().newCDPSession(H.pages[1]); await c.send('Emulation.setCPUThrottlingRate', { rate: 4 }); H.flow.throttled = 'Ben 4x'; } });
// ---------- H. a long session ----------
add({ id: 'long-3min', group: 'long', title: '2 players, 50 ms, 3 minutes of playing', lag: [[50, 10], [50, 10]], rate: 4, sec: 180, timeout: 360,
  post: async (H) => { const d = await Promise.all(H.pages.map((p) => p.evaluate(() => { const f = JJ.__fs, n = f.length; const L = f.map((x) => x[2]); return { L0: Math.round(L[Math.floor(n * 0.05)]), L1: Math.round(L[n - 1]), Lmin: Math.round(Math.min(...L)), Lmax: Math.round(Math.max(...L)) }; }))); H.flow.Ldrift = d; H.flow.jump = await Promise.all(H.pages.map(jumps)); } });

// ---------- I. flow: what happens when things change mid-jam ----------
add({ id: 'flow-join', group: 'flow', title: 'a third player walks in mid-jam (40 ms)', lag: [[40, 8], [40, 8], [40, 8]], startN: 2, players: [0, 1], sec: 14,
  flow: async (H) => {
    await sleep(4000); const t = Date.now();
    const C = await H.openJammer(2, H.code); H.pages.push(C);
    for (let i = 0; i < 100; i++) { const ok = await C.evaluate(() => JJ.clock.locked && JJ.S.players.size === 2 && [...JJ.room.peers.values()].every((x) => x.path === 'direct')).catch(() => false); if (ok) break; await sleep(100); }
    H.flow.joinToReadyMs = Date.now() - t;
    H.win[2] = [(await roomNow(C)) + 1000, Infinity];
    await C.evaluate(() => { clearInterval(JJ.__ft); JJ.__fs = []; JJ.__el = 0; JJ.__ft = setInterval(() => { const w = performance.timeOrigin + performance.now(); JJ.__fs.push([w, JJ.clock.now() - w, JJ.S.lookAuto, JJ.clock.isLeader ? 1 : 0, 1]); }, 100); });
    // what the newcomer sees of the others' instruments right away
    await sleep(500);
    H.flow.joinerSees = await C.evaluate(() => [...JJ.S.players.values()].map((p) => (p.rack || []).length));
    H.flow.firstNotesAfterJoinMs = await C.evaluate(async () => { const t0 = performance.now(); for (let i = 0; i < 100; i++) { if (JJ.engine.log.some((e) => e.type === 'on')) return Math.round(performance.now() - t0); await new Promise((r) => setTimeout(r, 50)); } return null; });
  },
  post: async (H) => { H.flow.joinerLate = await H.pages[2].evaluate(() => JJ.engine.log.filter((e) => e.type === 'on' && e.lateMs > 3).length); H.flow.joinerOn = await H.pages[2].evaluate(() => JJ.engine.log.filter((e) => e.type === 'on').length); await sleep(6000); H.flow.fpAfter = await Promise.all(H.pages.map((p) => p.evaluate(() => [...JJ.S.sync.values()].map((s) => !!s.ok)))); } });

add({ id: 'flow-leader-leaves', group: 'flow', title: 'the clock leader leaves mid-jam (3 players, 30/60/90 ms)', lag: [[30, 6], [60, 12], [90, 18]], sec: 16,
  flow: async (H) => {
    await sleep(5000);
    H.flow.leftAtRoom = await roomNow(H.pages[1]); H.win[0] = [-Infinity, H.flow.leftAtRoom - 200];
    await H.pages[0].click('#leaveBtn');
    const t = Date.now();
    for (let i = 0; i < 200; i++) { const st = await Promise.all([1, 2].map((k) => H.pages[k].evaluate(() => ({ leader: JJ.clock.isLeader, players: JJ.S.players.size, bpm: JJ.tempo.bpm(JJ.clock.now()) })))); if (st.some((s) => s.leader) && st.every((s) => s.players === 1)) { H.flow.handoffMs = Date.now() - t; H.flow.after = st; break; } await sleep(100); }
  },
  post: async (H) => { H.flow.jump = await Promise.all([1, 2].map((k) => jumps(H.pages[k]))); H.flow.newLeader = await Promise.all([1, 2].map((k) => H.pages[k].evaluate(() => JJ.clock.isLeader))); } });

add({ id: 'flow-tempo-storm', group: 'flow', title: 'tempo changed every 1.5 s by a follower, with a drummer (40 ms, 2% loss)', lag: [[40, 8, 0.02], [40, 8, 0.02], [60, 10, 0.02]], sec: 14,
  setup: async (H) => { await H.pages[0].evaluate(() => JJ.addVirtual('drums', 'rock')); await sleep(1500); },
  flow: async (H) => { const bpms = [120, 84, 140, 100, 132, 90, 110, 96]; for (const b of bpms) { await sleep(1500); await H.pages[1].evaluate((b) => JJ.setTempo(b), b); } },
  post: async (H) => {
    const segs = await Promise.all(H.pages.map((p) => p.evaluate(() => JSON.stringify(JJ.tempo.toJSON()))));
    H.flow.tempoMapsAgree = segs.every((s) => s === segs[0]); H.flow.segments = JSON.parse(segs[0]).length;
    H.flow.drummer = await compareBand(H);
  } });

add({ id: 'flow-lag-spike', group: 'flow', title: 'a 300 ms spike for 4 s on one player (normally 30 ms)', lag: [[30, 6], [30, 6]], sec: 16,
  flow: async (H) => {
    await sleep(4000);
    const t = Date.now();
    await H.pages[1].evaluate(() => { JJ.room.lag = { ms: 300, jitter: 30, loss: 0 }; });
    let rose = null; while (Date.now() - t < 4000) { const L = await H.pages[0].evaluate(() => JJ.S.lookAuto); if (rose == null && L >= 300) rose = Date.now() - t; await sleep(50); }
    await H.pages[1].evaluate(() => { JJ.room.lag = { ms: 30, jitter: 6, loss: 0 }; });
    const t2 = Date.now(); let back = null; while (Date.now() - t2 < 7000) { const L = await H.pages[0].evaluate(() => JJ.S.lookAuto); if (L < 120) { back = Date.now() - t2; break; } await sleep(100); }
    H.flow.LroseTo300Ms = rose; H.flow.LbackUnder120Ms = back;
  } });

add({ id: 'flow-knob-storm', group: 'flow', title: 'two players sweep a knob 60 times a second while playing (40 ms)', lag: [[40, 8], [40, 8]], silent: false, sec: 12,
  flow: async (H) => { await Promise.all([0, 1].map((k) => H.pages[k].evaluate(async () => { const end = performance.now() + 10000; let i = 0; while (performance.now() < end) { JJ.setParam('cutoff', 400 + 3000 * (0.5 + 0.5 * Math.sin(i++ / 10))); await new Promise((r) => setTimeout(r, 16)); } }))); },
  post: async (H) => { await sleep(5000); H.flow.fpAfter = await Promise.all(H.pages.map((p) => p.evaluate(() => [...JJ.S.sync.values()].map((s) => !!s.ok)))); H.flow.cutoffs = await Promise.all(H.pages.map((p) => p.evaluate(() => { const me = JJ.S.rack[0]?.cfg.params.cutoff; const them = [...JJ.S.players.values()].map((pl) => pl.rack?.[0]?.cfg?.params?.cutoff); return [Math.round(me), ...them.map(Math.round)]; }))); } });

add({ id: 'flow-drummer-lat', group: 'flow', title: 'a drummer across 3 players at 20 / 90 / 160 ms', lag: [[20, 4], [90, 15], [160, 25]], players: [], sec: 12,
  setup: async (H) => { await H.pages[1].evaluate(() => JJ.addVirtual('drums', 'funk')); await sleep(2500); },
  post: async (H) => { H.flow.drummer = await compareBand(H); } });

add({ id: 'flow-seq-loss', group: 'flow', title: "Machina's sequencer edited live under 10% loss (60 ms)", lag: [[60, 10, 0.1], [60, 10, 0.1]], players: [], sec: 14,
  setup: async (H) => {
    const A = H.pages[0]; await A.evaluate(() => JJ.addInstrument('machina', '909')); await sleep(600);
    const trig = async (i) => (await A.$$('.md-trig'))[i].click();
    for (const i of [0, 4, 8, 12]) await trig(i);
    await A.click('.md-btn.play'); await sleep(2000);
  },
  flow: async (H) => { const A = H.pages[0]; for (let k = 0; k < 24; k++) { await (await A.$$('.md-key'))[k % 3 === 0 ? 1 : 4].click(); await (await A.$$('.md-trig'))[(k * 5) % 16].click(); await sleep(400); } },
  post: async (H) => { H.flow.seq = await compareBand(H, (e) => e[1] === 'seq', true); } });

add({ id: 'flow-room-full', group: 'flow', title: 'a fifth person tries to join a full room', lag: [[10, 2], [10, 2], [10, 2], [10, 2]], players: [0, 1], sec: 6,
  flow: async (H) => {
    const ctx = await H.browser.newContext(); const p = await ctx.newPage();
    await p.goto(`${process.env.BASE || 'http://localhost:8787/'}?room=${H.code}&silent=1`); await p.fill('#nameIn', 'Fifth'); await p.click('#joinBtn'); await sleep(5000);
    H.flow.fifth = await p.evaluate(() => ({ inStudio: !document.querySelector('#studio').classList.contains('hide'), listener: document.body.classList.contains('listener'), status: (document.querySelector('#lobbyStatus')?.textContent || '') + ' ' + (document.querySelector('#status')?.textContent || '') }));
    H.flow.bandStill = await Promise.all(H.pages.map((q) => q.evaluate(() => JJ.S.players.size)));
    await ctx.close();
  } });

add({ id: 'flow-listener', group: 'flow', title: 'a listener at 120 ms hears a 2-player jam', lag: [[30, 6], [30, 6]], sec: 12,
  setup: async (H) => {
    const ctx = await H.browser.newContext(); const p = await ctx.newPage(); H.listener = p;
    await p.goto(`${process.env.BASE || 'http://localhost:8787/'}?room=${H.code}&listen=1&silent=1&lag=120&jitter=20`); await p.fill('#nameIn', 'Lis'); await p.click('#listenBtn'); await p.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { if (await p.evaluate(() => JJ.clock.locked && JJ.S.players.size >= 2)) break; await sleep(200); }
    await p.evaluate(() => { JJ.engine.log.length = 0; JJ.engine.logMax = 200000; });
  },
  post: async (H) => {
    const p = H.listener; const l = await p.evaluate(() => ({ on: JJ.engine.log.filter((e) => e.type === 'on').length, late: JJ.engine.log.filter((e) => e.type === 'on' && e.lateMs > 3).length, worst: Math.round(Math.max(0, ...JJ.engine.log.map((e) => e.lateMs || 0))) }));
    const sent = await Promise.all(H.pages.map((q) => q.evaluate(() => JJ.engine.log.filter((e) => e.type === 'on' && e.pid.startsWith(JJ.S.me + ':')).length)));
    H.flow.listener = { ...l, bandSent: sent.reduce((a, b) => a + b, 0), bandSeesListener: await H.pages[0].evaluate(() => document.querySelector('#listeners')?.textContent || '') };
    H.flow.listenerLMs = await H.pages[0].evaluate(() => Math.round(JJ.S.lookAuto));
  } });

add({ id: 'flow-relay-dies', group: 'flow', title: 'the handshake server dies mid-jam for 6 s (direct links, 30 ms)', lag: [[30, 6], [30, 6]], sec: 16,
  flow: async (H) => {
    await sleep(4000);
    const root = path.resolve(__dirname, '../..');
    try { execSync("pkill -f '^node server/dev.js'"); } catch (_) {}
    H.flow.killed = true; await sleep(6000);
    const child = spawn('node', ['server/dev.js'], { cwd: root, detached: true, stdio: 'ignore' }); child.unref();
    await sleep(3000);
    H.flow.afterRestart = await Promise.all(H.pages.map((p) => p.evaluate(() => ({ players: JJ.S.players.size, paths: [...JJ.room.peers.values()].map((x) => x.path), ws: JJ.room.ws ? JJ.room.ws.readyState : null, status: document.querySelector('#status')?.textContent || '' }))));
  } });

add({ id: 'flow-take-align', group: 'flow', title: 'a take locked in at 150 ms lands where it was played', lag: [[150, 15], [150, 15]], players: [], sec: 1, settle: 6,
  flow: async (H) => {
    const [A, B] = H.pages;
    await A.evaluate(() => { JJ.goRoom('compose'); JJ.setSong('sec:v1', { name: 'Verse', bars: 2, chords: ['C', 'G'], notes: '' }); JJ.setSong('order', ['v1']); JJ.play('loop', 'v1'); });
    await sleep(2500);
    // Ben plays a note exactly on every beat of one full pass, by the room clock (hear-myself off: he hears each one a lookahead later)
    const res = await B.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const r = JJ.S.rack[0].r, tr = JJ.song().transport;
      let b = Math.ceil(JJ.tempo.beatAt(JJ.clock.now()) + 0.5);
      const passLen = 8; b = Math.ceil(b / passLen) * passLen;   // start of a pass (2 bars of 4)
      for (let k = 0; k < passLen; k++) { while (JJ.tempo.beatAt(JJ.clock.now()) < b + k) await sleep(1); JJ.input.press(60, 100); await sleep(80); JJ.input.release(60); }
      while (JJ.tempo.beatAt(JJ.clock.now()) < b + passLen + 0.3) await sleep(10);
      const n = JJ.lockIn(r); await sleep(800);
      const s = JJ.song(); const part = Object.keys(s.sections || {}).length ? s : null;
      return { locked: n, L: Math.round(JJ.S.lookAuto), beatMs: Math.round(60000 / JJ.tempo.bpm(JJ.clock.now())), takes: JSON.stringify(s).length };
    });
    await sleep(1000);
    // the take's note starts, in beats from the section start
    const notes = await A.evaluate(() => { const s = JJ.song(); const out = []; for (const [k, v] of Object.entries(s)) { if (k.startsWith('take') || k.startsWith('part')) { const evs = (v && (v.takes || [v])).flatMap((t) => t.events || []); for (const e of evs) if (e.type === 'on') out.push(e.b); } } return out; });
    const all = notes.length ? notes : await A.evaluate(() => { const s = JJ.song(); const out = []; const walk = (o) => { if (!o || typeof o !== 'object') return; if (Array.isArray(o.events)) for (const e of o.events) if (e.type === 'on' && typeof e.b === 'number') out.push(e.b); for (const v of Object.values(o)) walk(v); }; walk(s); return out; });
    const offs = all.map((b) => b - Math.round(b));
    H.flow.take = { ...res, notes: all.length, offsetBeats: offs.map((x) => Math.round(x * 1000) / 1000), offsetMsMed: offs.length ? Math.round((offs.sort((a, b) => a - b)[offs.length >> 1]) * res.beatMs) : null };
  } });


// ---------- J. follow-ups: isolating what the first pass found, and repeats ----------
const drumSetup = (style = 'rock') => async (H) => { await H.pages[0].evaluate((st) => JJ.addVirtual('drums', st), style); await sleep(2000); };
const tempoFlow = (bpms, every = 1500, who = 1) => async (H) => { for (const b of bpms) { await sleep(every); await H.pages[who].evaluate((b) => JJ.setTempo(b), b); } };
const drumPost = async (H) => { H.flow.drummer = await compareBand(H); };
add({ id: 'fu-tempo-noloss', group: 'followup', title: 'tempo storm with a drummer, 40 ms, no loss', lag: [[40, 8], [40, 8], [60, 10]], players: [], sec: 14, setup: drumSetup(), flow: tempoFlow([120, 84, 140, 100, 132, 90, 110, 96]), post: drumPost });
add({ id: 'fu-tempo-zero', group: 'followup', title: 'tempo storm with a drummer, no simulated network', lag: [[0, 0], [0, 0]], players: [], sec: 14, setup: drumSetup(), flow: tempoFlow([120, 84, 140, 100, 132, 90, 110, 96]), post: drumPost });
add({ id: 'fu-tempo-leader', group: 'followup', title: 'tempo storm from the leader, drummer, 40 ms', lag: [[40, 8], [40, 8]], players: [], sec: 14, setup: drumSetup(), flow: tempoFlow([120, 84, 140, 100, 132, 90, 110, 96], 1500, 0), post: drumPost });
add({ id: 'fu-tempo-one', group: 'followup', title: 'one tempo change, drummer, 40 ms', lag: [[40, 8], [40, 8]], players: [], sec: 12, setup: drumSetup(), flow: tempoFlow([120], 4000), post: drumPost });
add({ id: 'fu-drum-loss', group: 'followup', title: 'drummer, 40 ms, 2% loss, steady tempo', lag: [[40, 8, 0.02], [40, 8, 0.02]], players: [], sec: 14, setup: drumSetup(), post: drumPost });
add({ id: 'fu-drum-steady', group: 'followup', title: 'drummer, 40 ms, steady tempo (control)', lag: [[40, 8], [40, 8]], players: [], sec: 14, setup: drumSetup(), post: drumPost });
add({ id: 'fu-seq-noloss', group: 'followup', title: "Machina's sequencer edited live, 60 ms, no loss (control)", lag: [[60, 10], [60, 10]], players: [], sec: 14,
  setup: S.find((x) => x.id === 'flow-seq-loss').setup, flow: S.find((x) => x.id === 'flow-seq-loss').flow, post: S.find((x) => x.id === 'flow-seq-loss').post });
add({ id: 'fu-spike-long', group: 'followup', title: 'a 300 ms spike for 4 s, watched for 20 s after', lag: [[30, 6], [30, 6]], sec: 30, rate: 6, timeout: 300,
  flow: async (H) => {
    const trace = []; const t0 = Date.now(); const tick = setInterval(async () => { try { trace.push([Date.now() - t0, Math.round(await H.pages[0].evaluate(() => JJ.S.lookAuto))]); } catch (_) {} }, 250);
    await sleep(4000); await H.pages[1].evaluate(() => { JJ.room.lag = { ms: 300, jitter: 30, loss: 0 }; });
    await sleep(4000); await H.pages[1].evaluate(() => { JJ.room.lag = { ms: 30, jitter: 6, loss: 0 }; });
    await sleep(20000); clearInterval(tick);
    const peak = Math.max(...trace.map((x) => x[1])), after = trace.filter((x) => x[0] > 8000);
    const back = after.find((x) => x[1] < 120); H.flow.spike = { peak, recoverMs: back ? back[0] - 8000 : null, Lat8s: after[0]?.[1], Lat18s: after.find((x) => x[0] > 18000)?.[1], Lat28s: after[after.length - 1]?.[1], trace: trace.filter((_, i) => i % 4 === 0) };
  } });
add({ id: 'fu-relay-dies-long', group: 'followup', title: 'the handshake server dies for 6 s, watched for 25 s after', lag: [[30, 6], [30, 6]], sec: 36, rate: 6, timeout: 300,
  flow: async (H) => {
    await sleep(4000); const root = path.resolve(__dirname, '../..');
    try { execSync("pkill -f '^node server/dev.js'"); } catch (_) {}
    await sleep(6000); const child = spawn('node', ['server/dev.js'], { cwd: root, detached: true, stdio: 'ignore' }); child.unref();
    const snap = async () => Promise.all(H.pages.map((p) => p.evaluate(() => ({ me: JJ.S.me, players: JJ.S.players.size, peers: [...JJ.room.peers.values()].map((x) => `${x.id}:${x.path}`) }))));
    H.flow.at3s = (await sleep(3000), await snap()); H.flow.at10s = (await sleep(7000), await snap()); H.flow.at22s = (await sleep(12000), await snap());
    // notes heard from each other in the last 8 s
    H.flow.recentHeard = await Promise.all(H.pages.map((p) => p.evaluate(() => { const t = JJ.clock.now() - 8000; const me = JJ.S.me; return JJ.engine.log.filter((e) => e.type === 'on' && !e.pid.startsWith(me + ':') && e.at > t).length; })));
  } });
add({ id: 'fu-leave-tempo', group: 'followup', title: 'the leader leaves, and a follower changes the tempo 2 s later', lag: [[30, 6], [30, 6], [30, 6]], players: [1, 2], sec: 14,
  flow: async (H) => {
    await sleep(3000); await H.pages[0].click('#leaveBtn'); await sleep(2000);
    await H.pages[1].evaluate(() => JJ.setTempo(130)); await sleep(3000);
    H.flow.bpm5sLater = await Promise.all([1, 2].map((k) => H.pages[k].evaluate(() => JJ.tempo.bpm(JJ.clock.now() + 1000))));
    H.flow.cornerStill = await H.pages[1].evaluate(() => [...JJ.S.players.values()].map((p) => p.name));
  } });
for (const id of ['asym-20-80', 'relay-80-loss', 'cpu-slow-phone', 'flow-tempo-storm', 'flow-relay-dies']) { const o = S.find((x) => x.id === id); add({ ...o, id: id + '-r2', group: 'repeat' }); add({ ...o, id: id + '-r3', group: 'repeat' }); }

add({ id: 'fu-leave-tempo-long', group: 'followup', title: 'the leader leaves, a follower changes the tempo 2 s later; checked 5 s and 20 s on', lag: [[30, 6], [30, 6], [30, 6]], players: [1, 2], sec: 26, timeout: 300,
  flow: async (H) => {
    await sleep(3000); await H.pages[0].click('#leaveBtn'); await sleep(2000);
    await H.pages[1].evaluate(() => JJ.setTempo(130));
    const bpm = () => Promise.all([1, 2].map((k) => H.pages[k].evaluate(() => JJ.tempo.bpm(JJ.clock.now() + 1000))));
    await sleep(5000); H.flow.bpmAt5s = await bpm(); await sleep(15000); H.flow.bpmAt20s = await bpm();
    H.flow.leaders = await Promise.all([1, 2].map((k) => H.pages[k].evaluate(() => JJ.clock.isLeader)));
  } });
// a computer whose own clock is off: the wall-clock help must ignore it when it's far off, and stay within it otherwise
const skewDate = (ms) => `(() => { const real = Date.now.bind(Date); const off = ${ms}; Date.now = () => real() + off; })()`;
add({ id: 'osclock-off-200', group: 'osclock', title: "20/80 ms route, the follower's computer clock 200 ms off", lag: [[20, 4], [80, 8]], init: [null, skewDate(200)] });
add({ id: 'osclock-off-15', group: 'osclock', title: "20/80 ms route, the follower's computer clock 15 ms off", lag: [[20, 4], [80, 8]], init: [null, skewDate(15)] });
add({ id: 'osclock-off-0-asym', group: 'osclock', title: '10/200 ms route, computer clocks agree', lag: [[10, 2], [200, 20]] });
add({ ...S.find((x) => x.id === 'lat-50'), id: 'lat-50-r2', group: 'repeat' }); add({ ...S.find((x) => x.id === 'lat-50'), id: 'lat-50-r3', group: 'repeat' });
module.exports = S;
