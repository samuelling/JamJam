// The "Your band's studio" guided tour, walked start to finish in a real browser: from a plain jam, through keeping
// it as a studio, to linking the band's Dropbox (a stand-in Dropbox) and where the files go.
//   node server/dev.js &  (8787)    (cd studio && npx wrangler dev --port 8799) &    node tests/studiotour.test.cjs
// SHOTS=1 saves a screenshot of every step in /tmp/shots/studiotour-*.png
const { chromium } = require('playwright'); const fs = require('fs');
const BASE = 'http://localhost:8787/', SV = process.env.STUDIOS || 'http://localhost:8799';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) fails++; };
(async () => {
  if (process.env.SHOTS) fs.mkdirSync('/tmp/shots', { recursive: true });
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 820 } });
  const json = (route, obj, status = 200) => route.fulfill({ status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(obj) });
  const files = new Map();
  await ctx.route(/^https:\/\/(www\.dropbox\.com|api\.dropboxapi\.com|content\.dropboxapi\.com)\//, (route) => {
    const rq = route.request(), u = new URL(rq.url());
    if (rq.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' } });
    if (u.pathname === '/oauth2/authorize') return route.fulfill({ status: 302, headers: { location: `${u.searchParams.get('redirect_uri')}?code=c0de&state=${u.searchParams.get('state')}` } });
    if (u.pathname === '/oauth2/token') return json(route, { access_token: 'at', expires_in: 14400, refresh_token: 'rt', account_id: 'dbid:AAH4testaccount0001' });
    if (u.pathname === '/2/users/get_current_account') return json(route, { account_id: 'dbid:AAH4testaccount0001', name: { display_name: 'Sam Ling' } });
    if (u.pathname === '/2/files/upload') { const a = JSON.parse(rq.headers()['dropbox-api-arg']); files.set(a.path, 1); return json(route, { path_display: a.path }); }
    if (u.pathname === '/2/sharing/create_shared_link_with_settings') return json(route, { url: 'https://www.dropbox.com/scl/fi/abcdef123456/t.wav?rlkey=abcdef123&dl=0' });
    return json(route, { error_summary: 'unknown' }, 400);
  });
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${BASE}?studios=${encodeURIComponent(SV)}&dropbox=testkey`); await p.fill('#nameIn', 'Sam'); await p.click('#startBtn'); await p.waitForSelector('#studio:not(.hide)');
  await p.evaluate(() => { JJ.goRoom('jam'); document.querySelectorAll('.drawer').forEach((d) => d.classList.add('hide')); });
  await p.click('#helpBtn'); await sleep(300);
  const menu = await p.$$eval('.tour-menu button', (bs) => bs.map((x) => x.textContent));
  check(menu.some((t) => /Your band's studio/.test(t)), `Help lists the new tour (${menu.length} tours)`);
  p.on('dialog', (d) => d.accept('The Garage'));   // "Name the studio"
  await p.click('.tour-menu button:has-text("Your band\'s studio")');
  const seen = []; let n = 0;
  for (let guard = 0; guard < 60; guard++) {
    await sleep(500);
    const a = await p.evaluate(() => JJ.tours.active()); if (!a) break;
    if (seen.at(-1) !== a.step) { seen.push(a.step); n++;
      if (process.env.SHOTS) await p.screenshot({ path: `/tmp/shots/studiotour-${String(n).padStart(2, '0')}-${a.step}.png` });
      const lit = await p.evaluate(() => !!JJ.tours.target());
      if (!lit && a.step !== 'end') console.log(`  (step ${a.step} has nothing lit)`);
    }
    if (a.step === 'end') { await p.click('.tour-actions button:has-text("Done")'); break; }
    if (a.step === 'keep') {
      const there = await p.evaluate(() => [...document.querySelectorAll('#compose .songopts button')].map((x) => x.textContent));
      if (!there.some((t) => /Keep as a studio/.test(t))) { console.log('  songopts buttons:', there.join(' | ')); continue; }
      await p.evaluate(() => [...document.querySelectorAll('#compose .songopts button')].find((x) => /Keep as a studio/.test(x.textContent)).click()); await sleep(1500); continue;
    }
    if (a.step === 'dbxlink') { if (!a.passed && !(await p.evaluate(() => JJ.studio.takesHome?.home))) await p.evaluate(() => document.querySelector('#compose .takeshome button').click()); await sleep(1500); continue; }
    if (a.passed) continue;
    const nx = await p.$('.tour-next'); const sh = await p.$('.tour-show');
    if (nx) await nx.click(); else if (sh) await sh.click();
  }
  console.log('  steps:', seen.join(' › '));
  check(seen.join() === 'why,room,opts,keep,name,link,alone,dbx,dbxlink,folder,band,care,end', 'the tour runs every step, in order');
  const st = await p.evaluate(() => JJ.studio && { id: JJ.studio.id, name: JJ.studio.name, home: JJ.studio.takesHome?.home });
  check(st.id && st.name === 'The Garage', `keeping it as a studio happened for real ("${st.name}")`);
  check(st.home?.by === 'Sam Ling' && st.home.folder.startsWith('The Garage ('), `linking Dropbox happened for real (folder "${st.home?.folder}")`);
  check(!(await p.evaluate(() => JJ.tours.active())), 'and Done closes the tour');
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})();
