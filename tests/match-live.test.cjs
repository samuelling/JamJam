// Live "Match my sound", end to end. Sam brings a Minimoog (the twin is Monolith). His "Minimoog" here is a hidden
// Monolith with different settings, played by MEGAjam's MIDI out (mock port) and heard 30 ms late through a fake
// audio input. While he plays single notes, the matcher measures the input's latency, learns from the notes, and
// glides the twin toward the hidden synth; Matt's browser receives the same glides.
//   node server/dev.js &  (8787)        node tests/match-live.test.cjs
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const mk = async (q, name) => { const c = await browser.newContext(); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?midimock=1&lag=20&matchfast=1', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=20`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1))); if (ok.every(Boolean)) break; await sleep(300); }

    // the hidden "real" synth: a Monolith set up differently, heard through a fake audio input 30 ms late
    const r = await A.evaluate(async () => {
      await JJ.enableMIDI();
      const ctx = JJ.engine.ctx, def = JJ.engine.defs.get('monolith'), dest = ctx.createMediaStreamDestination();
      const secret = {}; for (const P of def.params) secret[P.id] = P.def; Object.assign(secret, def.presets.lead, { cutoff: 3200, emphasis: 0.15, contour: 0.2, decay: 0.25, sustain: 0.35, release: 0.08, mix2: 0, mix3: 0, osc1Wave: 4 });
      const g = ctx.createGain(); g.gain.value = 0.8; g.connect(dest);
      const hw = def.create(ctx, g, secret);
      window.__secret = secret;
      const port = JJ.input.outputs[0], send = port.send.bind(port);
      port.send = (data, ts) => { send(data, ts); const t = ctx.currentTime + Math.max(0, ((ts ?? performance.now()) - performance.now()) / 1000) + 0.03; if ((data[0] & 0xf0) === 0x90 && data[2]) hw.noteOn(data[1], data[2], t); else if ((data[0] & 0xf0) === 0x80 || (data[0] & 0xf0) === 0x90) hw.noteOff(data[1], t); };
      navigator.mediaDevices.getUserMedia = async () => dest.stream;
      const e = JJ.addHardware('moog-minimoog-d', 'monolith'); e.midiOut = port.id; e.budget = 'balanced';
      JJ.select(e.r);
      return e.r;
    });
    await sleep(800);
    await A.evaluate((r) => JJ.match(r, true), r);
    const play = () => A.evaluate(async () => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); for (const n of [45, 52, 57, 48, 55, 60, 50, 57]) { JJ.input.press(n, 100); await s(520); JJ.input.release(n); await s(480); } });
    const s0 = await A.evaluate((r) => JJ.matchState(r), r);
    await play();
    let st;
    for (let i = 0; i < 40; i++) { await sleep(1000); st = await A.evaluate((r) => JJ.matchState(r), r); if (st.applied && st.renders > 60) break; }
    await play();
    for (let i = 0; i < 30; i++) { await sleep(1000); st = await A.evaluate((r) => JJ.matchState(r), r); if (st.renders > 140) break; }
    check(st.obs >= 4, `the matcher learned from the single notes (${st.obs} kept; skipped: ${JSON.stringify(st.why || {})})`);
    check(st.lag != null && st.lag >= 25 && st.lag <= 130, `it measured the input's latency (${st.lag} ms: the synth's 30 ms plus the browser's own output latency)`);
    check(st.applied > 0, `it glided the twin toward the hardware (fit distance ${st.d.toFixed(2)}, ${st.renders} note renders, ${(st.ms / st.renders).toFixed(0)} ms each)`);
    const moved = await A.evaluate((r) => { const p = JJ.matchState(r).params, s = window.__secret, def = JJ.engine.defs.get('monolith'), base = {}; for (const P of def.params) base[P.id] = P.def; Object.assign(base, def.presets.lead);
      const n = (P, v) => (P.curve === 'exp' ? Math.log(v / P.min) / Math.log(P.max / P.min) : (v - P.min) / (P.max - P.min));
      let before = 0, after = 0; const ids = ['cutoff', 'emphasis', 'contour', 'decay', 'sustain', 'release', 'mix2', 'mix3'];
      for (const id of ids) { const P = def.params.find((x) => x.id === id); before += Math.abs(n(P, base[id]) - n(P, s[id])); after += Math.abs(n(P, p[id]) - n(P, s[id])); }
      return { before: before / ids.length, after: after / ids.length }; }, r);
    console.log('   score of the hidden synth\'s own settings:', (await A.evaluate((r) => JJ.matchScore(r, window.__secret), r)).toFixed(2), ' of the starting twin:', (await A.evaluate((r) => { const def = JJ.engine.defs.get('monolith'), base = {}; for (const P of def.params) base[P.id] = P.def; Object.assign(base, def.presets.lead); return JJ.matchScore(r, base); }, r)).toFixed(2));
    console.log('   obs:', JSON.stringify((await A.evaluate((r) => JJ.matchObs(r), r)).slice(0, 2)));
    console.log('   changed:', await A.evaluate((r) => { const p = JJ.matchState(r).params, def = JJ.engine.defs.get('monolith'), base = {}; for (const P of def.params) base[P.id] = P.def; Object.assign(base, def.presets.lead); const s = window.__secret; return def.params.filter((P) => Math.abs((p[P.id] ?? 0) - (base[P.id] ?? 0)) > 1e-6).map((P) => `${P.id} ${+base[P.id].toFixed(3)}→${+p[P.id].toFixed(3)} (hw ${+s[P.id].toFixed(3)})`).join(', '); }, r));
    const sc = await A.evaluate(async (r) => { const def = JJ.engine.defs.get('monolith'), base = {}; for (const P of def.params) base[P.id] = P.def; Object.assign(base, def.presets.lead); return { base: await JJ.matchScore(r, base), now: await JJ.matchScore(r, JJ.matchState(r).params), hidden: await JJ.matchScore(r, window.__secret) }; }, r);
    check(sc.now < sc.base * 0.85, `the twin now sounds closer to the hardware (distance ${sc.base.toFixed(2)} → ${sc.now.toFixed(2)}; the hidden synth's own settings score ${sc.hidden.toFixed(2)})`);
    console.log(`   settings, mean distance to the hidden synth's over eight knobs: ${moved.before.toFixed(2)} → ${moved.after.toFixed(2)}`);
    await A.evaluate((r) => JJ.match(r, false), r); await sleep(2500);   // let the last glide land
    const aP = await A.evaluate((r) => JSON.stringify(JJ.matchState(r).params), r);
    const bP = await B.evaluate(() => { for (const [, pl] of JJ.S.players) for (const x of pl.rack) if (x.cfg.hw === 'moog-minimoog-d') return JSON.stringify(x.cfg.params); return null; });
    check(bP && JSON.stringify(JSON.parse(aP)) === JSON.stringify(JSON.parse(bP)), "Matt's copy of the twin has exactly the same settings");
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } catch (e) { console.error(e); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
