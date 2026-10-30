// A screenshot tour of every main view at 1400 and 1000 px into /tmp/shots (not a test: for checking the look).
//   node server/dev.js &  (8787)        node tests/tour.cjs   (needs /tmp/songs/blue-dorian.json for the Compose Room)
const { chromium } = require('playwright'); const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  for (const W of [1400, 1000]) {
    const c = await b.newContext({ viewport: { width: W, height: 860 } }); const p = await c.newPage(); const shot = (n) => p.screenshot({ path: `/tmp/shots/${W}-${n}.png` });
    await p.goto('http://localhost:8787/?doors=1&picks=1&empty=1'); await sleep(800); await shot('01-lobby');
    await p.fill('#nameIn', 'Sam'); await p.click('#startBtn'); await p.waitForSelector('#studio:not(.hide)'); await sleep(900); await shot('02-hall');
    await p.evaluate(() => JJ.goRoom('jam')); await sleep(600); await shot('03-jam-firstpick');
    await p.evaluate(() => document.querySelectorAll('.drawer').forEach((d) => d.classList.add('hide'))); await sleep(300); await shot('04-jam-empty');
    await p.evaluate(() => { const e = JJ.addInstrument('juniper', 'keys'); JJ.select(e.r); }); await sleep(600); await shot('05-jam-juniper');
    await p.click('#addSlot'); await sleep(500); await shot('06-wall');
    await p.click('#libCards .tile.drums .face'); await sleep(400); await p.evaluate(() => document.querySelector('#libExtra')?.scrollIntoView()); await sleep(300); await shot('07-drummers');
    await p.evaluate(() => document.querySelectorAll('.drawer').forEach((d) => d.classList.add('hide')));
    await p.click('#addHwBtn'); await sleep(500); await shot('08-hardware'); await p.evaluate(() => document.querySelectorAll('.drawer').forEach((d) => d.classList.add('hide')));
    await p.click('#copyBtn'); await sleep(500); await shot('09-invite'); await p.evaluate(() => document.querySelectorAll('.drawer').forEach((d) => d.classList.add('hide')));
    await p.click('#syncBtn'); await sleep(400); await shot('10-sync'); await p.evaluate(() => document.querySelectorAll('.drawer').forEach((d) => d.classList.add('hide')));
    await p.evaluate(() => JJ.addVirtual('drums', 'funk')); await sleep(800);
    const song = JSON.parse(fs.readFileSync('/tmp/songs/blue-dorian.json', 'utf8'));
    await p.evaluate((t) => { JJ.goRoom('compose'); JJ.loadSong(JJ.songFromTracker(t)); }, song); await sleep(1500); await shot('11-compose');
    await p.evaluate(() => document.querySelector('#compose .lanetoggle')?.click()); await sleep(300); await p.click('#compose .cell.take'); await sleep(400); await shot('12-compose-lanes');
    await p.evaluate(() => { JJ.goRoom('jam'); JJ.play('loop', JJ.song().order[1]); }); await sleep(3500); await shot('13-jam-loop');
    await p.evaluate(() => { const e = JJ.addInstrument('pads', 'chops'); JJ.select(e.r); }); await sleep(800); await shot('14-pads');
    await p.click('#techBtn'); await sleep(400); await shot('15-tech');
    await c.close();
  }
  await b.close();
})();
