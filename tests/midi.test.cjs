// External MIDI: your own gear on a MIDI port, a bandmate's part played on your gear, and MIDI clock out.
// Uses ?midimock=1 (two fake outputs that log every message with its timestamp) and ?silent=1.
//   node server/dev.js &  (8790)        node tests/midi.test.cjs
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8790/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const mk = async (q, name) => { const c = await browser.newContext(); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?midimock=1&silent=1&lag=25', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&midimock=1&silent=1&lag=25`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1))); if (ok.every(Boolean)) break; await sleep(300); }
    await sleep(2500);

    // 1. Sam's own synth on a MIDI port, channel 3, with Juniper as the twin the band hears
    const r = await A.evaluate(() => JJ.addExternal('Prophet', 'mock-a', 3, 'juniper'));
    await A.evaluate((r) => JJ.select(r), r);
    await sleep(300);
    const plate = await A.evaluate(() => ({ text: document.querySelector('#plate').textContent, name: document.querySelector('#plate input[aria-label=Name]')?.value }));
    check(plate.name === 'Prophet' && /External MIDI/.test(plate.text), 'the external gear gets its own panel');
    await A.evaluate((r) => { JJ.S.hearSelf = false; JJ.S.rack.find((e) => e.r === r).budget = 'balanced'; }, r);   // judge timing in lockstep mode (with self-monitoring on, your own gear answers at once)
    check((await A.textContent('#rackList')).includes('Prophet'), 'and a cart on the shelf');
    await A.evaluate(async () => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); for (let i = 0; i < 6; i++) { JJ.input.press(60 + i, 90); await s(110); JJ.input.release(60 + i); await s(70); } });
    await sleep(800);
    const own = await A.evaluate((r) => {
      const ons = JJ.engine.log.filter((e) => e.pid === JJ.S.me + ':' + r && e.type === 'on');
      const sent = JJ.midiLog().filter((m) => m.port === 'mock-a' && (m.data[0] & 0xf0) === 0x90);
      return { n: ons.length, chans: [...new Set(sent.map((m) => (m.data[0] & 15) + 1))], err: ons.map((e, i) => sent[i] ? Math.abs(sent[i].ts - JJ.clock.toLocal(e.at)) : 999), notes: sent.map((m) => m.data[1]).join() };
    }, r);
    check(own.n === 6 && own.notes === '60,61,62,63,64,65', `your notes go out to your gear (${own.notes})`);
    check(own.chans.join() === '3', `on the channel you picked (ch ${own.chans.join()})`);
    check(Math.max(...own.err) < 1, `timestamped for the moment the band hears them (errors ${own.err.map((x) => x.toFixed(1)).join(" ")} ms)`);
    const twinMuted = await A.evaluate((r) => JJ.engine.ch.get(JJ.S.me + ':' + r).out.gain.value, r);
    check(twinMuted < 0.01, 'you hear your gear, not its twin');
    const bSees = await B.evaluate(() => ({ corner: document.querySelector('#corners').textContent, inst: [...JJ.engine.ch.entries()].filter(([k]) => !k.startsWith(JJ.S.me)).map(([, c]) => c.insts[0]?.def.id) }));
    check(/Prophet/.test(bSees.corner) && bSees.inst.includes('juniper'), `the bandmate sees Sam's Prophet and hears its twin (${bSees.inst.join()}; ${bSees.corner.slice(0, 120)})`);

    // 2. Matt plays Sam's part on his own gear: mock-b, channel 10, browser muted
    const aKey = await A.evaluate((r) => JJ.S.me + ':' + r, r);
    await B.evaluate(() => JJ.enableMIDI());
    await B.evaluate((k) => JJ.route(k, { port: 'mock-b', ch: 10, mute: true }), aKey);
    await B.click('.sidetab[data-panel="panel-midi"]'); await sleep(200);
    check((await B.textContent('#midiBody')).includes('Prophet'), "the MIDI panel lists the band's parts");
    await A.evaluate(async () => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); for (const n of [48, 52, 55]) { JJ.input.press(n, 100); await s(150); JJ.input.release(n); await s(50); } });
    await sleep(900);
    const routed = await B.evaluate((k) => {
      const ons = JJ.engine.log.filter((e) => e.pid === k && e.type === 'on');
      const sent = JJ.midiLog().filter((m) => m.port === 'mock-b' && (m.data[0] & 0xf0) === 0x90);
      return { notes: sent.map((m) => m.data[1]).join(), ch: [...new Set(sent.map((m) => (m.data[0] & 15) + 1))].join(), err: ons.slice(-3).map((e, i) => Math.abs(sent[i].ts - JJ.clock.toLocal(e.at))), gain: JJ.engine.ch.get(k).out.gain.value };
    }, aKey);
    check(routed.notes === '48,52,55' && routed.ch === '10', `a bandmate's part plays on your gear (${routed.notes} on ch ${routed.ch})`);
    check(Math.max(...routed.err) < 1, `at the room's moment, not on arrival (max error ${Math.max(...routed.err).toFixed(2)} ms)`);
    check(routed.gain < 0.01, 'and the browser copy is muted');

    // 3. Sequenced hits route too: Sam's Machina kick on Matt's drum machine
    await A.evaluate(() => JJ.addInstrument('machina', '909'));
    await sleep(400);
    for (const i of [0, 4, 8, 12]) await (await A.$$('.md-trig'))[i].click();
    const mKey = await A.evaluate(() => JJ.S.me + ':' + JJ.S.rack[JJ.S.rack.length - 1].r);
    await sleep(600);
    await B.evaluate((k) => JJ.route(k, { port: 'mock-b', ch: 10, mute: true }), mKey);
    await A.click('.md-btn.play');
    await sleep(4500);
    await A.click('.md-transport .md-btn:nth-child(2)');
    await sleep(600);
    const hits = await B.evaluate((k) => {
      const seq = JJ.engine.log.filter((e) => e.pid === k && e.type === 'seq');
      const sent = JJ.midiLog().filter((m) => m.port === 'mock-b' && m.data[0] === 0x99 && m.data[1] === 36);
      const err = seq.map((e) => Math.min(...sent.map((m) => Math.abs(m.ts - JJ.clock.toLocal(e.at)))));
      return { seq: seq.length, sent: sent.length, err };
    }, mKey);
    check(hits.seq >= 4 && hits.sent === hits.seq && Math.max(...hits.err) < 1, `sequencer hits go to your drum machine on time (${hits.sent} kicks, max error ${Math.max(0, ...hits.err).toFixed(2)} ms)`);

    // 4. MIDI clock out from the room's tempo, Start on a bar
    await B.evaluate(() => JJ.setTempo(120));
    await sleep(600);
    await B.evaluate(() => JJ.clockOut({ port: 'mock-a', on: true }));
    await sleep(4500);   // Start waits for the next bar (up to 2 s at 120 bpm)
    await B.evaluate(() => JJ.clockOut({ on: false }));
    await sleep(200);
    const clk = await B.evaluate(() => {
      const log = JJ.midiLog().filter((m) => m.port === 'mock-a');
      const start = log.find((m) => m.data[0] === 0xfa), ticks = log.filter((m) => m.data[0] === 0xf8), stop = log.find((m) => m.data[0] === 0xfc);
      const gaps = ticks.slice(1).map((m, i) => m.ts - ticks[i].ts);
      const roomStart = start ? start.ts - (JJ.clock.toLocal(0)) : NaN;   // local -> room is a fixed offset
      return { start: !!start, stop: !!stop, n: ticks.length, gapMin: Math.min(...gaps), gapMax: Math.max(...gaps), beatAtStart: JJ.tempo.beatAt(roomStart), firstTickVsStart: ticks.length ? ticks[0].ts - start.ts : NaN, spp: log.some((m) => m.data[0] === 0xf2) };
    });
    const want = 60000 / 120 / 24;
    check(clk.start && clk.spp && clk.stop, 'clock out sends song position, Start and Stop');
    check(Math.abs(((clk.beatAtStart % 4) + 4) % 4) < 0.01 || Math.abs(((clk.beatAtStart % 4) + 4) % 4 - 4) < 0.01, `Start lands on a bar (beat ${clk.beatAtStart.toFixed(3)})`);
    check(clk.n > 96 && Math.abs(clk.gapMin - want) < 0.05 && Math.abs(clk.gapMax - want) < 0.05, `24 ticks per beat, evenly spaced (${clk.n} ticks, ${clk.gapMin.toFixed(3)}–${clk.gapMax.toFixed(3)} ms, want ${want.toFixed(3)})`);
    check(Math.abs(clk.firstTickVsStart) < 0.05, `the first tick is on the downbeat (${clk.firstTickVsStart})`);
    // 5. "I have one too": Matt owns a Moog One, Sam brings his. Matt hears Sam's part on his own Moog One.
    await B.evaluate(() => JJ.own('moog-moog-one', { port: 'mock-b', ch: 2 }));
    const rOne = await A.evaluate(() => JJ.addHardware('moog-moog-one').r);
    await sleep(1500);
    await A.evaluate((r) => { JJ.select(r); JJ.S.rack.find((e) => e.r === r).budget = 'balanced'; }, rOne);
    await A.evaluate(async () => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); for (const n of [36, 43]) { JJ.input.press(n, 100); await s(150); JJ.input.release(n); await s(60); } });
    await sleep(900);
    const one = await B.evaluate(() => {
      const k = [...JJ.S.routes.entries()].find(([, r]) => r.auto)?.[0];
      const sent = JJ.midiLog().filter((m) => m.port === 'mock-b' && m.data[0] === 0x91);
      return { k, auto: !!k, notes: sent.map((m) => m.data[1]).join(), gain: k ? JJ.engine.ch.get(k).out.gain.value : 1, chat: JJ.S.chat.map((c) => c.text).join(' | ') };
    });
    check(one.auto && one.notes === '36,43', `a bandmate who owns the same model hears it on their own (${one.notes} on ch 2)`);
    check(one.gain < 0.01 && /own Moog One/.test(one.chat), 'with the twin muted, and a note in chat');
    const aChat = await A.evaluate(() => JJ.S.chat.map((c) => c.text).join(' | '));
    check(/has a Moog One too/.test(aChat), 'and the player is told');
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } catch (e) { console.error(e); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
