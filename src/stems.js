// Stems: every track of the song rendered on its own, from the top of the song to its end (plus the ring-out), all
// the same length, so they drop into a DAW lined up at bar 1. Rendered offline (faster than real time), after the
// track's fader and pan and before the master, so the stems added together are the song's mix.
import * as SONG from './song.js';
import { buildAls, notesOf } from './ableton.js';

const TAIL = 4, LEAD = 0.05;
export const safeName = (s) => String(s || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled';
const dbToGain = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));

// the song's tracks in their order on the board, and each one's blocks section by section
export function trackList(song) {
  const recs = Object.values(song.lanes || {}).sort((a, b) => (a.at || 0) - (b.at || 0));
  return recs.map((t, i) => ({ ...t, n: i + 1, file: `${String(i + 1).padStart(2, '0')} ${safeName(t.name)}.wav` }));
}
const trackOf = (p) => p.laneId || p.id;

// render one track. o: { song, bpm, sr, track, defs (Map), resolve(cfg) -> {params}, clip(id) -> {pcm16, sr}|null }
// returns { L, R, peak, notes, skipped } over [0, song length + TAIL)
export async function renderTrack(o) {
  const { song, bpm, sr, track } = o, spb = 60 / bpm;
  const tl = timeline(song), total = tl.reduce((a, t) => Math.max(a, t.start + t.beats), 0) * spb;
  const n = Math.ceil((total + TAIL) * sr), ctx = new OfflineAudioContext(2, Math.ceil((LEAD + total + TAIL) * sr), sr);
  const g = ctx.createGain(); g.gain.value = dbToGain(track.vol ?? 0);
  const pn = ctx.createStereoPanner(); pn.pan.value = Math.max(-1, Math.min(1, track.pan ?? 0)); g.connect(pn).connect(ctx.destination);
  const insts = new Map(); let notes = 0; const skipped = [];
  // a clock for instruments that follow the beat (beat 0 = the top of the song, at LEAD seconds in)
  const env = { audioTime: (ms) => LEAD + ms / 1000, roomTime: (t) => (t - LEAD) * 1000, bpm: () => bpm, beatAt: (ms) => (ms / 1000) / spb, timeOf: (b) => b * spb * 1000 };
  const instFor = async (cfg) => {
    const key = `${cfg.inst}|${cfg.patch}|${JSON.stringify(cfg.params || {})}`;
    if (insts.has(key)) return insts.get(key);
    const def = o.defs.get(cfg.inst); let inst = null;
    if (def && !def.internal) {
      const params = { ...o.resolve({ inst: cfg.inst, patch: cfg.patch }).params, ...(cfg.params || {}) };
      try { if (def.init) await def.init(ctx, params); inst = def.create(ctx, g, params, env); } catch (_) { inst = null; }
    }
    if (!inst) skipped.push(def?.name || cfg.inst);
    insts.set(key, inst); return inst;
  };
  for (const t of tl) {
    const sec = song.sections[t.id]; if (!sec) continue;
    for (const p of Object.values(sec.parts || {})) {
      if (trackOf(p) !== track.id || p.muted || p.recording) continue;
      const take = SONG.currentTake(p); if (!take) continue;
      if (take.audio) { audioInto(ctx, g, o.clip(take.audio.id), take.audio, t, spb); continue; }
      if (!take.events?.length) continue;
      const inst = await instFor({ ...p, ...SONG.laneCfg(song, p) }); if (!inst) continue;
      const at = (b) => LEAD + (t.start + b) * spb, base = { ...o.resolve({ inst: (SONG.laneCfg(song, p).inst || p.inst), patch: (SONG.laneCfg(song, p).patch || p.patch) }).params, ...(SONG.laneCfg(song, p).params || p.params || {}) };
      const moved = SONG.movesOf(take.events);
      for (const e of SONG.expandMoves(take.events, bpm)) {
        if (e.type === 'on') { if (e.b >= t.beats) continue; inst.noteOn(e.note, e.vel ?? 100, at(e.b)); notes++; }
        else if (e.type === 'off') inst.noteOff(e.note, at(Math.min(e.b, t.beats)));
        else if (e.type === 'p' && inst.set && e.b <= t.beats) inst.set(e.id, e.v, at(e.b));
      }
      if (moved && inst.set) for (const id of moved) if (base[id] != null) inst.set(id, base[id], at(t.beats));
    }
  }
  // instruments with files to load get a moment before the first block (as the song's own bounces do)
  const hold = ctx.suspend(256 / sr).then(async () => { await new Promise((r) => setTimeout(r, 40)); ctx.resume(); });
  const full = await ctx.startRendering(); await hold;
  for (const i of insts.values()) { try { i?.dispose(); } catch (_) {} }
  const s0 = Math.round(LEAD * sr), L = full.getChannelData(0).slice(s0, s0 + n), R = full.getChannelData(1).slice(s0, s0 + n);
  let peak = 0; for (let i = 0; i < L.length; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > peak) peak = a; if (b > peak) peak = b; }
  return { L: pad(L, n), R: pad(R, n), peak, notes, skipped };
}
const pad = (a, n) => { if (a.length >= n) return a; const b = new Float32Array(n); b.set(a); return b; };
function timeline(song) { let b = 0; return (song.order || []).map((id) => { const s = song.sections[id]; const t = { id, start: b, beats: s ? SONG.sectionBeats(song, s) : 0 }; b += t.beats; return t; }).filter((t) => t.beats > 0); }
function audioInto(ctx, out, c, A, t, spb) {
  if (!c) return;
  const buf = ctx.createBuffer(1, c.pcm16.length, c.sr), ch = buf.getChannelData(0); for (let i = 0; i < c.pcm16.length; i++) ch[i] = c.pcm16[i] / 32768;
  const a0 = t.start + A.from, lo = Math.max(t.start, a0), hi = Math.min(t.start + t.beats, a0 + A.beats); if (hi <= lo) return;
  const into = ((lo - a0) * 60) / A.bpm; if (into >= buf.duration) return;
  const src = ctx.createBufferSource(), g = ctx.createGain(); src.buffer = buf; src.connect(g).connect(out);
  const ts = LEAD + lo * spb, te = LEAD + hi * spb;
  src.start(ts, into); g.gain.setValueAtTime(1, Math.max(ts, te - 0.008)); g.gain.linearRampToValueAtTime(0, te); src.stop(te + 0.02);
}

// 24-bit PCM WAV (what every DAW opens)
export function wav24({ L, R }, sr) {
  const n = L.length, bytes = n * 6, buf = new ArrayBuffer(44 + bytes), v = new DataView(buf), u = new Uint8Array(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 6, true); v.setUint16(32, 6, true); v.setUint16(34, 24, true); str(36, 'data'); v.setUint32(40, bytes, true);
  const put = (o, x) => { let s = Math.round(Math.max(-1, Math.min(1, x)) * 8388607); if (s < 0) s += 16777216; u[o] = s & 255; u[o + 1] = (s >> 8) & 255; u[o + 2] = (s >> 16) & 255; };
  for (let i = 0, o = 44; i < n; i++, o += 6) { put(o, L[i]); put(o + 3, R[i]); }
  return u;
}
export function readWav24(u) {
  const v = new DataView(u.buffer, u.byteOffset, u.byteLength), sr = v.getUint32(24, true), n = v.getUint32(40, true) / 6, L = new Float32Array(n), R = new Float32Array(n);
  const get = (o) => { let s = u[o] | (u[o + 1] << 8) | (u[o + 2] << 16); if (s & 0x800000) s -= 16777216; return s / 8388607; };
  for (let i = 0, o = 44; i < n; i++, o += 6) { L[i] = get(o); R[i] = get(o + 3); }
  return { sr, L, R };
}

// the whole export: stems, the mix (through the master fader), the song as MIDI and as a MEGAjam song, and a note.
// o: { song, bpm, sr, defs, resolve, clip, only (track ids or null), master (dB), by, onProgress(text), write(name, Uint8Array|string) }
export async function exportStems(o) {
  const all = trackList(o.song).filter((t) => !t.muted && (!o.only || o.only.includes(t.id)));
  if (!all.length) throw new Error('No tracks to export');
  const title = safeName(o.song.title), mixL = [], mixR = [], done = [], clipped = [], skipped = [];
  let alsOk = false, alsErr = null;
  for (let i = 0; i < all.length; i++) {
    const t = all[i]; o.onProgress?.(`Rendering ${t.name} (${i + 1} of ${all.length})…`);
    const r = await renderTrack({ ...o, track: t });
    if (r.skipped.length) skipped.push(`${t.name} (${[...new Set(r.skipped)].join(', ')})`);
    if (r.peak > 1) clipped.push(t.name);
    await o.write(`Stems/${t.file}`, wav24(r, o.sr)); done.push(t);
    if (!o.only) { mixL.push(r.L); mixR.push(r.R); }
  }
  if (!o.only && mixL.length) {
    o.onProgress?.('Mixing…');
    const n = mixL[0].length, L = new Float32Array(n), R = new Float32Array(n), m = dbToGain(o.master ?? 0);
    for (let k = 0; k < mixL.length; k++) { const a = mixL[k], b = mixR[k]; for (let i = 0; i < n; i++) { L[i] += a[i]; R[i] += b[i]; } }
    let pk = 0; for (let i = 0; i < n; i++) { L[i] *= m; R[i] *= m; pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i])); }
    if (pk > 0.98) { const s = 0.98 / pk; for (let i = 0; i < n; i++) { L[i] *= s; R[i] *= s; } }
    await o.write(`${title} (mix).wav`, wav24({ L, R }, o.sr));
    await o.write(`${title}.mid`, SONG.songToMidi(o.song));
    await o.write(`${title}.megajam.json`, JSON.stringify(o.song, null, 1));
    // a Live set with the stems lined up at the song's tempo, and each instrument track's notes as MIDI clips
    o.onProgress?.('Writing the Ableton Live set…');
    try {
      const tl = timeline(o.song), midi = done.filter((t) => t.kind !== 'audio').map((t) => ({ name: t.name, clips: tl.flatMap((s) => {
        const p = Object.values(o.song.sections[s.id]?.parts || {}).find((q) => trackOf(q) === t.id && !q.muted), take = p && SONG.currentTake(p);
        const notes = take && !take.audio ? notesOf(take.events, s.beats) : [];
        return notes.length ? [{ name: o.song.sections[s.id].name, start: s.start, beats: s.beats, notes }] : [];
      }) }));
      await o.write(`${title}.als`, await buildAls({ song: o.song, bpm: o.bpm, meter: o.song.meter || 4, sr: o.sr, frames: L.length, stems: done.map((t) => ({ name: t.name, file: `Stems/${t.file}` })), midi }));
      alsOk = true;
    } catch (e) { alsErr = e?.message || String(e); }
  }
  const key = o.song.key ? `${SONG.NOTE_NAMES[o.song.key.root]} ${o.song.key.mode}` : '';
  await o.write(`About ${o.only ? `${safeName(o.by)}'s ` : ''}stems.txt`, [
    `${o.song.title}: stems from MEGAjam${o.by ? `, exported by ${o.by}` : ''} on ${new Date().toLocaleString()}`, '',
    `Tempo ${o.bpm} bpm, ${o.song.meter || 4}/4${key ? `, ${key}` : ''}. ${o.sr} Hz, 24-bit stereo WAV.`,
    'Every stem starts at bar 1 and they are all the same length: drop them in at the start of a project at this tempo and they line up.',
    'Each stem is after its track\'s fader and pan (so together they make the mix), before the master fader.',
    ...(alsOk ? [`${title}.als opens in Ableton Live 11 or later: the stems on audio tracks from bar 1 (warped to the tempo), each instrument's notes on a MIDI track below them (pick an instrument for it). Keep the .als in this folder, next to Stems.`] : alsErr ? [`(No Live set this time: ${alsErr}.)`] : []), '',
    ...done.map((t) => `${t.file}  ${t.inst}${t.patch ? ' · ' + t.patch : ''}${t.ownerName ? ' · ' + t.ownerName : ''}${t.hw ? ' (played on hardware; rendered here on its software twin)' : ''}`),
    ...(clipped.length ? ['', `Louder than full scale (clipped in the file): ${clipped.join(', ')}. Pull those tracks' faders down and export again.`] : []),
    ...(skipped.length ? ['', `Couldn't render offline (silent in the stems): ${skipped.join('; ')}.`] : []),
  ].join('\n') + '\n');
  return { files: done.length, clipped, skipped, als: alsOk };
}
