// The relay restarting mid-jam, again and again: after each drop, does every browser still have exactly one entry per
// bandmate, registered, and do notes still flow both ways? (A phantom second entry, or a one-way silence, is a failure.)
//   node server/dev.js &      node tests/fleet/relaydrop.cjs [rooms] [drops per room]
const { chromium } = require('playwright');
const http = require('http');
const BASE = process.env.BASE || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const drop = () => new Promise((res) => http.get(new URL('__drop', BASE), (r) => { r.resume(); r.on('end', res); }).on('error', res));
(async () => {
  const ROOMS = +process.argv[2] || 10, DROPS = +process.argv[3] || 2; let bad = 0, total = 0; const fails = [];
  for (let k = 0; k < ROOMS; k++) {
    const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
    const mk = async (q, name, btn) => { const p = await (await b.newContext({ permissions: ['microphone'] })).newPage(); await p.goto(BASE + '?silent=1&lag=30&jitter=6' + q); await p.fill('#nameIn', name); await p.click(btn); await p.waitForSelector('#studio:not(.hide)'); return p; };
    const A = await mk('', 'Ana', '#startBtn'); const code = await A.textContent('#roomCode');
    const B = await mk('&room=' + code, 'Ben', '#joinBtn');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1))); if (ok.every(Boolean)) break; await sleep(200); }
    for (let d = 0; d < DROPS; d++) {
      await drop(); await sleep(7000);
      await Promise.all([A, B].map((p) => p.evaluate(async () => { JJ.engine.log.length = 0; for (let i = 0; i < 6; i++) { JJ.input.press(60 + i, 90); await new Promise((r) => setTimeout(r, 60)); JJ.input.release(60 + i); await new Promise((r) => setTimeout(r, 60)); } })));
      await sleep(1500);
      const st = await Promise.all([A, B].map((p) => p.evaluate(() => ({ me: JJ.S.me, players: [...JJ.S.players.keys()], peers: [...JJ.room.peers.values()].map((x) => `${x.id}:${x.path}`), heard: JJ.engine.log.filter((e) => e.type === 'on' && !e.pid.startsWith(JJ.S.me + ':')).length }))));
      const ok = st.every((s, i) => { const other = st[1 - i].me; return s.peers.length === 1 && s.peers[0].startsWith(other + ':') && s.players.length === 1 && s.players[0] === other && s.heard >= 6; });
      total++; if (!ok) { bad++; fails.push(st); }
      process.stdout.write(ok ? '.' : 'X');
    }
    await b.close();
  }
  console.log(`\n${bad} of ${total} drops left a phantom entry or a one-way silence`);
  for (const f of fails.slice(0, 5)) console.log(JSON.stringify(f));
  process.exit(bad ? 1 : 0);
})();
