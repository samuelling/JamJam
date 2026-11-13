// Ableton Live sets in: a Live project (its .als and the audio it uses) becomes a MEGAjam song. Arrangement view only:
//   - the tempo and time signature; locators become sections (none: a section every 8 bars)
//   - each MIDI track becomes a track: its clips' notes, unrolled the way Live plays them (a looping clip repeats
//     its loop for as long as the clip runs), cut into the sections. A Drum Rack's pads are mapped by name (Kick,
//     Snare, Closed Hat…, from the pad or its sample) onto the drum notes MEGAjam's kits play.
//   - each audio track becomes an audio track: in every section it plays in, one take rendered from its clips at
//     the song's tempo. An unwarped clip plays as recorded; a warped clip is time-stretched (keeping its pitch) to
//     follow its warp markers, however many there are, so nothing needs consolidating first. Mono at 48 kHz, or (in
//     a studio set to high fidelity) stereo where the file is stereo.
//   - muted tracks come in muted. Devices, automation, sends and Session view clips stay behind (warnings say so).
//
// The set itself is gzipped XML (Live 10 to 12 share this layout). Times are in beats; a warped audio clip's loop and
// markers are in the sample's own beats, which its warp markers (seconds ↔ beats) turn into seconds in the file; an
// unwarped clip's are in seconds. Audio files are found by the path the set keeps for them relative to the project
// (Collect All and Save puts them all inside it), or failing that by file name.
import { emptySong, newSection, sliceEvents, chartFromParts, guessInstrument, guessRole, keyFromParts } from './song.js';

const OUT_SR = 48000;   // imported audio: 48 kHz (mono, or stereo when asked for)

// ---------- small XML helpers (DOM from DOMParser) ----------
const kid = (e, path) => { let n = e; for (const t of path.split('/')) { if (!n) return null; n = [...n.children].find((c) => c.tagName === t) || null; } return n; };
const val = (e, path, d = null) => { const n = kid(e, path); const v = n?.getAttribute('Value'); return v == null ? d : v; };
const num = (e, path, d = 0) => { const v = parseFloat(val(e, path)); return Number.isFinite(v) ? v : d; };
const on = (e, path, d = false) => { const v = val(e, path); return v == null ? d : v === 'true'; };
const all = (e, tag) => (e ? [...e.getElementsByTagName(tag)] : []);

export async function gunzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// ---------- reading the set ----------
// -> { bpm, meter, locators: [{ beat, name }], tracks: [...], warnings: [] }
export function readLiveSet(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror') || doc.documentElement.tagName !== 'Ableton') throw new Error("that isn't an Ableton Live set");
  const ls = kid(doc.documentElement, 'LiveSet'), warnings = [];
  const master = kid(ls, 'MasterTrack') || kid(ls, 'MainTrack'), mixer = kid(master, 'DeviceChain/Mixer');
  const bpm = num(mixer, 'Tempo/Manual', 120);
  const ts = Math.round(num(mixer, 'TimeSignature/Manual', 201)), meter = (ts % 99) + 1, denom = 2 ** Math.floor(ts / 99);
  if (denom !== 4) warnings.push(`The set is in ${meter}/${denom}: MEGAjam counts it as ${meter} beats a bar.`);
  // tempo automation: a tempo envelope with more than one value
  const tempoId = kid(mixer, 'Tempo/AutomationTarget')?.getAttribute('Id');
  for (const env of all(master, 'AutomationEnvelope')) {
    if (val(env, 'EnvelopeTarget/PointeeId') !== tempoId) continue;
    const vs = new Set(all(env, 'FloatEvent').map((f) => f.getAttribute('Value')));
    if (vs.size > 1) warnings.push(`The tempo changes during the song; MEGAjam uses the opening tempo, ${Math.round(bpm * 100) / 100} bpm.`);
  }
  const locators = all(kid(ls, 'Locators'), 'Locator').map((l) => ({ beat: num(l, 'Time'), name: val(l, 'Name', '') })).filter((l) => l.beat >= 0).sort((a, b) => a.beat - b.beat);
  const tracks = [];
  let sessionClips = 0;
  for (const t of [...(kid(ls, 'Tracks')?.children || [])]) {
    if (t.tagName !== 'MidiTrack' && t.tagName !== 'AudioTrack') continue;
    const name = val(t, 'Name/UserName') || val(t, 'Name/EffectiveName') || (t.tagName === 'MidiTrack' ? 'MIDI' : 'Audio');
    const dc = kid(t, 'DeviceChain'), devices = [...(kid(dc, 'DeviceChain/Devices')?.children || [])];
    const muted = !on(dc, 'Mixer/Speaker/Manual', true);
    sessionClips += all(kid(dc, 'MainSequencer/ClipSlotList'), 'MidiClip').length + all(kid(dc, 'MainSequencer/ClipSlotList'), 'AudioClip').length;
    const seq = t.tagName === 'MidiTrack' ? kid(dc, 'MainSequencer/ClipTimeable/ArrangerAutomation/Events') : kid(dc, 'MainSequencer/Sample/ArrangerAutomation/Events');
    const clips = [...(seq?.children || [])].filter((c) => !on(c, 'Disabled')).map((c) => readClip(c));
    tracks.push({ name, kind: t.tagName === 'MidiTrack' ? 'midi' : 'audio', muted, devices: devices.map((d) => d.tagName), pads: drumPads(devices), clips, gain: num(dc, 'Mixer/Volume/Manual', 1) });
  }
  if (sessionClips) warnings.push(`${sessionClips} Session view clip${sessionClips === 1 ? '' : 's'} stayed behind: only the Arrangement comes in.`);
  return { bpm, meter, locators, tracks, warnings };
}
function readClip(c) {
  const loop = kid(c, 'Loop');
  const clip = { kind: c.tagName === 'MidiClip' ? 'midi' : 'audio', start: num(c, 'CurrentStart', parseFloat(c.getAttribute('Time')) || 0), end: num(c, 'CurrentEnd'), name: val(c, 'Name', ''),
    loop: { on: on(loop, 'LoopOn'), start: num(loop, 'LoopStart'), end: num(loop, 'LoopEnd'), rel: num(loop, 'StartRelative') } };
  if (clip.kind === 'midi') {
    clip.notes = [];
    for (const kt of all(kid(c, 'Notes/KeyTracks'), 'KeyTrack')) {
      const key = Math.round(num(kt, 'MidiKey', 60));
      for (const n of all(kt, 'MidiNoteEvent')) if (n.getAttribute('IsEnabled') !== 'false') clip.notes.push({ t: +n.getAttribute('Time'), d: +n.getAttribute('Duration'), key, vel: Math.round(+n.getAttribute('Velocity') || 100) });
    }
  } else {
    clip.warped = on(c, 'IsWarped');
    clip.file = { rel: val(c, 'SampleRef/FileRef/RelativePath', ''), path: val(c, 'SampleRef/FileRef/Path', ''), name: val(c, 'SampleRef/FileRef/Name', '') };
    clip.markers = all(kid(c, 'WarpMarkers'), 'WarpMarker').map((m) => ({ s: +m.getAttribute('SecTime'), b: +m.getAttribute('BeatTime') })).sort((a, b) => a.b - b.b);
    clip.gain = num(c, 'SampleVolume', 1);
    clip.pitch = num(c, 'PitchCoarse') + num(c, 'PitchFine') / 100;
    clip.reversed = on(c, 'IsReversed');
  }
  return clip;
}
// a Drum Rack's pads: MIDI note -> what the pad is (its name, or its sample's)
function drumPads(devices) {
  const dr = devices.find((d) => d.tagName === 'DrumGroupDevice'); if (!dr) return null;
  const pads = {};
  for (const b of all(kid(dr, 'Branches'), 'DrumBranch')) {
    const rn = parseFloat(val(b, 'BranchInfo/ReceivingNote')); if (!Number.isFinite(rn)) continue;
    const sample = all(b, 'FileRef').map((f) => val(f, 'RelativePath') || val(f, 'Path') || '').find(Boolean) || '';
    pads[128 - rn] = `${val(b, 'Name/UserName') || val(b, 'Name/EffectiveName') || ''} ${sample.split('/').pop()}`.trim();
  }
  return pads;
}
// a pad's name -> the General MIDI drum note MEGAjam's kits play (null: leave it where it is)
const PAD_RE = [[/kick|\bbd\b|bass ?drum/, 36], [/snare|\bsd\b/, 38], [/rim|side ?stick/, 37], [/clap|\bcp\b/, 39], [/open.?h|\boh\b|ohh/, 46], [/pedal/, 44],
  [/hat|\bhh\b|\bch\b|chh/, 42], [/crash|cymbal|\bcy\b/, 49], [/ride/, 51], [/low.?tom|floor|tom.?(low|lo|1)\b/, 41], [/hi.?tom|high.?tom|tom.?(hi|high|3)\b/, 48], [/tom/, 45],
  [/cow ?bell/, 56], [/clave/, 75], [/shaker|maraca/, 70], [/tamb/, 54], [/conga|bongo|perc/, 60]];
export function padNote(label) { const s = String(label || '').toLowerCase(); for (const [re, n] of PAD_RE) if (re.test(s)) return n; return null; }

// ---------- MIDI clips: the notes Live plays, in song beats ----------
export function clipNotes(clip) {
  const { start, end, loop } = clip, out = [], len = loop.end - loop.start;
  for (const n of clip.notes) {
    if (n.t < loop.start || n.t >= loop.end) continue;
    if (!loop.on) { const a = start + (n.t - loop.start); if (a < end) out.push({ a, z: Math.min(a + n.d, end, start + len), key: n.key, vel: n.vel }); continue; }
    if (len <= 0) continue;
    // the first pass begins at loop.start + rel; a note at t sounds at start + ((t - loop.start - rel) mod len) + k·len
    let a = start + ((((n.t - loop.start - loop.rel) % len) + len) % len);
    for (; a < end; a += len) out.push({ a, z: Math.min(a + n.d, end, a + (loop.end - n.t)), key: n.key, vel: n.vel });
  }
  return out.sort((x, y) => x.a - y.a);
}

// ---------- audio files ----------
// WAV (PCM 8/16/24/32-bit, float) and AIFF/AIFC (PCM, sowt, fl32): -> { sr, data: Float32Array (mono mix), stereo: [L, R] | null }
export function decodeAudio(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const tag = (o) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
  let fmt = null, data = null, sr = 0, ch = 1, bits = 16, le = true, float = false;
  if (tag(0) === 'RIFF' && tag(8) === 'WAVE') {
    for (let o = 12; o + 8 <= u.length;) {
      const id = tag(o), n = dv.getUint32(o + 4, true);
      if (id === 'fmt ') { let f = dv.getUint16(o + 8, true); ch = dv.getUint16(o + 10, true); sr = dv.getUint32(o + 12, true); bits = dv.getUint16(o + 22, true); if (f === 0xfffe) f = dv.getUint16(o + 32, true); float = f === 3; fmt = f; }
      else if (id === 'data') data = [o + 8, Math.min(n, u.length - o - 8)];
      o += 8 + n + (n & 1);
    }
    if (fmt !== 1 && fmt !== 3) throw new Error('that WAV is compressed (only PCM WAVs come in)');
  } else if (tag(0) === 'FORM' && (tag(8) === 'AIFF' || tag(8) === 'AIFC')) {
    for (let o = 12; o + 8 <= u.length;) {
      const id = tag(o), n = dv.getUint32(o + 4, false);
      if (id === 'COMM') {
        ch = dv.getUint16(o + 8, false); bits = dv.getUint16(o + 14, false);
        const e = dv.getUint16(o + 16, false) & 0x7fff, hi = dv.getUint32(o + 18, false), lo = dv.getUint32(o + 22, false);   // 80-bit extended
        sr = Math.round((hi * 2 ** 32 + lo) * 2 ** (e - 16383 - 63));
        le = false;
        if (tag(8) === 'AIFC') { const c = tag(o + 26); if (c === 'sowt') le = true; else if (c === 'fl32' || c === 'FL32') { float = true; bits = 32; } else if (c !== 'NONE' && c !== 'twos') throw new Error(`that AIFF is compressed (${c})`); }
      } else if (id === 'SSND') { const off = dv.getUint32(o + 8, false); data = [o + 16 + off, Math.min(n - 8 - off, u.length - o - 16 - off)]; }
      o += 8 + n + (n & 1);
    }
  } else throw new Error('not a WAV or AIFF file');
  if (!data || !sr) throw new Error('that audio file has no sound in it');
  const B = bits / 8, frames = Math.floor(data[1] / (B * ch)), out = new Float32Array(frames), L = ch > 1 ? new Float32Array(frames) : null, R = ch > 1 ? new Float32Array(frames) : null;
  for (let i = 0, p = data[0]; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++, p += B) {
      let v;
      if (float) v = bits === 64 ? dv.getFloat64(p, le) : dv.getFloat32(p, le);
      else if (B === 1) v = (u[p] - 128) / 128;
      else if (B === 2) v = dv.getInt16(p, le) / 32768;
      else if (B === 3) { const x = le ? u[p] | (u[p + 1] << 8) | (u[p + 2] << 16) : (u[p] << 16) | (u[p + 1] << 8) | u[p + 2]; v = ((x << 8) >> 8) / 8388608; }
      else v = dv.getInt32(p, le) / 2147483648;
      s += v; if (c === 0 && L) L[i] = v; else if (c === 1 && R) R[i] = v;
    }
    out[i] = s / ch;
  }
  let differ = false; if (L) { let d = 0, pk = 0; for (let i = 0; i < frames; i++) { d = Math.max(d, Math.abs(L[i] - R[i])); pk = Math.max(pk, Math.abs(L[i])); } differ = d > pk * 0.01; }
  return { sr, data: out, stereo: differ ? [L, R] : null };   // data: the mono mix; stereo: the first two channels, if they differ
}
function resample(x, from, to) {
  if (from === to) return x;
  const n = Math.floor((x.length * to) / from), y = new Float32Array(n), k = from / to;
  for (let i = 0; i < n; i++) { const p = i * k, j = Math.floor(p), f = p - j; y[i] = (x[j] || 0) * (1 - f) + (x[j + 1] || 0) * f; }
  return y;
}

// ---------- audio clips: rendered at the song's tempo ----------
// where in the file (seconds) a clip's content beat lies, by its warp markers (beyond them: the nearest segment's rate)
function secAt(markers, b) {
  const m = markers.length >= 2 ? markers : [{ s: 0, b: 0 }, { s: 1, b: 2 }];
  let i = 0; while (i < m.length - 2 && b > m[i + 1].b) i++;
  const A = m[i], Z = m[i + 1]; return A.s + ((b - A.b) * (Z.s - A.s)) / (Z.b - A.b || 1);
}
// how many beats of the song (from the clip's start) -> seconds in the file
function sourceMap(clip, bpm) {
  const { loop } = clip, len = loop.end - loop.start;
  const content = (d) => (loop.on && len > 0 ? loop.start + ((((loop.rel + d) % len) + len) % len) : loop.start + d);   // in the clip's own units
  if (clip.warped) return (d) => secAt(clip.markers, content(d));
  return (d) => content((d * 60) / bpm);   // unwarped: the loop is in seconds; d beats are d·60/bpm seconds
}
// WSOLA: an overlap-add of short windows taken where `at` says, each nudged to line up with the last (keeps the
// pitch). The windows are chosen once, on the mono mix, and the same ones taken from each channel (stereo stays put).
function wsola(src, sr, frames, at) {
  const N = Math.max(256, Math.round(sr * 0.04) & ~1), H = N >> 1, tol = H >> 1, plan = [];
  let prev = -1;
  for (let o = 0; o < frames; o += H) {
    let p = Math.round(at(o));
    const nat = prev + H;
    if (prev >= 0 && Math.abs(p - nat) <= 2 * N) {   // continuous: find the best match to where the last window was heading
      let best = p, bc = -Infinity;
      for (let d = -tol; d <= tol; d += 2) {
        const q = p + d; if (q < 0 || q + H >= src.length) continue;
        let c = 0; for (let i = 0; i < H; i += 4) c += src[q + i] * src[nat + i] || 0;
        if (c > bc) { bc = c; best = q; }
      }
      p = best;
    }
    plan.push(p); prev = p;
  }
  return { N, H, plan };
}
function overlapAdd(src, frames, { N, H, plan }, gain) {
  const out = new Float32Array(frames + N), w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  plan.forEach((p, k) => { const o = k * H; for (let i = 0; i < N; i++) { const s = src[p + i]; if (s !== undefined && p + i >= 0) out[o + i] += s * w[i] * gain; } });
  return out.subarray(0, frames);
}
// -> [mono] or [L, R] (stereo: when asked for and the file has two channels), at OUT_SR and the song's tempo
export function renderClip(clip, audio, bpm, stereo = false) {
  const sr = OUT_SR, chans = (stereo && audio.stereo ? audio.stereo : [audio.data]).map((x) => resample(x, audio.sr, sr)), mix = chans.length > 1 ? resample(audio.data, audio.sr, sr) : chans[0];
  const beats = clip.end - clip.start, frames = Math.max(0, Math.round((beats * 60 * sr) / bpm));
  const map = sourceMap(clip, bpm), at = (o) => map((o * bpm) / (60 * sr)) * sr;   // output frame -> source frame
  // a steady 1:1 rate (unwarped, or warped at the song's tempo): copy, sample for sample; otherwise stretch
  const rate = (at(Math.min(frames, sr)) - at(0)) / Math.min(frames, sr), steady = frames < 2 || [0.25, 0.5, 0.75, 1].every((f) => { const a = Math.floor(frames * f) - 1; return Math.abs(at(a + 1) - at(a) - 1) < 1e-3; });
  let outs;
  if (steady && Math.abs(rate - 1) < 1e-3) outs = chans.map((src) => { const o = new Float32Array(frames); for (let i = 0; i < frames; i++) o[i] = (src[Math.round(at(i))] || 0) * clip.gain; return o; });
  else { const pl = wsola(mix, sr, frames, at); outs = chans.map((src) => overlapAdd(src, frames, pl, clip.gain)); }
  const f = Math.min(Math.round(sr * 0.003), frames >> 1);   // no clicks at the edges
  for (const out of outs) { if (clip.reversed) out.reverse(); for (let i = 0; i < f; i++) { out[i] *= i / f; out[frames - 1 - i] *= i / f; } }
  return outs;
}

// ---------- the song ----------
const rid8 = () => Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'track';
function peaksOf(pcm) { const n = 120, out = []; for (let p = 0; p < n; p++) { let m = 0; for (let i = Math.floor((p * pcm.length) / n); i < Math.floor(((p + 1) * pcm.length) / n); i++) m = Math.max(m, Math.abs(pcm[i])); out.push(Math.round(m * 100) / 100); } return out; }

// files: [{ name (path inside the project, or just a file name), data: Uint8Array | () => Promise<Uint8Array> }]
// o: { progress(text), stereo (keep stereo files stereo: a studio set to high fidelity) }
// -> { song, clips: [{ id, pcm16 (interleaved when ch is 2), sr, ch }], warnings: [] }
export async function songFromLive(files, o = {}) {
  const say = o.progress || (() => {});
  const alsFile = files.find((f) => /\.als$/i.test(f.name)); if (!alsFile) throw new Error('there is no Live set (.als) in that project');
  const bytesOf = async (f) => (typeof f.data === 'function' ? await f.data() : f.data);
  let raw = await bytesOf(alsFile); if (raw[0] === 0x1f && raw[1] === 0x8b) raw = await gunzip(raw);
  const set = readLiveSet(new TextDecoder().decode(raw)), { meter } = set, warnings = [...set.warnings];
  // MEGAjam plays whole-number tempos (40 to 240): everything is placed and stretched to the tempo it will play at
  const bpm = Math.max(40, Math.min(240, Math.round(set.bpm)));
  if (Math.abs(bpm - set.bpm) > 1e-6) warnings.push(`Live's ${Math.round(set.bpm * 100) / 100} bpm plays at ${bpm} bpm here (audio stretched to match).`);
  const title = alsFile.name.split('/').pop().replace(/\.als$/i, '');
  const song = emptySong(); song.title = title; song.bpm = bpm; if (meter !== 4) song.meter = meter;

  // the song's length, and its sections: at the locators (on bar lines), or every 8 bars
  const lastBeat = Math.max(0, ...set.tracks.flatMap((t) => t.clips.map((c) => c.end)));
  const totalBars = Math.max(1, Math.ceil(lastBeat / meter - 1e-6));
  let cuts = set.locators.map((l) => ({ bar: Math.round(l.beat / meter), name: (l.name || 'Section').slice(0, 24) })).filter((c, i, a) => c.bar < totalBars && (i === 0 || c.bar !== a[i - 1].bar));
  if (!cuts.length || cuts[0].bar !== 0) cuts.unshift({ bar: 0, name: cuts.length ? 'Intro' : 'Part 1' });
  if (cuts.length === 1 && totalBars > 8) cuts = Array.from({ length: Math.ceil(totalBars / 8) }, (_, i) => ({ bar: i * 8, name: `Part ${i + 1}` }));
  const secs = cuts.map((c, i) => { const bars = (cuts[i + 1]?.bar ?? totalBars) - c.bar; return { sec: newSection(c.name, bars), a: c.bar * meter, z: (c.bar + bars) * meter }; });

  // the audio files the set uses, found in the project
  const norm = (s) => s.replace(/\\/g, '/').toLowerCase();
  const findFile = (ref) => { const rel = norm(ref.rel || ''), base = norm((ref.rel || ref.path || ref.name || '').split(/[\\/]/).pop()); return files.find((f) => rel && norm(f.name).endsWith(rel)) || files.find((f) => norm(f.name).split('/').pop() === base) || null; };
  const audioCache = new Map(), missing = new Set();
  const audioOf = async (ref) => {
    const f = findFile(ref), key = f?.name || ref.rel || ref.path; if (!f) { missing.add((ref.rel || ref.path || ref.name).split(/[\\/]/).pop()); return null; }
    if (!audioCache.has(key)) { say(`Reading ${f.name.split('/').pop()}…`); try { audioCache.set(key, decodeAudio(await bytesOf(f))); } catch (e) { warnings.push(`${f.name.split('/').pop()}: ${e.message}.`); audioCache.set(key, null); } }
    return audioCache.get(key);
  };

  const clips = [], used = new Set();
  for (const t of set.tracks) {
    let pid = 'l-' + slug(t.name); for (let k = 2; used.has(pid); k++) pid = `l-${slug(t.name)}-${k}`; used.add(pid);
    if (t.kind === 'midi') {
      const drums = !!t.pads;
      // a Drum Rack plays on Machina, with the kit its pads' names or samples suggest
      const kitOf = (txt) => { const s2 = txt.toLowerCase(); return /808/.test(s2) ? '808' : /909/.test(s2) ? '909' : /brush/.test(s2) ? 'brushes' : /jazz/.test(s2) ? 'jazz' : /acoustic|studio|live kit|kit-core|vintage/.test(s2) ? 'acoustic' : /lo-?fi|dusty/.test(s2) ? 'lofi' : /industrial/.test(s2) ? 'industrial' : '909'; };
      const g = drums ? { inst: 'machina', patch: kitOf(`${t.name} ${Object.values(t.pads).join(' ')}`), drums: true } : guessInstrument(`${t.name} ${t.devices.join(' ')}`);
      const events = [];
      for (const c of t.clips) for (const n of clipNotes(c)) {
        let note = n.key;
        if (drums) { const m = padNote(t.pads[n.key]); if (m) note = m; }
        events.push({ b: n.a, type: 'on', note, vel: n.vel }, { b: Math.max(n.a + 0.01, n.z - 0.001), type: 'off', note });
      }
      for (const { sec, a, z } of secs) {
        const ev = sliceEvents(events, a, z); if (!ev.some((e) => e.type === 'on')) continue;
        const p = { id: pid, name: t.name, lane: t.name, role: guessRole({ name: t.name, ...g }), inst: g.inst, patch: g.patch, drums: !!g.drums, takes: [{ id: 'live', events: ev, by: 'import', byName: 'Ableton Live', at: 0 }], current: 'live', by: 'import' };
        if (t.muted) p.muted = true;
        sec.parts[pid] = p;
      }
      continue;
    }
    // audio: each clip rendered once at the song's tempo, then each section's take mixed from the clips in it
    const rendered = [];
    for (const c of t.clips) {
      if (c.pitch) warnings.push(`${t.name}: a clip is pitch-shifted in Live; it comes in at its original pitch.`);
      const audio = await audioOf(c.file); if (!audio) continue;
      say(`Rendering ${t.name}${c.warped && c.markers.length > 2 ? ' (following its warp markers)' : c.warped ? ' (warped to the tempo)' : ''}…`);
      await new Promise((r) => setTimeout(r, 0));
      rendered.push({ c, pcm: renderClip(c, audio, bpm, !!o.stereo) });   // [mono] or [L, R]
    }
    for (const { sec, a, z } of secs) {
      const here = rendered.filter(({ c }) => c.start < z && c.end > a); if (!here.length) continue;
      const lo = Math.max(a, Math.min(...here.map(({ c }) => c.start))), hi = Math.min(z, Math.max(...here.map(({ c }) => c.end)));
      const frames = Math.round(((hi - lo) * 60 * OUT_SR) / bpm), ch = here.some(({ pcm }) => pcm.length === 2) ? 2 : 1, mixes = Array.from({ length: ch }, () => new Float32Array(frames));
      for (const { c, pcm } of here) {
        const from = Math.round(((Math.max(lo, c.start) - c.start) * 60 * OUT_SR) / bpm), to = Math.round(((Math.max(lo, c.start) - lo) * 60 * OUT_SR) / bpm);
        for (let k = 0; k < ch; k++) { const src = pcm[Math.min(k, pcm.length - 1)], dst = mixes[k]; for (let i = 0; to + i < frames && from + i < src.length; i++) dst[to + i] += src[from + i]; }   // a mono clip in a stereo take: both sides
      }
      const pcm16 = new Int16Array(frames * ch); for (let i = 0; i < frames; i++) for (let k = 0; k < ch; k++) pcm16[i * ch + k] = Math.max(-32768, Math.min(32767, Math.round(mixes[k][i] * 32767)));
      const mono = ch === 2 ? Float32Array.from(mixes[0], (v, i) => (v + mixes[1][i]) / 2) : mixes[0];
      const id = rid8(); clips.push({ id, pcm16, sr: OUT_SR, ch });
      const p = { id: pid, name: t.name, lane: t.name, role: 'texture', kind: 'audio', inst: 'audio', patch: '', drums: false,
        takes: [{ id: 'live', events: [], audio: { id, sr: OUT_SR, ...(ch === 2 ? { ch: 2 } : {}), frames, from: lo - a, beats: hi - lo, bpm, peaks: peaksOf(mono) }, by: 'import', byName: 'Ableton Live', at: 0 }], current: 'live', by: 'import' };
      if (t.muted) p.muted = true;
      sec.parts[pid] = p;
    }
  }
  if (missing.size) warnings.push(`${missing.size} audio file${missing.size === 1 ? '' : 's'} weren't in the project (${[...missing].slice(0, 3).join(', ')}${missing.size > 3 ? '…' : ''}): in Live, File › Collect All and Save, then bring the project in again.`);
  for (const { sec } of secs) { sec.chords = chartFromParts(Object.values(sec.parts).filter((p) => !p.drums && p.kind !== 'audio'), sec.bars, meter); song.sections[sec.id] = sec; song.order.push(sec.id); }
  song.key = keyFromParts(set.tracks.filter((t) => t.kind === 'midi' && !t.pads).map((t) => ({ events: t.clips.flatMap((c) => clipNotes(c).map((n) => ({ b: n.a, type: 'on', note: n.key }))) })));
  return { song, clips, warnings, tracks: set.tracks.length, bpm };
}
