// Renders every preset of every instrument offline (OfflineAudioContext, same code path as live) and checks:
// it makes sound, no NaN/Inf, sane peak level, identical output on a second render (determinism), and render speed.
//   node server/dev.js &   then   node tests/instruments.test.cjs [baseUrl]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8790/';
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  const results = await page.evaluate(async () => {
    const man = await (await fetch('instruments/index.json')).json();
    const out = [];
    const SR = 48000, DUR = 3;
    for (const it of man.instruments) {
      const src = await (await fetch('instruments/' + it.file)).text();
      const mod = (await import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))).default;
      for (const patch of Object.keys(mod.presets)) {
        const params = {};
        for (const p of mod.params) params[p.id] = p.def;
        Object.assign(params, mod.presets[patch]);
        const render = async () => {
          const ctx = new OfflineAudioContext(2, SR * DUR, SR);
          if (mod.init) await mod.init(ctx);
          const inst = mod.create(ctx, ctx.destination, params);
          const notes = mod.drums ? [36, 38, 42, 39, 46, 45, 49, 37, 56, 64, 42, 36] : [48, 55, 60, 64, 67, 72];
          notes.forEach((n, i) => {
            const t = 0.05 + i * (mod.drums ? 0.2 : 0.12);
            inst.noteOn(n, 70 + (i * 13) % 57, t);
            inst.noteOff(n, mod.drums ? t + 0.05 : 1.6);
          });
          inst.set(mod.params.find((p) => p.cc === 74)?.id || mod.params[0].id, mod.params.find((p) => p.cc === 74) ? params[mod.params.find((p) => p.cc === 74).id] * 0.6 : params[mod.params[0].id], 0.9);
          // let the timestamped messages reach the worklet thread before the (faster than realtime) render runs
          ctx.suspend(256 / SR).then(async () => { await new Promise((r) => setTimeout(r, 80)); ctx.resume(); });
          const t0 = performance.now();
          const buf = await ctx.startRendering();
          const ms = performance.now() - t0;
          return { buf, ms };
        };
        const a = await render(), b = await render();
        const L = a.buf.getChannelData(0), R = a.buf.getChannelData(1), L2 = b.buf.getChannelData(0);
        let peak = 0, sum = 0, bad = 0, diff = 0;
        for (let i = 0; i < L.length; i++) {
          const x = L[i], y = R[i];
          if (!Number.isFinite(x) || !Number.isFinite(y)) { bad++; continue; }
          peak = Math.max(peak, Math.abs(x), Math.abs(y)); sum += x * x + y * y;
          diff = Math.max(diff, Math.abs(x - L2[i]));
        }
        out.push({ inst: it.id, patch, peak, rms: Math.sqrt(sum / (2 * L.length)), bad, diff, speed: (DUR * 1000) / a.ms });
      }
    }
    return out;
  });
  for (const r of results) {
    const tag = `${r.inst}/${r.patch}`.padEnd(20);
    console.log(`  ${tag} peak ${r.peak.toFixed(2)}  rms ${r.rms.toFixed(3)}  ${r.speed.toFixed(0)}× realtime  diff ${r.diff.toExponential(1)}`);
    check(r.bad === 0, `${tag} no NaN/Inf`);
    check(r.rms > 0.005, `${tag} makes sound`);
    check(r.peak < 1.2, `${tag} peak under 1.2`);
    check(r.diff < 1e-4, `${tag} renders identically twice (within float rounding)`);
    check(r.speed > 3, `${tag} renders at least 3× faster than realtime`);
  }
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
