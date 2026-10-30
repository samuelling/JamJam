// Renders a tour of the Pads kits to a WAV file: for each kit its sixteen pads in order as 16ths, then a bar of a
// beat on it (for the chopped loops, the chops played back in order rebuild the loop).
//   node server/dev.js &  (8787)     node tests/demo-pads.cjs [out.wav] [kit,kit,...]
const { chromium } = require('playwright'); const fs = require('fs');
const OUT = process.argv[2] || '/tmp/pads.wav', ONLY = process.argv[3] ? process.argv[3].split(',') : null;
(async () => {
  const b = await chromium.launch(); const p = await b.newPage(); await p.goto('http://localhost:8787/');
  const out = await p.evaluate(async (ONLY) => {
    const src = await (await fetch('/instruments/pads.js')).text();
    const mod = (await import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))).default;
    const kits = Object.keys(mod.presets).filter((k) => k !== 'empty' && (!ONLY || ONLY.includes(k)));
    const SR = 44100, bpm = 100, s16 = 60 / bpm / 4, per = 32 * s16 + 0.8;
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * (per * kits.length + 1)), SR);
    const melodic = new Set(['kalimba', 'mallets']), chopped = new Set(['breaks', 'safari', 'tablaloop']);
    const beat = [0, 4, 4, 0, 1, 4, 0, 4, 0, 0, 4, 1, 4, 5, 1, 6], tune = [0, 4, 7, 11, 9, 7, 4, 2, 0, 2, 4, 7, 9, 11, 12, 15];
    for (let k = 0; k < kits.length; k++) {
      const params = { level: 0.85, tone: 20000, kit: mod.presets[kits[k]].kit };
      await mod.init(ctx, params);
      const inst = mod.create(ctx, ctx.destination, params), t0 = 0.2 + k * per;
      for (let i = 0; i < 16; i++) inst.noteOn(36 + i, 100, t0 + i * s16);
      const bar2 = chopped.has(kits[k]) ? [0, 1, 2, 3, 0, 1, 2, 3, 8, 9, 10, 11, 12, 13, 14, 15] : melodic.has(kits[k]) ? tune.map((x) => Math.min(15, Math.round(x * 15 / 15))) : beat;
      for (let i = 0; i < 16; i++) inst.noteOn(36 + bar2[i], i % 4 ? 84 : 110, t0 + (16 + i) * s16);
    }
    const buf = await ctx.startRendering(), L = buf.getChannelData(0), R = buf.getChannelData(1);
    let pk = 0; for (let i = 0; i < L.length; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
    const gg = 0.9 / pk, pcm = new Int16Array(L.length * 2); for (let i = 0; i < L.length; i++) { pcm[2 * i] = L[i] * gg * 32767; pcm[2 * i + 1] = R[i] * gg * 32767; }
    return { bytes: Array.from(new Uint8Array(pcm.buffer)), pk, kits, per };
  }, ONLY);
  const data = Buffer.from(out.bytes), hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22); hdr.writeUInt32LE(44100, 24); hdr.writeUInt32LE(44100 * 4, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  fs.writeFileSync(OUT, Buffer.concat([hdr, data])); await b.close();
  console.log(`wrote ${OUT}: ${out.kits.map((k, i) => `${(0.2 + i * out.per).toFixed(1)}s ${k}`).join(' · ')}  (peak ${out.pk.toFixed(2)})`);
})();
