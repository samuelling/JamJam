// An Ableton Live set for the stem export: the song's tempo, an audio track per stem (each stem a clip at bar 1,
// warped to the song's tempo, so changing the tempo in Live keeps them together) and, under them, a MIDI track per
// instrument track with a clip of its notes in each section (no instrument on it: pick one in Live).
//
// Built from a set Live itself saved (src/ableton-live11.xml, made by tools/ableton/make_template.py from a Live 11.3
// set with everything personal and every device taken out): its MIDI and audio tracks are cloned per track, with
// fresh ids. Live keeps one numbering ("pointee" ids) across every automation and modulation target in the set, so
// each clone's targets get new numbers from NextPointeeId up, and NextPointeeId moves past them.

const TEMPLATE = new URL('./ableton-live11.xml', import.meta.url).href;
const COLORS = [16, 24, 3, 12, 20, 8, 26, 14, 5, 22, 10, 18];   // Live's clip/track palette indices

const kid = (e, path) => { let n = e; for (const t of path.split('/')) { n = [...n.children].find((c) => c.tagName === t); if (!n) return null; } return n; };
const setV = (e, path, v) => { const n = kid(e, path); if (n) n.setAttribute('Value', String(v)); };

// o: { song, bpm, meter, sr, frames, stems: [{ name, file (path from the set's folder), color }],
//      midi: [{ name, clips: [{ name, start (beats), beats, notes: [{ n, a, z, v }] }] }] }
export async function buildAls(o) {
  const text = await (await fetch(TEMPLATE)).text();
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('The Live set template is damaged');
  const ls = doc.documentElement.querySelector(':scope > LiveSet'), tracks = kid(ls, 'Tracks');
  const midiT = kid(tracks, 'MidiTrack'), audioT = kid(tracks, 'AudioTrack');
  const audioClipT = kid(audioT, 'DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events/AudioClip');
  const midiClipT = kid(midiT, 'DeviceChain/MainSequencer/ClipTimeable/ArrangerAutomation/Events/MidiClip');
  audioClipT.remove(); midiClipT.remove(); midiT.remove(); audioT.remove();
  const firstReturn = kid(tracks, 'ReturnTrack');
  let pointee = +kid(ls, 'NextPointeeId').getAttribute('Value');
  let trackId = Math.max(0, ...[...tracks.children].map((t) => +t.getAttribute('Id') || 0)) + 100;
  const add = (tmpl, name, color) => {
    const t = tmpl.cloneNode(true);
    t.setAttribute('Id', String(trackId++));
    for (const e of t.getElementsByTagName('*')) if ((e.tagName.endsWith('Target') || e.tagName === 'Pointee') && e.hasAttribute('Id')) e.setAttribute('Id', String(pointee++));
    setV(t, 'Name/EffectiveName', name); setV(t, 'Name/UserName', name); setV(t, 'Color', color);
    tracks.insertBefore(t, firstReturn);
    return t;
  };
  const loop = (clip, start, len) => {
    clip.setAttribute('Time', String(start));
    setV(clip, 'CurrentStart', start); setV(clip, 'CurrentEnd', start + len);
    setV(clip, 'Loop/LoopStart', 0); setV(clip, 'Loop/LoopEnd', len); setV(clip, 'Loop/OutMarker', len);
    setV(clip, 'Loop/HiddenLoopStart', 0); setV(clip, 'Loop/HiddenLoopEnd', len); setV(clip, 'Loop/LoopOn', 'false'); setV(clip, 'Loop/StartRelative', 0);
    for (const ts of clip.getElementsByTagName('RemoteableTimeSignature')) { setV(ts, 'Numerator', o.meter || 4); setV(ts, 'Denominator', 4); }
  };
  const secs = o.frames / o.sr, beats = (secs * o.bpm) / 60;
  o.stems.forEach((s, i) => {
    const color = s.color ?? COLORS[i % COLORS.length], t = add(audioT, s.name, color);
    const c = audioClipT.cloneNode(true); c.setAttribute('Id', '0');
    loop(c, 0, beats); setV(c, 'Name', s.name); setV(c, 'Color', color);
    setV(c, 'IsWarped', 'true'); setV(c, 'WarpMode', 0); setV(c, 'Sync', 'true');
    const wm = kid(c, 'WarpMarkers'); wm.replaceChildren();
    for (const [k, sec, bt] of [[0, 0, 0], [1, secs, beats]]) { const m = doc.createElement('WarpMarker'); m.setAttribute('Id', String(k)); m.setAttribute('SecTime', String(sec)); m.setAttribute('BeatTime', String(bt)); wm.append(m); }
    setV(c, 'MarkersGenerated', 'false');
    const ref = kid(c, 'SampleRef');
    setV(ref, 'FileRef/RelativePathType', 3); setV(ref, 'FileRef/RelativePath', s.file); setV(ref, 'FileRef/Path', s.file); setV(ref, 'FileRef/Type', 2);
    setV(ref, 'FileRef/OriginalFileSize', 0); setV(ref, 'FileRef/OriginalCrc', 0); setV(ref, 'LastModDate', 0);
    setV(ref, 'DefaultDuration', o.frames); setV(ref, 'DefaultSampleRate', o.sr);
    kid(t, 'DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events').append(c);
  });
  (o.midi || []).forEach((m, i) => {
    if (!m.clips.length) return;
    const color = COLORS[(o.stems.length + i) % COLORS.length], t = add(midiT, `${m.name} (MIDI)`, color), ev = kid(t, 'DeviceChain/MainSequencer/ClipTimeable/ArrangerAutomation/Events');
    m.clips.forEach((cl, j) => {
      const c = midiClipT.cloneNode(true); c.setAttribute('Id', String(j));
      loop(c, cl.start, cl.beats); setV(c, 'Name', cl.name); setV(c, 'Color', color);
      const keys = kid(c, 'Notes/KeyTracks'); keys.replaceChildren();
      const byKey = new Map(); for (const n of cl.notes) (byKey.get(n.n) || byKey.set(n.n, []).get(n.n)).push(n);
      let nid = 1, kidN = 0;
      for (const [key, ns] of [...byKey].sort((a, b) => a[0] - b[0])) {
        const kt = doc.createElement('KeyTrack'); kt.setAttribute('Id', String(kidN++));
        const notes = doc.createElement('Notes');
        for (const n of ns.sort((a, b) => a.a - b.a)) {
          const e = doc.createElement('MidiNoteEvent');
          for (const [a, v] of [['Time', n.a], ['Duration', Math.max(0.01, n.z - n.a)], ['Velocity', Math.max(1, Math.min(127, Math.round(n.v ?? 100)))], ['VelocityDeviation', 0], ['OffVelocity', 64], ['Probability', 1], ['IsEnabled', 'true'], ['NoteId', nid++]]) e.setAttribute(a, String(+v === +v && typeof v === 'number' ? +v.toFixed(6) : v));
          notes.append(e);
        }
        const mk = doc.createElement('MidiKey'); mk.setAttribute('Value', String(key));
        kt.append(notes, mk); keys.append(kt);
      }
      setV(c, 'Notes/NoteIdGenerator/NextId', nid);
      ev.append(c);
    });
  });
  kid(ls, 'NextPointeeId').setAttribute('Value', String(pointee + 1));
  setV(ls, 'MasterTrack/DeviceChain/Mixer/Tempo/Manual', o.bpm);
  setV(ls, 'Transport/LoopLength', Math.max(4, Math.round(beats)));
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(doc.documentElement) + '\n';
  return gzip(new TextEncoder().encode(xml));
}
async function gzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
// the notes of a take as {n, a, z, v} (beats from the block's start)
export function notesOf(events, beats) {
  const out = [], on = new Map();
  for (const e of [...(events || [])].sort((a, b) => a.b - b.b)) {
    if (e.type === 'on') { if (e.b < beats) on.set(e.note, e); } else if (e.type === 'off' && on.has(e.note)) { const s = on.get(e.note); out.push({ n: e.note, a: s.b, z: Math.min(e.b, beats), v: s.vel ?? 100 }); on.delete(e.note); }
  }
  for (const [n, s] of on) out.push({ n, a: s.b, z: beats, v: s.vel ?? 100 });
  return out;
}
