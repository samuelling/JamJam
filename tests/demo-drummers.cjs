// Renders a short demo of the virtual drummer across styles (each on the kit that suits it) to a WAV file, to hear
// the drummers without opening a room.   node server/dev.js &  (8787)     node tests/demo-drummers.cjs [out.wav]
const { chromium } = require('playwright'); const fs = require('fs');
const OUT = process.argv[2] || '/tmp/drummers.wav';
(async () => {
  const b = await chromium.launch(); const p = await b.newPage(); await p.goto('http://localhost:8787/');
  const out = await p.evaluate(async () => {
    const P = await import('/src/players.js');
    const load = async (f) => { const src = await (await fetch('/instruments/' + f)).text(); return (await import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))).default; };
    const mods = { studio: await load('studio.js'), machina: await load('machina.js') };
    const SR = 44100, plan = [['medium', 150, 8], ['funk', 98, 4], ['rock', 118, 4], ['hiphop', 88, 4], ['house', 124, 4], ['trap', 140, 4]];
    let total = 0; for (const [, bpm, bars] of plan) total += bars * 4 * 60 / bpm + 0.6;
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * (total + 2)), SR);
    for (const m of Object.values(mods)) if (m.init) await m.init(ctx);
    let t0 = 0.2;
    for (const [style, bpm, bars] of plan) {
      const o = P.newVirtual('drums', 'x', 'x', style); o.seed = 1234; o.intensity = 0.6;
      const kit = P.kitOf(o), mod = mods[kit.inst], params = {}; for (const d of mod.params) params[d.id] = (mod.presets[kit.patch] || {})[d.id] ?? d.def;
      const g = ctx.createGain(); g.gain.value = kit.gain ?? 1; g.connect(ctx.destination);
      const inst = mod.create(ctx, g, params);
      for (let n = 0; n < bars; n++) { const f = P.withPrevFill(o, P.vampForm(n + 8), P.vampForm(n + 7), n + 8); for (const e of P.drummerBar(o, f, n + 8, 4, bpm)) { const t = t0 + (n * 4 + e.b) * 60 / bpm + e.ms / 1000; inst.noteOn(e.note, e.vel, Math.max(0, t), Math.round(t * 1000)); } }
      t0 += bars * 4 * 60 / bpm + 0.6;
    }
    // worklet instruments: hold the render a moment so every scheduled hit reaches its processor first
    ctx.suspend(256 / SR).then(() => new Promise((r) => setTimeout(r, 60))).then(() => ctx.resume());
    const buf = await ctx.startRendering(), L = buf.getChannelData(0), R = buf.getChannelData(1);
    let pk = 0; for (let i = 0; i < L.length; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
    const gg = 0.9 / pk, pcm = new Int16Array(L.length * 2); for (let i = 0; i < L.length; i++) { pcm[2 * i] = L[i] * gg * 32767; pcm[2 * i + 1] = R[i] * gg * 32767; }
    return Array.from(new Uint8Array(pcm.buffer));
  });
  const data = Buffer.from(out), hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22); hdr.writeUInt32LE(44100, 24); hdr.writeUInt32LE(44100 * 4, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  fs.writeFileSync(OUT, Buffer.concat([hdr, data])); await b.close(); console.log('wrote ' + OUT);
})();
