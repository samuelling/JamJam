// Sync record: two jammers each record their own instrument dry on their own machine, on the room's clock; the stems
// and MIDI are gathered over the direct link into one zip, and each stem's first note lands where its MIDI says.
//   node server/dev.js &  (8787)        node tests/syncrec.test.cjs
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
    const A = await mk('?lag=25', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=25`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1 && [...JJ.room.peers.values()].every((x) => x.path === 'direct')))); if (ok.every(Boolean)) break; await sleep(300); }
    await B.evaluate(() => { const e = JJ.S.rack[0]; JJ.changeEntry(e.r, { inst: 'monolith', patch: 'bass' }); });
    await sleep(1500);
    const [samId, mattId] = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.S.me)));

    await A.evaluate(() => JJ.sync());
    await sleep(1500);
    check(await B.evaluate(() => !!JJ.syncState()), "Matt's browser arms the take too");
    const play = (p, notes, gap) => p.evaluate(async ({ notes, gap }) => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); for (const n of notes) { JJ.input.press(n, 110); await s(gap); JJ.input.release(n); await s(120); } }, { notes, gap });
    await Promise.all([play(A, [60, 64, 67, 72], 260), (async () => { await sleep(170); await play(B, [36, 43, 36, 41], 300); })()]);
    await sleep(600);
    await A.evaluate(() => JJ.sync());   // stop
    let st;
    for (let i = 0; i < 60; i++) { st = await A.evaluate(() => JJ.syncState()); if (st && st.zip) break; await sleep(500); }
    check(st && st.zip, `the take is gathered into one zip (${st ? st.got.length : 0} jammers)`);
    const res = await A.evaluate(async ({ samId, mattId }) => {
      const r = JJ.S.srec, sr = JJ.engine.ctx.sampleRate;
      const readWav = (b) => { const v = new DataView(b.buffer, b.byteOffset, b.byteLength), n = (b.byteLength - 44) / 4, L = new Float32Array(n); for (let i = 0, o = 44; i < n; i++, o += 4) L[i] = v.getInt16(o, true) / 32767; return L; };
      const firstOnset = (L) => { for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > 0.02) return (i / sr) * 1000; return null; };
      const out = {};
      for (const [pid, files] of r.got) {
        const wav = files.find((f) => f.name.endsWith('.wav')), mid = files.find((f) => f.name.endsWith('.mid'));
        const firstNote = JJ.engine.log.filter((e) => e.pid.startsWith(pid + ':') && e.type === 'on' && e.at >= r.T0).map((e) => e.at)[0];
        out[pid === samId ? 'sam' : 'matt'] = { names: files.map((f) => f.name), onset: wav && firstOnset(readWav(wav.data)), expect: firstNote - r.T0, midHead: mid && String.fromCharCode(...mid.data.slice(0, 4)), midLen: mid && mid.data.length };
      }
      const z = await (await fetch(r.zip.url)).arrayBuffer();
      out.zipBytes = z.byteLength; out.zipSig = new DataView(z).getUint32(0, true) === 0x04034b50;
      return out;
    }, { samId, mattId });
    for (const who of ['sam', 'matt']) {
      const x = res[who];
      check(x && x.names.some((n) => n.endsWith('.wav')) && x.names.some((n) => n.endsWith('.mid')), `${who}: a WAV stem and a MIDI file (${x ? x.names.join(', ') : 'none'})`);
      check(x && x.midHead === 'MThd', `${who}: the MIDI file is a standard MIDI file`);
      const err = x && x.onset != null ? x.onset - x.expect : null;
      check(err != null && err >= -1 && err < 12, `${who}: the stem's first note is where the room's clock says (onset ${x?.onset?.toFixed(1)} ms vs note ${x?.expect?.toFixed(1)} ms)`);
    }
    check(res.zipSig && res.zipBytes > 100000, `the zip is a zip (${(res.zipBytes / 1e6).toFixed(1)} MB)`);
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } catch (e) { console.error(e); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
