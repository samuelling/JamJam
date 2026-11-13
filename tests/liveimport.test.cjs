// Ableton Live projects in (src/liveimport.js). A small Live project is made here (a gzipped set in Live 11's
// layout, the parts the importer reads, and its audio files), then brought in through Compose's "Import from Ableton
// Live…" folder picker, as someone would:
//   - tempo, time signature and locators -> sections
//   - a Drum Rack laid out off the General MIDI map (Kick on 60, Snare on 62): its pads mapped by name to 36 and 38
//   - a looping 1-bar MIDI clip unrolled across 8 bars; a non-looping clip cut at its end; chords read from a keys part
//   - audio: an unwarped 44.1 kHz stereo 24-bit WAV (mixed to mono, at 48 kHz, its length as recorded); a 16-bit AIFF
//     warped as if recorded at 120 bpm in a 100 bpm song (stretched by 1.2, still 440 Hz); the same AIFF with three
//     warp segments (each part where its markers put it, still 440 Hz); a clip that crosses a section line (split)
//   - a muted track comes in muted; a Session view clip and a missing audio file are reported
//   node server/dev.js &  (8787)        node tests/liveimport.test.cjs
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib');
const BASE = 'http://localhost:8787/';
let fails = 0; const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) fails++; };

// ---- the project ----
const BPM = 100, SR = 44100;
const sine = (n, sr, hz, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));
function wav24stereo(x, sr) {
  const n = x.length, b = Buffer.alloc(44 + n * 6); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 6, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 6, 28); b.writeUInt16LE(6, 32); b.writeUInt16LE(24, 34); b.write('data', 36); b.writeUInt32LE(n * 6, 40);
  for (let i = 0; i < n; i++) { const v = Math.round(x[i] * 8388607); for (let c = 0; c < 2; c++) b.writeIntLE(v, 44 + i * 6 + c * 3, 3); } return b;
}
function aiff16(x, sr) {   // mono, big-endian
  const n = x.length, b = Buffer.alloc(54 + n * 2); b.write('FORM', 0); b.writeUInt32BE(46 + n * 2, 4); b.write('AIFFCOMM', 8); b.writeUInt32BE(18, 16); b.writeUInt16BE(1, 20); b.writeUInt32BE(n, 22); b.writeUInt16BE(16, 26);
  let e = 16383 + 63, m = BigInt(sr); while (!(m & (1n << 63n))) { m <<= 1n; e--; } b.writeUInt16BE(e, 28); b.writeBigUInt64BE(m, 30);
  b.write('SSND', 38); b.writeUInt32BE(8 + n * 2, 42); b.writeUInt32BE(0, 46); b.writeUInt32BE(0, 50); for (let i = 0; i < n; i++) b.writeInt16BE(Math.round(x[i] * 32767), 54 + i * 2); return b;
}
const V = (tag, v) => `<${tag} Value="${v}" />`;
const loopX = (s, e, on, rel = 0) => `<Loop>${V('LoopStart', s)}${V('LoopEnd', e)}${V('StartRelative', rel)}${V('LoopOn', on)}${V('OutMarker', e)}${V('HiddenLoopStart', s)}${V('HiddenLoopEnd', e)}</Loop>`;
const midiClip = (start, end, loop, notes) => `<MidiClip Id="0" Time="${start}">${V('CurrentStart', start)}${V('CurrentEnd', end)}${loop}${V('Name', '')}${V('Disabled', 'false')}<Notes><KeyTracks>${
  Object.entries(notes.reduce((m, n) => ((m[n[1]] = m[n[1]] || []).push(n), m), {})).map(([k, ns]) => `<KeyTrack Id="0"><Notes>${ns.map(([t, , d]) => `<MidiNoteEvent Time="${t}" Duration="${d}" Velocity="100" IsEnabled="true" />`).join('')}</Notes>${V('MidiKey', k)}</KeyTrack>`).join('')}</KeyTracks></Notes></MidiClip>`;
const audioClip = (start, end, loop, warped, file, markers) => `<AudioClip Id="0" Time="${start}">${V('CurrentStart', start)}${V('CurrentEnd', end)}${loop}${V('Name', 'Audio')}${V('Disabled', 'false')}<WarpMarkers>${markers.map(([s, b]) => `<WarpMarker Id="0" SecTime="${s}" BeatTime="${b}" />`).join('')}</WarpMarkers>${V('IsWarped', warped)}${V('SampleVolume', 1)}${V('PitchCoarse', 0)}${V('PitchFine', 0)}<SampleRef><FileRef>${V('RelativePathType', 3)}${V('RelativePath', file)}${V('Path', '/Users/someone/Music/Proj/' + file)}</FileRef></SampleRef></AudioClip>`;
const track = (tag, name, muted, devices, events, session = '') => `<${tag} Id="0"><Name>${V('EffectiveName', name)}${V('UserName', name)}</Name><DeviceChain><Mixer><Speaker>${V('Manual', muted ? 'false' : 'true')}</Speaker><Volume>${V('Manual', 1)}</Volume></Mixer><MainSequencer><ClipSlotList>${session}</ClipSlotList>${
  tag === 'MidiTrack' ? `<ClipTimeable><ArrangerAutomation><Events>${events}</Events></ArrangerAutomation></ClipTimeable>` : `<Sample><ArrangerAutomation><Events>${events}</Events></ArrangerAutomation></Sample>`}</MainSequencer><DeviceChain><Devices>${devices}</Devices></DeviceChain></DeviceChain></${tag}>`;
const rack = `<DrumGroupDevice Id="0"><Branches>${[[60, 'Kick'], [62, 'Snare'], [64, 'Closed Hat']].map(([n, nm]) => `<DrumBranch Id="0"><Name>${V('EffectiveName', nm)}${V('UserName', '')}</Name><BranchInfo>${V('ReceivingNote', 128 - n)}${V('SendingNote', 60)}</BranchInfo></DrumBranch>`).join('')}</Branches></DrumGroupDevice>`;
const sec = 60 / BPM;   // seconds a beat
const set = `<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="11.0_11300" Creator="Ableton Live 11.3.13"><LiveSet><Tracks>
${track('MidiTrack', 'Drums', false, rack, midiClip(0, 32, loopX(0, 4, 'true'), [[0, 60, 0.25], [2, 60, 0.25], [1, 62, 0.25], [3, 62, 0.25], [0, 64, 0.25], [1, 64, 0.25], [2, 64, 0.25], [3, 64, 0.25]]), '<ClipSlot Id="0"><MidiClip Id="9" Time="0" /></ClipSlot>')}
${track('MidiTrack', 'Keys', false, '<Drift Id="0" />', midiClip(32, 40, loopX(0, 16, 'false'), [[0, 60, 4], [0, 64, 4], [0, 67, 4], [4, 57, 4], [4, 60, 4], [4, 64, 4], [12, 62, 2]]))}
${track('MidiTrack', 'Old idea', true, '<Drift Id="0" />', midiClip(0, 8, loopX(0, 8, 'false'), [[0, 72, 1]]))}
${track('AudioTrack', 'Vox', false, '', audioClip(4, 4 + 3 / sec, loopX(0, 3, 'false'), 'false', 'Samples/Recorded/vox.wav', [[0, 0], [0.01, 0.02]]))}
${track('AudioTrack', 'Loop', false, '', audioClip(32, 40, loopX(0, 8, 'false'), 'true', 'Samples/Imported/loop.aif', [[0, 0], [0.5, 1]]) + audioClip(36, 44, loopX(0, 8, 'false'), 'true', 'Samples/Imported/gone.wav', [[0, 0], [0.5, 1]]))}
${track('AudioTrack', 'Bent', false, '', audioClip(40, 52, loopX(0, 12, 'false'), 'true', 'Samples/Imported/loop.aif', [[0, 0], [1.5, 4], [2.25, 8], [3.25, 12]]))}
</Tracks><MasterTrack><DeviceChain><Mixer><Tempo>${V('Manual', BPM)}<AutomationTarget Id="8" /></Tempo><TimeSignature>${V('Manual', 201)}</TimeSignature></Mixer></DeviceChain></MasterTrack>
<Locators><Locators><Locator Id="0">${V('Time', 0)}${V('Name', 'Verse')}</Locator><Locator Id="1">${V('Time', 32)}${V('Name', 'Chorus')}</Locator><Locator Id="2">${V('Time', 48)}${V('Name', 'Outro')}</Locator></Locators></Locators></LiveSet></Ableton>`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-')), proj = path.join(dir, 'Test Song Project');
fs.mkdirSync(path.join(proj, 'Samples/Recorded'), { recursive: true }); fs.mkdirSync(path.join(proj, 'Samples/Imported'), { recursive: true }); fs.mkdirSync(path.join(proj, 'Backup'));
fs.writeFileSync(path.join(proj, 'Test Song.als'), zlib.gzipSync(set));
fs.writeFileSync(path.join(proj, 'Backup/Test Song [old].als'), zlib.gzipSync(set.replace('Verse', 'WRONG')));   // Live's backups are skipped
fs.writeFileSync(path.join(proj, 'Samples/Recorded/vox.wav'), wav24stereo(sine(SR * 3, SR, 220), SR));
fs.writeFileSync(path.join(proj, 'Samples/Imported/loop.aif'), aiff16(sine(48000 * 4, 48000, 440), 48000));

(async () => {
  const b = await chromium.launch(); const errors = [];
  const p = await (await b.newContext()).newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE); await p.fill('#nameIn', 'Sam'); await p.click('#startBtn'); await p.waitForSelector('#studio:not(.hide)');
  await p.evaluate(() => JJ.goRoom('compose')); await p.waitForTimeout(400);
  check(await p.isVisible('#compose button:has-text("Import from Ableton Live")'), 'Compose offers "Import from Ableton Live…"');
  await p.setInputFiles('#compose input[webkitdirectory]', proj);
  await p.waitForFunction(() => JJ.song().title === 'Test Song', null, { timeout: 30000 });
  const r = await p.evaluate(() => {
    const S = JJ.song(), secs = S.order.map((id) => S.sections[id]);
    const ons = (q) => q.takes[0].events.filter((e) => e.type === 'on');
    const freq = (id) => { const x = JJ.blobs.pcm(id).pcm16, sr = JJ.blobs.pcm(id).sr; let z = 0, a = Math.floor(x.length * 0.2), e = Math.floor(x.length * 0.8); for (let i = a + 1; i < e; i++) if (x[i - 1] < 0 && x[i] >= 0) z++; return (z * sr) / (e - a); };
    const part = (s, n) => Object.values(s?.parts || {}).find((q) => q.name === n);
    const au = (s, n) => { const q = part(s, n); if (!q) return null; const A = q.takes[0].audio; return { from: A.from, beats: A.beats, frames: A.frames, sr: A.sr, hz: Math.round(freq(A.id)), has: JJ.blobs.has(A.id), secs: A.frames / A.sr }; };
    return { bpm: Math.round(JJ.tempo.bpm(JJ.clock.now() + 5000)), meter: S.meter || 4, sections: secs.map((s) => `${s.name}:${s.bars}`), status: document.querySelector('#status')?.textContent || '',
      drums: secs.map((s) => { const d = part(s, 'Drums'); return d ? [...new Set(ons(d).map((e) => e.note))].sort().join(',') + '/' + ons(d).length : null; }),
      drumInst: part(secs[0], 'Drums')?.inst, keys: part(secs[1], 'Keys') && ons(part(secs[1], 'Keys')).map((e) => `${e.b}:${e.note}`).join(' '), chords: secs[1].chords.slice(0, 2).join(' '),
      muted: part(secs[0], 'Old idea')?.muted, vox: au(secs[0], 'Vox'), loop: au(secs[1], 'Loop'), bent: au(secs[1], 'Bent'), bent2: au(secs[2] || {}, 'Bent'), lanes: Object.values(S.lanes).map((t) => `${t.name}:${t.kind || 'midi'}`).sort().join(' ') };
  });
  console.log('  ', JSON.stringify(r));
  check(r.bpm === 100 && r.meter === 4, 'tempo 100, 4/4');
  check(r.sections.join() === 'Verse:8,Chorus:4,Outro:1', `locators become sections, the last running to the song's end (${r.sections.join(', ')}); Live's Backup folder ignored`);
  check(r.drumInst === 'machina' && r.drums[0] === '36,38,42/64', `the Drum Rack's Kick, Snare and Closed Hat (pads 60, 62, 64) play as 36, 38, 42; the 1-bar loop unrolled over 8 bars (${r.drums[0]})`);
  check(r.keys === '0:60 0:64 0:67 4:57 4:60 4:64', `the Keys clip stops at its end, 2 bars in (the note at bar 4 of its 4-bar content is cut): ${r.keys}`);
  check(/^C Am$/.test(r.chords), `chords from the keys part: ${r.chords}`);
  check(r.muted === true, 'the muted track comes in muted');
  check(r.vox && r.vox.from === 4 && r.vox.sr === 48000 && Math.abs(r.vox.secs - 3) < 0.01 && Math.abs(r.vox.hz - 220) <= 2, `unwarped 44.1 kHz stereo WAV: 1 bar in, 3 s long as recorded, at 48 kHz, still 220 Hz (${JSON.stringify(r.vox)})`);
  check(r.loop && Math.abs(r.loop.secs - 8 * 0.6) < 0.01 && Math.abs(r.loop.hz - 440) <= 3, `simple warp (120 bpm loop in a 100 bpm song): 8 beats = 4.8 s, stretched, still 440 Hz (${r.loop?.secs.toFixed(2)} s, ${r.loop?.hz} Hz)`);
  check(r.bent && r.bent.from === 8 && r.bent.beats === 8 && r.bent2 && r.bent2.from === 0 && r.bent2.beats === 4 && Math.abs(r.bent.hz - 440) <= 4, `complex warp (3 segments) across the Chorus/Outro line: split into two takes (8 + 4 beats), still 440 Hz (${r.bent?.hz} Hz)`);
  check(/Session view clip/.test(r.status) && /gone\.wav/.test(r.status) && /Collect All and Save/.test(r.status), 'the Session view clip and the missing file are reported');
  check(r.lanes.includes('Vox:audio') && r.lanes.includes('Keys:midi'), `tracks: ${r.lanes}`);
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  fs.rmSync(dir, { recursive: true, force: true });
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})();
