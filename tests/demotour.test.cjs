// The demo studio: from the lobby's "Try the demo studio", a studio of your own with the demo song (src/demo.js),
// its recorded guitar take saved to the studio, and the "Explore the demo song" tour walked start to finish.
//   node server/dev.js &  (8787)    (cd studio && npx wrangler dev --port 8799) &    node tests/demotour.test.cjs
// SHOTS=1 saves a screenshot of every step in /tmp/shots/demotour-*.png
const { chromium } = require('playwright'); const fs = require('fs');
const BASE = 'http://localhost:8787/', SV = process.env.STUDIOS || 'http://localhost:8799';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) fails++; };
(async () => {
  if (process.env.SHOTS) fs.mkdirSync('/tmp/shots', { recursive: true });
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 820 } })).newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${BASE}?studios=${encodeURIComponent(SV)}`); await p.fill('#nameIn', 'Sam');
  check(!!(await p.$('text=Try the demo studio')), 'the lobby offers the demo studio');
  await p.click('text=Try the demo studio'); await p.waitForSelector('#studio:not(.hide)', { timeout: 20000 });
  let a = null; for (let i = 0; i < 20 && !a; i++) { await sleep(300); a = await p.evaluate(() => JJ.tours.active()); }
  const st = await p.evaluate(() => ({ id: JJ.studio.id, name: JJ.studio.name, title: JJ.song().title, where: JJ.S.where }));
  check(st.id && st.name === 'Demo studio' && st.title === 'Demo Song' && st.where === 'compose', `it opens a studio of your own with the demo song, in the Compose Room (${st.id})`);
  check(a?.name === 'demo', 'and the demo tour starts by itself');
  const seen = []; let n = 0;
  for (let guard = 0; guard < 80; guard++) {
    a = await p.evaluate(() => JJ.tours.active()); if (!a) break;
    if (seen.at(-1) !== a.step) { seen.push(a.step); n++; if (process.env.SHOTS) await p.screenshot({ path: `/tmp/shots/demotour-${String(n).padStart(2, '0')}-${a.step}.png` });
      if (!(await p.evaluate(() => !!JJ.tours.target())) && a.step !== 'end') console.log(`  (step ${a.step} has nothing lit)`); }
    if (a.step === 'end') { await p.click('.tour-actions button:has-text("Done")'); break; }
    if (!a.passed) { const nx = await p.$('.tour-next'), sh = await p.$('.tour-show'); if (nx) await nx.click(); else if (sh) await sh.click(); }
    await sleep(500);
  }
  console.log('  steps:', seen.join(' › '));
  check(seen.join() === 'song,tracks,rows,play,chorus,loop,lead,pick,guitar,templates,yours,end', 'the tour runs every step, in order');
  const lead = await p.evaluate(() => { const S2 = JJ.song(), c = S2.order.find((id) => S2.sections[id].name === 'Chorus'); return Object.values(S2.sections[c].parts).find((q) => q.name === 'Lead')?.current; });
  check(lead === 'demo-kai', 'picking Kai\'s take happened for real');
  await p.evaluate(() => JJ.stopSong?.() || JJ.tours.stop());
  let clips = null; for (let i = 0; i < 30; i++) { clips = await (await fetch(`${SV}/studios/${st.id}/clips`)).json(); if (clips.ids.includes('demogtr1')) break; await sleep(500); }
  check(clips.ids.includes('demogtr1'), 'the recorded guitar take is saved in the studio');
  const saved = (await (await fetch(`${SV}/studios/${st.id}`)).json()).song;
  check(saved.title === 'Demo Song' && saved.order.length === 6 && Object.keys(saved).filter((k) => k.startsWith('part:')).length === 14, `the whole song is saved in the studio (${Object.keys(saved).filter((k) => k.startsWith('part:')).length} parts)`);
  // someone else (or you, another day) walking in hears the guitar from the studio
  const q = await (await b.newContext()).newPage(); q.on('pageerror', (e) => errors.push('2: ' + e.message));
  await q.goto(`${BASE}?studios=${encodeURIComponent(SV)}`); await q.fill('#nameIn', 'Kai');
  await p.evaluate(() => JJ.leave()); await sleep(500);
  await q.evaluate((id) => JJ.enterStudio(id), st.id); await q.waitForSelector('#studio:not(.hide)', { timeout: 20000 });
  let has = false; for (let i = 0; i < 40 && !has; i++) { await sleep(300); has = await q.evaluate(() => JJ.blobs.has('demogtr1') && JJ.song().title === 'Demo Song'); }
  check(has, 'coming back to it later, the song and the guitar are there');
  check(!(await q.evaluate(() => JJ.tours.active())), "and the tour doesn't start again for a studio you already have");
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})();
