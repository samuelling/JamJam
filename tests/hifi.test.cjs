// High-fidelity studio takes: jamming stays lean, locked takes can be 48 kHz stereo.
// Sam's "microphone" is a stereo file (440 Hz left, 660 Hz right) through Chromium's fake capture device.
//   - Standard (the default): a locked take is 24 kHz mono, as before
//   - High fidelity (Song options in a studio; here set directly): the next take is 48 kHz stereo, left and right
//     kept apart; it reaches Matt, who plays it as a stereo buffer
//   - the live stream to the band is unchanged: still mono
//   - a stereo take round-trips through a WAV (Save song, the band's Dropbox) as stereo
//   - the setting survives loading another song; an Ableton Live import keeps a stereo file stereo under it
// (Chromium's fake capture runs a file about 1.3% fast in headless runs, on main too, so pitches are checked within 2%
// and left/right by their 3:2 ratio.)
//   node server/dev.js &  (8787)        node tests/hifi.test.cjs
const { chromium } = require('playwright'); const fs = require('fs'), os = require('os'), path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) fails++; };
// a 48 kHz stereo 16-bit WAV: 440 Hz left, 660 Hz right, 30 s
const SR = 48000, N = SR * 30, wavb = Buffer.alloc(44 + N * 4);
wavb.write('RIFF', 0); wavb.writeUInt32LE(36 + N * 4, 4); wavb.write('WAVEfmt ', 8); wavb.writeUInt32LE(16, 16); wavb.writeUInt16LE(1, 20); wavb.writeUInt16LE(2, 22); wavb.writeUInt32LE(SR, 24); wavb.writeUInt32LE(SR * 4, 28); wavb.writeUInt16LE(4, 32); wavb.writeUInt16LE(16, 34); wavb.write('data', 36); wavb.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { wavb.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / SR)), 44 + i * 4); wavb.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 660 * i) / SR)), 46 + i * 4); }
const mic = path.join(os.tmpdir(), 'hifi-mic.wav'); fs.writeFileSync(mic, wavb);

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${mic}`] });
  const errors = [];
  const mk = async (q, name) => { const c = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['microphone'] }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); await p.goto('http://localhost:8787/' + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?lag=25', 'Sam'); await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=25`, 'Matt'); await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1))); if (ok.every(Boolean)) break; await sleep(250); }
    await A.evaluate(() => { JJ.setSong('sec:v1', { name: 'Verse', bars: 2, chords: ['C', 'G'], notes: '' }); JJ.setSong('order', ['v1']); });
    await sleep(400);
    const passMs = await A.evaluate(() => 8 * 60000 / JJ.tempo.bpm(JJ.clock.now()));
    const lockPass = async () => { await sleep(passMs * 1.3 + 800); return A.evaluate(() => JJ.lockAudio()); };
    const lastTake = (p) => p.evaluate(() => { const q = Object.values(JJ.song().sections.v1?.parts || {}).find((x) => x.kind === 'audio'); const t = q?.takes?.at(-1); return t && { ...t.audio, peaks: undefined }; });
    const freqs = (p, id, ch) => p.evaluate(([id, ch]) => { const c = JJ.blobs.pcm(id); if (!c) return null; const n = Math.floor(c.pcm16.length / ch), hz = []; for (let k = 0; k < ch; k++) { let z = 0; for (let i = Math.floor(n * 0.3) + 1; i < Math.floor(n * 0.7); i++) if (c.pcm16[(i - 1) * ch + k] < 0 && c.pcm16[i * ch + k] >= 0) z++; hz.push(Math.round((z * c.sr) / (n * 0.4))); } return hz; }, [id, ch]);

    // standard
    await A.click('#addLiveBtn'); await A.click('#laneBtn'); await sleep(800);
    check(await A.evaluate(() => JJ.lane().on), 'Sam goes live (the fake stereo file as his input)');
    await A.evaluate(() => JJ.play('loop', 'v1'));
    await sleep(passMs * 1.2);
    check((await lockPass()) === 1, 'a pass locks in (standard)');
    let t = await lastTake(A);
    check(t && t.sr === 24000 && !t.ch && (await A.evaluate((id) => JJ.blobs.pcm(id).pcm16.length, t.id)) === t.frames, `standard: 24 kHz mono, as before (${t?.sr} Hz, ${t?.ch || 1} ch)`);
    check(await A.evaluate(() => !JJ.lane().wantStereo), 'standard: the input is opened in mono');

    // high fidelity
    await A.evaluate(() => JJ.setTakeQuality('hifi')); await sleep(1500);
    check(await A.evaluate(() => JJ.song().master?.takes === 'hifi' && JJ.lane().on && JJ.lane().wantStereo), 'high fidelity: set for the song, and live audio reopens with two channels');
    check(await B.evaluate(() => JJ.song().master?.takes === 'hifi'), "it's the room's setting: Matt's song says high fidelity too");
    await sleep(passMs * 1.2);
    check((await lockPass()) === 1, 'a pass locks in (high fidelity)');
    t = await lastTake(A);
    const hz = t && await freqs(A, t.id, t.ch || 1);
    console.log('   take:', JSON.stringify(t), 'Hz per channel:', JSON.stringify(hz));
    check(t && t.sr === 48000 && t.ch === 2 && (await A.evaluate((id) => JJ.blobs.pcm(id).pcm16.length, t.id)) === t.frames * 2, `high fidelity: 48 kHz stereo (${t?.frames} frames, interleaved)`);
    const apart = (h) => h && Math.abs(h[0] / 440 - 1) < 0.02 && Math.abs(h[1] / 660 - 1) < 0.02 && Math.abs(h[1] / h[0] - 1.5) < 0.01;
    check(apart(hz), `left and right kept apart: ${hz?.join(' / ')} Hz (440 / 660 in)`);
    let got = false; for (let i = 0; i < 40 && !got; i++) { got = await B.evaluate((id) => JJ.blobs.has(id), t.id); await sleep(250); }
    const bHz = got && await freqs(B, t.id, 2);
    check(got && apart(bHz) && bHz.join() === hz.join(), `the stereo take reaches Matt intact (${bHz?.join(' / ')} Hz)`);
    check(await B.evaluate((id) => JJ.chOf(id), t.id) === 2, 'and Matt plays it as stereo');
    // the live stream is unchanged: the chunks that go out are mono
    const chunk = await A.evaluate(() => new Promise((res) => { const L = JJ.lane(), send = L.send; L.send = (buf) => { L.send = send; send(buf); const dv = new DataView(buf); res({ rate: dv.getUint32(16, true), frames: dv.getUint32(20, true), bytes: buf.byteLength }); }; }));
    check(chunk.bytes === 24 + chunk.frames * 2, `jamming stays lean: the live stream is still mono (${chunk.frames} samples a chunk at ${chunk.rate} Hz)`);
    // WAV round trip (Save song, the band's Dropbox)
    const rt = await A.evaluate(async (id) => { const Z = await import('/src/songzip.js'), c = JJ.blobs.pcm(id), w = Z.readPcmWav(Z.wav(c.pcm16, c.sr, 2)); return { ch: w.ch, sr: w.sr, same: w.pcm16.length === c.pcm16.length && w.pcm16.every((v, i) => v === c.pcm16[i]) }; }, t.id);
    check(rt.ch === 2 && rt.sr === 48000 && rt.same, 'a stereo take round-trips through a WAV, sample for sample');
    // the setting survives loading another song
    await A.evaluate(() => JJ.loadSong({ format: 'megajam.song/1', title: 'Other', bpm: 100, sections: {}, order: [], lanes: {} })); await sleep(300);
    check(await A.evaluate(() => JJ.song().master?.takes === 'hifi'), 'loading another song keeps the studio on high fidelity');
    // an Ableton import under high fidelity keeps a stereo file stereo
    const imp = await A.evaluate(async () => {
      const zlib = null; const enc = new TextEncoder();
      const V = (t, v) => `<${t} Value="${v}" />`;
      const xml = `<?xml version="1.0"?><Ableton><LiveSet><Tracks><AudioTrack><Name>${V('UserName', 'Stereo')}</Name><DeviceChain><Mixer><Speaker>${V('Manual', 'true')}</Speaker></Mixer><MainSequencer><Sample><ArrangerAutomation><Events><AudioClip Time="0">${V('CurrentStart', 0)}${V('CurrentEnd', 8)}<Loop>${V('LoopStart', 0)}${V('LoopEnd', 4.8)}${V('LoopOn', 'false')}${V('StartRelative', 0)}</Loop>${V('IsWarped', 'false')}${V('SampleVolume', 1)}<SampleRef><FileRef>${V('RelativePath', 'Samples/s.wav')}</FileRef></SampleRef></AudioClip></Events></ArrangerAutomation></Sample></MainSequencer><DeviceChain><Devices /></DeviceChain></DeviceChain></AudioTrack></Tracks><MasterTrack><DeviceChain><Mixer><Tempo>${V('Manual', 100)}</Tempo></Mixer></DeviceChain></MasterTrack></LiveSet></Ableton>`;
      const Z = await import('/src/songzip.js'), n = 48000 * 5, pcm = new Int16Array(n * 2); for (let i = 0; i < n; i++) { pcm[2 * i] = Math.round(9000 * Math.sin(2 * Math.PI * 440 * i / 48000)); pcm[2 * i + 1] = Math.round(9000 * Math.sin(2 * Math.PI * 660 * i / 48000)); }
      const L = await import('/src/liveimport.js');
      const r = await L.songFromLive([{ name: 'P/S.als', data: enc.encode(xml) }, { name: 'P/Samples/s.wav', data: Z.wav(pcm, 48000, 2) }], { stereo: true });
      const r2 = await L.songFromLive([{ name: 'P/S.als', data: enc.encode(xml) }, { name: 'P/Samples/s.wav', data: Z.wav(pcm, 48000, 2) }], { stereo: false });
      return { hifi: r.clips.map((c) => c.ch), std: r2.clips.map((c) => c.ch), take: Object.values(r.song.sections)[0] && Object.values(Object.values(r.song.sections)[0].parts)[0].takes[0].audio.ch };
    });
    check(imp.hifi.join() === '2' && imp.take === 2 && imp.std.join() === '1', `an Ableton import keeps a stereo file stereo under high fidelity, mono otherwise (${JSON.stringify(imp)})`);
    check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } catch (e) { console.log('ERROR', e.message); fails++; }
  await browser.close(); fs.rmSync(mic, { force: true });
  console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})();
