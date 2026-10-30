// Libraries: instruments loaded from another origin (another GitHub repo, a friend's build on their machine).
// Public library: a bandmate's browser loads it automatically. Private library: its address is never shared; a
// stand-in plays until that jammer adds their own copy, then the real instrument takes over.
//   node server/dev.js &  (8790)        node tests/library.test.cjs
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const BASE = process.argv[2] || 'http://localhost:8790/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };

(async () => {
  // the public library on one origin, a private copy on another
  const fx = path.join(__dirname, 'fixtures', 'ext-lib');
  const priv = fs.mkdtempSync(path.join(os.tmpdir(), 'jjpriv-'));
  for (const f of fs.readdirSync(fx)) fs.copyFileSync(path.join(fx, f), path.join(priv, f));
  const man = JSON.parse(fs.readFileSync(path.join(priv, 'megajam.json'), 'utf8')); fs.unlinkSync(path.join(priv, 'megajam.json'));  // the private copy uses the pre-rename name: tests the fallback
  man.id = 'secretlab'; man.name = 'Secret Lab'; man.private = true;
  fs.writeFileSync(path.join(priv, 'jamjam.json'), JSON.stringify(man));
  const servers = [spawn('python3', ['-I', path.join(__dirname, '..', 'tools', 'serve-library.py'), fx, '--port', '8792']), spawn('python3', ['-I', path.join(__dirname, '..', 'tools', 'serve-library.py'), priv, '--port', '8793'])];
  await sleep(800);
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const mk = async (q, name) => { const c = await browser.newContext(); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?lag=30', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=30`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1))); if (ok.every(Boolean)) break; await sleep(300); }
    await sleep(2500);

    // 1. public library from another origin
    const libId = await A.evaluate(() => JJ.addLibrary('http://localhost:8792/'));
    check(libId === 'testlab', 'a library loads from another origin (CORS server)');
    await A.click('#addInstBtn'); await A.click('#libTabs .page:nth-child(2)'); await sleep(200);
    const cards = await A.$$eval('#libCards .card .name', (n) => n.map((x) => x.textContent));
    check(cards.join() === 'Wobble,Beep A,Beep B', `the gear wall lists the library's instruments (${cards.join(', ')})`);
    await A.keyboard.press('Escape');
    const r1 = await A.evaluate(() => JJ.addFromLibrary('testlab/wobble', 'fast'));
    await sleep(2500);
    const bWob = await B.evaluate(() => ({ libs: [...JJ.engine.libs.keys()], has: JJ.engine.defs.has('testlab/wobble'), standins: JJ.S.standins.size }));
    check(bWob.has && bWob.libs.includes('testlab') && bWob.standins === 0, "a bandmate's browser loads a public library by itself");
    // both play the same thing
    await A.evaluate(async () => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); for (let i = 0; i < 6; i++) { JJ.input.press(60 + i, 100); await s(120); JJ.input.release(60 + i); await s(60); } });
    await sleep(1200);
    const heard = await Promise.all([A, B].map((p) => p.evaluate((r) => JJ.engine.log.filter((e) => e.pid.endsWith(':' + r) && e.type === 'on').map((e) => e.note + '@' + Math.round(e.at)).join(','), r1)));
    check(heard[0] && heard[0] === heard[1], 'the library instrument plays the same notes at the same times in both browsers');
    const aIdx = await A.evaluate((r) => JJ.engine.ch.get(JJ.S.me + ':' + r).insts[0].def.id, r1);
    const bIdx = await B.evaluate((r) => { const k = [...JJ.engine.ch.keys()].find((x) => x.endsWith(':' + r) && !x.startsWith(JJ.S.me)); return JJ.engine.ch.get(k).insts[0].def.id; }, r1);
    check(aIdx === 'testlab/wobble' && bIdx === 'testlab/wobble', `and it is the real instrument on both sides (${aIdx}, ${bIdx})`);

    // 2. private library: a stand-in until Matt adds his own copy
    await A.evaluate(() => JJ.addLibrary('http://localhost:8793/'));
    const r2 = await A.evaluate(() => JJ.addFromLibrary('secretlab/beep-b'));
    await sleep(2000);
    const bPriv = await B.evaluate(() => ({ libs: [...JJ.engine.libs.keys()], standins: [...JJ.S.standins.values()].map((x) => x.wanted.inst), chat: JJ.S.chat.map((c) => c.text).join(' | '), corners: document.querySelector('#corners').textContent }));
    check(!bPriv.libs.includes('secretlab'), "a private library's address is not shared");
    check(bPriv.standins.includes('secretlab/beep-b') && /stand-in/.test(bPriv.chat) && /stand-in/.test(bPriv.corners), 'the bandmate hears a stand-in, and is told so in chat and in the booth');
    const sentUrl = await A.evaluate((r) => JSON.stringify(JJ.S.rack.find((e) => e.r === r).cfg.lib), r2);
    check(!/8793/.test(sentUrl), `the private library's url is left out of what is sent (${sentUrl})`);
    await B.evaluate(() => JJ.addLibrary('http://localhost:8793/'));
    await sleep(1500);
    const bAfter = await B.evaluate(() => ({ standins: JJ.S.standins.size, inst: [...JJ.engine.ch.entries()].filter(([k]) => !k.startsWith(JJ.S.me)).map(([, c]) => c.insts[0]?.def.id) }));
    check(bAfter.standins === 0 && bAfter.inst.includes('secretlab/beep-b'), 'once the bandmate adds their own copy, the real instrument replaces the stand-in');
    await sleep(9000);
    const fp = await Promise.all([A, B].map((p) => p.evaluate(() => [...JJ.S.sync.values()].map((s) => s.ok))));
    check(fp.every((x) => x.length && x.every(Boolean)), `fingerprints agree once the real instrument is in (${JSON.stringify(fp)})`);
    const remembered = await B.evaluate(() => JSON.parse(localStorage.getItem('megajam.libs') || '[]'));
    check(remembered.length === 2, 'libraries are remembered in the browser');
  } finally {
    check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
    await browser.close();
    for (const s of servers) s.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
