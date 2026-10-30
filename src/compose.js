// The Compose Room: the band's song board. Sections in arrangement order, each with its length, chord chart, notes
// and the parts locked into it; import a sketch (MIDI or a SynthLand Tracker song), export the song; loop a section
// or play the whole song; "Jam this" takes everyone to the Jam Room with that section looping.
import { SECTION_NAMES, NOTE_NAMES, sectionBeats, newSection, parseChord, takesOf, currentTake, laneOf, ROLES } from './song.js';

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
  // x: { h, $, store, playersOf(), setSong(k, v), play(mode, sid), stop(), transport(), jamThis(sid), importFile(f), exportMidi(), exportJson(),
  //      removePart, mutePart, choose, vote, saveVariation, restoreVariation, setRole, working(), me(), iconEl, keyName(), bpm() }
  const { h, $ } = x;
  let PX = 18, sel = null, cell = null, editing = null;   // px per bar; the selected section and lane
  const LANE_COLORS = ['#FF68BA', '#7DB0FF', '#D8A83A', '#3ddc84', '#b892ff', '#ff8a3d', '#5fd4d4', '#ECEBE5'];
  const laneColor = (i) => LANE_COLORS[i % LANE_COLORS.length];
  function lanes() {
    const out = [], seen = new Map();
    for (const s of x.store.sections()) for (const p of Object.values(s.parts || {})) { const l = laneOf(p); if (!seen.has(l)) { seen.set(l, out.length); out.push({ lane: l, role: p.role, inst: p.inst, drums: p.drums, sample: p }); } }
    return out;
  }
  // a tiny picture of a take: notes as bars across the cell (pitch up), drums as ticks
  function miniRoll(take, beats, w, ht, color, drums) {
    const ev = take?.events || [], on = new Map(), notes = [];
    for (const e of ev) { if (e.type === 'on') on.set(e.note, e); else if (e.type === 'off' && on.has(e.note)) { notes.push({ n: e.note, a: on.get(e.note).b, z: e.b }); on.delete(e.note); } }
    for (const [n, e] of on) notes.push({ n, a: e.b, z: beats });
    if (!notes.length) return '';
    let lo = 127, hi = 0; for (const n of notes) { lo = Math.min(lo, n.n); hi = Math.max(hi, n.n); }
    const span = Math.max(6, hi - lo + 1), sx = w / beats, sy = (ht - 6) / span;
    const r = notes.map((n) => drums ? `<rect x="${(n.a * sx).toFixed(1)}" y="${(3 + (hi - n.n) * sy).toFixed(1)}" width="1.6" height="${Math.max(2, sy).toFixed(1)}"/>` : `<rect x="${(n.a * sx).toFixed(1)}" y="${(3 + (hi - n.n) * sy).toFixed(1)}" width="${Math.max(1.2, (n.z - n.a) * sx - 0.6).toFixed(1)}" height="${Math.max(1.5, sy - 0.6).toFixed(1)}" rx="0.6"/>`).join('');
    return `<svg viewBox="0 0 ${w} ${ht}" width="${w}" height="${ht}" preserveAspectRatio="none"><g fill="${color}">${r}</g></svg>`;
  }
  function render() {
    const box = $('#compose'); if (!box) return;
    const song = x.store.song, order = song.order.filter((id) => song.sections[id]), tl = x.store.timeline(), tr = x.transport(), meter = song.meter || 4;
    const L = lanes(), work = x.working();
    if (!sel || !song.sections[sel]) sel = order[0] || null;
    const totalBars = order.reduce((a, id) => a + song.sections[id].bars, 0), mins = (totalBars * meter) / x.bpm();
    const file = h('input', { type: 'file', accept: '.mid,.midi,.json,audio/midi,application/json', style: 'display:none', onchange: (e) => { const f = e.target.files[0]; if (f) x.importFile(f); e.target.value = ''; } });
    const vars = Object.values(song.variations || {});
    const head = h('div', { class: 'songhead' },
      h('input', { class: 'songtitle', value: song.title, maxlength: 60, 'aria-label': 'Song title', onkeydown: (e) => e.stopPropagation(), onchange: (e) => x.setSong('title', e.target.value.trim() || 'Untitled') }),
      h('span', { class: 'help mono' }, `${order.length} sections · ${totalBars} bars · ${Math.floor(mins)}:${String(Math.round((mins % 1) * 60)).padStart(2, '0')} · ${x.bpm()} bpm · ${x.keyName()}`),
      h('span', { style: 'flex:1' }),
      h('span', { class: 'presence' }, ...x.playersOf().map((p) => h('span', { class: 'who' + (p.where === 'compose' ? ' here' : ''), title: `${p.name}: ${p.where === 'compose' ? 'in the Compose Room' : 'in the Jam Room'}` }, p.name.slice(0, 1).toUpperCase()))),
      h('label', { class: 'help', title: 'What happens when someone locks in a new take of a lane' }, 'New takes ',
        h('select', { class: 'lcdsel', onchange: (e) => x.setSong('rule', e.target.value) }, ...[['newest', 'take over'], ['owner', 'wait for the owner'], ['vote', 'go to a vote']].map(([v, t]) => h('option', { value: v, selected: (song.rule || 'newest') === v }, t)))),
      h('select', { class: 'lcdsel', 'aria-label': 'Variations', onchange: (e) => { const v = e.target.value; e.target.value = ''; if (v === '__save') { const n = prompt('Name this version of the song', `Version ${vars.length + 1}`); if (n) x.saveVariation(n.slice(0, 40)); } else if (v) x.restoreVariation(v); } },
        h('option', { value: '' }, vars.length ? `Versions (${vars.length})` : 'Versions'), h('option', { value: '__save' }, 'Save this version…'), ...vars.map((v) => h('option', { value: v.name }, `Go to “${v.name}”`))),
      h('button', { class: 'btn small' + (tr?.on && tr.mode === 'song' ? ' on' : ''), onclick: () => (tr?.on && tr.mode === 'song' ? x.stop() : x.play('song')) }, tr?.on && tr.mode === 'song' ? '■ Stop' : '▶ Play the song'),
      h('button', { class: 'btn small', onclick: () => file.click(), title: "Bring in a sketch: a MIDI file, or a song from SynthLand's Tracker (.json)" }, 'Import…'), file,
      h('button', { class: 'btn small', onclick: () => x.exportMidi() }, 'Save MIDI'), h('button', { class: 'btn small ghost', onclick: () => x.exportJson() }, 'Save song'),
      h('span', { class: 'zoom' }, h('button', { class: 'btn small ghost', 'aria-label': 'Zoom out', onclick: () => { PX = Math.max(8, PX - 4); render(); } }, '−'), h('button', { class: 'btn small ghost', 'aria-label': 'Zoom in', onclick: () => { PX = Math.min(48, PX + 4); render(); } }, '+')));
    // the arrangement: sections left to right along the top, one row per lane, a block per take that sounds there
    const loopId = tr && tr.on && tr.mode === 'loop' ? tr.sid : null;
    const busy = new Map();   // lane -> the jammer playing it in the looping section right now
    if (loopId) for (const w of work) if (w.where === 'jam' && w.active) for (const name of w.parts) busy.set(`${w.who} · ${name}`, w);
    const cols = order.map((id, i) => ({ id, i, s: song.sections[id], label: (song.labels || [])[i] || '', w: Math.max(70, song.sections[id].bars * PX) }));
    const ruler = h('div', { class: 'arow ruler' }, h('div', { class: 'lhead' }, h('b', {}, 'Lanes'), h('small', {}, 'locked · being played · empty')),
      ...cols.map((c) => {
        const tlc = tl[c.i], live = tr && tr.on && (tr.mode === 'song' ? true : tr.sid === c.id);
        const here = c.id === loopId ? [...new Set(busy.values())] : [];
        return h('button', { class: 'shead' + (sel === c.id ? ' sel' : '') + (live && tr.mode === 'loop' ? ' live' : ''), style: `width:${c.w}px;--sc:${colorOfSection(c.s.name)}`, 'data-col': c.i, 'data-sec': c.id, onclick: () => { sel = c.id; cell = null; render(); } },
          h('b', {}, c.s.name), c.label ? h('small', { class: 'rm' }, c.label) : null, h('small', {}, `${c.s.bars} bars`),
          h('span', { class: 'ticks' }, ...Array.from({ length: c.s.bars }, (_, b) => h('i', { class: (b % 4 === 0 ? 'bar4' : '') + (c.s.chords[b] ? ' ch' : ''), title: c.s.chords[b] || '' }))),
          here.length ? h('span', { class: 'herein' }, ...here.map((w) => h('i', { style: `--c:${w.color}`, title: `${w.who} is jamming here` }, w.who.slice(0, 1)))) : null);
      }));
    const rows = L.map((ln, li) => h('div', { class: 'arow' },
      h('div', { class: 'lhead' + (cell && cell.lane === ln.lane ? ' sel' : ''), style: `--lc:${laneColor(li)}` }, x.iconEl(ln.sample), h('span', {}, h('b', {}, ln.lane), h('select', { class: 'role', 'aria-label': `${ln.lane}'s role`, onchange: (e) => { const s0 = x.store.sections().find((s) => Object.values(s.parts || {}).some((p) => laneOf(p) === ln.lane)); const p = Object.values(s0.parts).find((q) => laneOf(q) === ln.lane); x.setRole(s0.id, p.id, e.target.value); } }, ...ROLES.map((r) => h('option', { value: r, selected: (ln.role || '') === r }, r))))),
      ...cols.map((c) => {
        const p = Object.values(c.s.parts || {}).find((q) => laneOf(q) === ln.lane);
        const wk = c.id === loopId ? busy.get(ln.lane) : null;
        if (!p) return wk ? h('div', { class: 'cell working', style: `width:${c.w}px;--lc:${wk.color}`, title: `${wk.who} is playing this now; nothing locked yet` }, h('span', {}, '● being played · not locked'))
          : h('div', { class: 'cell empty', style: `width:${c.w}px`, title: 'Nothing here yet: jam it and lock a take in', onclick: () => { sel = c.id; cell = null; render(); } }, h('span', {}, '+ jam it'));
        const take = currentTake(p), n = takesOf(p).length, beats = c.s.bars * meter;
        const blk = h('div', { class: 'cell take' + (p.muted ? ' muted' : '') + (wk ? ' retake' : '') + (cell && cell.sid === c.id && cell.pid === p.id ? ' sel' : ''), style: `width:${c.w}px;--lc:${laneColor(li)}`, title: `${ln.lane} in ${c.s.name}: ${n} take${n > 1 ? 's' : ''}, playing ${take?.byName || '?'}'s${p.muted ? ' (muted)' : ''}`, onclick: () => { sel = c.id; cell = { sid: c.id, pid: p.id, lane: ln.lane }; render(); } });
        blk.innerHTML = miniRoll(take, beats, c.w - 4, 30, '#18181b', p.drums);
        blk.append(...[h('span', { class: 'lock', 'aria-hidden': 'true' }, '🔒'), n > 1 ? h('span', { class: 'ntakes' }, `${n} takes`) : null, wk ? h('span', { class: 'retaking', style: `--c:${wk.color}` }, `${wk.who} trying a new take`) : null].filter(Boolean));
        return blk;
      })));
    // someone jamming the looping section on an instrument that has no lane yet: a row of its own, marked as unlocked work
    const known = new Set(L.map((l) => l.lane)), ghosts = [];
    for (const [lane, w] of busy) if (!known.has(lane)) ghosts.push(h('div', { class: 'arow ghost' }, h('div', { class: 'lhead', style: `--lc:${w.color}` }, h('span', {}, h('b', {}, lane), h('small', {}, 'jamming now'))),
      ...cols.map((c) => h('div', { class: c.id === loopId ? 'cell working' : 'cell blank', style: `width:${c.w}px;--lc:${w.color}` }, c.id === loopId ? h('span', {}, '● being played · not locked') : null))));
    const grid = h('div', { class: 'arranger' }, ruler, ...rows, ...ghosts, h('div', { class: 'playhead hide', 'data-playhead': '' }),
      h('div', { class: 'arow' }, h('div', { class: 'lhead addl' }, h('small', {}, L.length ? 'New lanes appear when someone locks in a take.' : 'No lanes yet: jam a section and Lock it in, or import a sketch.')),
        h('div', { class: 'addsec' }, h('b', {}, '+ Section'), ...SECTION_NAMES.map((nm) => h('button', { class: 'btn small ghost', onclick: () => addSection(nm) }, nm)))));
    box.replaceChildren(head, grid, details(sel, cell));
    if (editing) $(`[data-cell="${editing}"]`)?.focus();
  }
  function details(sid, c) {
    const s = sid && x.store.song.sections[sid]; if (!s) return h('div', { class: 'details' });
    const song = x.store.song, i = song.order.indexOf(sid), tr = x.transport();
    const save = (patch) => x.setSong('sec:' + s.id, { name: s.name, bars: s.bars, chords: s.chords, notes: s.notes, ...patch });
    const live = tr && tr.on && tr.mode === 'loop' && tr.sid === s.id;
    const nameSel = h('select', { class: 'secname', style: `--sc:${colorOfSection(s.name)}`, 'aria-label': 'Section', onchange: (e) => { if (e.target.value === '__custom') { const n = prompt('Section name', s.name); if (n) save({ name: n.slice(0, 24) }); } else save({ name: e.target.value }); } },
      ...[...new Set([...SECTION_NAMES, s.name])].map((n) => h('option', { value: n, selected: n === s.name }, n)), h('option', { value: '__custom' }, 'Name it…'));
    const label = h('input', { class: 'rmlabel', value: (song.labels || [])[i] || '', placeholder: 'road map: head in, solo, trading 4s…', maxlength: 30, onkeydown: (e) => e.stopPropagation(), onchange: (e) => { const l = [...(song.labels || [])]; l.length = song.order.length; l[i] = e.target.value.trim(); x.setSong('labels', Array.from(l, (v) => v || '')); } });
    const chart = h('div', { class: 'chart' }, ...Array.from({ length: s.bars }, (_, b) => {
      const v = s.chords[b] || '', ok = !v || parseChord(v);
      return h('input', { class: 'chord' + (ok ? '' : ' bad') + (b % 4 === 0 ? ' downbar' : ''), value: v, placeholder: b === 0 ? 'chord' : '·', maxlength: 8, 'aria-label': `Bar ${b + 1} chord`, 'data-cell': `${s.id}:${b}`,
        onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.target.blur(); $(`[data-cell="${s.id}:${b + (e.shiftKey ? -1 : 1)}"]`)?.focus(); } },
        onfocus: () => { editing = `${s.id}:${b}`; }, onblur: (e) => { editing = null; const ch = Array.from({ length: s.bars }, (_, k) => s.chords[k] || ''); ch[b] = e.target.value.trim(); if (ch[b] !== (s.chords[b] || '')) save({ chords: ch }); } });
    }));
    const prog = h('select', { class: 'lcdsel', 'aria-label': 'Fill the chart', onchange: (e) => { const p = PROGS.find((q) => q[0] === e.target.value); if (p) save({ chords: fillChart(song.key, s.bars, p[1]) }); e.target.value = ''; } },
      h('option', { value: '' }, `Fill in ${x.keyName()}…`), ...PROGS.map(([n]) => h('option', { value: n }, n)));
    const secPane = h('div', { class: 'pane', style: `--sc:${colorOfSection(s.name)}` },
      h('div', { class: 'row' }, h('span', { class: 'secno' }, String(i + 1).padStart(2, '0')), nameSel,
        h('span', { class: 'bars' }, h('button', { class: 'btn small', 'aria-label': 'Fewer bars', onclick: () => { const b = Math.max(1, s.bars - (s.bars > 4 ? 4 : 1)); save({ bars: b, chords: s.chords.slice(0, b) }); } }, '−'), h('b', {}, `${s.bars} bars`), h('button', { class: 'btn small', 'aria-label': 'More bars', onclick: () => { const b = Math.min(64, s.bars + (s.bars >= 4 ? 4 : 1)); save({ bars: b, chords: [...s.chords, ...Array(Math.max(0, b - s.chords.length)).fill('')] }); } }, '+')),
        h('span', { style: 'flex:1' }),
        h('button', { class: 'btn small ghost', disabled: i <= 0, onclick: () => move(i, -1) }, '←'), h('button', { class: 'btn small ghost', disabled: i >= song.order.length - 1, onclick: () => move(i, 1) }, '→'),
        h('button', { class: 'btn small ghost', onclick: () => { const o = [...song.order]; o.splice(i + 1, 0, s.id); x.setSong('order', o); } }, 'Repeat'),
        h('button', { class: 'btn small ghost', onclick: () => { const o = [...song.order]; o.splice(i, 1); x.setSong('order', o); if (!o.includes(s.id)) x.setSong('sec:' + s.id, null); sel = null; } }, 'Remove')),
      label, chart, h('div', { class: 'row' }, prog,
        h('button', { class: 'btn small' + (live ? ' on' : ''), onclick: () => (live ? x.stop() : x.play('loop', s.id)) }, live ? '■ Stop' : '↻ Loop it'),
        h('button', { class: 'btn small hot', onclick: () => x.jamThis(s.id) }, 'Jam this section')),
      h('textarea', { class: 'secnotes', rows: 2, placeholder: 'Ideas: feel, who plays what, lyrics…', onkeydown: (e) => e.stopPropagation(), onchange: (e) => save({ notes: e.target.value.slice(0, 2000) }) }, s.notes || ''));
    let takePane = h('div', { class: 'pane takes' }, h('p', { class: 'help' }, 'Pick a block in the arrangement to see its takes.'));
    const p = c && s.parts?.[c.pid];
    if (p) {
      const cur = currentTake(p), rule = song.rule || 'newest', ts = takesOf(p);
      takePane = h('div', { class: 'pane takes' },
        h('div', { class: 'row' }, h('b', {}, `${laneOf(p)} in ${s.name}`), h('span', { class: 'help' }, `${p.role || ''}${p.by && p.by !== 'import' ? ` · owner ${p.byName || ''}` : ''} · ${rule === 'vote' ? 'the band votes' : rule === 'owner' ? 'the owner picks' : 'newest take wins'}`), h('span', { style: 'flex:1' }),
          h('button', { class: 'btn small ghost', onclick: () => x.mutePart(s.id, p.id, !p.muted) }, p.muted ? 'Unmute lane here' : 'Mute here'), h('button', { class: 'btn small ghost', onclick: () => { x.removePart(s.id, p.id); cell = null; } }, 'Remove')),
        ...[...ts].reverse().map((t, k) => {
          const votes = (p.votes?.[t.id] || []).length, on = cur && cur.id === t.id;
          return h('div', { class: 'takerow' + (on ? ' on' : '') }, h('span', { class: 'tno' }, `take ${ts.length - k}`), h('span', {}, `${t.byName || 'someone'}${t.at ? ' · ' + new Date(t.at > 1e12 ? t.at : Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''} · ${t.events.filter((e) => e.type === 'on').length} notes`),
            rule === 'vote' ? h('span', { class: 'help' }, `${votes} vote${votes === 1 ? '' : 's'}`) : null, h('span', { style: 'flex:1' }),
            on ? h('b', { class: 'curtag' }, 'sounding') : h('button', { class: 'btn small', onclick: () => (rule === 'vote' ? x.vote(s.id, p.id, t.id) : x.choose(s.id, p.id, t.id)) }, rule === 'vote' ? 'Vote for it' : 'Use this take'));
        }));
    }
    return h('div', { class: 'details' }, secPane, takePane);
  }
  function move(i, d) { const o = [...x.store.song.order]; const [v] = o.splice(i, 1); o.splice(i + d, 0, v); x.setSong('order', o); const l = [...(x.store.song.labels || [])]; const [lv] = l.splice(i, 1); l.splice(i + d, 0, lv || ''); x.setSong('labels', l.map((q) => q || '')); }
  function addSection(name) {
    const prev = x.store.sections().slice(-1)[0], sec = newSection(name, name === 'Intro' || name === 'Outro' ? 4 : 8);
    if (prev && !name.match(/intro|outro|break/i)) sec.chords = [...prev.chords].slice(0, sec.bars);
    x.setSong('sec:' + sec.id, { name: sec.name, bars: sec.bars, chords: sec.chords.concat(Array(Math.max(0, sec.bars - sec.chords.length)).fill('')), notes: '' });
    x.setSong('order', [...x.store.song.order, sec.id]); sel = sec.id;
  }
  // while playing: the playhead across the arrangement, and the live bar in the chord chart
  let sig = '';
  function tick(pos) {
    const box = $('#compose');
    for (const c of document.querySelectorAll('.chord')) c.classList.toggle('now', !!pos && c.dataset.cell === `${pos.sid}:${pos.bar}`);
    if (!box || box.offsetParent === null) return;
    // who is playing what changes on its own (someone starts or stops); redraw then, but never under someone's typing
    const tr = x.transport(), s2 = JSON.stringify([tr?.on, tr?.mode, tr?.sid, x.working().filter((w) => w.active && w.where === 'jam').map((w) => [w.who, w.parts])]);
    if (s2 !== sig && !box.contains(document.activeElement?.matches?.('input,textarea,select') ? document.activeElement : null)) { sig = s2; render(); }
    const ph = $('[data-playhead]'); if (!ph) return;
    if (!pos) { ph.classList.add('hide'); return; }
    const col = tr.mode === 'loop' ? x.store.song.order.indexOf(pos.sid) : pos.seg.idx ?? x.store.song.order.indexOf(pos.sid);
    const head = document.querySelector(`.shead[data-col="${col}"]`); if (!head) { ph.classList.add('hide'); return; }
    const grid = head.closest('.arranger'), gr = grid.getBoundingClientRect(), hr = head.getBoundingClientRect();
    const frac = Math.min(1, (pos.bar + pos.beat / (x.store.song.meter || 4)) / x.store.song.sections[pos.sid].bars);
    ph.classList.remove('hide'); ph.style.left = `${hr.left - gr.left + grid.scrollLeft + frac * hr.width}px`; ph.style.height = `${grid.scrollHeight}px`;
  }
  return { render, tick, addSection };
}
