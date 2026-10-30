// Renders a short demo of Hammerwork Lite (the modelled piano) to a WAV file: the register from low to high, a
// soft-to-hard velocity sweep, then a few bars of chords and melody.
//   node server/dev.js &  (8787)     node tests/demo-piano.cjs [out.wav] [preset] [--raw]
// --raw writes the render as it is (no normalising), as 32-bit float, for checking levels.
const { chromium } = require('playwright'); const fs = require('fs');
const args = process.argv.slice(2), raw = args.includes('--raw'), pos = args.filter((a) => !a.startsWith('--'));
const OUT = pos[0] || '/tmp/piano.wav', PRESET = pos[1] || 'grand';
(async () => {
  const b = await chromium.launch(); const p = await b.newPage(); await p.goto('http://localhost:8787/');
  const out = await p.evaluate(async ({ PRESET, raw }) => {
    const src = await (await fetch('/instruments/hammerwork.js')).text();
    const mod = (await import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))).default;
    const params = {}; for (const d of mod.params) params[d.id] = (mod.presets[PRESET] || {})[d.id] ?? d.def;
    const SR = 44100, ev = [];
    const note = (n, v, t, d) => ev.push([n, v, t, t + d]);
    let t = 0.2;
    for (const n of [28, 40, 52, 64, 76, 88, 100]) { note(n, 80, t, 1.1); t += 1.2; }            // the register
    t += 0.3;
    for (let v = 20; v <= 127; v += 15) { note(60, v, t, 0.7); t += 0.75; }                      // pp to fff on middle C
    t += 0.4;
    const bpm = 84, beat = 60 / bpm;
    const chords = [[48, 55, 64, 67, 71], [45, 52, 60, 64, 67], [50, 57, 62, 65, 69], [43, 55, 59, 62, 65]];
    const mel = [76, 74, 72, 71, 72, 74, 76, 79, 81, 79, 77, 76, 74, 72, 74, 71];
    chords.forEach((c, i) => {
      const t0 = t + i * 4 * beat;
      c.forEach((n, j) => note(n, j === 0 ? 72 : 58, t0 + j * 0.012, 4 * beat - 0.05));
      for (let k = 0; k < 4; k++) note(mel[i * 4 + k], 84 - (k % 2) * 14, t0 + k * beat, beat * 0.95);
    });
    t += 16 * beat; note(36, 90, t, 3); note(48, 70, t, 3); note(60, 64, t + 0.02, 3); note(64, 60, t + 0.03, 3); note(67, 60, t + 0.04, 3); note(72, 66, t + 0.05, 3);
    const total = t + 4.5;
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * total), SR);
    await mod.init(ctx);
    const inst = mod.create(ctx, ctx.destination, params);
    for (const [n, v, a, z] of ev) { inst.noteOn(n, v, a); inst.noteOff(n, z); }
    ctx.suspend(256 / SR).then(() => new Promise((r) => setTimeout(r, 80))).then(() => ctx.resume());
    const t0 = performance.now();
    const buf = await ctx.startRendering(), L = buf.getChannelData(0), R = buf.getChannelData(1);
    const speed = total * 1000 / (performance.now() - t0);
    let pk = 0; for (let i = 0; i < L.length; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
    if (raw) { const f = new Float32Array(L.length * 2); for (let i = 0; i < L.length; i++) { f[2 * i] = L[i]; f[2 * i + 1] = R[i]; } return { bytes: Array.from(new Uint8Array(f.buffer)), pk, speed }; }
    const gg = 0.9 / pk, pcm = new Int16Array(L.length * 2); for (let i = 0; i < L.length; i++) { pcm[2 * i] = L[i] * gg * 32767; pcm[2 * i + 1] = R[i] * gg * 32767; }
    return { bytes: Array.from(new Uint8Array(pcm.buffer)), pk, speed };
  }, { PRESET, raw });
  const data = Buffer.from(out.bytes), hdr = Buffer.alloc(44), bits = raw ? 32 : 16;
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(raw ? 3 : 1, 20); hdr.writeUInt16LE(2, 22); hdr.writeUInt32LE(44100, 24); hdr.writeUInt32LE(44100 * 2 * bits / 8, 28); hdr.writeUInt16LE(2 * bits / 8, 32); hdr.writeUInt16LE(bits, 34); hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  fs.writeFileSync(OUT, Buffer.concat([hdr, data])); await b.close();
  console.log(`wrote ${OUT}  (${PRESET}, peak ${out.pk.toFixed(3)}, ${out.speed.toFixed(1)}× realtime)`);
})();
