// Tapestry, the tape-replay keyboard: every recording sounds and differs (spectral centroid), levels sit with the
// other keyboards, a held note runs out at the tape's end (and doesn't on an optical disc), the Chord setting plays
// a chord from one key, the Strings strum... and it all renders fast enough with 6 notes held.
//   node server/dev.js &   then   node tests/tapestry.test.cjs [baseUrl]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787/';
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  const r = await page.evaluate(async () => {
    const SR = 48000;
    const load = async (f) => (await import(URL.createObjectURL(new Blob([await (await fetch('instruments/' + f)).text()], { type: 'text/javascript' })))).default;
    const T = await load('tapestry.js');
    const render = async (mod, patch, over, dur, play) => {
      const params = {}; for (const p of mod.params) params[p.id] = p.def; Object.assign(params, mod.presets[patch] || {}, over || {});
      const ctx = new OfflineAudioContext(2, SR * dur, SR);
      if (mod.init) await mod.init(ctx, params);
      const inst = mod.create(ctx, ctx.destination, params);
      play(inst);
      ctx.suspend(256 / SR).then(async () => { await new Promise((res) => setTimeout(res, 80)); ctx.resume(); });
      const t0 = performance.now(); const buf = await ctx.startRendering(); const ms = performance.now() - t0;
      return { L: buf.getChannelData(0), ms, dur };
    };
    const rms = (L, a, b) => { let s = 0; const i0 = Math.round(a * SR), i1 = Math.round(b * SR); for (let i = i0; i < i1; i++) s += L[i] * L[i]; return Math.sqrt(s / (i1 - i0)); };
    const peak = (L) => { let p = 0, bad = 0; for (const x of L) { if (!Number.isFinite(x)) bad++; else p = Math.max(p, Math.abs(x)); } return { p, bad }; };
    // spectral centroid of 4096 samples from `at` (a plain DFT over a few bins is enough for a proxy)
    const centroid = (L, at) => {
      const N = 4096, i0 = Math.round(at * SR); let num = 0, den = 0;
      for (let k = 2; k < 400; k += 2) { let re = 0, im = 0; const w = (2 * Math.PI * k) / N; for (let n = 0; n < N; n += 2) { const x = L[i0 + n] * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N)); re += x * Math.cos(w * n); im -= x * Math.sin(w * n); } const m = Math.hypot(re, im); num += m * (k * SR / N); den += m; }
      return num / den;
    };
    const goertzel = (L, at, len, f) => { const i0 = Math.round(at * SR), N = Math.round(len * SR), c = 2 * Math.cos((2 * Math.PI * f) / SR); let s1 = 0, s2 = 0; for (let n = 0; n < N; n++) { const s = L[i0 + n] + c * s1 - s2; s2 = s1; s1 = s; } return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / N; };
    const out = { patches: {} };
    const chordPlay = (inst) => { [48, 55, 60, 64, 67, 72].forEach((n, i) => { inst.noteOn(n, 90, 0.05 + i * 0.1); inst.noteOff(n, 2.2); }); };
    for (const patch of Object.keys(T.presets)) {
      const a = await render(T, patch, null, 3, chordPlay), a2 = await render(T, patch, null, 3, chordPlay), pk = peak(a.L);   // the faster of two renders: the machine may be busy
      const one = await render(T, patch, { chord: 0 }, 1.5, (inst) => { inst.noteOn(60, 100, 0.05); inst.noteOff(60, 1.4); });
      out.patches[patch] = { peak: pk.p, bad: pk.bad, rms: rms(a.L, 0.5, 2), speed: (a.dur * 1000) / Math.min(a.ms, a2.ms), centroid: centroid(one.L, 0.6) };
    }
    // levels against the other keyboards, same notes
    out.ref = {};
    for (const [f, patch] of [['tine.js', 'keys'], ['juniper.js', 'strings'], ['tonewheel.js', 'jazz']]) { const m = await load(f); const a = await render(m, patch, null, 3, chordPlay); out.ref[f + '/' + patch] = rms(a.L, 0.5, 2); }
    // the tape's end: a 12 s hold on an 8 s tape goes quiet; the optical disc loops on
    const held = async (over) => { const a = await render(T, 'strings', over, 12, (inst) => { inst.noteOn(60, 100, 0.05); inst.noteOff(60, 11.8); }); return { early: rms(a.L, 1, 3), mid: rms(a.L, 4.5, 6), late: rms(a.L, 9, 11) }; };
    out.tape = await held({}); out.short = await held({ length: 4 }); out.disc = await held({ medium: 1 });
    // Chord: one key plays a major chord (the E above C shows up); Single doesn't
    const ch = async (chord) => { const a = await render(T, 'chordorgan', { chord }, 1.2, (inst) => { inst.noteOn(60, 100, 0.05); inst.noteOff(60, 1.1); }); return goertzel(a.L, 0.4, 0.5, 440 * Math.pow(2, (64 - 69) / 12)) / (goertzel(a.L, 0.4, 0.5, 440 * Math.pow(2, (60 - 69) / 12)) + 1e-9); };
    out.chordE = await ch(1); out.singleE = await ch(0);
    // a release lifts the pad quickly
    const rel = await render(T, 'strings', null, 2, (inst) => { inst.noteOn(60, 100, 0.05); inst.noteOff(60, 1); });
    out.afterRelease = rms(rel.L, 1.6, 1.9); out.beforeRelease = rms(rel.L, 0.6, 0.9);
    return out;
  });
  for (const [p, x] of Object.entries(r.patches)) {
    const tag = `tapestry/${p}`.padEnd(22);
    console.log(`  ${tag} peak ${x.peak.toFixed(2)}  rms ${x.rms.toFixed(3)}  centroid ${x.centroid.toFixed(0)} Hz  ${x.speed.toFixed(0)}× realtime`);
    check(x.bad === 0 && x.rms > 0.01 && x.peak < 1, `${tag} sounds, no NaN, peak under 1`);
    check(x.speed > 3, `${tag} renders 6 held notes at least 3× faster than realtime`);
  }
  const refs = Object.values(r.ref), lo = Math.min(...refs) / 2.5, hi = Math.max(...refs) * 2.5;
  console.log('  reference rms', JSON.stringify(Object.fromEntries(Object.entries(r.ref).map(([k, v]) => [k, +v.toFixed(3)]))));
  check(Object.values(r.patches).every((x) => x.rms > lo && x.rms < hi), `every patch sits within 8 dB of the other keyboards (${lo.toFixed(3)}..${hi.toFixed(3)})`);
  const cents = ['strings', 'flute', 'choir', 'cello', 'brass', 'vibes'].map((p) => r.patches[p].centroid).sort((a, b) => a - b);
  const minGap = Math.min(...cents.slice(1).map((c, i) => c / cents[i]));
  check(minGap > 1.03, `the six tape recordings differ in brightness (centroids ${cents.map(Math.round).join(', ')} Hz)`);
  check(r.tape.mid > 0.02 && r.tape.late < r.tape.mid * 0.02, `an 8 s tape runs out on a 12 s hold (${r.tape.mid.toFixed(3)} → ${r.tape.late.toFixed(4)})`);
  check(r.short.early > 0.02 && r.short.mid < r.tape.mid * 0.02, `a 4 s tape sounds, then has run out by 4.5 s (${r.short.early.toFixed(3)} → ${r.short.mid.toFixed(4)})`);
  check(r.disc.late > r.disc.mid * 0.5, `an optical disc loops on (${r.disc.mid.toFixed(3)} → ${r.disc.late.toFixed(3)})`);
  check(r.chordE > 0.3 && r.singleE < 0.1, `Chord plays a major chord from one key (E/C ${r.chordE.toFixed(2)} vs single ${r.singleE.toFixed(2)})`);
  check(r.afterRelease < r.beforeRelease * 0.02, `letting go lifts the pad quickly (${r.beforeRelease.toFixed(3)} → ${r.afterRelease.toFixed(4)})`);
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
