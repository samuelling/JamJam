// A sequencer with many parts on one USB cable (a Cirklon: usb1, usb2… 16 channels each), on mock ports.
// MEGAjam listens while it plays and lists every port and channel with notes; each gets an instrument (a linked
// synth by channel, or a guess from the notes); the same channel on two ports stays apart; a port that is spoken
// for plays nothing it wasn't assigned; and run a lookahead ahead, its clock goes early by exactly what its notes
// are stamped with, so they land on the room's beat, on Matt's side too.
//   node server/dev.js &  (8787)        node tests/sequencer.test.cjs
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const b = await chromium.launch(); const errors = [];
  const mk = async (q, name) => { const c = await b.newContext({ viewport: { width: 1300, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?midimock=1&silent=1&lag=25&empty=1', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&midimock=1&silent=1&lag=25`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1))); if (ok.every(Boolean)) break; await sleep(300); }
    await sleep(800);
    // the Cirklon's USB ports, and Sam's OB-6 (on channel 1, behind a MIDI interface)
    await A.evaluate(async () => {
      await JJ.input.enableMIDI();
      JJ.input.inputs.push({ id: 'cirk-1', name: 'Cirklon usb1' }, { id: 'cirk-2', name: 'Cirklon usb2' });
      JJ.input.outputs.push({ id: 'cirk-out', name: 'Cirklon usb1', send: (data, ts) => JJ.input.mockLog.push({ port: 'cirk-out', data: [...data], ts: ts ?? performance.now(), sent: performance.now() }) });
      JJ.own('sequential-ob-6', { port: 'mock-a', ch: 1 });
      document.querySelector('#addHwBtn').click();
    });
    await sleep(300);
    const on = (port, st, n) => A.evaluate(([port, st, n]) => { JJ.input.onMIDI({ data: [st, n, 100], target: { id: port } }); JJ.input.onMIDI({ data: [st & 0xef, n, 0], target: { id: port } }); }, [port, st, n]);
    await A.evaluate(() => JJ.gear.listen(2));
    for (let i = 0; i < 4; i++) { await on('cirk-1', 0x90, 60 + i); await on('cirk-1', 0x92, 36 + i * 2); await on('cirk-2', 0x99, 36 + (i % 2) * 2); await on('cirk-2', 0x90, 72 + i); }
    await sleep(2400);
    const rows = await A.$$eval('#gearMine .seqrow', (rs) => rs.map((r) => [r.querySelector('b').textContent, r.querySelector('select').value]));
    check(rows.length === 4, `it hears four parts on two ports (${rows.map((r) => r.join(' → ')).join(' | ')})`);
    const pickOf = (label) => rows.find((r) => r[0] === label)?.[1];
    check(pickOf('Cirklon usb1 · ch 1') === 'gear:sequential-ob-6' && pickOf('Cirklon usb1 · ch 3') === 'monolith' && /studio|machina/.test(pickOf('Cirklon usb2 · ch 10')),
      'the linked OB-6 is matched by its channel, a low line gets a bass, channel 10 gets drums');
    // usb2's channel 1 is not the OB-6: a keys sound instead; and Sam's OB-6 plays from MEGAjam, in time with the band
    await A.evaluate(() => {
      const row = [...document.querySelectorAll('#gearMine .seqrow')].find((r) => r.querySelector('b').textContent === 'Cirklon usb2 · ch 1');
      const s = row.querySelector('select'); s.value = 'juniper'; s.dispatchEvent(new Event('change'));
    });
    await sleep(100);
    await A.evaluate(() => { const row = [...document.querySelectorAll('#gearMine .seqrow')].find((r) => r.querySelector('b').textContent === 'Cirklon usb1 · ch 1'); row.querySelector('input[type=checkbox]').click(); });
    await A.evaluate(() => { const sel = document.querySelector('#gearMine .seqclock select'); sel.value = 'cirk-out'; sel.dispatchEvent(new Event('change')); });
    await A.evaluate(() => [...document.querySelectorAll('#gearMine .seqclock button')].find((x) => /on my desk/.test(x.textContent)).click());
    await sleep(1500);
    const desk = await A.evaluate(() => JJ.S.rack.map((e) => ({ r: e.r, inst: e.cfg.inst, hw: e.cfg.hw || null, in: e.midiIn, ch: e.midiCh, out: e.midiOut, seq: !!e.seq })));
    check(desk.length === 4 && desk.every((e) => e.seq && e.in), `four instruments on the desk, each listening to its port and channel (${desk.map((e) => `${e.hw || e.inst}@${e.in}/${e.ch}`).join(', ')})`);
    const ob = desk.find((e) => e.hw === 'sequential-ob-6'), keys = desk.find((e) => !e.hw && e.inst === 'juniper');
    check(ob && ob.in === 'cirk-1' && ob.ch === 1 && ob.out === 'mock-a' && keys && keys.in === 'cirk-2' && keys.ch === 1, "the OB-6 listens to usb1 ch 1 and MEGAjam plays Sam's OB-6 for it; usb2 ch 1 is the keys");
    const mc = await A.evaluate(() => ({ ...JJ.S.mclock }));
    check(mc.on && mc.port === 'cirk-out' && mc.ahead && mc.aheadMs >= 30, `the room clock goes to the Cirklon, a lookahead ahead (${mc.aheadMs} ms)`);

    // the same channel on two ports reaches two instruments; an unassigned channel on a claimed port plays nothing
    const logOf = () => A.evaluate(() => JJ.engine.log.filter((x) => x.type === 'on').map((x) => `${x.pid}:${x.note}`));
    const before = (await logOf()).length;
    await on('cirk-1', 0x90, 61); await on('cirk-2', 0x90, 77); await on('cirk-2', 0x94, 50);
    await sleep(400);
    const got = (await logOf()).slice(before), me = await A.evaluate(() => JJ.S.me);
    check(got.includes(`${me}:${ob.r}:61`) && got.includes(`${me}:${keys.r}:77`) && got.length === 2, `usb1 ch 1 plays the OB-6 part, usb2 ch 1 the keys, usb2 ch 5 nothing (${got.join(', ')})`);

    // timing: a note from the sequencer is stamped exactly one run-ahead later; Sam's OB-6 gets it then; Matt hears it then
    const t = await A.evaluate(async () => {
      const n0 = JJ.input.mockLog.length, now = JJ.clock.now();
      JJ.input.onMIDI({ data: [0x90, 65, 100], target: { id: 'cirk-1' } });
      const ev = JJ.engine.log.filter((x) => x.type === 'on' && x.note === 65).pop();
      await new Promise((r) => setTimeout(r, 50));
      const out = JJ.input.mockLog.slice(n0).find((m) => m.port === 'mock-a' && m.data[1] === 65);
      JJ.input.onMIDI({ data: [0x80, 65, 0], target: { id: 'cirk-1' } });
      return { stamp: ev.at - now, ahead: JJ.S.mclock.aheadMs, outLead: out ? out.ts - out.sent : null };
    });
    check(Math.abs(t.stamp - t.ahead) < 3, `a sequenced note is stamped one run-ahead later (${t.stamp.toFixed(1)} ms vs ${t.ahead})`);
    check(t.outLead != null && Math.abs(t.outLead - t.ahead) < 6, `and Sam's OB-6 plays it then, with the band (${t.outLead?.toFixed(1)} ms later)`);
    await sleep(800);
    const mattHeard = await B.evaluate(() => JJ.engine.log.some((x) => x.type === 'on' && x.note === 65));
    check(mattHeard, 'Matt hears it too');
    // the clock: Start lands one run-ahead before the bar it starts
    const clk = await A.evaluate(() => {
      const m = JJ.S.mclock, st = JJ.input.mockLog.find((x) => x.port === 'cirk-out' && x.data[0] === 0xfa);
      return st ? { lead: JJ.clock.toLocal(JJ.tempo.timeOf(m.startBar)) - st.ts, ahead: m.aheadMs, ticks: JJ.input.mockLog.filter((x) => x.port === 'cirk-out' && x.data[0] === 0xf8).length } : null;
    });
    check(clk && Math.abs(clk.lead - clk.ahead) < 2 && clk.ticks > 10, `the clock's Start goes one run-ahead before its bar (${clk && clk.lead.toFixed(1)} ms early, ${clk && clk.ticks} ticks)`);
    check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  } finally { await b.close(); }
  console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
