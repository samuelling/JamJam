// Machina's deeper drum synthesis and its two assignable LFOs, rendered offline:
//   every kit renders clean; an LFO on a slot knob makes successive hits differ, synced to the beat, and the same
//   render twice is identical (lockstep); a free-running LFO follows room time; S&H is seeded; the master knobs follow
//   an LFO between hits; the new knobs do what they say (sub tail, bursts, sweep, noise, drive, glue).
//   node server/dev.js &   then   node tests/machina.test.cjs [baseUrl]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787/';
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + 'instruments/index.json');
  try {
    const r = await page.evaluate(async () => {
      const def = (await import('/instruments/machina.js')).default, SR = 48000;
      const defaults = Object.fromEntries(def.params.map((P) => [P.id, P.def]));
      const kitOf = (name) => ({ ...defaults, ...(def.presets[name] || {}) });
      const destOf = (id) => def.params.find((P) => P.id === 'lfo1.dest').options.indexOf(def.params.find((P) => P.id === id).group + ' · ' + def.params.find((P) => P.id === id).name);
      // hits: [note, vel, time s]; env: a 120 bpm room clock whose beat 0 is at 0.05 s, as the app gives
      const env = { audioTime: (ms) => ms / 1000, roomTime: (t) => t * 1000, bpm: () => 120, beatAt: (ms) => (ms / 1000 - 0.05) * 2, timeOf: (b) => (b / 2 + 0.05) * 1000 };
      async function render(params, hits, secs, useEnv = true) {
        const ctx = new OfflineAudioContext(2, Math.ceil(SR * secs), SR);
        await def.init(ctx);
        const inst = def.create(ctx, ctx.destination, params, useEnv ? env : undefined);
        for (const [n, v, t] of hits) inst.noteOn(n, v, t, useEnv ? t * 1000 : undefined);
        const hold = ctx.suspend(256 / SR).then(async () => { await new Promise((res) => setTimeout(res, 40)); ctx.resume(); });
        const b = await ctx.startRendering(); await hold; inst.dispose();
        return [b.getChannelData(0), b.getChannelData(1)];
      }
      const stats = ([L, R]) => { let pk = 0, ss = 0, nan = false; for (let i = 0; i < L.length; i++) { const a = L[i], b = R[i]; if (!Number.isFinite(a) || !Number.isFinite(b)) nan = true; pk = Math.max(pk, Math.abs(a), Math.abs(b)); ss += a * a + b * b; } return { pk, rms: Math.sqrt(ss / (2 * L.length)), nan }; };
      const win = ([L], t, d) => { const a = Math.round(t * SR), b = Math.round((t + d) * SR); let pk = 0, ss = 0, zc = 0; for (let i = a; i < b; i++) { pk = Math.max(pk, Math.abs(L[i])); ss += L[i] * L[i]; if (i > a && (L[i] >= 0) !== (L[i - 1] >= 0)) zc++; } return { pk, rms: Math.sqrt(ss / (b - a)), zc }; };
      const same = (a, b) => { let d = 0; for (let i = 0; i < a[0].length; i++) d = Math.max(d, Math.abs(a[0][i] - b[0][i]), Math.abs(a[1][i] - b[1][i])); return d; };
      const out = {};
      // 1. every kit, the full set of slots: clean and at a sane level
      const all = [[36, 110, 0.05], [42, 90, 0.3], [38, 120, 0.55], [39, 100, 0.8], [37, 90, 1.05], [46, 100, 1.3], [45, 110, 1.55], [56, 100, 1.8], [49, 100, 2.05], [64, 100, 2.6]];
      out.kits = {};
      for (const name of Object.keys(def.presets)) { const s = stats(await render(kitOf(name), all, 4)); out.kits[name] = { pk: +s.pk.toFixed(3), rms: +s.rms.toFixed(4), nan: s.nan }; }
      // 2. LFO 1 on the closed hat's decay, a triangle over a bar: 16 hats over a bar, their tails differ in a rise-and-fall
      const hats = Array.from({ length: 16 }, (_, i) => [42, 100, 0.05 + i * 0.125]);
      const lfoKit = { ...kitOf('808'), 'lfo1.dest': destOf('chh.decay'), 'lfo1.shape': 1, 'lfo1.rate': 9, 'lfo1.depth': 0.5 };
      const a1 = await render(lfoKit, hats, 2.3), a2 = await render(lfoKit, hats, 2.3), off = await render(kitOf('808'), hats, 2.3);
      const tail = (buf, i) => win(buf, 0.05 + i * 0.125 + 0.03, 0.08).rms;
      out.lfoTails = hats.map((_, i) => +tail(a1, i).toFixed(4)); out.offTails = hats.map((_, i) => +tail(off, i).toFixed(4));
      out.lfoSame = same(a1, a2);
      // 3. synced vs room beat: the same hit at the same beat gets the same value whatever the render's start
      const shifted = { ...env, beatAt: (ms) => (ms / 1000 - 0.05) * 2 + 4 };   // a bar later in the room: a 1-bar LFO is at the same phase
      const ctxA = await render(lfoKit, hats.slice(0, 4), 1), ctxB = await (async () => { const save = env.beatAt; env.beatAt = shifted.beatAt; const b = await render(lfoKit, hats.slice(0, 4), 1); env.beatAt = save; return b; })();
      out.barShiftSame = same(ctxA, ctxB);
      const halfBar = { ...lfoKit }; const ctxC = await (async () => { const save = env.beatAt; env.beatAt = (ms) => (ms / 1000 - 0.05) * 2 + 2; const b = await render(halfBar, hats.slice(0, 4), 1); env.beatAt = save; return b; })();
      out.halfBarDiff = same(ctxA, ctxC);
      // 4. S&H on tom pitch: the wonky kit; deterministic and pitch differs hit to hit
      const toms = Array.from({ length: 8 }, (_, i) => [45, 110, 0.05 + i * 0.25]);
      const w1 = await render(kitOf('wonky'), toms, 2.3), w2 = await render(kitOf('wonky'), toms, 2.3);
      out.wonkySame = same(w1, w2);
      out.tomZc = toms.map((_, i) => win(w1, 0.05 + i * 0.25 + 0.05, 0.15).zc);
      // 5. master LFO on level: a held-out tail of a long cymbal swells and dips with a 1/4 sine
      const cymKit = { ...kitOf('808'), 'cym.decay': 4, 'lfo2.dest': destOf('level'), 'lfo2.shape': 0, 'lfo2.rate': 7, 'lfo2.depth': -0.4 };
      const cy = await render(cymKit, [[49, 110, 0.05]], 2.2);
      out.cymEnv = Array.from({ length: 16 }, (_, i) => +win(cy, 0.3 + i * 0.0625, 0.0625).rms.toFixed(4));
      // 6. free-running Hz rate, no clock: still deterministic
      const free = { ...kitOf('808'), 'lfo1.dest': destOf('snare.pitch'), 'lfo1.rate': 0, 'lfo1.hz': 3.3, 'lfo1.depth': 0.2 };
      out.freeSame = same(await render(free, toms.map(([, v, t]) => [38, v, t]), 2.3, false), await render(free, toms.map(([, v, t]) => [38, v, t]), 2.3, false));
      // 7. the new knobs: sub tail, bursts, sweep, noise 0, drive, glue
      const k0 = kitOf('808');
      const tailAt = async (p, n, t0, d) => win(await render(p, [[n, 110, 0.05]], 1.6), t0, d).rms;
      out.sub = [await tailAt(k0, 36, 0.9, 0.3), await tailAt({ ...k0, 'kick.sub': 1 }, 36, 0.9, 0.3)];
      // each burst after the first, and the tail after the last, is a jump in level: count 2 ms bins that leap up
      const burstsOf = async (b) => { const [L] = await render({ ...k0, 'clap.bursts': b, 'clap.spread': 15, 'clap.decay': 0.3 }, [[39, 110, 0.05]], 0.4); const a = Math.round(0.05 * SR), w = Math.round(0.002 * SR), rms = []; for (let k = 0; k < 60; k++) { let ss = 0; for (let j = a + k * w; j < a + (k + 1) * w; j++) ss += L[j] * L[j]; rms.push(Math.sqrt(ss / w)); } let n = 0; for (let k = 1; k * 2 < b * 15; k++) if (rms[k] > rms[k - 1] * 3 && rms[k] > 0.02) n++; return n + 1; };
      out.bursts = [await burstsOf(2), await burstsOf(5)];
      out.noiseOff = [await tailAt({ ...k0, 'snare.body': 0 }, 38, 0.06, 0.1), await tailAt({ ...k0, 'snare.body': 0, 'snare.noise': 0 }, 38, 0.06, 0.1), await tailAt({ ...k0, 'snare.noise': 0 }, 38, 0.06, 0.1)];
      out.drive = [(await (async () => win(await render(k0, [[45, 60, 0.05]], 0.6), 0.05, 0.2).pk)()), (await (async () => win(await render({ ...k0, 'tom.drive': 1 }, [[45, 60, 0.05]], 0.6), 0.05, 0.2).pk)())];
      const sweepZc = async (sw) => win(await render({ ...k0, 'kick.sweep': sw }, [[36, 110, 0.05]], 0.4), 0.05, 0.03).zc;
      out.sweep = [await sweepZc(0), await sweepZc(1), await sweepZc(3)];
      const busy = Array.from({ length: 8 }, (_, i) => [36, 100, 0.05 + i * 0.25]).concat(Array.from({ length: 8 }, (_, i) => [42, 60, 0.175 + i * 0.25]));
      const clean = { ...k0, drive: 0, level: 0.5 };   // glue sits before the drive: measure it where the drive isn't already squashing
      const punch = (buf) => { let a = 0; for (let i = 0; i < 8; i++) { const t = 0.05 + i * 0.25; a += win(buf, t + 0.06, 0.05).rms / win(buf, t, 0.01).pk; } return a / 8; };
      out.glue = await Promise.all([render(clean, busy, 2.3), render({ ...clean, glue: 1 }, busy, 2.3)].map(async (p) => { const b = await p; return { tailToHit: +punch(b).toFixed(3), rms: +stats(b).rms.toFixed(4) }; }));
      out.nParams = def.params.length; out.dests = def.params.find((P) => P.id === 'lfo1.dest').options.length;
      return out;
    });
    for (const [name, s] of Object.entries(r.kits)) check(!s.nan && s.pk > 0.05 && s.pk <= 1.0001, `kit ${name} renders clean (peak ${s.pk}, rms ${s.rms})`);
    const ref = r.kits['808'].pk;
    for (const name of ['rolling', 'wonky', 'breathing', 'industrial']) check(r.kits[name] && r.kits[name].pk > ref * 0.4, `new kit ${name} is at a sane level (${r.kits[name]?.pk} vs 808 ${ref})`);
    const spread = (a) => Math.max(...a) / Math.max(1e-9, Math.min(...a));
    check(spread(r.offTails) < 1.05 && spread(r.lfoTails) > 1.5, `an LFO on hat decay makes the tails differ hit to hit (off ${spread(r.offTails).toFixed(2)}×, on ${spread(r.lfoTails).toFixed(2)}×)`);
    const peakAt = r.lfoTails.indexOf(Math.max(...r.lfoTails));
    check(peakAt === 4, `the triangle peaks a quarter of the way through its bar, on the downbeat of beat 2 (hit ${peakAt + 1} of 16)`);
    check(r.lfoSame === 0, 'the same render twice is identical');
    check(r.barShiftSame < 1e-6 && r.halfBarDiff > 1e-3, `the LFO follows the room's beat: a bar later sounds the same, half a bar later doesn't (${r.barShiftSame}, ${r.halfBarDiff.toFixed(3)})`);
    check(r.wonkySame === 0 && new Set(r.tomZc).size >= 4, `S&H on tom pitch: deterministic, and the toms land on different pitches (${r.tomZc.join(' ')})`);
    const cy = r.cymEnv, rises = cy.slice(1).filter((v, i) => v > cy[i]).length;
    check(rises >= 3, `a master LFO on level moves a ringing cymbal between hits (${rises} rises in its tail)`);
    check(r.freeSame === 0, 'a free-running LFO without a clock is deterministic too');
    check(r.sub[1] > r.sub[0] * 1.8, `Sub tail lengthens the kick (${r.sub.map((x) => x.toFixed(4)).join(' → ')})`);
    check(r.bursts[0] === 2 && r.bursts[1] === 5, `Clap bursts: 2 and 5 hits heard in the clap (${r.bursts.join(', ')})`);
    check(r.noiseOff[0] > 0.02 && r.noiseOff[1] < r.noiseOff[0] * 0.02 && r.noiseOff[2] > 0.02, `Body and Noise split the snare: body 0 leaves the rattle, both 0 leave nothing, noise 0 leaves the drum (${r.noiseOff.map((x) => x.toFixed(4)).join(', ')})`);
    check(r.drive[1] > r.drive[0] * 1.15, `Drive pushes a soft tom harder (${r.drive.map((x) => x.toFixed(3)).join(' → ')})`);
    check(r.sweep[0] < r.sweep[1] && r.sweep[1] < r.sweep[2], `Sweep: more sweep, more cycles in the kick's first 30 ms (${r.sweep.join(' < ')})`);
    check(r.glue[1].tailToHit < r.glue[0].tailToHit * 0.9 && r.glue[1].rms > r.glue[0].rms * 0.7 && r.glue[1].rms < r.glue[0].rms * 1.4, `Glue: the hits' fronts come through and what follows them is pulled down (pumping), the level stays close (${JSON.stringify(r.glue)})`);
    check(r.dests > 100, `${r.dests - 1} knobs to send an LFO to, of ${r.nParams} params`);
    check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  } catch (e) { check(false, 'threw: ' + e.message); }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
