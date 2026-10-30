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
    check(/4 of 4 free/.test(await A.textContent('#addSlot')), 'one add slot on your shelf, with all four free');
    check(/Your desk is empty/.test(await A.textContent('#plate')), 'the desk offers a first pick');
    await A.keyboard.down('a'); await sleep(100); await A.keyboard.up('a'); await sleep(200);
    check(/Pick an instrument first/.test(await A.evaluate(() => document.body.innerText)), 'playing a key says to pick something first');
    await A.click('#plate .quick >> text=Play some keys'); await sleep(600);
    check((await A.evaluate(() => JJ.S.rack.map((e) => e.cfg.inst).join())) === 'juniper' && /3 of 4 free/.test(await A.textContent('#addSlot')), 'one click puts keys on the desk; three slots left');
    await A.click('#rackList .cartx'); await sleep(400);
    check((await A.evaluate(() => JJ.S.rack.length)) === 0 && /Your desk is empty/.test(await A.textContent('#plate')), 'the last instrument can come off again');
    // Acoustic: numbered chord pads 1 to 7 even with no key set; a number key strums that chord
    await A.click('#plate .quick >> text=Something to strum');
    for (let i = 0; i < 40 && !(await A.evaluate(() => JJ.S.rack.length)); i++) await sleep(300);
    await sleep(500);
    const pads = await A.$$eval('#pads:not(.hide) .pad', (els) => els.map((e) => e.textContent.trim()));
    check(pads.length === 7 && pads[0].replace(/\s/g, '') === '1CI' && pads[4].replace(/\s/g, '') === '5GV', `Acoustic gets chord pads 1 to 7 in C with no key set (${pads.map((t) => t.replace(/\s+/g, '')).slice(0, 7).join(' ')})`);
    const n0 = await A.evaluate(() => JJ.engine.log.filter((e) => e.type === 'on').length);
    await A.keyboard.down('Digit5'); await sleep(300); await A.keyboard.up('Digit5'); await sleep(200);
    const ons = await A.evaluate((n0) => JJ.engine.log.filter((e) => e.type === 'on').slice(n0).map((e) => e.note % 12), n0);
    check(ons.length >= 3 && [7, 11, 2].every((pc) => ons.includes(pc)), `pressing 5 plays a G chord (${ons.join(',')})`);
    await A.keyboard.down('Shift'); await A.keyboard.down('Digit5'); await sleep(300); await A.keyboard.up('Digit5'); await A.keyboard.up('Shift'); await sleep(200);
    const ons7 = await A.evaluate((n0) => JJ.engine.log.filter((e) => e.type === 'on').slice(n0).map((e) => e.note % 12), n0 + ons.length);
    check(ons7.includes(5), `Shift+5 adds the seventh: G7 (${ons7.join(',')})`);
    await A.click('#rackList .cartx'); await sleep(300);
    // the Drummer tile on the wall
    await A.click('#addSlot'); await sleep(500);
    await A.click('#libCards .tile.drums .face'); await sleep(400);
    check((await A.$$('#libExtra .dgenre')).length >= 8, 'the Drummer tile opens every style by genre');
    await A.selectOption('#libExtra select', 'studio');
    await A.click('#libExtra .dgenre button >> text=Funk'); await sleep(800);
    const vp = await A.evaluate(() => Object.values(JJ.players())[0]);
    check(vp && vp.style === 'funk' && vp.kit === 'studio' && vp.name === 'Funk drummer', `picking Funk on the Studio kit brings in a ${vp ? vp.name : 'nothing'}`);
    check((await A.$$('.corner.vp')).length === 1, 'it takes a corner of its own');
    // no stray "null" anywhere: the sync take drawer and the section bar while a section loops
    await A.evaluate(() => { JJ.setSong('sec:v1', { name: 'Verse', bars: 2, chords: ['C', 'G'], notes: '' }); JJ.setSong('order', ['v1']); JJ.play('loop', 'v1'); });
    await sleep(1500);
    await A.click('#syncBtn'); await sleep(400);
    const nulls = await A.evaluate(() => (document.body.innerText.match(/\bnull\b/g) || []).length);
    check(nulls === 0, `no stray "null" on screen with the sync drawer and the section bar up (${nulls})`);
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } catch (e) { console.error(e); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
