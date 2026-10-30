// The song's master fader, and Export stems: every track from bar 1, lined up, the same length, 24-bit WAV, after
// its fader and pan; the mix, MIDI and song alongside; "just my tracks" for the band folder.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const errors = [];
  const mk = async (q, name) => { const c = await b.newContext({ viewport: { width: 1400, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  const settle = async (pages) => { for (let i = 0; i < 60; i++) { const ok = await Promise.all(pages.map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size >= 1))); if (ok.every(Boolean)) break; await sleep(300); } await sleep(800); };
  try {
    const A = await mk('?lag=30&empty=1', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=30&empty=1`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    await settle([A, B]);
    // two sections at 120 bpm (2 s a bar): a Bass track of Sam's playing on beat 1 of the Chorus only, Keys of Matt's in both
    await A.evaluate(() => {
      const on = (b, n) => [{ b, type: 'on', note: n, vel: 110 }, { b: b + 1, type: 'off', note: n }];
      JJ.goRoom('compose');
      JJ.loadSong({ format: 'megajam.song/1', title: 'Stem Test', bpm: 120, key: { root: 0, mode: 'major' }, meter: 4, order: ['v', 'c'], labels: [], rule: 'newest', variations: {},
        lanes: { tb: { id: 'tb', name: 'Bass', ownerName: 'Sam', by: 'x', inst: 'monolith', patch: 'bass', kind: 'midi', at: 1, vol: -6 }, tk: { id: 'tk', name: 'Keys/Pad', ownerName: 'Matt', by: 'y', inst: 'tine', patch: 'keys', kind: 'midi', at: 2, pan: -1 } },
        sections: {
          v: { id: 'v', name: 'Verse', bars: 1, chords: ['C'], notes: '', parts: { tk: { id: 'tk', laneId: 'tk', name: 'Keys/Pad', inst: 'tine', patch: 'keys', by: 'y', byName: 'Matt', takes: [{ id: 'k1', events: on(0, 64), by: 'y', byName: 'Matt', at: 1 }], current: 'k1' } } },
          c: { id: 'c', name: 'Chorus', bars: 1, chords: ['F'], notes: '', parts: {
            tb: { id: 'tb', laneId: 'tb', name: 'Bass', inst: 'monolith', patch: 'bass', by: 'x', byName: 'Sam', takes: [{ id: 'b1', events: on(0, 36), by: 'x', byName: 'Sam', at: 1 }], current: 'b1' },
            tk: { id: 'tk', laneId: 'tk', name: 'Keys/Pad', inst: 'tine', patch: 'keys', by: 'y', byName: 'Matt', takes: [{ id: 'k2', events: on(2, 67), by: 'y', byName: 'Matt', at: 1 }], current: 'k2' } } } } });
    });
    await sleep(800);

    // master fader: in the song header, shared
    await A.evaluate(() => { const r = document.querySelector('.mfader'); r.value = '-10'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(700);
    const m = await B.evaluate(() => ({ v: JJ.song().master?.vol, g: JJ.master() })); await sleep(300);
    const g2 = await B.evaluate(() => JJ.master());
    check(m.v === -10 && Math.abs(g2 - Math.pow(10, -0.5)) < 0.02, `the master fader reaches Matt and his song master sits at -10 dB (${JSON.stringify(m)}, ${g2})`);

    // export everything, in memory
    const r = await A.evaluate(async () => { const r = await JJ.exportStems({ to: 'memory' }); return r; });
    const names = r.files.map((f) => f.name);
    check(names.includes('Stem Test stems/Stems/01 Bass.wav') && names.includes('Stem Test stems/Stems/02 Keys Pad.wav') && names.includes('Stem Test stems/Stem Test (mix).wav') && names.includes('Stem Test stems/Stem Test.mid') && names.includes('Stem Test stems/Stem Test.megajam.json') && names.some((n) => /About stems\.txt$/.test(n)) && names.includes('Stem Test stems/Stem Test.als'),
      `the export has numbered stems, the mix, MIDI, the song and a note (${names.join(', ')})`);
    const an = await A.evaluate(() => {
      const f = (n) => JJ.lastStems.find((x) => x.name.endsWith(n)).data, out = {};
      for (const [k, n] of [['bass', '01 Bass.wav'], ['keys', '02 Keys Pad.wav'], ['mix', '(mix).wav']]) {
        const w = JJ.readWav24(f(n)), first = (ch) => { for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) > 0.01) return i / w.sr; return -1; };
        let eL = 0, eR = 0; for (let i = 0; i < w.L.length; i++) { eL += w.L[i] * w.L[i]; eR += w.R[i] * w.R[i]; }
        let bad = 0; for (let i = 0; i < w.L.length; i++) if (!Number.isFinite(w.L[i])) bad++;
        out[k] = { sr: w.sr, len: w.L.length, first: +first(w.L).toFixed(3), firstR: +first(w.R).toFixed(3), eL, eR, bad };
      }
      out.about = new TextDecoder().decode(JJ.lastStems.find((x) => /About/.test(x.name)).data);
      return out;
    });
    check(an.bass.len === an.keys.len && an.keys.len === an.mix.len && Math.abs(an.bass.len / an.bass.sr - 8) < 0.01, `all the same length: two bars at 120 bpm plus a 4 s ring-out (${an.bass.len / an.bass.sr} s)`);
    check(Math.abs(an.bass.first - 2) < 0.02, `the Bass stem is silent through the Verse and starts right on the Chorus at 2.0 s (${an.bass.first})`);
    check(Math.abs(an.keys.first) < 0.02 && Math.abs(an.mix.first) < 0.02, `the Keys stem starts at 0 s, lined up with the mix (${an.keys.first}, ${an.mix.first})`);
    check(an.keys.eR < an.keys.eL * 0.01, `the Keys stem is panned hard left, as its track is (${an.keys.eL.toFixed(1)} vs ${an.keys.eR.toFixed(3)})`);
    check(!an.bass.bad && !an.keys.bad && an.bass.eL > 1 && /120 bpm/.test(an.about) && /bar 1/.test(an.about), 'no NaN, real sound, and the note gives the tempo and says they line up at bar 1');

    // the Live set: the song's tempo, an audio track per stem pointing at it, a MIDI track per instrument track with its notes
    const als = await A.evaluate(async () => {
      const f = JJ.lastStems.find((x) => x.name.endsWith('.als')); if (!f) return null;
      const xml = await new Response(new Blob([f.data]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      const d = new DOMParser().parseFromString(xml, 'application/xml'), q = (s) => [...d.getElementsByTagName(s)];
      const ids = [...d.getElementsByTagName('*')].filter((e) => /Target|Pointee/.test(e.tagName) && e.hasAttribute('Id')).map((e) => +e.getAttribute('Id'));
      const name = (t) => t.getElementsByTagName('EffectiveName')[0].getAttribute('Value');
      return { xml, bad: !!d.querySelector('parsererror'), tempo: d.querySelector('MasterTrack Tempo Manual').getAttribute('Value'),
        audio: q('AudioTrack').map((t) => ({ name: name(t), file: t.querySelector('SampleRef RelativePath')?.getAttribute('Value'), end: +t.querySelector('AudioClip CurrentEnd').getAttribute('Value'), frames: t.querySelector('SampleRef DefaultDuration').getAttribute('Value') })),
        midi: q('MidiTrack').map((t) => ({ name: name(t), clips: [...t.getElementsByTagName('MidiClip')].map((c) => ({ t: +c.getAttribute('Time'), n: c.getElementsByTagName('MidiNoteEvent').length, keys: [...c.getElementsByTagName('MidiKey')].map((k) => +k.getAttribute('Value')) })) })),
        dupIds: ids.length - new Set(ids).size, maxId: Math.max(...ids), next: +d.querySelector('NextPointeeId').getAttribute('Value'), personal: /\/Users\//.test(xml), gz: [f.data[0], f.data[1]] };
    });
    if (als) require('fs').writeFileSync('/tmp/stemtest.als.xml', als.xml);
    check(als && !als.bad && als.gz[0] === 0x1f && als.gz[1] === 0x8b && als.tempo === '120', `a gzipped Live set comes with the stems, at 120 bpm (${als && als.tempo})`);
    check(als && als.audio.length === 2 && als.audio[0].name === 'Bass' && als.audio[0].file === 'Stems/01 Bass.wav' && als.audio[1].file === 'Stems/02 Keys Pad.wav' && Math.abs(als.audio[0].end - 16) < 0.01 && +als.audio[0].frames === an.bass.len, `an audio track per stem, each clip the stem, 8 s = 16 beats long (${JSON.stringify(als && als.audio)})`);
    check(als && als.midi.length === 2 && JSON.stringify(als.midi[1].clips) === JSON.stringify([{ t: 0, n: 1, keys: [64] }, { t: 4, n: 1, keys: [67] }]) && JSON.stringify(als.midi[0].clips) === JSON.stringify([{ t: 4, n: 1, keys: [36] }]), `a MIDI track per instrument track, a clip of its notes in each section where it plays (${JSON.stringify(als && als.midi)})`);
    check(als && als.dupIds === 0 && als.maxId < als.next && !als.personal, `every automation target has its own id below NextPointeeId, and no personal paths (${als && [als.dupIds, als.maxId, als.next]})`);

    // fader: the Bass stem at -6 dB vs 0 dB
    await A.evaluate(() => JJ.setSong('lane:tb', { ...JJ.song().lanes.tb, vol: 0 })); await sleep(200);
    await A.evaluate(async () => JJ.exportStems({ mine: true, to: 'memory' }));
    const mine = await A.evaluate(() => { const w = JJ.readWav24(JJ.lastStems.find((x) => x.name.endsWith('01 Bass.wav')).data); let e = 0; for (let i = 0; i < w.L.length; i++) e += w.L[i] * w.L[i]; return { names: JJ.lastStems.map((x) => x.name), e }; });
    const ratioDb = 10 * Math.log10(mine.e / an.bass.eL);
    check(Math.abs(ratioDb - 6) < 0.6, `stems are after the track's fader: Bass is 6 dB louder at 0 dB than at -6 dB (${ratioDb.toFixed(2)} dB)`);
    check(mine.names.length === 2 && mine.names.some((n) => n.endsWith('01 Bass.wav')) && mine.names.some((n) => /About Sam's stems\.txt$/.test(n)), `"Just my tracks" writes only Sam's Bass and a note with his name (${mine.names.join(', ')})`);

    // the panel: Song options > Export stems, the band folder link shared
    await A.evaluate(() => { if (!document.querySelector('.songopts')) document.querySelector('.moretoggle').click(); }); await sleep(200);
    await A.evaluate(() => [...document.querySelectorAll('.songopts button')].find((x) => x.textContent.startsWith('Export stems')).click()); await sleep(200);
    await A.fill('.sharelink', 'https://drive.google.com/drive/folders/abc123'); await A.press('.sharelink', 'Tab'); await sleep(600);
    const sh = await B.evaluate(() => JJ.song().share);
    check(sh && sh.url === 'https://drive.google.com/drive/folders/abc123' && sh.last && sh.last.by === 'Sam', `the band folder link and the last export reach Matt (${JSON.stringify(sh)})`);
    check(!!(await A.$('.stemspanel button')), 'the Export stems panel is in Song options');
    check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  } finally { await b.close(); }
  console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
