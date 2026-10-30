// Wobbler: the wobble is clock-synced and the key picks its speed. Renders offline with a room clock at 140 bpm and
// measures the wobble's rate from the output's loudness envelope (its strongest modulation between 1 and 14 Hz):
//   Octave mode: C2 wobbles at 1/4 (2.33 Hz), C3 at 1/8 (4.67 Hz), twice as fast
//   Keys mode: each key its own division; Fixed: every key the same
//   locked to the beat: two notes started at different moments wobble in step; restart-on-note: they're offset
//   no room clock: the BPM knob runs it; no NaN; level close to Monolith's
//   node server/dev.js &   then   node tests/wobbler.test.cjs [baseUrl]
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
  const R = await page.evaluate(async () => {
    const load = async (f) => (await import(URL.createObjectURL(new Blob([await (await fetch('instruments/' + f)).text()], { type: 'text/javascript' })))).default;
    const W = await load('wobbler.js'), M = await load('monolith.js');
    const SR = 48000, DUR = 4;
    const env140 = { roomTime: (t) => t * 1000, beatAt: (ms) => (ms / 1000) * 140 / 60, bpm: () => 140, timeOf: (b) => (b * 60000) / 140, audioTime: (ms) => ms / 1000 };
    async function render(mod, over, notes, env) {
      const params = {}; for (const p of mod.params) params[p.id] = p.def; Object.assign(params, over);
      const ctx = new OfflineAudioContext(2, SR * DUR, SR);
      await mod.init(ctx);
      const inst = mod.create(ctx, ctx.destination, params, env);
      for (const [n, t0, t1] of notes) { inst.noteOn(n, 100, t0); inst.noteOff(n, t1); }
      ctx.suspend(256 / SR).then(async () => { await new Promise((r) => setTimeout(r, 80)); ctx.resume(); });
      return (await ctx.startRendering()).getChannelData(0);
    }
    // loudness envelope in 5 ms frames
    const envOf = (x, from, to) => { const hop = SR / 200, out = []; for (let i = Math.floor(from * SR); i + hop <= to * SR; i += hop) { let s = 0; for (let k = 0; k < hop; k++) s += x[i + k] * x[i + k]; out.push(Math.sqrt(s / hop)); } return out; };
    const rate = (x, from = 0.6, to = 3.6) => {
      const e = envOf(x, from, to), m = e.reduce((a, b) => a + b, 0) / e.length; let best = 0, bf = 0;
      for (let f = 1; f <= 14; f += 0.01) { let re = 0, im = 0; e.forEach((v, i) => { const a = (2 * Math.PI * f * i) / 200; re += (v - m) * Math.cos(a); im += (v - m) * Math.sin(a); }); const p = re * re + im * im; if (p > best) { best = p; bf = f; } }
      return bf;
    };
    const finite = (x) => x.every(Number.isFinite);
    const peak = (x) => x.reduce((a, v) => Math.max(a, Math.abs(v)), 0);
    const out = {};
    const c2 = await render(W, {}, [[36, 0.1, 3.8]], env140), c3 = await render(W, {}, [[48, 0.1, 3.8]], env140);
    out.oct = [rate(c2), rate(c3)];
    out.keys = [rate(await render(W, { map: 1 }, [[24 + 7, 0.1, 3.8]], env140)), rate(await render(W, { map: 1 }, [[24 + 9, 0.1, 3.8]], env140))];
    out.fixed = [rate(await render(W, { map: 2, rate: 4 }, [[36, 0.1, 3.8]], env140)), rate(await render(W, { map: 2, rate: 4 }, [[60, 0.1, 3.8]], env140))];
    // locked vs restart: the same note started 0.1 s and 0.37 s in; compare their envelopes after both have started
    const a = await render(W, {}, [[36, 0.1, 3.8]], env140), b = await render(W, {}, [[36, 0.37, 3.8]], env140);
    const ra = await render(W, { retrig: 1 }, [[36, 0.1, 3.8]], env140), rb = await render(W, { retrig: 1 }, [[36, 0.37, 3.8]], env140);
    // the phase of the wobble (at its 1/4 rate) measured on the room's clock, from 0.8 s on, when both have started
    const phase = (x) => { const e = envOf(x, 0.8, 3.6), f = 140 / 60; let re = 0, im = 0; e.forEach((v, i) => { const t = 0.8 + i / 200; re += v * Math.cos(2 * Math.PI * f * t); im += v * Math.sin(2 * Math.PI * f * t); }); return Math.atan2(im, re); };
    const dph = (p, q) => { let d = Math.abs(p - q) % (2 * Math.PI); return Math.min(d, 2 * Math.PI - d) / (2 * Math.PI); };   // in cycles, 0..0.5
    out.locked = dph(phase(a), phase(b)); out.restart = dph(phase(ra), phase(rb));
    out.noclock = rate(await render(W, { bpm: 120 }, [[48, 0.1, 3.8]]));
    out.finite = true; out.peaks = {};
    for (const k of Object.keys(W.presets)) { const x = await render(W, W.presets[k], [[36, 0.1, 1.6], [43, 1.7, 2.6], [48, 2.7, 3.6]], env140); out.finite = out.finite && finite(x); out.peaks[k] = peak(x); }
    out.mono = peak(await render(M, M.presets.bass, [[36, 0.1, 1.6], [43, 1.7, 2.6], [48, 2.7, 3.6]]));
    // the octave switch and the sub: plain notes (A2 = 110 Hz for the oscillators, A3 = 220 Hz over the sub), nothing wobbling, counted by rising zero crossings
    const zc = (x, from = 1, to = 3) => { let n = 0, prev = 0, lp = 0; for (let i = Math.floor(from * SR); i < to * SR; i++) { lp += (x[i] - lp) * 0.02; if (prev <= 0 && lp > 0) n++; prev = lp; } return n / (to - from); };
    const flat = { depth: 0, ampWub: 0, growl: 0, cutoff: 8000, reso: 0, drive: 0.2, detune: 0 };
    out.osc = { };
    for (const [k, oc] of [['down2', 0], ['down1', 1], ['zero', 2], ['up1', 3]]) out.osc[k] = zc(await render(W, { ...flat, saw: 0, square: 1, sub: 0, oct: oc }, [[45, 0.1, 3.8]], env140));
    out.sub = { };
    for (const [k, so, sw] of [['sine1', 0, 0], ['sine2', 1, 0], ['tri1', 0, 1], ['sq1', 0, 2]]) out.sub[k] = zc(await render(W, { ...flat, saw: 0, square: 0, sub: 1, subOct: so, subWave: sw }, [[57, 0.1, 3.8]], env140));
    const rms = (x) => Math.sqrt(x.slice(SR, 3 * SR).reduce((a, v) => a + v * v, 0) / (2 * SR));
    const lean = await render(W, { ...flat, saw: 0, square: 0, sub: 1 }, [[45, 0.1, 3.8]], env140), fat = await render(W, { ...flat, saw: 0, square: 0, sub: 1, beef: 1 }, [[45, 0.1, 3.8]], env140);
    out.beef = { lean: rms(lean), fat: rms(fat), crestLean: peak(lean) / rms(lean), crestFat: peak(fat) / rms(fat) };
    return out;
  });
  const near = (x, want) => Math.abs(x - want) / want < 0.04;
  const r = (x) => x.toFixed(2);
  check(near(R.oct[0], 140 / 60) && near(R.oct[1], 2 * 140 / 60), `Octave mode at 140 bpm: C2 wobbles at 1/4 (${r(R.oct[0])} Hz, want 2.33), C3 at 1/8 (${r(R.oct[1])} Hz, want 4.67)`);
  check(near(R.oct[1] / R.oct[0], 2), `an octave up wobbles twice as fast (${r(R.oct[1] / R.oct[0])}×)`);
  check(near(R.keys[0], 2 * 140 / 60) && near(R.keys[1], 4 * 140 / 60), `Keys mode: G picks 1/8 (${r(R.keys[0])} Hz), A picks 1/16 (${r(R.keys[1])} Hz)`);
  check(near(R.fixed[0], 140 / 60) && near(R.fixed[1], 140 / 60), `Fixed 1/4: every key the same (${r(R.fixed[0])}, ${r(R.fixed[1])} Hz)`);
  check(R.locked < 0.03, `locked to the beat: notes started 0.27 s apart wobble in step (phase apart ${r(R.locked)} cycles)`);
  check(Math.abs(R.restart - Math.min(0.27 * 140 / 60 % 1, 1 - 0.27 * 140 / 60 % 1)) < 0.05, `restart on note: they're apart by the 0.27 s between them (${r(R.restart)} cycles, want ${r(Math.min(0.27 * 140 / 60 % 1, 1 - 0.27 * 140 / 60 % 1))})`);
  check(near(R.noclock, 4), `no room clock: the BPM knob (120) runs it, C3 at 1/8 = ${r(R.noclock)} Hz (want 4)`);
  const o = R.osc, sb = R.sub;
  check(near(o.zero, 110) && near(o.down1, 55) && near(o.down2, 27.5) && near(o.up1, 220), `the octave switch moves the oscillators: A2 plays at ${o.down2.toFixed(0)} / ${o.down1.toFixed(0)} / ${o.zero.toFixed(0)} / ${o.up1.toFixed(0)} Hz for −2 / −1 / 0 / +1`);
  check(near(sb.sine1, 110) && near(sb.sine2, 55) && near(sb.tri1, 110) && near(sb.sq1, 110), `the sub sits one or two octaves under A3: ${sb.sine1.toFixed(0)} and ${sb.sine2.toFixed(0)} Hz; triangle and square at ${sb.tri1.toFixed(0)}, ${sb.sq1.toFixed(0)} Hz`);
  check(R.beef.fat > R.beef.lean * 1.3 && R.beef.crestFat < R.beef.crestLean, `Beef fattens the sub: louder (${(20 * Math.log10(R.beef.fat / R.beef.lean)).toFixed(1)} dB) and denser (crest ${R.beef.crestLean.toFixed(2)} to ${R.beef.crestFat.toFixed(2)})`);
  check(R.finite, 'no NaN or Inf in any preset');
  const pk = Object.entries(R.peaks).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');
  check(Object.values(R.peaks).every((v) => v > 0.3 * R.mono && v < 1.1 && v < 2.2 * R.mono), `levels sit near Monolith's bass (${R.mono.toFixed(2)}): ${pk}`);
  check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
