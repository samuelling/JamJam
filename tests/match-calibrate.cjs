// Calibrate "Match my sound" against real synth recordings: for each sampled instrument, fit its software twin
// to a few of its notes and report how much closer it got, how long it took, and the CPU it cost.
// Recordings: FluidR3 GM (CC BY 3.0) via gleitz/midi-js-soundfonts; download them first (not kept in the repo):
//   mkdir -p /tmp/corpus && cd /tmp/corpus && for n in lead_1_square lead_2_sawtooth synth_bass_1 pad_2_warm synth_brass_1 synth_strings_1 electric_piano_1; do
//     curl -sO "https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/gh-pages/FluidR3_GM/$n-mp3.js"; done
//   node server/dev.js &   node tests/match-calibrate.cjs /tmp/corpus [batches] [batchSize] [wavOutDir]
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const DIR = process.argv[2] || '/tmp/corpus', BATCHES = +process.argv[3] || 24, BATCH = +process.argv[4] || 8, OUT = process.argv[5] || '';
const BASE = 'http://localhost:8787/';
const SET = [
  ['lead_1_square', 'juniper', 'lead', ['C4', 'G4']],
  ['lead_2_sawtooth', 'monolith', 'lead', ['C4', 'G4']],
  ['synth_bass_1', 'monolith', 'bass', ['C2', 'G2']],
  ['pad_2_warm', 'juniper', 'pad', ['C4', 'G3']],
  ['synth_brass_1', 'juniper', 'brass', ['C4', 'G3']],
  ['synth_strings_1', 'juniper', 'strings', ['C4', 'G3']],
  ['electric_piano_1', 'tine', 'keys', ['C4', 'G4']],
];
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const midiOf = (n) => 12 * (+n.slice(-1) + 1) + NOTE[n[0]] + (n.includes('b') ? -1 : 0);
// read the base64 audio for a note out of the soundfont file as text (the file is data: it is never run)
const sampleOf = (file, note) => { const m = fs.readFileSync(file, 'utf8').match(new RegExp(`"${note}":\\s*"data:audio/mp3;base64,([A-Za-z0-9+/=]+)"`)); return m && m[1]; };

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => console.log('page error', e.message));
  await page.goto(BASE);
  const rows = [];
  for (const [name, twin, patch, notes] of SET.filter((x) => !process.env.ONLY || process.env.ONLY.split(',').includes(x[0]))) {
    const file = path.join(DIR, name + '-mp3.js');
    if (!fs.existsSync(file)) { console.log('skip (not downloaded)', name); continue; }
    const samples = notes.map((n) => ({ note: midiOf(n), b64: sampleOf(file, n) })).filter((x) => x.b64);
    const r = await page.evaluate(async ({ twin, patch, samples, BATCHES, BATCH, wantWav }) => {
      const M = await import('/src/match.js');
      const def = (await import(`/instruments/${twin}.js`)).default;
      const base = {}; for (const P of def.params) base[P.id] = P.def; Object.assign(base, def.presets[patch] || {});
      const ac = new OfflineAudioContext(1, 1, 44100);
      const obs = [];
      for (const s of samples) {
        const bytes = Uint8Array.from(atob(s.b64), (c) => c.charCodeAt(0));
        const buf = await ac.decodeAudioData(bytes.buffer);
        const x = buf.getChannelData(0);
        // trim the encoder's leading silence: start at the onset
        let on = 0; for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.003) { on = Math.max(0, i - 64); break; }
        const o = M.analyze(x.subarray(on), buf.sampleRate, s.note, 1.0);
        if (o) { o.rel = null; o.vel = 100; obs.push(o); }   // the recordings' release point is unknown
      }
      const f = new M.Fitter(def, base, { batch: BATCH });
      for (const o of obs) f.observe(o);
      const d0 = await f.scoreAll(base);
      const t0 = performance.now(), trace = [];
      for (let i = 0; i < BATCHES; i++) { const s = await f.step(); trace.push(+s.d.toFixed(3)); }
      const wall = performance.now() - t0;
      const d1 = await f.scoreAll();
      const moved = f.space.filter((P) => Math.abs((f.best[P.id] ?? P.def) - (base[P.id] ?? P.def)) > 1e-6).map((P) => `${P.id} ${+(base[P.id] ?? P.def).toFixed(3)}→${+f.best[P.id].toFixed(3)}`);
      let wavs = null;
      if (wantWav) {
        // target, starting twin and matched twin, one after another, for listening
        const render = async (p) => { const ctx = new OfflineAudioContext(1, 48000 * 2, 48000); if (def.init) await def.init(ctx); const g = ctx.createGain(); g.connect(ctx.destination); const inst = def.create(ctx, g, p); inst.noteOn(samples[0].note, 100, 0.01); inst.noteOff(samples[0].note, 1.01); const b = await ctx.startRendering(); return Array.from(b.getChannelData(0)); };
        const tb = await ac.decodeAudioData(Uint8Array.from(atob(samples[0].b64), (c) => c.charCodeAt(0)).buffer);
        wavs = { sr: 48000, target: Array.from(tb.getChannelData(0).slice(0, Math.min(tb.length, Math.round(tb.sampleRate * 2)))), targetSr: tb.sampleRate, before: await render(base), after: await render(f.best) };
      }
      return { obs: obs.length, d0, d1, wall, renders: f.renders, renderMs: f.ms, sim0: f.similarity(d0), sim1: f.similarity(d1), moved, trace, wavs };
    }, { twin, patch, samples, BATCHES, BATCH, wantWav: !!OUT });
    rows.push({ name, twin, patch, ...r });
    console.log(`${name.padEnd(18)} → ${twin}/${patch}: distance ${r.d0.toFixed(2)} → ${r.d1.toFixed(2)} (similarity ${(100 * r.sim0).toFixed(0)}% → ${(100 * r.sim1).toFixed(0)}%), ${BATCHES} batches in ${(r.wall / 1000).toFixed(1)} s, ${(r.renderMs / r.renders).toFixed(1)} ms per note render`);
    console.log('   moved:', r.moved.join(', ') || 'nothing');
    if (OUT && r.wavs) {
      fs.mkdirSync(OUT, { recursive: true });
      const toWav = (arr, sr) => { const n = arr.length, b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); let pk = 1e-9; for (const v of arr) pk = Math.max(pk, Math.abs(v)); arr.forEach((v, i) => b.writeInt16LE(Math.round((v / pk) * 0.8 * 32767), 44 + i * 2)); return b; };
      fs.writeFileSync(path.join(OUT, `${name}-1-real.wav`), toWav(r.wavs.target, r.wavs.targetSr));
      fs.writeFileSync(path.join(OUT, `${name}-2-twin-before.wav`), toWav(r.wavs.before, r.wavs.sr));
      fs.writeFileSync(path.join(OUT, `${name}-3-twin-matched.wav`), toWav(r.wavs.after, r.wavs.sr));
    }
  }
  const better = rows.filter((r) => r.d1 < r.d0 * 0.9).length;
  console.log(`\n${better} of ${rows.length} twins got at least 10% closer.`);
  await browser.close();
})();
