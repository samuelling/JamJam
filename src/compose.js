// The Compose Room: the band's song board. Sections in arrangement order, each with its length, chord chart, notes
// and the parts locked into it; import a sketch (MIDI or a SynthLand Tracker song), export the song; loop a section
// or play the whole song; "Jam this" takes everyone to the Jam Room with that section looping.
import { SECTION_NAMES, NOTE_NAMES, sectionBeats, newSection, parseChord } from './song.js';

const COLORS = { Intro: '#7DB0FF', Verse: '#ECEBE5', 'Pre-chorus': '#D8A83A', Chorus: '#FF68BA', Bridge: '#9b8cff', Solo: '#3ddc84', Breakdown: '#8a8f98', Drop: '#ff7a3d', Outro: '#7DB0FF' };
export const colorOfSection = (name) => COLORS[Object.keys(COLORS).find((k) => String(name).toLowerCase().startsWith(k.toLowerCase()))] || '#A0A6AF';

// progressions by scale degree (0-based), with the chord quality the key's scale gives each degree
const PROGS = [['I–V–vi–IV', [0, 4, 5, 3]], ['I–IV–V–IV', [0, 3, 4, 3]], ['vi–IV–I–V', [5, 3, 0, 4]], ['ii–V–I–I', [1, 4, 0, 0]], ['i–VI–III–VII', [0, 5, 2, 6]], ['i–iv–v–i', [0, 3, 4, 0]], ['i–VII–VI–VII', [0, 6, 5, 6]], ['12-bar blues', 'blues']];
const STEPS = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], lydian: [0, 2, 4, 6, 7, 9, 11], pentmaj: [0, 2, 4, 5, 7, 9, 11], pentmin: [0, 2, 3, 5, 7, 8, 10], blues: [0, 2, 3, 5, 7, 8, 10] };
export function chordOnDegree(key, d) {
  const st = STEPS[key.mode] || STEPS.major, t = [0, 2, 4].map((j) => st[(d + j) % 7] + 12 * Math.floor((d + j) / 7));
  const q = t[1] - t[0] === 4 ? (t[2] - t[0] === 8 ? '+' : '') : t[2] - t[0] === 6 ? '°' : 'm';
  return NOTE_NAMES[(key.root + t[0]) % 12] + q;
}
export function fillChart(key, bars, prog) {
  if (prog === 'blues') { const I = NOTE_NAMES[key.root] + '7', IV = NOTE_NAMES[(key.root + 5) % 12] + '7', V = NOTE_NAMES[(key.root + 7) % 12] + '7'; const b = [I, IV, I, I, IV, IV, I, I, V, IV, I, V]; return Array.from({ length: bars }, (_, i) => b[i % 12]); }
  return Array.from({ length: bars }, (_, i) => chordOnDegree(key, prog[i % prog.length]));
}

export function makeCompose(x) {
  // x: { h, $, store, me, name, playersOf(), setSong(k, v), play(mode, sid), stop(), transport(), jamThis(sid), importFile(file), exportMidi(), exportJson(), removePart(sid, pid), mutePart(sid, pid, on), describePart(p), iconEl, keyName(), setKey(root, mode), setBpm(bpm), bpm() }
  const { h, $ } = x;
  let editing = null;   // the chord cell being typed into: keep focus across renders
  function sectionCard(s, i, total, tl) {
    const col = colorOfSection(s.name), tr = x.transport(), live = tr && tr.on && (tr.mode === 'song' ? tl?.some((t) => t.id === s.id) : tr.sid === s.id);
    const save = (patch) => x.setSong('sec:' + s.id, { name: s.name, bars: s.bars, chords: s.chords, notes: s.notes, ...patch });
    const nameSel = h('select', { class: 'secname', 'aria-label': 'Section', onchange: (e) => { if (e.target.value === '__custom') { const n = prompt('Section name', s.name); if (n) save({ name: n.slice(0, 24) }); else e.target.value = s.name; } else save({ name: e.target.value }); } },
      ...[...new Set([...SECTION_NAMES, s.name])].map((n) => h('option', { value: n, selected: n === s.name }, n)), h('option', { value: '__custom' }, 'Name it…'));
    const bars = h('div', { class: 'bars' }, h('button', { class: 'btn small', 'aria-label': 'Fewer bars', onclick: () => { const b = Math.max(1, s.bars - (s.bars > 4 ? 4 : 1)); save({ bars: b, chords: s.chords.slice(0, b) }); } }, '−'),
      h('b', {}, `${s.bars} bars`), h('button', { class: 'btn small', 'aria-label': 'More bars', onclick: () => { const b = Math.min(64, s.bars + (s.bars >= 4 ? 4 : 1)); save({ bars: b, chords: [...s.chords, ...Array(b - s.chords.length).fill('')] }); } }, '+'));
    const chart = h('div', { class: 'chart' }, ...Array.from({ length: s.bars }, (_, b) => {
      const v = s.chords[b] || '', ok = !v || parseChord(v);
      const inp = h('input', { class: 'chord' + (ok ? '' : ' bad') + (b % 4 === 0 ? ' downbar' : ''), value: v, placeholder: b === 0 ? 'chord' : '·', maxlength: 8, 'aria-label': `Bar ${b + 1} chord`, 'data-cell': `${s.id}:${b}`,
        onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.target.blur(); const n = $(`[data-cell="${s.id}:${b + (e.shiftKey ? -1 : 1)}"]`); n?.focus(); } },
        onfocus: () => { editing = `${s.id}:${b}`; }, onblur: (e) => { editing = null; const c = [...s.chords]; c.length = s.bars; c[b] = e.target.value.trim(); for (let k = 0; k < s.bars; k++) c[k] = c[k] || ''; if (c[b] !== (s.chords[b] || '')) save({ chords: c }); } });
      return inp;
    }));
    const prog = h('select', { class: 'lcdsel', 'aria-label': 'Fill the chart', onchange: (e) => { const p = PROGS.find((q) => q[0] === e.target.value); if (p) save({ chords: fillChart(x.store.song.key, s.bars, p[1]) }); e.target.value = ''; } },
      h('option', { value: '' }, `Fill in ${x.keyName()}…`), ...PROGS.map(([n]) => h('option', { value: n }, n)));
    const notes = h('textarea', { class: 'secnotes', rows: 2, placeholder: 'Ideas: feel, who plays what, lyrics…', onkeydown: (e) => e.stopPropagation(), onchange: (e) => save({ notes: e.target.value.slice(0, 2000) }) }, s.notes || '');
    const parts = Object.values(s.parts || {});
    return h('div', { class: 'seccard' + (live ? ' live' : ''), style: `--sc:${col}`, 'data-sec': s.id },
      h('div', { class: 'sechead' }, h('span', { class: 'secno' }, String(i + 1).padStart(2, '0')), nameSel,
        h('span', { class: 'secmove' }, h('button', { class: 'btn small ghost', disabled: i === 0, 'aria-label': 'Move earlier', onclick: () => move(i, -1) }, '←'), h('button', { class: 'btn small ghost', disabled: i === total - 1, 'aria-label': 'Move later', onclick: () => move(i, 1) }, '→'))),
      bars, chart, h('div', { class: 'row' }, prog), notes,
      h('div', { class: 'secparts' }, parts.length ? null : h('span', { class: 'help' }, 'No parts yet. Jam it and lock one in.'),
        ...parts.map((p) => h('div', { class: 'part' + (p.muted ? ' muted' : '') }, x.iconEl(p), h('span', {}, h('b', {}, p.name), h('small', {}, `${p.byName || (p.by === 'import' ? 'imported' : '')}${p.events ? ` · ${p.events.filter((e) => e.type === 'on').length} notes` : ''}`)),
          h('button', { class: 'btn small ghost', title: p.muted ? 'Unmute' : 'Mute', onclick: () => x.mutePart(s.id, p.id, !p.muted) }, p.muted ? 'muted' : 'M'),
          h('button', { class: 'btn small ghost', title: 'Remove this part', onclick: () => x.removePart(s.id, p.id) }, '×')))),
      h('div', { class: 'secacts' },
        h('button', { class: 'btn small' + (live && tr.mode === 'loop' ? ' on' : ''), onclick: () => (live && tr.mode === 'loop' ? x.stop() : x.play('loop', s.id)) }, live && tr.mode === 'loop' ? '■ Stop' : '↻ Loop'),
        h('button', { class: 'btn small hot', onclick: () => x.jamThis(s.id) }, 'Jam this'),
        h('button', { class: 'btn small ghost', title: 'Repeat this section after itself', onclick: () => { const o = [...x.store.song.order]; o.splice(i + 1, 0, s.id); x.setSong('order', o); } }, 'Repeat'),
        h('button', { class: 'btn small ghost', title: 'Take it out of the song', onclick: () => { const o = [...x.store.song.order]; o.splice(i, 1); x.setSong('order', o); if (!o.includes(s.id)) x.setSong('sec:' + s.id, null); } }, 'Remove')));
  }
  function move(i, d) { const o = [...x.store.song.order]; const [v] = o.splice(i, 1); o.splice(i + d, 0, v); x.setSong('order', o); }
  function addSection(name) {
    const prev = x.store.sections().slice(-1)[0], sec = newSection(name, name === 'Intro' || name === 'Outro' ? 4 : 8);
    if (prev && !name.match(/intro|outro|break/i)) sec.chords = [...prev.chords].slice(0, sec.bars);
    x.setSong('sec:' + sec.id, { name: sec.name, bars: sec.bars, chords: sec.chords.concat(Array(Math.max(0, sec.bars - sec.chords.length)).fill('')), notes: '' });
    x.setSong('order', [...x.store.song.order, sec.id]);
  }
  function render() {
    const box = $('#compose'); if (!box) return;
    const song = x.store.song, secs = x.store.sections(), tl = x.store.timeline(), tr = x.transport();
    const totalBars = secs.reduce((a, s) => a + s.bars, 0), mins = (totalBars * (song.meter || 4)) / x.bpm();
    const title = h('input', { class: 'songtitle', value: song.title, maxlength: 60, 'aria-label': 'Song title', onkeydown: (e) => e.stopPropagation(), onchange: (e) => x.setSong('title', e.target.value.trim() || 'Untitled') });
    const file = h('input', { type: 'file', accept: '.mid,.midi,.json,audio/midi,application/json', style: 'display:none', onchange: (e) => { const f = e.target.files[0]; if (f) x.importFile(f); e.target.value = ''; } });
    const keyNow = $('#keySel')?.value || '';
    const who = x.playersOf();
    box.replaceChildren(
      h('div', { class: 'songhead' }, title,
        h('span', { class: 'help mono' }, `${secs.length} section${secs.length === 1 ? '' : 's'} · ${totalBars} bars · ${Math.floor(mins)}:${String(Math.round((mins % 1) * 60)).padStart(2, '0')} at ${x.bpm()} bpm · ${x.keyName()}`),
        h('span', { style: 'flex:1' }),
        h('span', { class: 'presence' }, ...who.map((p) => h('span', { class: 'who' + (p.where === 'compose' ? ' here' : ''), title: `${p.name}: ${p.where === 'compose' ? 'in the Compose Room' : p.where === 'jam' ? 'in the Jam Room' : 'in the hall'}` }, p.name.slice(0, 1).toUpperCase()))),
        h('button', { class: 'btn small' + (tr?.on && tr.mode === 'song' ? ' on' : ''), onclick: () => (tr?.on && tr.mode === 'song' ? x.stop() : x.play('song')) }, tr?.on && tr.mode === 'song' ? '■ Stop' : '▶ Play the song'),
        h('button', { class: 'btn small', onclick: () => file.click(), title: 'Bring in a sketch: a MIDI file, or a song from SynthLand\'s Tracker (.json)' }, 'Import…'), file,
        h('button', { class: 'btn small', onclick: () => x.exportMidi() }, 'Save MIDI'),
        h('button', { class: 'btn small ghost', onclick: () => x.exportJson() }, 'Save song')),
      h('div', { class: 'board' }, ...secs.map((s, i) => sectionCard(s, i, secs.length, tl)),
        h('div', { class: 'seccard add' }, h('b', {}, '+ Section'), ...SECTION_NAMES.map((n) => h('button', { class: 'btn small ghost', onclick: () => addSection(n) }, n)))));
    if (editing) { const el = $(`[data-cell="${editing}"]`); if (el) { el.focus(); } }
    void keyNow;
  }
  // light updates while playing: which section and bar is live
  function tick(pos) {
    for (const c of document.querySelectorAll('.seccard[data-sec]')) {
      const on = pos && c.dataset.sec === pos.sid;
      c.classList.toggle('live', !!on);
      c.querySelectorAll('.chord').forEach((el, b) => el.classList.toggle('now', !!on && b === pos.bar));
    }
  }
  return { render, tick, addSection };
}
