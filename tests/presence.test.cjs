// Who's in the room, kept right through the awkward moments: a hello that goes missing heals itself, a jammer who
// leaves is gone from everyone's room at once (not 12 s later), the tempo stays shared when the clock leader leaves
// and a follower changes it straight away, and the relay restarting leaves no phantom bandmate behind.
//   node server/dev.js &  (8787)        node tests/presence.test.cjs
const { chromium } = require('playwright');
const http = require('http');
const BASE = process.argv[2] || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
const drop = () => new Promise((res) => http.get(new URL('__drop', BASE), (r) => { r.resume(); r.on('end', res); }).on('error', res));
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const mk = async (q, name, btn, init) => {
    const p = await (await b.newContext()).newPage(); p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    if (init) await p.addInitScript(init);
    await p.goto(BASE + '?silent=1&lag=30&jitter=6' + q); await p.fill('#nameIn', name); await p.click(btn); await p.waitForSelector('#studio:not(.hide)'); return p;
  };
  const players = (p) => p.evaluate(() => [...JJ.S.players.values()].map((x) => x.name).sort().join(','));
  const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return Date.now() - t; await sleep(100); } return null; };
  try {
    // 1. Ben's first hello is lost on the way; Ana still meets him, by asking
    const A = await mk('', 'Ana', '#startBtn');
    const code = await A.textContent('#roomCode');
    const B = await mk('&room=' + code, 'Ben', '#joinBtn', () => {
      const t = setInterval(() => { const r = window.JJ && window.JJ.room; if (!r) return; clearInterval(t); const send = r.send.bind(r); let dropped = false;
        r.send = (m, id) => { if (!dropped && m && m.k === 'hello') { dropped = true; window.__helloDropped = true; return; } return send(m, id); }; }, 5);
    });
    const healed = await until(async () => (await players(A)) === 'Ben');
    check(await B.evaluate(() => !!window.__helloDropped), "Ben's first hello really was lost");
    check(healed != null, `Ana meets Ben anyway: she asks who he is, he says hello again (${healed} ms)`);
    check((await players(B)) === 'Ana', 'and Ben has Ana');

    // 2. a third joins; then the clock leader (Ana) leaves, and Ben changes the tempo a second later
    const C = await mk('&room=' + code, 'Cy', '#joinBtn');
    await until(async () => (await players(A)) === 'Ben,Cy' && (await players(B)) === 'Ana,Cy' && (await players(C)) === 'Ana,Ben');
    await sleep(2000);
    await A.click('#leaveBtn');
    const goneB = await until(async () => (await players(B)) === 'Cy'), goneC = await until(async () => (await players(C)) === 'Ben');
    check(goneB != null && goneB < 2000 && goneC != null && goneC < 2000, `Ana is gone from both rooms at once (${goneB} ms, ${goneC} ms; it used to take 12 s)`);
    await sleep(1000);
    await B.evaluate(() => JJ.setTempo(131));
    const agreed = await until(async () => (await Promise.all([B, C].map((p) => p.evaluate(() => JJ.tempo.bpm(JJ.clock.now() + 1500))))).every((x) => x === 131), 5000);
    const lead = await Promise.all([B, C].map((p) => p.evaluate(() => JJ.clock.isLeader)));
    check(agreed != null && lead.filter(Boolean).length === 1, `the new tempo reaches both who stayed, under one new leader (${agreed} ms)`);

    // 3. the relay restarts: no phantom bandmate, and notes flow both ways
    await drop(); await sleep(7000);
    const peers = await Promise.all([B, C].map((p) => p.evaluate(() => [...JJ.room.peers.values()].map((x) => x.id))));
    const mes = await Promise.all([B, C].map((p) => p.evaluate(() => JJ.S.me)));
    check(peers[0].length === 1 && peers[0][0] === mes[1] && peers[1].length === 1 && peers[1][0] === mes[0], `after the relay restarts each has exactly one entry for the other (${JSON.stringify(peers)})`);
    await Promise.all([B, C].map((p) => p.evaluate(async () => { JJ.engine.log.length = 0; for (let i = 0; i < 6; i++) { JJ.input.press(60 + i, 90); await new Promise((r) => setTimeout(r, 60)); JJ.input.release(60 + i); await new Promise((r) => setTimeout(r, 60)); } })));
    await sleep(1500);
    const heard = await Promise.all([B, C].map((p) => p.evaluate(() => JJ.engine.log.filter((e) => e.type === 'on' && !e.pid.startsWith(JJ.S.me + ':')).length)));
    check(heard.every((n) => n >= 6), `and each hears the other's notes (${heard.join(', ')})`);
    // 4. a fourth walks in after all that
    const D = await mk('&room=' + code, 'Dee', '#joinBtn');
    check(await until(async () => (await players(D)) === 'Ben,Cy' && (await players(B)) === 'Cy,Dee') != null, 'a newcomer still walks in and meets everyone');
  } catch (e) { check(false, 'threw: ' + e.message); }
  check(!errors.length, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await b.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
