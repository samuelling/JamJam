// The Compose Room: the band's song board. Sections in arrangement order, each with its length, chord chart, notes
// and the parts locked into it; import a sketch (MIDI or a SynthLand Tracker song), export the song; loop a section
// or play the whole song; "Jam this" takes everyone to the Jam Room with that section looping.
import { SECTION_NAMES, NOTE_NAMES, newSection, parseChord, takesOf, currentTake, laneOf, ROLES } from './song.js';

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
  //      removePart, mutePart, choose, vote, saveVariation, restoreVariation, setRole, laneSounds(drums), setLaneSound(lane, inst, patch), midiOn(), enableMidi(), presets(), loadPreset(genre, song), working(), me(), iconEl, keyName(), bpm() }
  const { h, $ } = x;
  let PX = 18, sel = null, cell = null, editing = null;
  let draft = null, dragging = false;   // a loop being drawn before it plays; true while a handle is held
  const mem = (k, d) => { try { const v = localStorage.getItem('megajam.' + k); return v == null ? d : v === '1'; } catch (_) { return d; } };
  const remember = (k, v) => { try { localStorage.setItem('megajam.' + k, v ? '1' : '0'); } catch (_) {} };
  let songMore = mem('songMore', false), secMore = mem('secMore', false);
  const SNAP = [{ name: '1/4', g: 1 }, { name: '1/8', g: 0.5 }, { name: '1/16', g: 0.25 }, { name: '1/8 triplet', g: 1 / 3 }, { name: '1/16 triplet', g: 1 / 6 }, { name: '1/32', g: 0.125 }];
  let snapI = 2, qStrength = 1;
  // step entry: with a lane's roll open, what you play lands at a cursor instead of going to your desk, and only you
  // hear it until it's in the song. Notes held together are one chord; letting go of them all moves the cursor on.
  const LENGTHS = [['1/16', 0.25], ['1/8 triplet', 1 / 3], ['1/8', 0.5], ['1/4', 1], ['dotted 1/4', 1.5], ['1/2', 2], ['dotted 1/2', 3], ['whole', 4]];
  const step = { on: false, b: 0, len: 1, key: '' }, held = new Set();
  const edits = new Map();   // section:part -> your edits to it, to step back and forward through
  const num = (k, d) => { try { const v = parseFloat(localStorage.getItem('megajam.' + k)); return Number.isFinite(v) ? v : d; } catch (_) { return d; } };
  const keep = (k, v) => { try { localStorage.setItem('megajam.' + k, String(v)); } catch (_) {} };
  let split = num('split', 0.52), detH = num('detH', 0);   // the two dividers: how wide the left pane is, how tall the part view (0: its own size)
  let chord = [], stepAt = null;   // the notes held for this step; the open roll, when it can be written on
  let open = false; try { open = localStorage.getItem('megajam.lanes') === '1'; } catch (_) {}   // lanes folded into one row by default   // px per bar; the selected section and lane
  const LANE_COLORS = ['#FF68BA', '#7DB0FF', '#D8A83A', '#3ddc84', '#b892ff', '#ff8a3d', '#5fd4d4', '#ECEBE5'];
  const laneColor = (i) => LANE_COLORS[i % LANE_COLORS.length];
  function lanes() {
    const out = [], seen = new Map();
    for (const s of x.store.sections()) for (const p of Object.values(s.parts || {})) { const l = laneOf(p); if (!seen.has(l)) { seen.set(l, out.length); out.push({ lane: l, role: p.role, inst: p.inst, drums: p.drums, sample: p }); } }
    return out;
  }
  // a tiny picture of a take: notes as bars across the cell (pitch up), drums as ticks
  function miniRoll(take, beats, w, ht, color, drums) {
    if (take?.audio) {
      // an audio take: its waveform outline, where it sits in the section
      const A = take.audio, x0 = (A.from / beats) * w, ww = (A.beats / beats) * w, n = A.peaks.length, mid = ht / 2;
      const pts = A.peaks.map((v, i) => `${(x0 + (i / (n - 1)) * ww).toFixed(1)},${(mid - Math.min(1, v * 1.6) * (mid - 2)).toFixed(1)}`);
      const back = A.peaks.map((v, i) => `${(x0 + (i / (n - 1)) * ww).toFixed(1)},${(mid + Math.min(1, v * 1.6) * (mid - 2)).toFixed(1)}`).reverse();
      return `<svg viewBox="0 0 ${w} ${ht}" width="${w}" height="${ht}" preserveAspectRatio="none"><polygon points="${[...pts, ...back].join(' ')}" fill="${color}" opacity="${x.audioReady?.(A.id) ? 1 : 0.35}"/></svg>`;
    }
    const ev = take?.events || [], on = new Map(), notes = [];
    for (const e of ev) { if (e.type === 'on') on.set(e.note, e); else if (e.type === 'off' && on.has(e.note)) { notes.push({ n: e.note, a: on.get(e.note).b, z: e.b }); on.delete(e.note); } }
    for (const [n, e] of on) notes.push({ n, a: e.b, z: beats });
    if (!notes.length) return '';
    let lo = 127, hi = 0; for (const n of notes) { lo = Math.min(lo, n.n); hi = Math.max(hi, n.n); }
    const span = Math.max(6, hi - lo + 1), sx = w / beats, sy = (ht - 6) / span;
    const r = notes.map((n) => drums ? `<rect x="${(n.a * sx).toFixed(1)}" y="${(3 + (hi - n.n) * sy).toFixed(1)}" width="1.6" height="${Math.max(2, sy).toFixed(1)}"/>` : `<rect x="${(n.a * sx).toFixed(1)}" y="${(3 + (hi - n.n) * sy).toFixed(1)}" width="${Math.max(1.2, (n.z - n.a) * sx - 0.6).toFixed(1)}" height="${Math.max(1.5, sy - 0.6).toFixed(1)}" rx="0.6"/>`).join('');
    return `<svg viewBox="0 0 ${w} ${ht}" width="${w}" height="${ht}" preserveAspectRatio="none"><g fill="${color}">${r}</g></svg>`;
  }
  function pickLane(lane) {
    const song = x.store.song, has = (sid) => Object.values(song.sections[sid]?.parts || {}).find((q) => laneOf(q) === lane);
    const sid = has(sel) ? sel : song.order.find(has); if (!sid) return;
    sel = sid; cell = { sid, pid: has(sid).id, lane }; render();
  }
  // the picked lane's notes in this section, in detail: a roll under the chord chart, with names, bars and velocities.
  // It is also where parts get written: on an empty roll (a lane with no take here yet, or a new lane for one of your
  // instruments) a click places a note and a drag makes it longer. A written part lives in the song like a jammed
  // take, so every browser has all of it before it plays and schedules it exactly, with no lookahead to wait for.
  const KIT_ROWS = [49, 51, 46, 42, 50, 47, 45, 39, 38, 37, 36], PAD_ROWS = Array.from({ length: 16 }, (_, i) => 51 - i);
  const shift = new Map();   // lane -> semitones the empty roll has been scrolled
  let lastAdd = { t: 0, n: -1, a: -1 };   // the note just placed, and when
  function laneView(s, p, color) {
    const meter = x.store.song.meter || 4, beats = s.bars * meter, take = currentTake(p), notes = [], on = new Map();
    for (const e of [...(take?.events || [])].sort((a, b) => a.b - b.b)) { if (e.type === 'on') on.set(e.note, e); else if (e.type === 'off' && on.has(e.note)) { const o = on.get(e.note); notes.push({ n: e.note, a: o.b, z: e.b, v: o.vel ?? 100 }); on.delete(e.note); } }
    for (const [n, o] of on) notes.push({ n, a: o.b, z: beats, v: o.vel ?? 100 });
    const close = h('button', { class: 'gearx', style: 'position:static', 'aria-label': 'Hide the notes', onclick: () => { cell = null; render(); } }, '×');
    const head = (...k) => h('div', { class: 'row lvhead' }, h('b', { style: `color:${color}` }, laneOf(p)), ...k, h('span', { style: 'flex:1' }), close);
    const canEdit = !!x.editTake && !take?.audio;
    if (!notes.length && !canEdit) return h('div', { class: 'laneview' }, head(h('span', { class: 'help' }, 'no notes in this take')));
    const name = (n) => (p.drums ? drumName(n) : NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1));
    const pos = (b) => `bar ${Math.floor(b / meter) + 1} beat ${+((b % meter) + 1).toFixed(2)}`;
    const rows = p.drums ? [...new Set([...notes.map((n) => n.n), ...(canEdit ? (p.inst === 'pads' ? PAD_ROWS : KIT_ROWS) : [])])].sort((a, b) => b - a) : null;
    const sh = shift.get(laneOf(p)) || 0, bass = p.role === 'bass' || /bass/i.test(p.name || '');
    let lo = 127, hi = 0; for (const n of notes) { lo = Math.min(lo, n.n); hi = Math.max(hi, n.n); }
    if (!p.drums) {
      // to read: the notes' range and a row either side. To write: a steady two-octave window (scrolled by ▲▼) that
      // grows to take in any note outside it, so the rows don't shift under the pointer as notes go in.
      if (canEdit) { const d0 = (bass ? 33 : 53) + sh; lo = Math.max(0, Math.min(lo, d0)); hi = Math.min(127, Math.max(hi, d0 + 24)); }
      else { lo -= 1; hi += 1; }
    }
    const nRows = p.drums ? rows.length : hi - lo + 1, rh = canEdit ? Math.max(8, Math.min(p.drums ? 14 : 10, Math.floor(240 / nRows))) : Math.max(4, Math.min(p.drums ? 14 : 9, Math.floor(150 / nRows))), H = nRows * rh, W = beats * 24;
    const rowOf = (n) => (p.drums ? rows.indexOf(n) : hi - n);
    const vels = notes.map((n) => n.v), pcs = [...new Set(notes.map((n) => n.n % 12))].sort((a, b) => a - b), vNew = vels.length ? Math.round(vels.reduce((u, w) => u + w, 0) / vels.length) : 96;
    const lanes = [];
    for (let r = 0; r < nRows; r++) { const n = p.drums ? rows[r] : hi - r; if (!p.drums && [1, 3, 6, 8, 10].includes(n % 12)) lanes.push(`<rect x="0" y="${r * rh}" width="${W}" height="${rh}" fill="#ffffff06"/>`); if (!p.drums && n % 12 === 0) lanes.push(`<line x1="0" x2="${W}" y1="${(r + 1) * rh}" y2="${(r + 1) * rh}" stroke="#ffffff14" vector-effect="non-scaling-stroke"/>`); }
    const g = SNAP[snapI].g;
    const sub = canEdit && g < 1 ? Array.from({ length: Math.round(beats / g) }, (_, k) => k * g).filter((b) => Math.abs(b - Math.round(b)) > 1e-6).map((b) => `<line x1="${b * 24}" x2="${b * 24}" y1="0" y2="${H}" stroke="#ffffff07" vector-effect="non-scaling-stroke"/>`).join('') : '';
    const grid = sub + Array.from({ length: beats + 1 }, (_, b) => `<line x1="${b * 24}" x2="${b * 24}" y1="0" y2="${H}" stroke="${b % meter ? '#ffffff0d' : '#ffffff30'}" stroke-width="${b % meter ? 1 : 1.5}" vector-effect="non-scaling-stroke"/>`).join('');
    const rects = notes.map((n, i) => `<rect data-i="${i}" class="lvnote" x="${(n.a * 24).toFixed(1)}" y="${rowOf(n.n) * rh + 0.5}" width="${Math.max(3, (n.z - n.a) * 24 - 1).toFixed(1)}" height="${rh - 1}" rx="1.5" fill="${color}" fill-opacity="${(0.35 + 0.65 * Math.min(1, n.v / 127)).toFixed(2)}"><title>${name(n.n)} · ${pos(n.a)} · ${+(n.z - n.a).toFixed(2)} beats · velocity ${n.v}</title></rect>`).join('');
    const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">${lanes.join('')}${grid}${rects}</svg>`;
    const labels = h('div', { class: 'lvkeys', style: `height:${H}px` }, ...Array.from({ length: nRows }, (_, r) => { const n = p.drums ? rows[r] : hi - r; return p.drums || nRows <= 18 || n % 12 === 0 || r === 1 || r === nRows - 2 ? h('span', { style: `top:${r * rh}px;height:${rh}px;line-height:${rh}px` }, name(n)) : null; }).filter(Boolean));
    const roll = h('div', { class: 'lvroll' + (canEdit ? ' editable' : '') + (canEdit && !notes.length ? ' blank' : '') }); roll.innerHTML = svg; roll.append(h('div', { class: 'lvhead-play hide', 'data-lvplay': s.id }));
    if (canEdit && step.on && step.b < beats) roll.append(h('div', { class: 'lvcursor', style: `left:${(step.b / beats) * 100}%;width:${(Math.min(step.len, beats - step.b) / beats) * 100}%` }));
    // drag a note to move it (snapping to the grid; hold Alt for none), drag its right end to lengthen or shorten it,
    // click an empty spot to place a note (drag to make it longer), double-click a note (or right-click it) to delete
    // it. Changing someone's take saves an edited copy (the original stays in the take list).
    const toBeat = (cx) => { const r = roll.getBoundingClientRect(); return Math.max(0, Math.min(beats, ((cx - r.left) / r.width) * beats)); };
    const toRow = (cy) => { const r = roll.getBoundingClientRect(); return Math.max(0, Math.min(nRows - 1, Math.floor((cy - r.top) / rh))); };
    const noteOfRow = (r) => (p.drums ? rows[r] : hi - r);
    const snap = (b, alt) => (alt ? b : Math.round(b / g) * g);
    const write = (list, what) => { const ev = []; for (const n of list) { const a = Math.max(0, Math.min(beats - 0.01, n.a)), z = Math.max(a + 0.02, Math.min(beats - 0.001, n.z)); ev.push({ b: a, type: 'on', note: n.n, vel: n.v }, { b: z, type: 'off', note: n.n }); } ev.sort((u, w) => u.b - w.b || (u.type === 'off' ? -1 : 1)); x.editTake(s.id, p.id, ev, what, p); };
    // every change keeps what came before it, in this browser; Undo writes that back as a new edit
    const key = `${s.id}:${p.id}`, hist = edits.get(key) || edits.set(key, { back: [], fwd: [] }).get(key);
    const save = (list, what) => { hist.back.push({ notes, b: step.b }); if (hist.back.length > 200) hist.back.shift(); hist.fwd = []; write(list, what); };
    const swap = (from, to) => { const e = from.pop(); if (!e) return; to.push({ notes, b: step.b }); step.b = e.b; write(e.notes, 'undo'); render(); };
    const undo = () => swap(hist.back, hist.fwd), redo = () => swap(hist.fwd, hist.back);
    const hear = (n, v) => x.previewNote?.(p, n, v);
    if (canEdit) {
      if (step.key !== key) { const end = Math.max(0, ...notes.map((n) => n.z)); step.key = key; step.b = end < beats ? end : 0; }   // pick up after the last note
      stepAt = { notes, save, p, beats, undo, redo };
    }
    if (canEdit) {
      roll.addEventListener('pointerdown', (ev) => {
        if (ev.button) return;
        const el = ev.target.closest?.('.lvnote');
        ev.preventDefault(); roll.setPointerCapture(ev.pointerId); dragging = true;
        if (!el) {
          // a new note: from the grid line under the press, as long as the drag (at least one grid step)
          const a = Math.min(beats - g, Math.floor(toBeat(ev.clientX) / g) * g), r0 = toRow(ev.clientY), n = noteOfRow(r0), len0 = p.drums ? Math.min(g, 0.25) : Math.max(g, 0.5);
          let z = a + len0;
          const ghost = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          Object.entries({ class: 'lvnote ghost', x: (a * 24).toFixed(1), y: r0 * rh + 0.5, width: Math.max(3, len0 * 24 - 1), height: rh - 1, rx: 1.5, fill: color }).forEach(([k, v]) => ghost.setAttribute(k, v));
          roll.querySelector('svg').append(ghost); hear(n, vNew);
          const mv = (e) => { const b = toBeat(e.clientX); if (b > a + g * 0.5) { z = Math.max(a + g, snap(b, e.altKey)); ghost.setAttribute('width', Math.max(3, (z - a) * 24 - 1).toFixed(1)); } };
          const up = () => {
            roll.removeEventListener('pointermove', mv); dragging = false;
            // the second click of a double-click lands before the roll redraws: don't place the same note twice
            if (performance.now() - lastAdd.t < 450 && lastAdd.n === n && Math.abs(lastAdd.a - a) < 1e-6) { ghost.remove(); return; }
            lastAdd = { t: performance.now(), n, a }; save([...notes, { n, a, z, v: vNew }], 'add');
          };
          roll.addEventListener('pointermove', mv); roll.addEventListener('pointerup', up, { once: true }); roll.addEventListener('pointercancel', () => { roll.removeEventListener('pointermove', mv); dragging = false; ghost.remove(); }, { once: true });
          return;
        }
        const i = +el.dataset.i, n0 = notes[i], r = el.getBoundingClientRect(), edge = ev.clientX > r.right - 6 && r.width > 8;
        const b0 = toBeat(ev.clientX), r0 = rowOf(n0.n); let cur = { ...n0 }, moved = false, heard = n0.n;
        const mv = (e) => {
          const db = toBeat(e.clientX) - b0, dr = toRow(e.clientY) - r0;
          if (Math.abs(db) * (roll.getBoundingClientRect().width / beats) > 3 || dr) moved = true; if (!moved) return;
          if (edge) cur = { ...n0, z: Math.max(n0.a + Math.max(g, 0.05), snap(n0.z + db, e.altKey)) };
          else { const a = snap(n0.a + db, e.altKey), len = n0.z - n0.a; cur = { ...n0, a, z: a + len, n: noteOfRow(Math.max(0, Math.min(nRows - 1, r0 + dr))) }; }
          if (cur.n !== heard) { heard = cur.n; hear(cur.n, cur.v); }
          el.setAttribute('x', (cur.a * 24).toFixed(1)); el.setAttribute('width', Math.max(3, (cur.z - cur.a) * 24 - 1).toFixed(1)); el.setAttribute('y', rowOf(cur.n) * rh + 0.5);
        };
        const up = () => { roll.removeEventListener('pointermove', mv); dragging = false; if (moved) { const list = notes.map((q, k) => (k === i ? cur : q)); save(list, edge ? 'length' : 'move'); } };
        roll.addEventListener('pointermove', mv); roll.addEventListener('pointerup', up, { once: true }); roll.addEventListener('pointercancel', up, { once: true });
      });
      const del = (ev) => {
        const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.lvnote:not(.ghost)');   // the press captured the pointer, so not ev.target
        if (!el) return false;
        const q = notes[+el.dataset.i]; if (!q) return false;
        if (performance.now() - lastAdd.t < 450 && q.n === lastAdd.n && Math.abs(q.a - lastAdd.a) < 1e-6) return false;   // the second click of the double-click that placed it
        save(notes.filter((_, k) => k !== +el.dataset.i), 'delete'); return true;
      };
      roll.addEventListener('dblclick', del);
      roll.addEventListener('contextmenu', (ev) => { if (document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.lvnote')) { ev.preventDefault(); del(ev); } });
    }
    const barsRow = h('div', { class: 'lvbars' }, ...Array.from({ length: s.bars }, (_, b) => h('span', { onclick: () => { if (canEdit && step.on) { step.b = b * meter; render(); } } }, h('i', {}, String(b + 1)), s.chords[b] ? h('b', {}, s.chords[b]) : null)));
    const stats = !notes.length ? [take ? 'no notes in this take' : 'an empty roll: nothing written here yet'] : [`${notes.length} note${notes.length === 1 ? '' : 's'}`, p.drums ? `${new Set(notes.map((n) => n.n)).size} voice${new Set(notes.map((n) => n.n)).size === 1 ? '' : 's'}` : `${name(Math.min(...notes.map((n) => n.n)))}–${name(Math.max(...notes.map((n) => n.n)))}`, `velocity ${Math.min(...vels)}–${Math.max(...vels)} (avg ${vNew})`, `${+(notes.length / s.bars).toFixed(1)} per bar`,
      p.drums ? null : `uses ${pcs.map((c) => NOTE_NAMES[c]).join(' ')}`, take?.byName ? `${take.byName}'s ${take.written ? 'part' : 'take'}` : null].filter(Boolean);
    const octave = (d) => { shift.set(laneOf(p), sh + d); render(); };
    // quantize after the fact: pull each note's start toward the grid, by a strength
    const tools = !canEdit ? null : h('div', { class: 'row lvtools' },
      h('span', { class: 'help' }, 'Grid'), h('select', { class: 'lcdsel', 'aria-label': 'Grid', onchange: (e) => { snapI = +e.target.value; render(); } }, ...SNAP.map((q, k) => h('option', { value: k, selected: k === snapI }, q.name))),
      h('select', { class: 'lcdsel', 'aria-label': 'Strength', disabled: !notes.length, onchange: (e) => { qStrength = +e.target.value; } }, ...[[1, '100%'], [0.75, '75%'], [0.5, '50%'], [0.25, '25%']].map(([v, t]) => h('option', { value: v, selected: v === qStrength }, `${t} pull`))),
      h('button', { class: 'btn small', disabled: !notes.length, title: 'Pull every note start toward the grid', onclick: () => save(notes.map((n) => { const a = n.a + (Math.round(n.a / g) * g - n.a) * qStrength; return { ...n, a, z: n.z + (a - n.a) }; }), 'quantize') }, 'Quantize'),
      p.drums ? null : h('span', { class: 'octs' }, h('button', { class: 'btn small ghost', 'aria-label': 'Show lower notes', title: 'Scroll the roll down an octave', onclick: () => octave(-12) }, '▼'), h('button', { class: 'btn small ghost', 'aria-label': 'Show higher notes', title: 'Scroll the roll up an octave', onclick: () => octave(12) }, '▲')),
      h('button', { class: 'btn small ghost', disabled: !hist.back.length, title: 'Undo your last change (⌘Z or Ctrl+Z)', onclick: undo }, '↶ Undo'),
      h('button', { class: 'btn small ghost', disabled: !hist.fwd.length, title: 'Redo it (⇧⌘Z or Ctrl+Shift+Z)', onclick: redo }, '↷ Redo'),
      h('button', { class: 'btn small ghost danger', disabled: !notes.length, title: 'Delete every note here (Undo brings them back)', onclick: () => { save([], 'clear'); render(); } }, 'Clear notes'),
      h('button', { class: 'btn small' + (step.on ? ' on' : ''), 'aria-pressed': String(step.on), title: 'Enter notes from your MIDI keyboard or computer keys, one step at a time', onclick: () => { step.on = !step.on; render(); } }, '🎹 Step entry'),
      h('span', { class: 'help', title: 'Drag a note to move it, its right end to resize it; hold Alt to place off the grid' }, 'click to add a note (drag for longer) · drag to move · double-click to delete'),
      take?.edit && take.of && SONG_TAKE(p, take.of) ? h('button', { class: 'btn small ghost', onclick: () => x.choose(s.id, p.id, take.of) }, 'Back to the original') : null);
    const nudge = (d) => { step.b = Math.max(0, Math.min(beats, step.b + d)); render(); };
    const stepBar = !canEdit || !step.on ? null : h('div', { class: 'row lvtools stepbar' },
      h('span', { class: 'help' }, 'Length'), h('select', { class: 'lcdsel', 'aria-label': 'Step length', onchange: (e) => { step.len = +e.target.value; e.target.blur(); render(); } }, ...LENGTHS.map(([t, v]) => h('option', { value: v, selected: v === step.len }, t))),
      h('button', { class: 'btn small ghost', title: 'Move the cursor back a step', onclick: () => nudge(-step.len) }, '◀ Back'),
      h('button', { class: 'btn small ghost', title: 'Leave a rest: move the cursor on a step', onclick: () => nudge(step.len) }, 'Rest ▶'),
      x.midiOn?.() ? null : h('button', { class: 'btn small hot', onclick: async () => { await x.enableMidi(); render(); } }, 'Enable MIDI'),
      h('span', { class: 'help' }, step.b >= beats ? 'end of the section: click a bar number to go back' : `${pos(step.b)}: play a note or chord · click a bar number to jump`));
    return h('div', { class: 'laneview' }, head(h('span', { class: 'help' }, stats.join(' · '))), tools, stepBar, h('div', { class: 'lvbody' }, h('div', { class: 'lvgut' }), barsRow, labels, roll));
  }
  // a note played anywhere: true when step entry took it, so it doesn't go to your desk. A note that started on the
  // desk still ends there, whatever has opened since.
  function takeNote(on, n, v, ch, port) {
    const id = `${port}:${ch}:${n}`;
    if (!on) { if (!held.delete(id)) return false; if (!held.size) stepCommit(); return true; }
    if (!step.on || !stepAt || $('#compose')?.offsetParent === null) return false;
    held.add(id); if (!chord.some((q) => q.n === n)) chord.push({ n, v });
    x.previewNote?.(stepAt.p, n, v);
    return true;
  }
  function stepCommit() {
    const c = chord, T = stepAt; chord = [];
    if (!T || !c.length || step.b >= T.beats) return;
    const a = step.b, z = Math.min(T.beats, a + step.len), ns = new Set(c.map((q) => q.n));
    // what's already on these pitches gives way: a note can't overlap itself
    const list = T.notes.flatMap((q) => (!ns.has(q.n) || q.z <= a || q.a >= z ? [q] : q.a < a ? [{ ...q, z: a }] : []));
    for (const q of c) list.push({ n: q.n, a, z: T.p.drums ? Math.min(z, a + 0.25) : z, v: q.v });
    T.save(list, 'step'); step.b = z; render();
  }
  // open an empty roll in a section for a lane (spec.lane) or one of your instruments (spec.r)
  function writeFor(sid, spec) {
    sel = sid;
    const d = x.draftPart?.(spec); if (!d) { cell = null; render(); return; }
    const here = x.store.song.sections[sid]?.parts?.[d.id];
    cell = { sid, pid: d.id, lane: laneOf(d), draft: here ? null : d }; render();
  }
  // under the chart when no lane is open: write a part, for a lane already in the song or an instrument on your desk
  function writeRow(s, c) {
    if (!x.editTake || !x.draftPart) return null;
    const L = lanes().filter((l) => l.sample.kind !== 'audio'), known = new Set(L.map((l) => l.lane)), desk = (x.desk?.() || []).filter((d) => !known.has(d.lane));
    if (!L.length && !desk.length) return h('div', { class: 'row writerow' }, h('span', { class: 'help' }, 'Put an instrument on your desk to write a part for it here.'));
    const pick = h('select', { class: 'lcdsel', 'aria-label': 'Write a part for', onchange: (e) => { const v = e.target.value; if (!v) return; writeFor(s.id, v.startsWith('r:') ? { r: +v.slice(2) } : { lane: v }); } },
      h('option', { value: '' }, '✎ Write a part for…'),
      L.length ? h('optgroup', { label: 'Lanes in the song' }, ...L.map((l) => h('option', { value: l.lane }, l.lane + (s.parts && Object.values(s.parts).some((q) => laneOf(q) === l.lane) ? ' (has a take here)' : '')))) : null,
      desk.length ? h('optgroup', { label: 'A new lane, from your desk' }, ...desk.map((d) => h('option', { value: 'r:' + d.r }, d.name))) : null);
    return h('div', { class: 'row writerow' }, pick, h('span', { class: 'help' }, 'or click an empty block in a lane: notes you write here go to everyone with the song, whole, before they play'));
  }
  // the lane's instrument and patch: pick another and the notes stay, played on it, in every section
  function soundPick(ln) {
    if (ln.sample.kind === 'audio' || !x.laneSounds) return null;
    const groups = x.laneSounds(ln.drums), cur = `${ln.inst}|${ln.sample.patch}`, known = groups.some((d) => d.patches.some(([t]) => `${d.id}|${t}` === cur));
    return h('select', { class: 'role sound', 'aria-label': `${ln.lane}'s instrument`, title: 'Change the instrument: the notes stay', onchange: (e) => {
      const [inst, patch] = e.target.value.split('|'), next = x.setLaneSound(ln.lane, inst, patch);
      if (cell?.lane === ln.lane) cell = { ...cell, lane: next };
      render();
    } }, known ? null : h('option', { value: cur, selected: true }, ln.sample.name || ln.inst),
      ...groups.map((d) => h('optgroup', { label: d.name }, ...d.patches.map(([t, name]) => h('option', { value: `${d.id}|${t}`, selected: `${d.id}|${t}` === cur }, `${d.name} · ${name}`)))));
  }
  function SONG_TAKE(p, id) { return takesOf(p).find((t) => t.id === id); }
  function drumName(n) {
    return { 35: 'Kick', 36: 'Kick', 37: 'Rim', 38: 'Snare', 40: 'Snare', 39: 'Clap', 42: 'Hat', 44: 'Pedal hat', 46: 'Open hat', 41: 'Low tom', 43: 'Low tom', 45: 'Mid tom', 47: 'Mid tom', 48: 'High tom', 50: 'High tom', 49: 'Crash', 57: 'Crash', 51: 'Ride', 59: 'Ride', 53: 'Bell', 54: 'Tamb', 56: 'Cowbell', 70: 'Shaker', 75: 'Clave' }[n] || `Perc ${n}`;
  }
  function render() {
    const box = $('#compose'); if (!box || dragging) return;
    stepAt = null;
    const song = x.store.song, order = song.order.filter((id) => song.sections[id]), tl = x.store.timeline(), tr = x.transport(), meter = song.meter || 4;
    const L = lanes(), work = x.working();
    if (!sel || !song.sections[sel]) sel = order[0] || null;
    const totalBars = order.reduce((a, id) => a + song.sections[id].bars, 0), mins = (totalBars * meter) / x.bpm();
    const file = h('input', { type: 'file', accept: '.mid,.midi,.json,audio/midi,application/json', style: 'display:none', onchange: (e) => { const f = e.target.files[0]; if (f) x.importFile(f); e.target.value = ''; } });
    const vars = Object.values(song.variations || {});
    const playing = tr?.on && tr.mode === 'song', empty = !order.length || !L.length;
    const importBtn = (cls) => h('button', { class: cls, onclick: () => file.click(), title: "Bring in a sketch: a MIDI file, or a song from SynthLand's Tracker (.json)" }, 'Import a sketch…');
    // a form, changes and a basic band to start from, by genre
    const presetPick = (cls) => h('select', { class: 'lcdsel ' + cls, 'aria-label': 'Song presets', title: 'Start from a song: a form, chord changes, drums, bass and chords', onchange: (e) => {
      const [g, i] = e.target.value.split(':'); e.target.value = ''; if (!g) return;
      if (L.length && !confirm('Replace this song with the preset, for everyone in the room?')) return;
      x.loadPreset(+g, +i);
    } }, h('option', { value: '' }, '♪ Song presets…'), ...(x.presets?.() || []).map((q, gi) => h('optgroup', { label: q.name }, ...q.songs.map((t, si) => h('option', { value: `${gi}:${si}` }, `${q.name}: ${t}`)))));
    const head = h('div', { class: 'songhead' },
      h('input', { class: 'songtitle', value: song.title, maxlength: 60, 'aria-label': 'Song title', onkeydown: (e) => e.stopPropagation(), onchange: (e) => x.setSong('title', e.target.value.trim() || 'Untitled') }),
      order.length ? h('button', { class: 'btn playsong' + (playing ? ' on' : ' hot'), onclick: () => (playing ? x.stop() : x.play('song')) }, playing ? '■ Stop' : '▶ Play the song') : null,
      empty ? importBtn('btn') : null, empty ? presetPick('presets') : null,
      h('span', { class: 'help mono songstats' }, `${order.length} sections · ${totalBars} bars · ${Math.floor(mins)}:${String(Math.round((mins % 1) * 60)).padStart(2, '0')}`),
      h('span', { style: 'flex:1' }),
      h('span', { class: 'presence' }, ...x.playersOf().map((p) => h('span', { class: 'who' + (p.where === 'compose' ? ' here' : ''), title: `${p.name}: ${p.where === 'compose' ? 'in the Compose Room' : 'in the Jam Room'}` }, p.name.slice(0, 1).toUpperCase()))),
      h('button', { class: 'btn small ghost moretoggle', 'aria-expanded': String(songMore), onclick: () => { songMore = !songMore; remember('songMore', songMore); render(); } }, songMore ? '▾ Song options' : '▸ Song options'), file);
    const opts = !songMore ? null : h('div', { class: 'songopts' },
      h('label', { class: 'help', title: 'What happens when someone locks in a new take of a lane' }, 'New takes ',
        h('select', { class: 'lcdsel', onchange: (e) => x.setSong('rule', e.target.value) }, ...[['newest', 'take over'], ['owner', 'wait for the owner'], ['vote', 'go to a vote']].map(([v, t]) => h('option', { value: v, selected: (song.rule || 'newest') === v }, t)))),
      h('select', { class: 'lcdsel', 'aria-label': 'Versions', onchange: (e) => { const v = e.target.value; e.target.value = ''; if (v === '__save') { const n = prompt('Name this version of the song', `Version ${vars.length + 1}`); if (n) x.saveVariation(n.slice(0, 40)); } else if (v) x.restoreVariation(v); } },
        h('option', { value: '' }, vars.length ? `Versions (${vars.length})` : 'Versions'), h('option', { value: '__save' }, 'Save this version…'), ...vars.map((v) => h('option', { value: v.name }, `Go to “${v.name}”`))),
      empty ? null : importBtn('btn small'), empty ? null : presetPick('presets'), h('button', { class: 'btn small', onclick: () => x.exportMidi() }, 'Save MIDI'), h('button', { class: 'btn small', onclick: () => x.exportJson() }, 'Save song'),
      h('span', { class: 'help mono' }, `${x.bpm()} bpm · ${x.keyName()}`),
      h('span', { class: 'zoom' }, h('small', { class: 'help' }, 'zoom'), h('button', { class: 'btn small ghost', 'aria-label': 'Zoom out', onclick: () => { PX = Math.max(8, PX - 4); render(); } }, '−'), h('button', { class: 'btn small ghost', 'aria-label': 'Zoom in', onclick: () => { PX = Math.min(48, PX + 4); render(); } }, '+')));
    // the arrangement: sections left to right along the top, one row per lane, a block per take that sounds there
    const loopId = tr && tr.on ? (tr.mode === 'loop' ? tr.sid : tr.mode === 'range' ? work[0]?.sid || null : null) : null;
    const busy = new Map();   // lane -> the jammer playing it in the looping section right now
    if (loopId) for (const w of work) if (w.where === 'jam' && w.active) for (const name of w.parts) busy.set(`${w.who} · ${name}`, w);
    const cols = order.map((id, i) => ({ id, i, s: song.sections[id], label: (song.labels || [])[i] || '', w: Math.max(70, song.sections[id].bars * PX) }));
    const toggle = () => { open = !open; try { localStorage.setItem('megajam.lanes', open ? '1' : '0'); } catch (_) {} render(); };
    const ruler = h('div', { class: 'arow ruler' }, h('div', { class: 'lhead' }, h('button', { class: 'lanetoggle', 'aria-expanded': String(open), title: open ? 'Fold the lanes into one row' : 'Show a row per lane, with its takes', onclick: toggle }, open ? '▾ ' : '▸ ', h('b', {}, `${L.length} lane${L.length === 1 ? '' : 's'}`)), null),
      ...cols.map((c) => {
        const t0 = tl[c.i], live = tr && tr.on && (tr.mode === 'song' ? true : tr.mode === 'range' ? t0 && t0.start < tr.b && t0.start + t0.beats > tr.a : tr.sid === c.id);
        const here = c.id === loopId ? [...new Set(busy.values())] : [];
        const hd = h('div', { class: 'shead' + (sel === c.id ? ' sel' : '') + (live && tr.mode !== 'song' ? ' live' : ''), role: 'button', tabindex: 0, 'aria-label': `${c.s.name}, ${c.s.bars} bars: drag to move it`, style: `width:${c.w}px;--sc:${colorOfSection(c.s.name)}`, 'data-col': c.i, 'data-sec': c.id,
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sel = c.id; cell = null; render(); } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); const to = c.i + (e.key === 'ArrowLeft' ? -1 : 1); if (to >= 0 && to < cols.length) reorder(c.i, to); } } },
          h('button', { class: 'secx', title: `Remove ${c.s.name}`, 'aria-label': `Remove ${c.s.name}`, onpointerdown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); removeAt(c.i); } }, '×'),
          h('b', {}, c.s.name), c.label ? h('small', { class: 'rm' }, c.label) : null, h('small', {}, `${c.s.bars} bars`),
          h('span', { class: 'ticks' }, ...Array.from({ length: c.s.bars }, (_, b) => h('i', { class: (b % 4 === 0 ? 'bar4' : '') + (c.s.chords[b] ? ' ch' : ''), title: c.s.chords[b] || '' }))),
          here.length ? h('span', { class: 'herein' }, ...here.map((w) => h('i', { style: `--c:${w.color}`, title: `${w.who} is jamming here` }, w.who.slice(0, 1)))) : null);
        // press to pick it; drag sideways to move it in the song
        hd.addEventListener('pointerdown', (ev) => {
          if (ev.button) return;
          const x0p = ev.clientX; let moving = false, to = c.i;
          try { hd.setPointerCapture(ev.pointerId); } catch (_) {}
          const heads = () => [...document.querySelectorAll('#compose .shead')];
          const mv = (e) => {
            if (!moving && Math.abs(e.clientX - x0p) < 6) return;
            if (!moving) { moving = true; dragging = true; hd.classList.add('dragging'); }
            hd.style.transform = `translateX(${e.clientX - x0p}px)`;
            to = c.i; const hs = heads();
            for (let k = 0; k < hs.length; k++) { if (k === c.i) continue; const r = hs[k].getBoundingClientRect(), mid = r.left + r.width / 2; if (k > c.i && e.clientX > mid) to = k; if (k < c.i && e.clientX < mid && to === c.i) to = k; }
            hs.forEach((el, k) => { el.classList.toggle('dropbefore', to < c.i && k === to); el.classList.toggle('dropafter', to > c.i && k === to); });
          };
          const up = () => {
            hd.removeEventListener('pointermove', mv);
            if (!moving) { sel = c.id; cell = null; render(); return; }
            dragging = false; if (to !== c.i) reorder(c.i, to); else render();
          };
          hd.addEventListener('pointermove', mv); hd.addEventListener('pointerup', up, { once: true }); hd.addEventListener('pointercancel', () => { hd.removeEventListener('pointermove', mv); dragging = false; render(); }, { once: true });
        });
        return hd;
      }));
    const rows = !open ? [] : L.map((ln, li) => h('div', { class: 'arow' },
      h('div', { class: 'lhead pick' + (cell && cell.lane === ln.lane ? ' sel' : ''), style: `--lc:${laneColor(li)}`, title: `Show ${ln.lane}'s notes below`, onclick: (e) => { if (e.target.closest('select')) return; pickLane(ln.lane); } }, x.iconEl(ln.sample), h('span', {}, h('b', {}, ln.lane), h('select', { class: 'role', 'aria-label': `${ln.lane}'s role`, onchange: (e) => { const s0 = x.store.sections().find((s) => Object.values(s.parts || {}).some((p) => laneOf(p) === ln.lane)); const p = Object.values(s0.parts).find((q) => laneOf(q) === ln.lane); x.setRole(s0.id, p.id, e.target.value); } }, ...ROLES.map((r) => h('option', { value: r, selected: (ln.role || '') === r }, r))), soundPick(ln))),
      ...cols.map((c) => {
        const p = Object.values(c.s.parts || {}).find((q) => laneOf(q) === ln.lane);
        const wk = c.id === loopId ? busy.get(ln.lane) : null;
        if (!p) return wk ? h('div', { class: 'cell working', style: `width:${c.w}px;--lc:${wk.color}`, title: `${wk.who} is playing this now; nothing locked yet` }, h('span', {}, '● being played · not locked'))
          : h('div', { class: 'cell empty', style: `width:${c.w}px`, title: `Nothing here yet: write ${ln.lane}'s notes on an empty roll, or jam it and lock a take in`, onclick: () => writeFor(c.id, { lane: ln.lane }) }, h('span', {}, '+ write or jam'));
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
    // folded: one row, a block per section with a thin stripe for each locked lane
    const summary = open ? [] : [h('div', { class: 'arow sumrow' }, h('div', { class: 'lhead', style: '--lc:#555' }, h('span', {}, h('b', {}, 'Locked'), h('small', {}, L.length ? '' : 'nothing yet'))),
      ...cols.map((c) => {
        const parts = Object.values(c.s.parts || {}), wk = c.id === loopId ? [...new Set(busy.values())] : [];
        const fresh = wk.filter((w) => !parts.some((p) => w.parts.some((n) => laneOf(p) === `${w.who} · ${n}`)));
        if (!parts.length) return h('div', { class: 'cell ' + (wk.length ? 'working' : 'empty'), style: `width:${c.w}px;--lc:${wk[0]?.color || '#888'}`, title: wk.length ? `${wk.map((w) => w.who).join(' and ')} playing; nothing locked yet` : 'Nothing locked here yet', onclick: () => { sel = c.id; cell = null; render(); } }, h('span', {}, wk.length ? `● ${wk.map((w) => w.who).join(', ')} · not locked` : '+ jam it'));
        const blk = h('div', { class: 'cell sum' + (wk.length ? ' retake' : ''), style: `width:${c.w}px;--lc:${wk[0]?.color || '#ECEBE5'}`, title: `${parts.length} lane${parts.length > 1 ? 's' : ''} locked in ${c.s.name}`, onclick: () => { sel = c.id; cell = null; render(); } },
          h('span', { class: 'stripes' }, ...L.map((ln, li) => { const p = parts.find((q) => laneOf(q) === ln.lane); return h('i', { class: p ? (p.muted ? 'mu' : 'on') : '', style: `--lc:${laneColor(li)}`, title: p ? `${ln.lane}${p.muted ? ' (muted)' : ''}` : '' }); })),
          h('span', { class: 'lock' }, `🔒 ${parts.length}`), fresh.length ? h('span', { class: 'retaking', style: `--c:${fresh[0].color}` }, `${fresh.map((w) => w.who).join(', ')} trying something`) : null);
        return blk;
      }))];
    // the loop: drag across the strip to draw one, drag an end to crop it, drag the middle to move it
    const tlx = x.store.timeline(), x0 = []; { let acc = 0; for (const c of cols) { x0.push(acc); acc += c.w + 2; } }
    const beatToX = (bt) => { for (let i = 0; i < cols.length; i++) { const t = tlx[i]; if (bt <= t.start + t.beats + 1e-6) return x0[i] + Math.max(0, Math.min(1, (bt - t.start) / t.beats)) * cols[i].w; } return x0.length ? x0[x0.length - 1] + cols[cols.length - 1].w : 0; };
    const xToBeat = (px) => { for (let i = 0; i < cols.length; i++) { if (px < x0[i] + cols[i].w + 1 || i === cols.length - 1) { const t = tlx[i]; return Math.round((t.start + Math.max(0, Math.min(1, (px - x0[i]) / cols[i].w)) * t.beats) / meter) * meter; } } return 0; };
    const loopNow = tr && tr.on ? (tr.mode === 'range' ? [tr.a, tr.b] : tr.mode === 'loop' ? (() => { const t = tlx.find((q) => q.id === tr.sid); return t ? [t.start, t.start + t.beats] : null; })() : null) : null;
    const region = loopNow || draft;
    const band = h('div', { class: 'band' + (loopNow ? ' live' : ' draft') + (region ? '' : ' hide') }, h('span', { class: 'lh a', 'data-h': 'a', title: 'Drag to move the start' }), h('span', { class: 'lh b', 'data-h': 'b', title: 'Drag to move the end' }));
    const place = (r) => { if (!r) { band.classList.add('hide'); return; } band.classList.remove('hide'); const l = beatToX(r[0]), rr = beatToX(r[1]); band.style.left = `${l}px`; band.style.width = `${Math.max(6, rr - l)}px`; band.title = `Loop: bar ${r[0] / meter + 1} to ${r[1] / meter} (${(r[1] - r[0]) / meter} bars)`; };
    place(region);
    const track = h('div', { class: 'looptrack', style: `width:${x0.length ? x0[x0.length - 1] + cols[cols.length - 1].w : 0}px`, title: 'Drag across to set a loop' }, band);
    track.addEventListener('pointerdown', (ev) => {
      if (!cols.length) return;
      const rect = track.getBoundingClientRect(), px = (e) => e.clientX - rect.left, startX = px(ev), r0 = region ? [...region] : null;
      const which = ev.target.dataset?.h || (ev.target === band ? 'move' : 'new'), anchor = xToBeat(startX);
      let cur = r0, moved = false;
      dragging = true; track.setPointerCapture(ev.pointerId); ev.preventDefault();
      const move = (e) => {
        if (Math.abs(px(e) - startX) > 3) moved = true; if (!moved) return;
        const bt = xToBeat(px(e)), total = tlx.length ? tlx[tlx.length - 1].start + tlx[tlx.length - 1].beats : 0;
        if (which === 'a' && r0) cur = [Math.min(bt, r0[1] - meter), r0[1]];
        else if (which === 'b' && r0) cur = [r0[0], Math.max(bt, r0[0] + meter)];
        else if (which === 'move' && r0) { const d = bt - xToBeat(startX), len = r0[1] - r0[0], a = Math.max(0, Math.min(total - len, r0[0] + d)); cur = [a, a + len]; }
        else cur = [Math.min(anchor, bt), Math.max(anchor, bt) === Math.min(anchor, bt) ? Math.min(anchor, bt) + meter : Math.max(anchor, bt)];
        place(cur);
      };
      const up = () => {
        track.removeEventListener('pointermove', move); dragging = false;
        if (moved && cur) { draft = cur; x.loopRange(cur[0], cur[1]); } else render();
      };
      track.addEventListener('pointermove', move); track.addEventListener('pointerup', up, { once: true }); track.addEventListener('pointercancel', up, { once: true });
    });
    const looprow = h('div', { class: 'arow looprow' }, h('div', { class: 'lhead' },
      loopNow ? h('button', { class: 'btn small on loopbtn', onclick: () => x.stop() }, '■ Stop loop') : region ? h('button', { class: 'btn small hot loopbtn', onclick: () => x.loopRange(region[0], region[1]) }, '↻ Loop') : h('small', {}, 'Drag across to loop ⟶')), track);
    const grid = h('div', { class: 'arranger' + (open ? '' : ' folded') }, looprow, ruler, ...summary, ...rows, ...(open ? ghosts : []), h('div', { class: 'playhead hide', 'data-playhead': '' }),
      h('div', { class: 'arow' }, h('div', { class: 'lhead addl' }, L.length ? null : h('small', {}, 'Jam a section and Lock it in to fill this up.')),
        h('div', { class: 'addsec' }, h('select', { class: 'lcdsel addsel', 'aria-label': 'Add a section', onchange: (e) => { if (e.target.value) addSection(e.target.value); e.target.value = ''; } }, h('option', { value: '' }, '+ Add a section'), ...SECTION_NAMES.map((nm) => h('option', { value: nm }, nm))))));
    const panes = 'arranger', was = [...box.querySelectorAll(`.${panes},.details .pane`)].map((e) => [e.scrollLeft, e.scrollTop]);
    const det = details(sel, cell);
    box.replaceChildren(...[head, opts, grid, divider(det), det].filter(Boolean));
    [...box.querySelectorAll(`.${panes},.details .pane`)].forEach((e, i) => { if (was[i]) [e.scrollLeft, e.scrollTop] = was[i]; });   // a redraw doesn't lose your place
    if (editing) $(`[data-cell="${editing}"]`)?.focus();
  }
  // drag a handle along one axis: move(px moved) while it's held, done() at the end
  function grip(el, axis, move, done) {
    el.addEventListener('pointerdown', (ev) => {
      if (ev.button) return;
      ev.preventDefault(); el.setPointerCapture(ev.pointerId); dragging = true;
      const from = ev[axis], mv = (e) => move(e[axis] - from);
      const up = () => { el.removeEventListener('pointermove', mv); dragging = false; done(); render(); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up, { once: true }); el.addEventListener('pointercancel', up, { once: true });
    });
  }
  const applyH = (det) => { const px = detH && clampH(detH); det.style.height = px ? `${px}px` : ''; det.style.maxHeight = px ? 'none' : ''; };
  // the handle between the arrangement and what's below it
  function divider(det) {
    applyH(det);
    const el = h('div', { class: 'hsplit', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize the part view', tabindex: 0, title: 'Drag to resize',
      onkeydown: (e) => { if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return; e.preventDefault(); e.stopPropagation(); detH = clampH((detH || det.offsetHeight) + (e.key === 'ArrowUp' ? 30 : -30)); keep('detH', detH); render(); $('.hsplit')?.focus(); } });
    let h0 = 0;
    el.addEventListener('pointerdown', () => { h0 = det.offsetHeight; }, true);
    grip(el, 'clientY', (d) => { detH = clampH(h0 - d); applyH(det); }, () => keep('detH', detH));
    return el;
  }
  const clampH = (px) => Math.max(120, Math.min(($('#compose')?.clientHeight || 600) - 165, px));
  // the handle between the section pane and the take pane
  function paneSplit(det) {
    const el = h('div', { class: 'vsplit', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the panes', tabindex: 0, title: 'Drag to resize',
      onkeydown: (e) => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); e.stopPropagation(); split = clampS(split + (e.key === 'ArrowLeft' ? -0.04 : 0.04)); keep('split', split); render(); $('.vsplit')?.focus(); } });
    let s0 = 0, w = 1;
    el.addEventListener('pointerdown', () => { s0 = split; w = el.parentElement.clientWidth || 1; }, true);
    grip(el, 'clientX', (d) => { split = clampS(s0 + d / w); paint(el.parentElement); }, () => keep('split', split));
    return el;
  }
  const clampS = (f) => Math.max(0.25, Math.min(0.88, f));
  const paint = (det) => { det.style.setProperty('--fl', `${split}fr`); det.style.setProperty('--fr', `${1 - split}fr`); };
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
    // the lane open under the chart: a part that's here, or a part about to be written (its first note makes it)
    const lp = c && (s.parts?.[c.pid] || (c.draft && c.sid === s.id ? c.draft : null));
    const secPane = h('div', { class: 'pane', style: `--sc:${colorOfSection(s.name)}` },
      h('div', { class: 'row' }, nameSel,
        h('span', { class: 'bars' }, h('button', { class: 'btn small ghost', 'aria-label': 'Fewer bars', onclick: () => { const b = Math.max(1, s.bars - (s.bars > 4 ? 4 : 1)); save({ bars: b, chords: s.chords.slice(0, b) }); } }, '−'), h('b', {}, `${s.bars} bars`), h('button', { class: 'btn small ghost', 'aria-label': 'More bars', onclick: () => { const b = Math.min(64, s.bars + (s.bars >= 4 ? 4 : 1)); save({ bars: b, chords: [...s.chords, ...Array(Math.max(0, b - s.chords.length)).fill('')] }); } }, '+')),
        (song.labels || [])[i] ? h('i', { class: 'help' }, song.labels[i]) : null,
        h('span', { style: 'flex:1' }),
        h('button', { class: 'btn small' + (live ? ' on' : ''), onclick: () => (live ? x.stop() : x.play('loop', s.id)) }, live ? '■ Stop' : '↻ Loop it'),
        h('button', { class: 'btn hot', onclick: () => x.jamThis(s.id) }, 'Jam this section'),
        h('button', { class: 'btn small ghost danger', title: `Remove ${s.name} from the song`, onclick: () => removeAt(i) }, 'Remove')),
      chart,
      lp ? laneView(s, lp, laneColor(Math.max(0, lanes().findIndex((l) => l.lane === laneOf(lp))))) : writeRow(s, c),
      h('button', { class: 'linkbtn', 'aria-expanded': String(secMore), onclick: () => { secMore = !secMore; remember('secMore', secMore); render(); } }, secMore ? '▾ Less' : '▸ More: fill chords from the key, notes, road map, arrange'),
      secMore ? h('div', { class: 'secmore' },
        h('div', { class: 'row' }, prog, label),
        h('textarea', { class: 'secnotes', rows: 2, placeholder: 'Ideas: feel, who plays what, lyrics…', onkeydown: (e) => e.stopPropagation(), onchange: (e) => save({ notes: e.target.value.slice(0, 2000) }) }, s.notes || ''),
        h('div', { class: 'row' }, h('span', { class: 'help' }, `Section ${i + 1} of ${song.order.length}`),
          h('button', { class: 'btn small ghost', disabled: i <= 0, onclick: () => move(i, -1) }, '← Earlier'), h('button', { class: 'btn small ghost', disabled: i >= song.order.length - 1, onclick: () => move(i, 1) }, 'Later →'),
          h('button', { class: 'btn small ghost', onclick: () => { const o = [...song.order]; o.splice(i + 1, 0, s.id); x.setSong('order', o); } }, 'Repeat it'),
          h('span', { class: 'help' }, 'Tip: drag a section by its name to move it.'))) : (s.notes ? h('p', { class: 'help secnote1' }, s.notes.slice(0, 140)) : null));
    let takePane = null;   // only when a block is picked
    const p = c && s.parts?.[c.pid];
    if (p) {
      const cur = currentTake(p), rule = song.rule || 'newest', ts = takesOf(p);
      takePane = h('div', { class: 'pane takes' },
        h('div', { class: 'row' }, h('b', {}, `${laneOf(p)} in ${s.name}`), h('button', { class: 'gearx', style: 'position:static', 'aria-label': 'Close', onclick: () => { cell = null; render(); } }, '×'), h('span', { class: 'help' }, `${p.role || ''}${p.by && p.by !== 'import' ? ` · owner ${p.byName || ''}` : ''} · ${rule === 'vote' ? 'the band votes' : rule === 'owner' ? 'the owner picks' : 'newest take wins'}`), h('span', { style: 'flex:1' }),
          h('button', { class: 'btn small ghost', onclick: () => x.mutePart(s.id, p.id, !p.muted) }, p.muted ? 'Unmute lane here' : 'Mute here'), h('button', { class: 'btn small ghost', onclick: () => { x.removePart(s.id, p.id); cell = null; } }, 'Remove')),
        ...[...ts].reverse().map((t, k) => {
          const votes = (p.votes?.[t.id] || []).length, on = cur && cur.id === t.id;
          return h('div', { class: 'takerow' + (on ? ' on' : '') }, h('span', { class: 'tno' }, `take ${ts.length - k}`), h('span', {}, `${t.byName || 'someone'}${t.at ? ' · ' + new Date(t.at > 1e12 ? t.at : Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''} · ${t.audio ? `${(t.audio.frames / t.audio.sr).toFixed(1)} s of audio${x.audioReady?.(t.audio.id) ? '' : ' · on its way…'}` : `${t.events.filter((e) => e.type === 'on').length} notes`}`),
            rule === 'vote' ? h('span', { class: 'help' }, `${votes} vote${votes === 1 ? '' : 's'}`) : null, h('span', { style: 'flex:1' }),
            on ? h('b', { class: 'curtag' }, 'sounding') : h('button', { class: 'btn small', onclick: () => (rule === 'vote' ? x.vote(s.id, p.id, t.id) : x.choose(s.id, p.id, t.id)) }, rule === 'vote' ? 'Vote for it' : 'Use this take'));
        }));
    }
    else if (lp) takePane = h('div', { class: 'pane takes' },   // a part about to be written: the same layout it will have
      h('div', { class: 'row' }, h('b', {}, `${laneOf(lp)} in ${s.name}`), h('button', { class: 'gearx', style: 'position:static', 'aria-label': 'Close', onclick: () => { cell = null; render(); } }, '×')),
      h('p', { class: 'help' }, 'Nothing here yet. Your first note makes this part; it plays from the song for everyone, the whole part sent ahead of time.'));
    const det = h('div', { class: 'details' + (takePane ? ' lane' : ' one') }, secPane);
    if (takePane) { paint(det); det.append(paneSplit(det), takePane); }
    return det;
  }
  // move the section at position i to position j (the road-map labels move with it)
  function reorder(i, j) {
    const o = [...x.store.song.order], l = Array.from({ length: o.length }, (_, k) => (x.store.song.labels || [])[k] || '');
    const [v] = o.splice(i, 1), [lv] = l.splice(i, 1); o.splice(j, 0, v); l.splice(j, 0, lv);
    x.setSong('order', o); x.setSong('labels', l); sel = v;
  }
  function removeAt(i) {
    const song = x.store.song, id = song.order[i], s = song.sections[id]; if (!s) return;
    const n = Object.keys(s.parts || {}).length, again = song.order.filter((q) => q === id).length > 1;
    if (n && !again && !confirm(`Remove ${s.name} and the ${n} part${n > 1 ? 's' : ''} locked into it?`)) return;
    const o = [...song.order], l = Array.from({ length: o.length }, (_, k) => (song.labels || [])[k] || '');
    o.splice(i, 1); l.splice(i, 1); x.setSong('order', o); x.setSong('labels', l);
    if (!o.includes(id)) x.setSong('sec:' + id, null);
    if (sel === id) sel = null;
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
    for (const lv of document.querySelectorAll('[data-lvplay]')) { const on = !!pos && lv.dataset.lvplay === pos.sid; lv.classList.toggle('hide', !on); if (on) lv.style.left = `${Math.min(100, ((pos.bar + pos.beat / (x.store.song.meter || 4)) / x.store.song.sections[pos.sid].bars) * 100)}%`; }
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
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || !stepAt || $('#compose')?.offsetParent === null) return;
    if (/INPUT|TEXTAREA/.test(e.target?.tagName || '')) return;   // their own undo
    e.preventDefault(); if (e.shiftKey) stepAt.redo(); else stepAt.undo();
  });
  return { render, tick, addSection, takeNote };
}
