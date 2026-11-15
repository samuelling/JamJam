// The audio editor (src/audioedit.js), driven through its own buttons and keys, in a room with a bandmate.
//   - ✎ Edit audio on an audio take opens it; dragging on the waveform picks (snapped to beats), Delete cuts it out,
//     ⌘Z / ⇧⌘Z undo and redo
//   - ⌘C the first half, click at the end, ⌘V: the take is 1.5 times as long; Save makes a new take that sounds now,
//     the original stays in the list, the new clip holds 440 Hz · 660 Hz · 440 Hz where it should, and Matt gets it
//   - Normalize, Undo, −6 dB, Fade out on the new take: the saved audio is half as loud and fades to nothing
//   - Play plays the pick; Esc with an unsaved edit asks first
//   node server/dev.js &  (8787)        node tests/audioedit.test.cjs
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [], dialogs = [];
  const mk = async (q, name) => { const c = await browser.newContext({ viewport: { width: 1400, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); p.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); }); await p.goto('http://localhost:8787/' + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?lag=25', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=25`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1))); if (ok.every(Boolean)) break; await sleep(250); }
    // a 2-bar Verse with one audio take: 440 Hz for four beats, then 660 Hz
    const bpm = await A.evaluate(() => {
      const bpm = Math.round(JJ.tempo.bpm(JJ.clock.now())), sr = 24000, n = Math.round((8 * 60 / bpm) * sr), pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) { const b = (i / sr) * bpm / 60; pcm[i] = Math.round(Math.sin(2 * Math.PI * (b < 4 ? 440 : 660) * i / sr) * 12000); }
      JJ.blobs.put('vvvvvvv1', pcm, sr);
      JJ.setSong('lane:vox', { id: 'vox', name: 'Vox', inst: 'audio', kind: 'audio', role: 'texture' });
      JJ.setSong('sec:v1', { name: 'Verse', bars: 2, chords: ['', ''], notes: '' });
      JJ.setSong('part:v1:vox', { id: 'vox', laneId: 'vox', name: 'Vox', lane: 'Vox', inst: 'audio', kind: 'audio', role: 'texture', takes: [{ id: 'a1', events: [], audio: { id: 'vvvvvvv1', sr, frames: n, from: 0, beats: 8, bpm, peaks: Array(120).fill(0.37) }, by: 'x', byName: 'Sam', at: 1 }], current: 'a1' });
      JJ.setSong('order', ['v1']); return bpm;
    });
    const secs8 = ((8 * 60) / bpm).toFixed(2), secs4 = ((4 * 60) / bpm).toFixed(2), secs12 = ((12 * 60) / bpm).toFixed(2);
    await A.evaluate(() => JJ.goRoom('compose')); await sleep(500);
    if (!(await A.$('.arow .cell.take'))) { await A.click('.lanetoggle'); await sleep(300); }
    await A.click('.arow .cell.take'); await sleep(300);
    await A.click('.aeopen'); await A.waitForSelector('.aedit');
    const info = () => A.textContent('.aeinfo'), msg = () => A.textContent('.aemsg');
    check((await info()).startsWith(secs8 + ' s') && /Vox in Verse, take 1/.test(await A.textContent('.aehead b')), `✎ Edit audio opens the take (${(await info()).trim()})`);
    await A.selectOption('.aefoot select', 'beat');
    const wave = await (await A.$('.aewave')).boundingBox();
    const drag = async (f0, f1) => { await A.mouse.move(wave.x + wave.width * f0, wave.y + wave.height / 2); await A.mouse.down(); await A.mouse.move(wave.x + wave.width * ((f0 + f1) / 2), wave.y + wave.height / 2, { steps: 4 }); await A.mouse.move(wave.x + wave.width * f1, wave.y + wave.height / 2, { steps: 4 }); await A.mouse.up(); await sleep(100); };
    // pick the second half and delete it
    await drag(0.49, 0.995);
    check(/Picked bar 2 beat 1 to bar 3 beat 1/.test(await msg()), `a drag picks, snapped to the beat (${(await msg()).trim()})`);
    await A.keyboard.press('Delete'); await sleep(150);
    check((await info()).startsWith(secs4 + ' s'), `Delete cuts it out (${(await info()).trim()})`);
    await A.keyboard.press('Meta+z'); await sleep(150);
    const u1 = await info();
    await A.keyboard.press('Meta+Shift+z'); await sleep(150);
    const r1 = await info();
    await A.click('.aetools button:has-text("Undo")'); await sleep(150);
    check(u1.startsWith(secs8) && r1.startsWith(secs4) && (await info()).startsWith(secs8) && /Undid: Delete/.test(await msg()), `⌘Z undoes it, ⇧⌘Z redoes it, the Undo button undoes it again (${u1.trim()} → ${r1.trim()} → ${(await info()).trim()})`);
    // copy the first half, paste it at the end
    await drag(0.005, 0.49); await A.keyboard.press('Meta+c'); await sleep(100);
    await A.mouse.click(wave.x + wave.width - 1, wave.y + wave.height / 2); await sleep(100);
    await A.keyboard.press('Meta+v'); await sleep(150);
    check((await info()).startsWith(secs12 + ' s') && /runs past the section's end/.test(await info()), `⌘C then ⌘V at the end makes it 1.5 times as long, and it says what runs past the section (${(await info()).trim()})`);
    // play the pick
    if (process.env.SHOT) { await drag(0.3, 0.55); await A.screenshot({ path: '/tmp/ae.png' }); }
    await drag(0.1, 0.2); await A.click('.aeplay'); await sleep(150);
    const playing = await A.textContent('.aeplay'); await sleep(1500);
    check(/Stop/.test(playing) && /Play the pick/.test(await A.textContent('.aeplay')), `Play plays the pick and stops at its end ("${playing.trim()}")`);
    await A.click('.aefoot button:has-text("Save as a new take")'); await sleep(600);
    const sv = await A.evaluate(() => { const p = JJ.song().sections.v1.parts.vox, t = p.takes.find((q) => q.id === p.current); return { n: p.takes.length, cur: p.current, by: t.byName, edit: t.edit, of: t.of, a: t.audio, open: !!document.querySelector('.aedit') }; });
    check(sv.n === 2 && sv.cur !== 'a1' && sv.edit && sv.of === 'a1' && /Sam's edit of Sam's take/.test(sv.by) && !sv.open, `Save makes a new take that sounds now ("${sv.by}"); the original stays in the list`);
    check(sv.a.beats === 8 && sv.a.from === 0 && Math.abs(sv.a.frames / sv.a.sr - (12 * 60) / bpm) < 0.01, `the new take plays the section's 8 beats of its ${(sv.a.frames / sv.a.sr).toFixed(2)} s`);
    const hz = (p, id, beat) => p.evaluate(([id, beat, bpm]) => { const d = JJ.blobs.pcm(id); if (!d) return -1; const i0 = Math.round((beat * 60 / bpm) * d.sr), n = Math.round(0.1 * d.sr); let z = 0, e = 0; for (let i = i0 + 1; i < i0 + n; i++) { const a = d.pcm16[i - 1], b = d.pcm16[i]; if ((a < 0) !== (b < 0)) z++; e += Math.abs(b); } return e / n < 50 ? 0 : Math.round(z / 2 / 0.1); }, [id, beat, bpm]);
    const p3 = [await hz(A, sv.a.id, 1), await hz(A, sv.a.id, 5), await hz(A, sv.a.id, 9)];
    check(Math.abs(p3[0] - 440) < 20 && Math.abs(p3[1] - 660) < 25 && Math.abs(p3[2] - 440) < 20, `the edit holds 440 Hz, 660 Hz, then the pasted 440 Hz (${p3.join(', ')})`);
    let gotB = false; for (let i = 0; i < 20 && !gotB; i++) { await sleep(400); gotB = await B.evaluate((id) => JJ.audio().have.includes(id) && JJ.song().sections.v1.parts.vox.takes.length === 2, sv.a.id); }
    check(gotB, 'Matt has the new take and its audio');
    // shape the new take: normalize, undo it, -6 dB, fade out (no pick: all of it)
    await A.click('.arow .cell.take'); await sleep(300);
    await A.locator('.aeopen').first().click(); await A.waitForSelector('.aedit');
    await A.click('.aetools button:has-text("Normalize")'); await sleep(100);
    await A.keyboard.press('Meta+z'); await sleep(100);
    await A.selectOption('.aetools select', '-6'); await sleep(100);
    await A.click('.aetools button:has-text("Fade out")'); await sleep(100);
    await A.click('.aefoot button:has-text("Save as a new take")'); await sleep(600);
    const sh = await A.evaluate(() => { const p = JJ.song().sections.v1.parts.vox, t = p.takes.find((q) => q.id === p.current), d = JJ.blobs.pcm(t.audio.id), n = d.pcm16.length; const pk = (a, b) => { let m = 0; for (let i = a; i < b; i++) m = Math.max(m, Math.abs(d.pcm16[i])); return m; }; return { n: p.takes.length, head: pk(0, Math.floor(n * 0.05)), tail: pk(Math.floor(n * 0.995), n) }; });
    check(sh.n === 3 && Math.abs(sh.head - 6014) < 400 && sh.tail < 150, `Normalize then Undo, −6 dB and Fade out: the start is half as loud (${sh.head}, was 12000) and the end fades to nothing (${sh.tail})`);
    // Esc with an unsaved edit asks first
    await A.click('.arow .cell.take'); await sleep(300);
    await A.locator('.aeopen').first().click(); await A.waitForSelector('.aedit');
    await A.click('.aetools button:has-text("Reverse")'); await A.keyboard.press('Escape'); await sleep(200);
    check(dialogs.some((d) => /Close without saving/.test(d)) && !(await A.$('.aedit')) && (await A.evaluate(() => JJ.song().sections.v1.parts.vox.takes.length)) === 3, 'Esc with an unsaved edit asks first, and saves nothing');
    check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  } catch (e) { console.log('FAIL', e.message); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
