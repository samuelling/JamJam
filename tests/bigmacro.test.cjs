// Big Macro (the Plaits DSP as a six-voice instrument): every model sounds offline and live with no NaN; A4 is 440 Hz at
// 48 kHz and at 44.1 kHz (the resampled path); a noisy model renders the same twice; it sits near Juniper's level;
// six held voices render well faster than realtime; and the app loads it with its credit.
//   node server/dev.js &   then   node tests/bigmacro.test.cjs [baseUrl]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787/';
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(BASE);
    const r = await page.evaluate(async () => {
      const load = async (f) => (await import(URL.createObjectURL(new Blob([await (await fetch('instruments/' + f)).text()], { type: 'text/javascript' })))).default;
      const K = await load('bigmacro.js'), J = await load('juniper.js');
      const defaults = (mod, over) => { const p = {}; for (const d of mod.params) p[d.id] = d.def; return Object.assign(p, over); };
      // render notes [[note, vel, on, off]] offline; returns channels and how fast it rendered
      const render = async (mod, params, notes, { sr = 48000, dur = 2, at } = {}) => {
        const ctx = new OfflineAudioContext(2, Math.round(sr * dur), sr);
        await mod.init(ctx, params);
        const inst = mod.create(ctx, ctx.destination, params);
        for (const [n, v, on, off] of notes) { inst.noteOn(n, v, on, at ? at + on * 1000 : undefined); if (off != null) inst.noteOff(n, off); }
        ctx.suspend(256 / sr).then(async () => { await new Promise((x) => setTimeout(x, 80)); ctx.resume(); });
        const t0 = performance.now(), buf = await ctx.startRendering();
        return { L: buf.getChannelData(0), R: buf.getChannelData(1), speed: (dur * 1000) / (performance.now() - t0), sr };
      };
      const stats = (b, from = 0) => { let pk = 0, ss = 0, bad = 0; for (let i = Math.floor(from * b.sr); i < b.L.length; i++) { const x = b.L[i], y = b.R[i]; if (!Number.isFinite(x) || !Number.isFinite(y)) { bad++; continue; } pk = Math.max(pk, Math.abs(x), Math.abs(y)); ss += x * x + y * y; } return { pk, rms: Math.sqrt(ss / (2 * b.L.length)), bad }; };
      const freq = (b, from, to) => { const s = b.L.subarray(Math.floor(from * b.sr), Math.floor(to * b.sr)), z = []; for (let i = 1; i < s.length; i++) if (s[i - 1] < 0 && s[i] >= 0) z.push(i - 1 + -s[i - 1] / (s[i] - s[i - 1])); return (b.sr * (z.length - 1)) / (z[z.length - 1] - z[0]); };
      const out = { models: [] };
      // every model, a held note (gate Hold) and a pinged one
      const names = K.params.find((p) => p.id === 'model').options;
      for (let m = 0; m < names.length; m++) {
        const b = await render(K, defaults(K, { model: m, gate: 1 }), [[48, 100, 0.05, 0.6], [55, 90, 0.1, 0.6], [62, 80, 0.7, 1.2]], { dur: 1.5 });
        out.models.push({ name: names[m], ...stats(b), speed: b.speed });
      }
      // tuning: two-op FM with no modulation is a sine
      const sine = { model: names.indexOf('Two-op FM'), harmonics: 0, timbre: 0, morph: 0, gate: 1, colour: 0, decay: 1 };
      out.f48 = freq(await render(K, defaults(K, sine), [[69, 100, 0.05, 1.9]]), 0.5, 1.5);
      out.f44 = freq(await render(K, defaults(K, sine), [[69, 100, 0.05, 1.9]], { sr: 44100 }), 0.5, 1.5);
      // determinism with a noisy model, seeded from room time
      const noisy = defaults(K, { model: names.indexOf('Particle noise'), gate: 1 }), nn = [[60, 100, 0.05, 1], [67, 90, 0.3, 1]];
      const a = await render(K, noisy, nn, { at: 123456 }), b2 = await render(K, noisy, nn, { at: 123456 }), c = await render(K, noisy, nn, { at: 999999 });
      let d1 = 0, d2 = 0; for (let i = 0; i < a.L.length; i++) { d1 = Math.max(d1, Math.abs(a.L[i] - b2.L[i])); d2 = Math.max(d2, Math.abs(a.L[i] - c.L[i])); }
      out.same = d1; out.otherSeed = d2;
      // level next to Juniper: the same six-note chord on each pad preset
      const chord = [48, 55, 60, 64, 67, 72].map((n, i) => [n, 100, 0.05 + i * 0.02, 1.5]);
      out.kPk = stats(await render(K, defaults(K, K.presets.pad), chord)).pk;
      out.jPk = stats(await render(J, defaults(J, J.presets.pad), chord)).pk;
      // CPU: six held voices for five seconds, the cheapest and the heaviest models
      const six = [36, 43, 48, 55, 60, 67].map((n) => [n, 100, 0.05, 4.9]);
      out.speedVA = (await render(K, defaults(K, { model: 0, gate: 1 }), six, { dur: 5 })).speed;
      out.speedModal = (await render(K, defaults(K, { model: names.indexOf('Modal resonator'), gate: 1 }), six, { dur: 5 })).speed;
      // live: a real AudioContext through an analyser
      const ctx = new AudioContext({ sampleRate: 48000 }); await ctx.resume();
      await K.init(ctx); const an = ctx.createAnalyser(); an.fftSize = 2048; an.connect(ctx.destination);
      const live = K.create(ctx, an, defaults(K, { model: 0, gate: 1 })), t = ctx.currentTime + 0.05;
      live.noteOn(57, 110, t, Date.now()); live.noteOn(64, 100, t, Date.now());
      await new Promise((x) => setTimeout(x, 400));
      const buf = new Float32Array(2048); an.getFloatTimeDomainData(buf); let lr = 0, lbad = 0; for (const x of buf) { if (!Number.isFinite(x)) lbad++; else lr += x * x; }
      out.liveRms = Math.sqrt(lr / buf.length); out.liveBad = lbad; live.allOff(ctx.currentTime); live.dispose(); await ctx.close();
      return out;
    });
    for (const m of r.models) {
      console.log(`  ${m.name.padEnd(20)} peak ${m.pk.toFixed(2)}  rms ${m.rms.toFixed(3)}  ${m.speed.toFixed(0)}× realtime`);
      check(m.bad === 0 && m.rms > 0.003 && m.pk < 1.2, `${m.name}: sounds, no NaN, peak under 1.2`);
    }
    const cents = (f) => 1200 * Math.log2(f / 440);
    check(Math.abs(cents(r.f48)) < 3, `A4 at 48 kHz: ${r.f48.toFixed(2)} Hz (${cents(r.f48).toFixed(2)} cents)`);
    check(Math.abs(cents(r.f44)) < 3, `A4 at 44.1 kHz, resampled: ${r.f44.toFixed(2)} Hz (${cents(r.f44).toFixed(2)} cents)`);
    check(r.same < 1e-6 && r.otherSeed > 1e-3, `a noisy model renders the same for the same room time (${r.same.toExponential(1)}), differently for another (${r.otherSeed.toFixed(3)})`);
    check(r.kPk > r.jPk / 2.5 && r.kPk < r.jPk * 2.5, `level near Juniper's: pad chord peak ${r.kPk.toFixed(2)} vs ${r.jPk.toFixed(2)}`);
    check(r.speedVA > 8, `six held virtual-analog voices render ${r.speedVA.toFixed(1)}× realtime`);
    check(r.speedModal > 3, `six held modal notes (three voices sound) render ${r.speedModal.toFixed(1)}× realtime`);
    check(r.liveBad === 0 && r.liveRms > 0.01, `plays live in a real AudioContext (rms ${r.liveRms.toFixed(3)})`);

    // the app loads it, credited
    await page.goto(BASE + '?lag=30&empty=1'); await page.fill('#nameIn', 'Sam'); await page.click('#startBtn'); await page.waitForSelector('#studio:not(.hide)');
    const def = await page.evaluate(async () => { for (let i = 0; i < 50 && !JJ.engine.defs.get('bigmacro'); i++) await new Promise((x) => setTimeout(x, 100)); const d = JJ.engine.defs.get('bigmacro'); return d && { by: d.by, lineage: d.lineage, name: d.name, n: d.presets && Object.keys(d.presets).length }; });
    check(def && def.by === 'Émilie Gillet' && /Plaits.*MIT/.test(def.lineage) && def.name === 'Big Macro', `the app loads Big Macro, credited (${JSON.stringify(def)})`);
    check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally { await browser.close(); }
  console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
