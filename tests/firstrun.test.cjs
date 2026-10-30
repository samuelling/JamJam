// Walking in with an empty desk: four empty slots, a desk that offers a first pick, keys that say to pick something,
// the last instrument can be removed again, and the Drummer tile on the wall brings a drummer of any style and kit.
//   node server/dev.js &  (8787)        node tests/firstrun.test.cjs
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  try {
    const c = await browser.newContext({ viewport: { width: 1400, height: 900 } }); const A = await c.newPage(); A.on('pageerror', (e) => errors.push(e.message));
    await A.goto('http://localhost:8787/?empty=1'); await A.fill('#nameIn', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    await sleep(800);
    check((await A.evaluate(() => JJ.S.rack.length)) === 0, 'you walk in with nothing on your desk');
    check((await A.$$('#rackList .emptyslot')).length === 4, 'four empty slots on your shelf');
    check(/Your desk is empty/.test(await A.textContent('#plate')), 'the desk offers a first pick');
    await A.keyboard.down('a'); await sleep(100); await A.keyboard.up('a'); await sleep(200);
    check(/Pick an instrument first/.test(await A.evaluate(() => document.body.innerText)), 'playing a key says to pick something first');
    await A.click('#plate .quick >> text=Play some keys'); await sleep(600);
    check((await A.evaluate(() => JJ.S.rack.map((e) => e.cfg.inst).join())) === 'juniper' && (await A.$$('#rackList .emptyslot')).length === 3, 'one click puts keys on the desk; three slots left');
    await A.click('#rackList .cartx'); await sleep(400);
    check((await A.evaluate(() => JJ.S.rack.length)) === 0 && /Your desk is empty/.test(await A.textContent('#plate')), 'the last instrument can come off again');
    // the Drummer tile on the wall
    await A.click('#rackList .emptyslot >> nth=0'); await sleep(500);
    await A.click('#libCards .tile.drums .face'); await sleep(400);
    check((await A.$$('#libExtra .dgenre')).length >= 8, 'the Drummer tile opens every style by genre');
    await A.selectOption('#libExtra select', 'studio');
    await A.click('#libExtra .dgenre button >> text=Funk'); await sleep(800);
    const vp = await A.evaluate(() => Object.values(JJ.players())[0]);
    check(vp && vp.style === 'funk' && vp.kit === 'studio' && vp.name === 'Funk drummer', `picking Funk on the Studio kit brings in a ${vp ? vp.name : 'nothing'}`);
    check((await A.$$('.corner.vp')).length === 1, 'it takes a corner of its own');
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } catch (e) { console.error(e); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
