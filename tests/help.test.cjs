// The written manual (help.html): its contents reach every chapter, its "Chapter N" cross-references name the chapter they
// link to, search filters and marks, it fits a phone, and the lobby and the Help menu link to it.
//   node server/dev.js &  (8787)        node tests/help.test.cjs
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const b = await chromium.launch(); const errors = [];
  try {
    const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(BASE + 'help.html');
    const toc = await p.$$eval('#toc a', (as) => as.map((a) => ({ href: a.getAttribute('href'), text: a.textContent })));
    const ids = await p.$$eval('section.ch', (ss) => ss.map((s) => s.id));
    check(toc.length === ids.length && toc.length >= 20, `the contents list every chapter (${toc.length})`);
    check(toc.every((t) => ids.includes(t.href.slice(1)) && t.text.length > 3), 'every contents entry lands on a chapter, with a title');
    const xref = await p.$$eval('main a[href^="#"]', (as) => as.filter((a) => /^Chapter \d+$/.test(a.textContent)).map((a) => { const s = document.querySelector(a.getAttribute('href')); return { text: a.textContent, target: s && s.querySelector('h2 .num')?.textContent }; }));
    const bad = xref.filter((x) => x.text !== x.target);
    check(xref.length >= 8 && !bad.length, `every "Chapter N" cross-reference names the chapter it links to (${xref.length} checked${bad.length ? '; wrong: ' + JSON.stringify(bad) : ''})`);
    const anchors = await p.$$eval('main a[href^="#"]', (as) => as.map((a) => a.getAttribute('href')).filter((h) => h !== '#top' && !document.querySelector(h)));
    check(!anchors.length, `no link inside the manual goes nowhere${anchors.length ? ' (' + anchors.join(', ') + ')' : ''}`);
    const walks = await p.$$eval('.walk', (w) => w.length);
    check(walks >= 15, `walkthroughs throughout (${walks})`);
    await p.fill('#search', 'drummer'); await sleep(400);
    const vis = await p.$$eval('section.ch', (ss) => ss.filter((s) => !s.classList.contains('hidden')).map((s) => s.id));
    const marks = await p.$$eval('main mark', (m) => m.length);
    check(vis.includes('drummer') && vis.length < ids.length && marks > 3, `search keeps the chapters that mention it and marks the word (${vis.length} chapters, ${marks} marks)`);
    await p.fill('#search', 'zzqqxx'); await sleep(400);
    check(await p.isVisible('#nohit'), 'a search with no hits says so');
    await p.fill('#search', ''); await sleep(400);
    check((await p.$$eval('section.ch.hidden', (s) => s.length)) === 0 && (await p.$$eval('main mark', (m) => m.length)) === 0, 'clearing the search brings every chapter back, unmarked');
    await p.click('#toc a[href="#gear"]'); await sleep(2500);
    check(await p.$eval('#toc a[href="#gear"]', (a) => a.classList.contains('on')), 'the chapter you are reading is lit in the contents');

    // a phone
    const m = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    m.on('pageerror', (e) => errors.push(e.message));
    await m.goto(BASE + 'help.html'); await sleep(400);
    check(await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'on a phone nothing runs off the side');
    check(!(await m.isVisible('#toc')) && await m.isVisible('#navBtn'), 'on a phone the contents fold behind a button');
    await m.tap('#navBtn'); await sleep(200);
    check(await m.isVisible('#toc a[href="#compose"]'), 'the button opens them');
    await m.tap('#toc a[href="#compose"]'); await sleep(2500);
    const top = await m.evaluate(() => document.querySelector('#compose h2').getBoundingClientRect().top);
    check(!(await m.isVisible('#toc')) && top > 40 && top < 200, `picking a chapter closes them and shows it below the bar (${Math.round(top)} px)`);

    // linked from the app
    const a = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    a.on('pageerror', (e) => errors.push(e.message));
    await a.goto(BASE);
    check((await a.getAttribute('#lobby a.manuallink', 'href')) === 'help.html', 'the lobby links to the manual');
    await a.fill('#nameIn', 'Sam'); await a.click('#startBtn'); await a.waitForSelector('#studio:not(.hide)'); await sleep(800);
    await a.click('#helpBtn'); await sleep(200);
    const ml = await a.$('.tour-menu a.tour-manual');
    check(!!ml && (await ml.getAttribute('href')) === 'help.html' && (await ml.getAttribute('target')) === '_blank', 'the Help menu has the manual, opening in a new tab');
    const r = await a.request.get(BASE + 'help.html'); check(r.ok(), 'help.html is served');
  } catch (e) { check(false, 'threw: ' + e.message); }
  check(!errors.length, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await b.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
