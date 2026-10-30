// Two jammers with the same synth (an OB-6, on mock MIDI ports): Matt hears Sam's part on his own OB-6, gets Sam's
// current sound by SysEx (Sam's browser asks Sam's synth for its edit buffer; Matt's plays it into his), and Sam's
// knob moves follow: a CC, an NRPN kept in one piece, a program change (which brings the new sound across too).
// Also: guessing a synth from its port name, and the "is this your OB-6?" prompt.
//   node server/dev.js &  (8787)        node tests/gear.test.cjs
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
const OB6 = 'sequential-ob-6';
(async () => {
  const b = await chromium.launch(); const errors = [];
  const mk = async (q, name) => { const c = await b.newContext(); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?midimock=1&silent=1&lag=25', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&midimock=1&silent=1&lag=25`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1))); if (ok.every(Boolean)) break; await sleep(300); }
    await sleep(800);

    // port names to synths
    const g = await A.evaluate(() => ['OB-6', 'Prophet Rev2 Module', 'minilogue xd', 'USB MIDI Interface', 'IAC Driver Bus 1', 'Digitone'].map((n) => JJ.gear.guessUnit(n)?.id || null));
    check(g[0] === 'sequential-ob-6' && g[2] && /minilogue-xd/.test(g[2]) && g[3] === null && g[4] === null, `port names map to synths, generic ports to nothing (${g.join(', ')})`);

    // Sam's OB-6 answers like an OB-6: its identity, and its edit buffer when asked
    const DUMP = [0xf0, 0x01, 0x2e, 0x03, ...Array.from({ length: 40 }, (_, i) => (i * 7) & 0x7f), 0xf7];
    await A.evaluate((DUMP) => {
      window.DUMPS = 0;
      JJ.input.mockReply = (d) => {
        if (d[0] === 0xf0 && d[1] === 0x7e && d[4] === 0x01) return [[0xf0, 0x7e, 0x00, 0x06, 0x02, 0x01, 0x2e, 0x01, 0x00, 0x00, 0x01, 0x05, 0x00, 0x00, 0xf7]];
        if (d.join(' ') === [0xf0, 0x01, 0x2e, 0x06, 0xf7].join(' ')) { window.DUMPS++; return [DUMP.map((x, i) => (i === 10 ? (x + window.DUMPS) & 0x7f : x))]; }
        return null;
      };
    }, DUMP);
    for (const p of [A, B]) await p.evaluate((id) => { const u = JJ.engine.unit(id); if (!u.dump) u.dump = { request: 'F0 01 2E 06 F7', reply: 'F0 01 2E 03', replies: 1 }; }, OB6);

    // both link an OB-6; Matt allows SysEx; Sam puts his on the desk
    await A.evaluate((id) => { JJ.own(id, { port: 'mock-a', ch: 1 }); return JJ.gear.allowSysex(); }, OB6);
    await B.evaluate((id) => { JJ.own(id, { port: 'mock-b', ch: 3 }); return JJ.gear.allowSysex(); }, OB6);
    const r = await A.evaluate((id) => { JJ.gear.play(id); return JJ.S.rack.find((e) => e.cfg.hw === id)?.r; }, OB6);
    check(!!r, 'Play it puts the linked OB-6 on the desk, with its best twin for everyone else');
    await sleep(2500);
    const route = await B.evaluate(() => [...JJ.S.routes.values()].find((x) => x.same));
    check(route && route.port === 'mock-b' && route.ch === 3, `Matt's browser plays Sam's OB-6 part on Matt's own OB-6 (${JSON.stringify(route)})`);
    const sx = () => B.evaluate(() => JJ.midiLog().filter((m) => m.port === 'mock-b' && m.data[0] === 0xf0 && m.data[1] !== 0x7e));   // not Matt's own identity request
    let got = await sx();
    check(got.length === 1 && got[0].data.length === DUMP.length && got[0].data[3] === 0x03, `the handshake copies Sam's current sound into Matt's OB-6 (${got.length} dump, ${got[0]?.data.length} bytes)`);
    const chatB = await B.evaluate(() => JJ.S.chat.map((c) => c.text).join(' | '));
    check(/sound is on yours now/.test(chatB), 'Matt is told the sound arrived, and that his saved programs are untouched');

    // knob moves: a CC, an NRPN, then a program change
    const mark = await B.evaluate(() => JJ.midiLog().length);
    await A.evaluate(() => {
      JJ.input.onMIDI({ data: [0xb0, 74, 100] });
      for (const d of [[0xb0, 99, 0], [0xb0, 98, 43], [0xb0, 6, 1], [0xb0, 38, 16]]) JJ.input.onMIDI({ data: d });
    });
    await sleep(800);
    const cc = await B.evaluate((mark) => JJ.midiLog().slice(mark).filter((m) => m.port === 'mock-b').map((m) => m.data), mark);
    check(cc.some((d) => d.join(',') === [0xb2, 74, 100].join(',')), `a CC from Sam's OB-6 reaches Matt's, on Matt's channel (${JSON.stringify(cc[0])})`);
    check(cc.some((d) => d.join(',') === [0xb2, 99, 0, 0xb2, 98, 43, 0xb2, 6, 1, 0xb2, 38, 16].join(',')), 'an NRPN arrives as one piece: number and value together');
    await A.evaluate(() => JJ.input.onMIDI({ data: [0xc0, 5] }));
    await sleep(2500);
    const after = await B.evaluate((mark) => JJ.midiLog().slice(mark).filter((m) => m.port === 'mock-b').map((m) => m.data), mark);
    got = await sx();
    check(after.some((d) => d[0] === 0xc2 && d[1] === 5), 'a program change follows');
    check(got.length === 2 && got[1].data[10] !== got[0].data[10], `and the new sound comes across after it (${got.length} dumps)`);

    // timing: the dump lands no earlier than the moment it was stamped for (a bar line when a song is playing)
    const late = await B.evaluate(() => { const l = JJ.midiLog().filter((m) => m.port === 'mock-b' && m.data[0] === 0xf0); return l.every((m) => m.ts >= m.sent - 1); });
    check(late, 'the dump is scheduled ahead, not sent the moment it arrives');

    // a Roland JV-1080: its sound is asked for in five blocks (one RQ1 each), and all five replies come across
    await A.evaluate(() => {
      const prev = JJ.input.mockReply;
      JJ.input.mockReply = (d, port) => (d[0] === 0xf0 && d[1] === 0x41 && d[4] === 0x11 ? [[0xf0, 0x41, 0x10, 0x6a, 0x12, ...d.slice(5, 9), 1, 2, 3, 0x22, 0xf7]] : prev(d, port));
      JJ.own('roland-jv-1080', { port: 'mock-b', ch: 1 }); JJ.gear.play('roland-jv-1080');
    });
    await B.evaluate(() => JJ.own('roland-jv-1080', { port: 'mock-a', ch: 1 }));
    await sleep(3500);
    const jv = await B.evaluate(() => JJ.midiLog().filter((m) => m.port === 'mock-a' && m.data[0] === 0xf0 && m.data[1] === 0x41).map((m) => m.data.slice(4, 9).join('.')));
    const asks = await A.evaluate(() => JJ.midiLog().filter((m) => m.port === 'mock-b' && m.data[1] === 0x41 && m.data[4] === 0x11).length);
    check(asks === 5 && jv.length === 5 && new Set(jv).size === 5, `a five-block Roland sound is asked for block by block and arrives whole (${asks} requests, ${jv.length} blocks)`);

    // the My gear panel shows the linked synth and who plays on it
    await A.evaluate(() => document.querySelector('#addHwBtn').click()); await sleep(300);
    const panel = await A.evaluate(() => document.querySelector('#gearMine')?.textContent || '');
    check(/OB-6/.test(panel) && /Matt on theirs/.test(panel) && /Send my sound/.test(panel), `My gear lists the linked OB-6 and that Matt plays it on his (${panel.slice(0, 120)})`);

    // a recognised port that isn't linked yet: the prompt
    const prompted = await B.evaluate(() => { JJ.input.outputs.push({ id: 'mock-c', name: 'Prophet-6', send() {} }); JJ.gear.check(); return document.querySelector('.gearprompt')?.textContent || ''; });
    check(/Prophet-6/.test(prompted), `plugging in a synth MEGAjam knows by name asks whether it's yours (${prompted.slice(0, 60)})`);
    check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  } finally { await b.close(); }
  console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
