// Every instrument has the arpeggiator: each one that plays notes (not the drum machines) offers the Arp page, and
// it plays on instruments that never declared it (Tine, Juniper, Poly): stepped notes on the room's 1/16 grid, the
// bandmate hearing the same notes, the sound engine never told about the arp knobs (no page errors), and the
// Arp page there on the panel. An external synth (MIDI only) gets it too.
//   node server/dev.js &  (8787)        node tests/arpall.test.cjs
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
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
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1))); if (ok.every(Boolean)) break; await sleep(250); }
    const list = await A.evaluate(() => [...JJ.engine.defs.values()].filter((d) => !d.internal || d.id === 'none').map((d) => ({ id: d.id, drums: !!d.drums, arp: d.params.some((p) => p.id === 'arpMode') })));
    const melodic = list.filter((d) => !d.drums), drums = list.filter((d) => d.drums);
    console.log('   with the arp:', melodic.map((d) => d.id + (d.arp ? '' : '(NO)')).join(' '));
    check(melodic.length >= 13 && melodic.every((d) => d.arp), `every instrument that plays notes has the arp (${melodic.length}, the MIDI-only stand-in included)`);
    check(drums.length >= 3 && drums.every((d) => !d.arp), `the drum machines don't (${drums.map((d) => d.id).join(', ')})`);
    await sleep(4000);
    for (const inst of ['tine', 'juniper', 'poly']) {
      const r = await A.evaluate((i) => JJ.addInstrument(i)?.r, inst); await sleep(900);
      const me = await A.evaluate(() => JJ.S.me), pid = `${me}:${r}`;
      await A.evaluate(() => { JJ.setParam('arpMode', 1); JJ.setParam('arpRate', 3); JJ.setParam('arpOct', 1); });
      const page = await A.evaluate(() => [...document.querySelectorAll('#plate .pages .page')].map((b) => b.textContent));
      await sleep(600);
      await Promise.all([A, B].map((p) => p.evaluate(() => { JJ.engine.log.length = 0; })));
      await A.evaluate(() => { JJ.input.press(60, 100, 0); JJ.input.press(64, 90, 0); JJ.input.press(67, 80, 0); });
      await sleep(1500);
      await A.evaluate(() => { JJ.input.release(60, 0); JJ.input.release(64, 0); JJ.input.release(67, 0); });
      await sleep(900);
      const ons = (p) => p.evaluate((pid) => JJ.engine.log.filter((e) => e.pid === pid && e.type === 'on').map((e) => ({ n: e.note, at: e.at })), pid);
      const a = await ons(A), b = await ons(B);
      const grid = await A.evaluate((ats) => ats.every((at) => { const x = JJ.tempo.beatAt(at) / 0.25; return Math.abs(x - Math.round(x)) < 1e-3; }), a.map((x) => x.at));
      const seq = a.map((x) => x.n).join(' ');
      check(page.includes('Arp') && a.length >= 6 && /^60 64 67 72 76 79/.test(seq) && grid, `${inst}: the Arp page is on its panel, and held C E G step Up over two octaves on the 1/16 grid (${seq.slice(0, 30)}…)`);
      const same = b.length >= a.length - 1 && a.slice(0, Math.min(a.length, b.length) - 1).every((x, i) => x.n === b[i].n && Math.abs(x.at - b[i].at) < 1);
      check(same, `${inst}: Matt hears the same notes at the same times (${b.length} vs ${a.length})`);
      await A.evaluate(() => JJ.setParam('arpMode', 0));
    }
    check(errors.length === 0, 'no page errors (the instruments never see the arp knobs)' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  } catch (e) { console.log('FAIL', e.message); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
