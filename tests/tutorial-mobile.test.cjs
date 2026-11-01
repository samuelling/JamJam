// The tours on a phone-sized touch screen (390 x 844, like an iPhone): at every step of both tours the lit hole sits
// on the thing it points at and the card is fully on screen; scrolling the page doesn't pull them apart (they scroll
// with it), and neither does a zoomed-in page (iOS Safari zooms in when a text field is focused).
//   node server/dev.js &  (8787)        node tests/tutorial-mobile.test.cjs
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const errors = [];
  try {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(BASE + '?lag=30'); await sleep(600);
    // how far the hole is from its target, and whether the card is on screen (client coordinates, after a frame)
    const measure = () => p.evaluate(() => new Promise((res) => requestAnimationFrame(() => {
      const t = JJ.tours.target(), sh = document.querySelector('.tour-shade'), card = document.querySelector('.tour-card');
      const c = card.getBoundingClientRect(), on = c.left >= -1 && c.top >= -1 && c.right <= innerWidth + 1 && c.bottom <= innerHeight + 1;
      if (!t || !t.getClientRects().length) return res({ off: 0, on, none: true });
      const a = t.getBoundingClientRect(), s = sh.getBoundingClientRect();
      res({ off: Math.max(Math.abs(s.left + 8 - a.left), Math.abs(s.top + 8 - a.top), Math.abs(s.width - 16 - a.width), Math.abs(s.height - 16 - a.height)), on, id: JJ.tours.active().step });
    })));
    const scroller = () => p.evaluate(() => { const t = JJ.tours.target(); const host = t && (t.closest('#studio') || t.closest('#lobby')); if (!host || host.scrollHeight <= host.clientHeight) return false; host.scrollTop += host.scrollTop > 100 ? -120 : 120; return true; });
    const step = () => p.evaluate(() => JJ.tours.active()?.step || null);
    const bad = [], offscreen = [], scrolled = [];
    const visit = async () => {
      const id = await step(); await sleep(700);
      const m = await measure(); if (m.off > 2) bad.push(`${id} ${m.off.toFixed(1)}px`); if (!m.on) offscreen.push(id);
      if (await scroller()) { const m2 = await measure(); if (m2.off > 2) scrolled.push(`${id} ${m2.off.toFixed(1)}px`); }
    };
    const advance = async () => {
      const show = await p.$('.tour-card .tour-show'); if (show) { await show.click(); } else { const nx = await p.$('.tour-card .tour-next') || await p.$('.tour-card .btn.hot'); if (nx) await nx.click(); }
    };
    // the jam tour from the lobby, then the song tour, Show me / Next throughout
    await p.click('#tourBtn');
    const seen = [];
    for (let guard = 0; guard < 60; guard++) {
      const id = await step(); if (!id) break;
      if (seen.at(-1) !== id) { seen.push(id); await visit(); }
      if (id === 'end' && seen.filter((x) => x === 'end').length === 2) { await p.click('.tour-card .btn.hot'); break; }
      await advance();
      for (let t = 0; t < 40 && (await step()) === id; t++) await sleep(150);
    }
    check(seen.length >= 30, `walked ${seen.length} steps of both tours on a phone-sized screen`);
    check(!bad.length, 'the lit hole sits on its target at every step' + (bad.length ? ': ' + bad.join(', ') : ''));
    check(!scrolled.length, 'scrolling the page leaves the hole on its target (it scrolls with the page)' + (scrolled.length ? ': ' + scrolled.join(', ') : ''));
    check(!offscreen.length, 'the card is fully on screen at every step' + (offscreen.length ? ': ' + offscreen.join(', ') : ''));
    // zoomed in, as iOS Safari leaves a page after a text field had focus
    const cdp = await ctx.newCDPSession(p);
    await p.evaluate(() => JJ.tours.start('compose')); await sleep(800);
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.6 }); await sleep(500);
    const z = await measure();
    check(z.off <= 2, `zoomed to 160%, the hole still sits on its target (${z.off.toFixed(1)}px off)`);
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    const fs = await p.evaluate(() => getComputedStyle(document.querySelector('#nameIn')).fontSize);
    check(!!fs, `text fields: ${fs} (16px on iOS Safari, where smaller ones make it zoom)`);
    check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  } catch (e) { console.error(e); failures++; }
  await b.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
