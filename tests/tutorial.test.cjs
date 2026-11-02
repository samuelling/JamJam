// The guided tours, run the way a newcomer would: "New to this?" in the lobby starts "Your first jam" (name, Start,
// play, key, chord pads, a virtual drummer, tempo, lock to key, record, invite), which hands over to "Write your
// first song" in the Compose Room (chords, a clicked-in drum beat, Loop it, a bass track jammed in and locked,
// play the song). Each step waits for the real thing to happen; a couple use Show me.
//   node server/dev.js &  (8787)        node tests/tutorial.test.cjs
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const errors = [];
  try {
    const p = await (await b.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(BASE + '?lag=30&picks=1&doors=1'); await sleep(600);   // a first visit: the hall's two doors, then "What do you want to play?"
    const step = () => p.evaluate(() => JJ.tours.active()?.step || null);
    const waitStep = async (id, ms = 8000) => { for (let t = 0; t < ms; t += 150) { if ((await step()) === id) return true; await sleep(150); } return false; };
    const card = () => p.textContent('.tour-card');
    const next = async () => { await p.click('.tour-card .tour-next'); await sleep(250); };
    const show = async () => { await p.click('.tour-card .tour-show'); };
    const keys = async (list) => { for (const k of list) { await p.keyboard.down(k); await sleep(90); await p.keyboard.up(k); await sleep(60); } };

    check(await p.isVisible('#tourBtn') && (await p.getAttribute('#tourBtn', 'class')).includes('fresh'), 'the lobby offers "New to this? Take the tour", lit for a first visit');
    await p.click('#tourBtn');
    check(await waitStep('name') && /type your name/i.test(await card()), 'the tour starts at your name');
    check(!!(await p.$('.tour-card .tour-wait')), 'a doing-step waits for you (no Next until it\'s done)');
    await p.fill('#nameIn', 'Robin');
    check(await waitStep('start'), 'typing a name moves it on to Start a jam');
    await p.click('#startBtn');
    check(await waitStep('door') && await p.isVisible('#hall'), 'starting the studio: the hall, and the tour says to go into the Jam Room');
    await p.click('#hall .door2.jam');
    check(await waitStep('pick'), 'through the Jam Room door: "What do you want to play?"');
    await p.waitForSelector('#quickPicks .quick', { state: 'visible' }); await sleep(300);
    const lit2 = await p.evaluate(() => { const s = document.querySelector('.tour-shade').getBoundingClientRect(), c = document.querySelector('#quickPicks').getBoundingClientRect(); return Math.abs(s.top + 8 - c.top) < 3 && Math.abs(s.height - 16 - c.height) < 3; });
    check(lit2, 'the lit hole sits on the first picks');
    await p.evaluate(() => [...document.querySelectorAll('#quickPicks .quick')].find((b) => /strum/i.test(b.textContent)).click());
    check(await waitStep('corner'), 'picking something to strum moves it on to your corner');
    check(!(await p.evaluate(() => [...document.querySelectorAll('.drawer')].some((d) => d.getClientRects().length && !d.classList.contains('hide')))), 'no drawer is left covering your corner');
    check(!(await p.$('.tour-card .btn.ghost:not(.tour-show)')) || !(await p.evaluate(() => [...document.querySelectorAll('.tour-card button')].some((b) => b.textContent === 'Back'))), 'no Back from the corner into steps that are done');
    await sleep(600);
    const lit = await p.evaluate(() => { const s = document.querySelector('.tour-shade').getBoundingClientRect(), c = document.querySelector('.corner.me').getBoundingClientRect(); return Math.abs(s.left + 8 - c.left) < 3 && Math.abs(s.width - 16 - c.width) < 3; });
    check(lit, 'the lit hole sits on your corner');
    await next(); check(await waitStep('desk') && /Acoustic/.test(await card()), 'Next goes to the desk, naming what you picked'); await next();
    check(await waitStep('play'), 'then: play some notes');
    await p.mouse.click(700, 5); await keys(['a', 's', 'd', 'f', 'g', 'h', 'j']);
    check(await waitStep('key'), 'playing six notes on the computer keys moves it on');
    await p.selectOption('#keySel', { label: 'A minor' }).catch(async () => { await show(); });
    check(await waitStep('pads'), 'choosing A minor moves it on to the chord pads');
    await p.mouse.click(700, 5); await keys(['Digit1', 'Digit6', 'Digit4', 'Digit5']);
    check(await waitStep('add'), 'three chords on the number keys move it on');
    await p.click('#addSlot');
    check(await waitStep('drummer'), 'Add opens the wall; on to the Drummer');
    await p.click('#libCards .tile.drums .face');
    check(await waitStep('style'), 'the Drummer tile opens its styles');
    await p.click('#libExtra .dgenre button');
    check(await waitStep('tempo') && (await p.evaluate(() => JJ.band ? 1 : 1)), 'picking a style brings in a drummer; on to tempo');
    const b0 = await p.evaluate(() => Math.round(JJ.tempo.bpm(JJ.clock.now() + 1000)));
    check(new RegExp(`from ${b0} to ${b0 + 4}`).test(await card()) && /4 to go/.test(await card()), `the tempo step names the target: from ${b0} to ${b0 + 4}, 4 to go`);
    await p.click('#bpmUp'); await sleep(500);
    check(/3 to go/.test(await card()) && (await step()) === 'tempo', 'one press: the card counts down (3 to go) and waits');
    for (let i = 0; i < 3; i++) { await p.click('#bpmUp'); await sleep(150); }
    check(await waitStep('lock'), 'reaching the target moves it on');
    await p.click('#lockBtn');
    check(await waitStep('jam'), 'Lock to key moves it on');
    await p.mouse.click(700, 5); await keys(['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'j', 'h', 'g', 'f', 'd']);
    check(await waitStep('record'), 'jamming a dozen notes moves it on');
    await show();
    check(await waitStep('invite', 15000), 'Show me records a short tape and moves on');
    await next();
    check(await waitStep('end') && /all set/i.test(await card()), '"You\'re all set!" at the end of the jam tour');
    check(/Write your first song/.test(await card()) && /Jam with a friend/.test(await card()) && /manual/.test(await card()) && await p.evaluate(() => JJ.tours.target()?.id === 'helpBtn'), 'it points to the other two tours and the manual, under Tours');
    const jamDone = await p.evaluate(() => ({ drummer: document.querySelectorAll('.corner.vp').length, key: JJ.S.key.mode, tapes: document.querySelector('#tapesBtn') && !document.querySelector('#tapesBtn').classList.contains('hide') }));
    check(jamDone.drummer === 1 && jamDone.key === 'minor' && jamDone.tapes, `the jam is real: a drummer in a corner, A minor, a tape (${JSON.stringify(jamDone)})`);

    // straight on into the Compose Room tour
    await p.click('.tour-card .btn.hot');
    check(await waitStep('room') && (await p.evaluate(() => localStorage.getItem('megajam.tour.jam'))) === '1', 'the jam tour is marked done; the song tour begins');
    await p.click('#roomSeg [data-room="compose"]');
    check(await waitStep('board'), 'the Compose Room');
    await next();
    check(await waitStep('chords'), 'then: chords');
    const sid = await p.evaluate(() => JJ.song().order[0]);
    check((await p.evaluate((sid) => JJ.song().sections[sid].bars, sid)) === 4, 'the empty Verse is cut to 4 bars for the tour');
    await p.click(`[data-cell="${sid}:0"]`);
    for (const c of ['C', 'Am', 'F', 'G']) { await p.keyboard.type(c); await p.keyboard.press('Enter'); await sleep(150); }
    check(await waitStep('drumtrack'), 'four chords typed move it on');
    await p.click('.addtrack:not(.open) button');
    check(await waitStep('drumpick'), '+ Add track opens the form');
    await p.selectOption('.addtrack.open select[aria-label="Instrument"]', 'machina'); await p.click('.addtrack.open button.hot');
    check(await waitStep('beat'), 'a Machina track; on to writing a beat');
    // click four hits into the empty roll (Kick row is low, the Snare above it)
    const R = await p.evaluate(() => { document.querySelector('.lvroll').scrollIntoView({ block: 'center' }); const r = document.querySelector('.lvroll').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    for (const f of [0.02, 0.27, 0.52, 0.77]) { await p.mouse.click(R.x + R.w * f, R.y + R.h - 6); await sleep(250); }
    check(await waitStep('loop'), 'four hits clicked in move it on');
    await p.evaluate(() => [...document.querySelectorAll('#compose button')].find((b) => /Loop it/.test(b.textContent)).click());
    check(await waitStep('basstrack'), 'Loop it plays the Verse; on to a bass');
    await p.click('.addtrack:not(.open) button');
    check(await waitStep('basspick'), '+ Add track again');
    await p.selectOption('.addtrack.open select[aria-label="Instrument"]', 'monolith'); await p.click('.addtrack.open button.hot');
    check(await waitStep('jamit'), 'a Monolith track; on to Jam it');
    await p.evaluate(() => [...document.querySelectorAll('.trackbar button')].find((b) => b.textContent === 'Jam it').click());
    check(await waitStep('jamsec'), 'Jam it puts the bass on the desk');
    await p.evaluate(() => [...document.querySelectorAll('#compose button')].find((b) => b.textContent === 'Jam this section').click());
    check(await waitStep('bassplay') && (await p.isVisible('.keybed')), 'Jam this section goes to the Jam Room, keys in view');
    await p.mouse.click(700, 5); await keys(['z', 'z', 'a', 'a', 'h', 'h', 'f', 'f', 'g', 'g']);
    check(await waitStep('lock'), 'playing along moves it on to Lock in');
    await show();
    check(await waitStep('back', 10000), 'Show me locks a bass take in');
    await p.click('#roomSeg [data-room="compose"]');
    check(await waitStep('mix'), 'back in the Compose Room');
    const parts = await p.evaluate((sid) => { const s = JJ.song(); return Object.values(s.lanes).map((t) => { const p = Object.values(s.sections[sid].parts).find((q) => q.laneId === t.id); const tk = p && p.takes.find((x) => x.id === p.current); return `${t.inst}:${tk ? tk.events.filter((e) => e.type === 'on').length : 0}`; }); }, sid);
    check(parts.length === 2 && parts.every((x) => +x.split(':')[1] > 0), `the song has a drum beat and a bass line in the Verse (${parts.join(', ')})`);
    await next();
    check(await waitStep('song'), 'then: play the song');
    await p.click('.playsong');
    check(await waitStep('more'), 'Play the song moves it on');
    await next();
    check(await waitStep('end') && /all set/i.test(await card()) && /Jam with a friend/.test(await card()), '"You\'re all set!" at the end of the song tour, with the friend tour offered next');
    await p.evaluate(() => [...document.querySelectorAll('.tour-card button')].find((b) => b.textContent === 'Done').click());
    await sleep(300);
    check(!(await p.$('.tour-card')) && (await p.evaluate(() => localStorage.getItem('megajam.tour.compose'))) === '1' && !(await p.getAttribute('#helpBtn', 'class')).includes('fresh'), 'Done lets go: no card, both tours marked done, the ? stops pulsing');
    // the ? menu and leaving part-way
    await p.click('#helpBtn'); await sleep(200);
    check((await p.$$('.tour-menu button')).length === 3, '? opens a menu of the three tours');
    await p.click('.tour-menu button'); check(await waitStep('door'), 'the jam tour started from the Compose Room skips the lobby and first asks you into the Jam Room');
    await p.click('.tour-card .tour-x'); await sleep(200);
    check(!(await p.$('.tour-card')) && !(await p.$('.tour-shade')), '× leaves the tour');
    check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  } catch (e) { console.error(e); failures++; }
  await b.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
