// Clear the song, in a band studio: Song options › Clear song… (it asks first) leaves a blank page for everyone,
// with the tempo and key as they were; the cleared song is what the studio keeps; Undo brings back every section,
// track, take and saved version, and the studio keeps that again.
//   node server/dev.js &  (8787)    (cd studio && npx wrangler dev --port 8799) &    node tests/clearsong.test.cjs
const { chromium } = require('playwright');
const BASE = 'http://localhost:8787/', SV = process.env.STUDIOS || 'http://localhost:8799';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) fails++; };
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage(); const errors = [], asked = [];
  p.on('pageerror', (e) => errors.push(e.message)); p.on('dialog', (d) => { asked.push(d.message()); d.accept(); });
  try {
    await p.goto(`${BASE}?studios=${encodeURIComponent(SV)}`); await p.fill('#nameIn', 'Sam');
    await p.click('text=Try the demo studio'); await p.waitForSelector('#studio:not(.hide)', { timeout: 20000 });
    await sleep(1500); await p.evaluate(() => JJ.tours.stop?.());
    const id = await p.evaluate(() => JJ.studio.id);
    await p.evaluate(() => JJ.saveVar('Rough mix'));
    const before = await p.evaluate(() => ({ bpm: Math.round(JJ.tempo.bpm(JJ.clock.now())), key: JJ.song().key, n: JJ.song().order.length }));
    const saved = async () => { const s = (await (await fetch(`${SV}/studios/${id}`)).json()).song || {}; return { order: (s.order || []).length, parts: Object.keys(s).filter((k) => k.startsWith('part:') && s[k]).length, title: s.title }; };
    let sv0 = null; for (let i = 0; i < 30; i++) { sv0 = await saved(); if (sv0.parts >= 14) break; await sleep(500); }
    check(before.n === 6 && sv0.parts >= 14, `the demo song is in the studio (${before.n} sections, ${sv0.parts} parts)`);
    let hasVar = false; for (let i = 0; i < 20 && !hasVar; i++) { hasVar = !!((await (await fetch(`${SV}/studios/${id}`)).json()).song || {})['var:Rough_mix']; if (!hasVar) await sleep(500); }
    check(hasVar, 'a version named with a space ("Rough mix") is saved in the studio too (it used to stop the studio saving at all)');
    if (!(await p.$('.clearsong'))) await p.click('.moretoggle');
    await p.click('.clearsong'); await sleep(600);
    const c = await p.evaluate(() => { const S = JJ.song(); return { order: S.order.map((q) => `${S.sections[q].name}/${S.sections[q].bars}`).join(), lanes: Object.keys(S.lanes || {}).length, vars: Object.keys(S.variations || {}).length, title: S.title, bpm: Math.round(JJ.tempo.bpm(JJ.clock.now())), key: S.key, bar: document.querySelector('.undobar')?.textContent || '' }; });
    console.log('  ', JSON.stringify(c));
    check(/^Clear the song for everyone in “Demo studio”\?/.test(asked[0] || ''), `it asks first ("${(asked[0] || '').slice(0, 60)}…")`);
    check(c.order === 'Verse/4' && c.lanes === 0 && c.vars === 0 && c.title === 'Untitled', 'a blank page: a 4-bar Verse, no tracks, no saved versions');
    check(c.bpm === before.bpm && JSON.stringify(c.key) === JSON.stringify(before.key), `the tempo and key stay (${c.bpm} bpm)`);
    check(/Cleared “Demo Song”, for everyone\./.test(c.bar) && /Undo/.test(c.bar), 'the bar says so, with Undo');
    let sv1 = null; for (let i = 0; i < 30; i++) { sv1 = await saved(); if (sv1.parts === 0 && sv1.order === 1) break; await sleep(500); }
    check(sv1.parts === 0 && sv1.order === 1 && sv1.title === 'Untitled', `the studio keeps the cleared song (${JSON.stringify(sv1)})`);
    await p.click('.undobar button:has-text("Undo")'); await sleep(800);
    const u = await p.evaluate(() => { const S = JJ.song(); return { n: S.order.length, parts: S.order.reduce((a, q) => a + Object.keys(S.sections[q].parts || {}).length, 0), vars: Object.values(S.variations || {}).map((v) => v.name), title: S.title, gtr: Object.values(S.sections).some((s) => Object.values(s.parts || {}).some((q) => q.takes?.some((t) => t.audio?.id === 'demogtr1'))) }; });
    check(u.n === 6 && u.parts >= 14 && u.title === 'Demo Song' && u.vars.includes('Rough mix') && u.gtr, `Undo brings it all back: ${u.n} sections, ${u.parts} parts, the saved version, the guitar's audio take`);
    let sv2 = null; for (let i = 0; i < 30; i++) { sv2 = await saved(); if (sv2.parts >= 14) break; await sleep(500); }
    check(sv2.parts >= 14 && sv2.order === 6 && sv2.title === 'Demo Song', `and the studio keeps it again (${JSON.stringify(sv2)})`);
    check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  } catch (e) { console.log('FAIL', e.message); fails++; }
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
