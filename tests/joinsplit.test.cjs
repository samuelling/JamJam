// Join and split sections, and play the song from a cue, in the Compose Room.
//   - shift-click two section heads, Join into one section: one section as long as both, chords end to end, each
//     track's block plays what it played (notes shifted, audio takes spliced into a new clip), a repeat elsewhere stays
//   - the new clip reaches a bandmate; Undo puts the old sections back
//   - Split… after bar 1: every place the section repeats splits; a note ringing across the cut sounds again at the
//     top of the second half; every take is kept on both sides; audio is cut into two clips
//   - clicking a block cues Play there ("▶ Play from bar 4"), the song starts in that section, ⏮ goes back to the top
//   - in Compose the band's corners fold to a row of name tags; ▾ Band opens them; the Jam Room keeps them full
//   node server/dev.js &  (8787)        node tests/joinsplit.test.cjs
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const mk = async (q, name) => { const c = await browser.newContext({ viewport: { width: 1400, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); p.on('dialog', (d) => d.accept()); await p.goto('http://localhost:8787/' + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?lag=25', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=25`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1))); if (ok.every(Boolean)) break; await sleep(250); }
    // Verse (2 bars) · Chorus (2 bars) · Verse again; Keys has notes, Vox has audio takes
    await A.evaluate(() => {
      const bpm = Math.round(JJ.tempo.bpm(JJ.clock.now())), sr = 24000;
      const tone = (id, beats, parts) => { const n = Math.round((beats * 60 / bpm) * sr), pcm = new Int16Array(n); for (let i = 0; i < n; i++) { const b = (i / sr) * bpm / 60, hz = parts.find((q) => b >= q[0] && b < q[1])?.[2] || 0; pcm[i] = hz ? Math.round(Math.sin(2 * Math.PI * hz * i / sr) * 12000) : 0; } JJ.blobs.put(id, pcm, sr); return { id, sr, frames: n, bpm, peaks: Array(120).fill(0.4) }; };
      JJ.setSong('lane:keys', { id: 'keys', name: 'Keys', inst: 'juniper', kind: 'midi', role: 'chords' });
      JJ.setSong('lane:vox', { id: 'vox', name: 'Vox', inst: 'audio', kind: 'audio', role: 'texture' });
      JJ.setSong('sec:v1', { name: 'Verse', bars: 2, chords: ['Am', 'F'], notes: '' });
      JJ.setSong('sec:c1', { name: 'Chorus', bars: 2, chords: ['C', 'G'], notes: 'big' });
      const on = (b, n) => ({ b, type: 'on', note: n, vel: 90 }), off = (b, n) => ({ b, type: 'off', note: n });
      JJ.setSong('part:v1:keys', { id: 'keys', laneId: 'keys', name: 'Keys', lane: 'Keys', inst: 'juniper', role: 'chords', takes: [{ id: 't1', events: [on(0, 60), off(1.5, 60), on(3, 67), off(5, 67), on(6, 64), off(7.5, 64)], by: 'x', byName: 'Sam', at: 1 }, { id: 't2', events: [on(0, 72), off(1, 72)], by: 'x', byName: 'Sam', at: 2 }], current: 't1' });
      JJ.setSong('part:c1:keys', { id: 'keys', laneId: 'keys', name: 'Keys', lane: 'Keys', inst: 'juniper', role: 'chords', takes: [{ id: 't3', events: [on(0, 48), off(8, 48)], by: 'x', byName: 'Sam', at: 3 }], current: 't3' });
      JJ.setSong('part:v1:vox', { id: 'vox', laneId: 'vox', name: 'Vox', lane: 'Vox', inst: 'audio', kind: 'audio', role: 'texture', takes: [{ id: 'a1', events: [], audio: { ...tone('vvvvvvv1', 8, [[0, 4, 440], [4, 8, 660]]), from: 0, beats: 8 }, by: 'x', byName: 'Sam', at: 4 }], current: 'a1' });
      JJ.setSong('part:c1:vox', { id: 'vox', laneId: 'vox', name: 'Vox', lane: 'Vox', inst: 'audio', kind: 'audio', role: 'texture', takes: [{ id: 'a2', events: [], audio: { ...tone('ccccccc1', 4, [[0, 4, 220]]), from: 2, beats: 4 }, by: 'x', byName: 'Sam', at: 5 }], current: 'a2' });
      JJ.setSong('order', ['v1', 'c1', 'v1']); JJ.setSong('labels', ['head', '', 'out']);
    });
    await A.evaluate(() => JJ.goRoom('compose')); await sleep(600);
    // the pitch of a clip around a beat, from its zero crossings
    const hz = (p, id, beat) => p.evaluate(([id, beat]) => { const t = Object.values(JJ.song().sections).flatMap((s) => Object.values(s.parts)).flatMap((q) => q.takes).find((x) => x.audio?.id === id); const d = JJ.blobs.pcm(id); if (!t || !d) return -1; const ch = t.audio.ch === 2 ? 2 : 1, i0 = Math.round(((beat - t.audio.from) * 60 / t.audio.bpm) * d.sr), n = Math.round(0.1 * d.sr); let z = 0, e = 0; for (let i = i0 + 1; i < i0 + n; i++) { const a = d.pcm16[(i - 1) * ch], b = d.pcm16[i * ch]; if ((a < 0) !== (b < 0)) z++; e += Math.abs(b); } return e / n < 50 ? 0 : Math.round(z / 2 / 0.1); }, [id, beat]);

    // ---- join: shift-click Verse then Chorus
    await A.click('.shead[data-col="0"]'); await A.click('.shead[data-col="1"]', { modifiers: ['Shift'] });
    if (process.env.SHOT) { if (!(await A.$('.arow .cell.take'))) { await A.click('.lanetoggle'); await sleep(300); } await A.screenshot({ path: '/tmp/js-join.png' }); }
    const bar = await A.textContent('.joinbar'); console.log('  ', bar.trim());
    check(/2 sections picked: Verse, Chorus/.test(bar), 'shift-click picks a run of sections and offers to join them');
    await A.click('.joinbar button:has-text("Join into one section")'); await sleep(500);
    const j = await A.evaluate(() => { const S = JJ.song(), id = S.order[0], s = S.sections[id], k = s.parts.keys, v = s.parts.vox; const cur = (p) => p.takes.find((t) => t.id === p.current); return { order: S.order.map((q) => S.sections[q].name), labels: S.labels, bars: s.bars, chords: s.chords.join(' '), notes: s.notes, keys: cur(k).events.filter((e) => e.type === 'on').map((e) => `${e.b}:${e.note}`).join(' '), ntakes: k.takes.length, vox: cur(v).audio, v1: !!S.sections.v1, c1: !!S.sections.c1 }; });
    console.log('  ', JSON.stringify({ ...j, vox: { ...j.vox, peaks: undefined } }));
    check(j.order.join(',') === 'Verse + Chorus,Verse' && j.bars === 4 && j.chords === 'Am F C G' && j.notes === 'big' && j.labels.join(',') === 'head,out', `one 4-bar section "Verse + Chorus" with the chords end to end; the repeat of the Verse stays (${j.order.join(', ')})`);
    check(j.keys === '0:60 3:67 6:64 8:48' && j.ntakes === 1, `Keys plays its current takes end to end: ${j.keys}`);
    check(j.vox && j.vox.from === 0 && Math.abs(j.vox.beats - 14) < 1e-6 && !j.v1 === false && !j.c1, `Vox is one new clip, beats 0 to 14 (the chorus take started 2 beats in) (${j.vox?.from}..${(j.vox?.from || 0) + (j.vox?.beats || 0)})`);
    const jid = j.vox.id, pj = [await hz(A, jid, 1), await hz(A, jid, 5), await hz(A, jid, 9), await hz(A, jid, 11)];
    check(Math.abs(pj[0] - 440) < 20 && Math.abs(pj[1] - 660) < 25 && pj[2] === 0 && Math.abs(pj[3] - 220) < 15, `the spliced clip holds both takes in place: 440 Hz, 660 Hz, silence, 220 Hz (${pj.join(', ')})`);
    let gotB = false; for (let i = 0; i < 20 && !gotB; i++) { await sleep(400); gotB = await B.evaluate((id) => JJ.audio().have.includes(id), jid); }
    check(gotB && (await B.evaluate(() => JJ.song().order.length)) === 2, 'Matt has the joined song and the new clip');
    await A.click('.undobar button:has-text("Undo")'); await sleep(500);
    const u = await A.evaluate(() => { const S = JJ.song(); return { order: S.order.join(','), labels: S.labels.join(','), keys: S.sections.v1?.parts.keys?.takes.length, vox: S.sections.c1?.parts.vox?.current, n: Object.keys(S.sections).length }; });
    check(u.order === 'v1,c1,v1' && u.labels === 'head,,out' && u.keys === 2 && u.vox === 'a2' && u.n === 2, `Undo puts the Verse and Chorus back as they were (${JSON.stringify(u)})`);

    // ---- split the Verse after bar 1
    await A.click('.shead[data-col="0"]'); await sleep(200);
    await A.selectOption('.splitsel', '1'); await sleep(500);
    const s = await A.evaluate(() => { const S = JJ.song(), [a, b] = S.order, A = S.sections[a], B = S.sections[b], ev = (p, t) => p.takes.find((x) => x.id === t).events.filter((e) => e.type === 'on').map((e) => `${e.b}:${e.note}`).join(' ');
      return { order: S.order.map((q) => `${S.sections[q].name}/${S.sections[q].bars}`).join(','), same: S.order[3] === a && S.order[4] === b, labels: S.labels.join(','), chords: [A.chords.join(' '), B.chords.join(' ')], ka: ev(A.parts.keys, 't1'), kb: ev(B.parts.keys, 't1'), ta: A.parts.keys.takes.map((t) => t.id).join(), cur: B.parts.keys.current, va: A.parts.vox.takes[0].audio, vb: B.parts.vox.takes[0].audio }; });
    console.log('  ', JSON.stringify({ ...s, va: s.va && { from: s.va.from, beats: s.va.beats }, vb: s.vb && { from: s.vb.from, beats: s.vb.beats } }));
    check(s.order === 'Verse/1,Verse 2/1,Chorus/2,Verse/1,Verse 2/1' && s.same && s.labels === 'head,,,out,', `the Verse splits in two, at both places it plays (${s.order})`);
    check(s.chords[0] === 'Am' && s.chords[1] === 'F', 'each half keeps its chords');
    check(s.ka === '0:60 3:67' && s.kb === '0:67 2:64' && s.ta === 't1,t2' && s.cur === 't1', `the note ringing across the cut sounds again at the top of the second half; both takes kept (${s.ka} | ${s.kb})`);
    const pa = await hz(A, s.va.id, 1), pb = await hz(A, s.vb.id, 1);
    check(s.va.beats === 4 && s.vb.beats === 4 && Math.abs(pa - 440) < 20 && Math.abs(pb - 660) < 25, `the audio take is cut into two clips: 440 Hz, then 660 Hz (${pa}, ${pb})`);

    // ---- cue: click the second bar of the Chorus's Keys block, then play
    if (!(await A.$('.arow .cell.take'))) { await A.click('.lanetoggle'); await sleep(300); }
    const r = await A.locator('.arow .cell.take').nth(2).boundingBox();
    const sec = await A.evaluate(() => JJ.song().sections[JJ.song().order[2]].name);
    await A.mouse.click(r.x + r.width * 0.75, r.y + r.height / 2); await sleep(300);
    if (process.env.SHOT) { await A.selectOption('.splitsel', { index: 0 }).catch(() => {}); await A.screenshot({ path: '/tmp/js-cue.png' }); }
    const label = await A.textContent('.playsong');
    check(sec === 'Chorus' && /Play from bar 4/.test(label) && (await A.$('.looptrack .cuemark')) !== null, `clicking a block cues Play there ("${label.trim()}")`);
    await A.click('.playsong');
    let w = null; for (let i = 0; i < 80 && !w; i++) { await sleep(100); w = await A.evaluate(() => { const p = JJ.where(); return p && { sec: JJ.song().sections[p.sid].name, bar: p.bar, from: JJ.song().transport.from }; }); }
    check(w && w.sec === 'Chorus' && w.bar === 1 && w.from === 12, `the song starts there, in the Chorus's second bar (${JSON.stringify(w)})`);
    const wB = await B.evaluate(() => { const p = JJ.where(); return p && JJ.song().sections[p.sid].name; });
    check(wB === 'Chorus', 'Matt hears it from the same place');
    await A.click('.playsong'); await sleep(300);
    await A.click('.cuetop'); await sleep(200);
    check(/Play the song/.test(await A.textContent('.playsong')), '⏮ puts the cue back at the top');
    // a click on the strip above the sections cues too
    const tr = await (await A.$('.looptrack')).boundingBox(); await A.mouse.click(tr.x + 5, tr.y + tr.height / 2); await sleep(200);
    check(/Play the song/.test(await A.textContent('.playsong')), 'a click at the very start of the strip cues bar 1');
    // the band's corners fold into a row of name tags in Compose; "▾ Band" opens them, and it's remembered
    const hgt = () => A.evaluate(() => Math.round(document.querySelector('#corners').getBoundingClientRect().height));
    const folded = await hgt(), tags = await A.evaluate(() => [...document.querySelectorAll('#corners .corner')].filter((c) => c.offsetParent).map((c) => c.querySelector('.cname')?.textContent).join(', '));
    if (process.env.SHOT) await A.screenshot({ path: '/tmp/js-corners.png' });
    await A.click('.cornerstoggle'); await sleep(200); const full = await hgt();
    await A.evaluate(() => JJ.goRoom('jam')); await sleep(300); const jam = await hgt();
    await A.evaluate(() => JJ.goRoom('compose')); await sleep(300);
    check(folded < 50 && /Sam · you, Matt/.test(tags) && full > 100 && jam > 100, `in Compose the corners fold to a ${folded}px row of name tags (${tags}); ▾ Band opens them (${full}px); the Jam Room keeps them full (${jam}px)`);
    await A.click('.cornerstoggle'); await sleep(200);
    check((await hgt()) < 50 && (await A.evaluate(() => localStorage.getItem('megajam.cornersFull'))) === '0', 'folding again is remembered');
    check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  } catch (e) { console.log('FAIL', e.message); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
