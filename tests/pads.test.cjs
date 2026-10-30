// Pads: Sam racks the MPC-style pads, plays them from the keys (ZXCV row = pads 1-4) and both browsers play the same
// hits; he loads his own sound onto a pad, it's analysed (what kind of hit, for the stand-in), Matt gets the audio
// itself once, a bandmate who joins later asks for it and gets it, and trimming and tuning travel with the kit.
//   node server/dev.js &  (8787)        node tests/pads.test.cjs
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
// a test sound: a pitched tone with a decay (a little "bell"), as a 16-bit WAV
function wav(sr = 44100, secs = 0.8) {
  const n = Math.round(sr * secs), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * Math.exp(-i / (sr * 0.25)) * 26000), 44 + i * 2);
  return b;
}
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const mk = async (q, name) => { const c = await browser.newContext({ viewport: { width: 1400, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto('http://localhost:8787/' + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?lag=25', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=25`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1 && [...JJ.room.peers.values()].every((x) => x.path === 'direct')))); if (ok.every(Boolean)) break; await sleep(300); }
    const r = await A.evaluate(() => { const e = JJ.addInstrument('pads', 'chops'); JJ.select(e.r); return e.r; });
    await sleep(800);
    const names = await A.$$eval('.padgrid .padbtn b', (els) => els.map((e) => e.textContent));
    check(names.length === 16 && names.includes('Kick') && names.includes('Hat'), `sixteen pads with the starter kit (${names.slice(12).join(', ')} on the bottom row)`);
    // play pad 1 (Z) and pad 5 (A): both browsers play the same hits
    for (const k of ['z', 'a', 'z']) { await A.keyboard.down(k); await sleep(120); await A.keyboard.up(k); await sleep(200); }
    await sleep(600);
    const hits = await Promise.all([A, B].map((p) => p.evaluate((r) => JJ.engine.log.filter((e) => e.pid.endsWith(':' + r) && e.type === 'on').map((e) => `${e.note}@${Math.round(e.at)}`).join(' '), r)));
    check(hits[0].split(' ').length === 3 && hits[0].startsWith('36@') && hits[0] === hits[1], `the keys play the pads, the same hits in both browsers (${hits[0]})`);
    // load Sam's own sound onto pad 6
    await A.click('.padgrid .padbtn[data-padbtn="5"]'); await sleep(200);
    await A.setInputFiles('.padedit input[type=file]', { name: 'bell.wav', mimeType: 'audio/wav', buffer: wav() });
    await sleep(1200);
    const pad = await A.evaluate((r) => JJ.S.rack.find((e) => e.r === r).cfg.params.kit[5], r);
    check(pad && pad.id && pad.name === 'bell' && pad.recipe, `the sound lands on pad 6 under its content address (${pad?.id}), analysed as a "${pad?.recipe?.kind}" at ${pad?.recipe?.f} Hz`);
    let got = false;
    for (let i = 0; i < 20 && !got; i++) { await sleep(400); got = await B.evaluate((id) => JJ.audio().have.includes(id), pad.id); }
    check(got, 'Matt gets the audio itself, once');
    const theirKit = await B.evaluate(({ id }) => { for (const pl of JJ.S.players.values()) for (const x of pl.rack || []) if (x.cfg?.params?.kit) return x.cfg.params.kit[5]?.id === id; return false; }, { id: pad.id });
    check(theirKit, "and Matt's copy of Sam's kit names it on pad 6");
    // trim and tune travel with the kit
    await A.evaluate(() => { const i = document.querySelectorAll('.padedit input[type=range]'); i[1].value = '0.5'; i[1].dispatchEvent(new Event('change')); i[2].value = '7'; i[2].dispatchEvent(new Event('change')); });
    await sleep(800);
    const edited = await B.evaluate(() => { for (const pl of JJ.S.players.values()) for (const x of pl.rack || []) if (x.cfg?.params?.kit) return x.cfg.params.kit[5]; return null; });
    check(edited && edited.end === 0.5 && edited.tune === 7, `trimming and tuning reach Matt (end ${edited?.end}, tune ${edited?.tune})`);
    // a bandmate who joins later asks for the sample and gets it
    const C = await mk(`?room=${code}&lag=25`, 'Pat');
    await C.click('#joinBtn'); await C.waitForSelector('#studio:not(.hide)');
    let late = false;
    for (let i = 0; i < 40 && !late; i++) { await sleep(500); late = await C.evaluate((id) => JJ.audio().have.includes(id), pad.id); }
    check(late, 'a bandmate who joins later gets the sample too');
    await A.screenshot({ path: '/tmp/pads.png' });
    // another kit from the picker: Matt's copy of Sam's pads switches with it
    await A.selectOption('.kitsel', 'hands'); await sleep(1200);
    const kitB = await B.evaluate(() => { for (const p of JJ.S.players.values()) for (const x of p.rack || []) if (x.cfg.inst === 'pads') return { patch: x.cfg.patch, first: x.cfg.params.kit[0]?.name, src: x.cfg.params.kit[0]?.src }; return null; });
    check(kitB && kitB.patch === 'hands' && kitB.first === 'Tumba' && /instruments\/pads\/hands\//.test(kitB.src), `the kit picker loads another kit, and the bandmate's copy follows (${JSON.stringify(kitB)})`);
    const ok = await A.evaluate(async () => (await fetch('instruments/pads/hands/01.mp3')).ok);
    check(ok, "the kit's sounds are files on the site, so nothing has to be sent between browsers");
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } catch (e) { console.error(e); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
