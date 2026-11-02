// Join reliability: open N rooms of three players (the third arriving right behind the second) and check every browser
// registered every bandmate. A bandmate missing from one side is the "invisible bandmate" the fleet found.
//   node server/dev.js &      node tests/fleet/joins.cjs [rooms] [lag ms]
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const N = +process.argv[2] || 30, lag = process.argv[3] || '30'; let bad = 0; const fails = [];
  for (let k = 0; k < N; k++) {
    const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
    const mk = async (q, name, btn) => { const p = await (await b.newContext({ permissions: ['microphone'] })).newPage(); await p.goto('http://localhost:8787/?silent=1&lag=' + lag + '&jitter=6' + q); await p.fill('#nameIn', name); await p.click(btn); await p.waitForSelector('#studio:not(.hide)'); return p; };
    const A = await mk('', 'Ana', '#startBtn'); const code = await A.textContent('#roomCode');
    const B = await mk('&room=' + code, 'Ben', '#joinBtn'); const C = await mk('&room=' + code + '&lag=90', 'Cy', '#joinBtn');
    await sleep(9000);
    const st = await Promise.all([A, B, C].map((p) => p.evaluate(() => ({ players: JJ.S.players.size, peers: [...JJ.room.peers.values()].map((x) => ({ path: x.path, opened: !!x.opened, dc: x.dc?.readyState, fast: x.fast?.readyState, pc: x.pc?.connectionState, sig: x.pc?.signalingState, rtt: x.rtt.length })) }))));
    const ok = st.every((s) => s.players === 2);
    if (!ok) { bad++; fails.push(st); }
    process.stdout.write(ok ? '.' : 'X');
    await b.close();
  }
  console.log(`\n${bad} of ${N} joins left a bandmate invisible to one side`);
  for (const f of fails) console.log(JSON.stringify(f));
})();
