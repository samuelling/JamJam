// The bass line sequencer in Acid Line Lite: a 16-step pattern in the 303 tradition. Every step has a note
// (C to C, an octave switch), a gate (note, rest or tie), an accent and a slide. A slide holds the note into the
// next step and glides to its pitch without restarting the envelopes; a tie just holds it. Accented steps play
// hard (velocity 120), which the synth turns into its accent.
//
// It runs in lockstep like Machina's sequencer (src/seq.js): every browser holds the same pattern and plays it from
// the room's clock, so no notes travel, only edits, each stamped far enough ahead to reach every browser before
// any of them has scheduled the step it touches. Whether a note holds into the next step is decided at its own
// step time from the pattern as of then, which every browser sees the same, so all of them play the same notes.

export const BASE = 36;            // C2: step note 0, octave 0
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B', "C'"];   // C' is the C an octave up
const blank = () => ({ n: 0, o: 0, g: 0, a: 0, s: 0 });
const clampStep = (x) => ({ n: Math.max(0, Math.min(12, x.n | 0)), o: Math.max(-1, Math.min(1, x.o | 0)), g: Math.max(0, Math.min(2, x.g | 0)), a: x.a ? 1 : 0, s: x.s ? 1 : 0 });

// a pattern that sounds like the thing the moment you press play
export const DEFAULT_PATTERN = [
  [0, 0, 1, 1, 0], [0, 0, 1, 0, 0], [12, 0, 1, 0, 1], [0, 0, 1, 0, 0],
  [3, 0, 1, 1, 0], [0, 0, 0, 0, 0], [0, 0, 1, 0, 0], [10, 0, 1, 0, 1],
  [0, 1, 1, 1, 0], [0, 0, 1, 0, 0], [7, 0, 1, 0, 0], [0, 0, 2, 0, 0],
  [5, 0, 1, 1, 1], [3, 0, 1, 0, 0], [0, 0, 1, 0, 0], [12, -1, 1, 1, 0],
].map(([n, o, g, a, s]) => ({ n, o, g, a, s }));

// a random acid line: mostly the root, in a minor key, with rests, ties, accents and slides sprinkled in
export function randomPattern(rnd = Math.random) {
  const scale = [0, 0, 0, 3, 5, 7, 10, 12];
  return Array.from({ length: 16 }, (_, i) => {
    const r = rnd();
    const g = i === 0 ? 1 : r < 0.68 ? 1 : r < 0.86 ? 0 : 2;
    return { n: scale[Math.floor(rnd() * scale.length)], o: rnd() < 0.18 ? 1 : rnd() < 0.08 ? -1 : 0, g, a: g === 1 && rnd() < 0.3 ? 1 : 0, s: g === 1 && rnd() < 0.25 ? 1 : 0 };
  });
}

export class AcidSeq {
  constructor() {
    this.kind = 'acid';
    this.len = 16; this.tr = 0;
    this.steps = DEFAULT_PATTERN.map((x) => ({ ...x }));
    this.playing = false; this.startBeat = 0; this.stopBeat = Infinity;
    this.pending = []; this.next = null; this.pos = -1; this.posT = 0; this.rev = 0;
    this.sounding = null;          // the note still held from an earlier step (a slide or tie), or null
  }
  queue(at, op) { let i = this.pending.length; while (i > 0 && this.pending[i - 1].at > at) i--; this.pending.splice(i, 0, { at, op }); }
  applyUpTo(t) { while (this.pending.length && this.pending[0].at <= t) this.apply(this.pending.shift().op); }
  apply(op) {
    const [k, a, b, c] = op;
    if (k === 'st' && a >= 0 && a < 16 && b && typeof b === 'object') this.steps[a] = clampStep({ ...this.steps[a], ...b });
    else if (k === 'pat' && Array.isArray(a) && a.length === 16) { this.steps = a.map((x) => clampStep(x || blank())); if (b) this.len = Math.max(1, Math.min(16, b | 0)); }
    else if (k === 'len') this.len = Math.max(1, Math.min(16, a | 0));
    else if (k === 'tr') this.tr = Math.max(-12, Math.min(12, a | 0));
    else if (k === 'play') { this.playing = true; this.startBeat = a; this.stopBeat = Infinity; this.next = null; }
    else if (k === 'stop') this.stopBeat = a;
    void c;
    this.rev++;
  }
  noteOf(st) { return Math.max(0, Math.min(127, BASE + this.tr + st.n + 12 * st.o)); }

  // the note events due up to `horizon` (room ms): [{type: 'on'|'off', note, vel, at}]
  due(tempo, now, horizon) {
    const out = [];
    this.applyUpTo(now);
    if (!this.playing) return out;
    if (this.next == null) this.next = Math.max(0, Math.ceil((tempo.beatAt(now) - this.startBeat) * 4 - 1e-9));
    for (let guard = 0; guard < 64; guard++) {
      const beat = this.startBeat + this.next / 4, t = tempo.timeOf(beat);
      if (t > horizon) break;
      this.applyUpTo(t);
      if (beat >= this.stopBeat) {
        if (this.sounding != null) { out.push({ type: 'off', note: this.sounding, vel: 0, at: t }); this.sounding = null; }
        this.playing = false; this.pos = -1; this.rev++; break;
      }
      const i = this.next % this.len, st = this.steps[i], nx = this.steps[(i + 1) % this.len];
      const late = t < now - 30;   // a step already past (joining mid-pattern): keep the state, send nothing
      if (st.g === 1) {
        const n = this.noteOf(st);
        // a slide into the same pitch just carries on; into another, the held note ends just after the new one
        // starts, so the synth glides instead of restarting
        if (this.sounding !== n) {
          if (!late) out.push({ type: 'on', note: n, vel: st.a ? 120 : 80, at: t });
          if (this.sounding != null && !late) out.push({ type: 'off', note: this.sounding, vel: 0, at: t + 2 });
          this.sounding = n;
        }
      } else if (st.g === 0 && this.sounding != null) {
        if (!late) out.push({ type: 'off', note: this.sounding, vel: 0, at: t });
        this.sounding = null;
      }
      // does the sounding note carry on into the next step? a slide into a note, or a tie, holds it
      const holds = this.sounding != null && ((st.s && nx.g === 1) || nx.g === 2);
      if (this.sounding != null && !holds) {
        const end = t + (tempo.timeOf(beat + 0.25) - t) * 0.55;
        if (!late) out.push({ type: 'off', note: this.sounding, vel: 0, at: end });
        this.sounding = null;
      }
      this.pos = i; this.posT = t;
      this.next++;
    }
    return out;
  }
  snapshot() {
    return { kind: 'acid', len: this.len, tr: this.tr, st: this.steps.map((x) => [x.n, x.o, x.g, x.a, x.s]), play: this.playing ? this.startBeat : null, stop: this.stopBeat === Infinity ? null : this.stopBeat, pend: this.pending.map((p) => [p.at, p.op]) };
  }
  load(s) {
    if (!s || s.kind !== 'acid') return;
    this.len = Math.max(1, Math.min(16, s.len | 0 || 16)); this.tr = Math.max(-12, Math.min(12, s.tr | 0));
    if (Array.isArray(s.st) && s.st.length === 16) this.steps = s.st.map(([n, o, g, a, sl]) => clampStep({ n, o, g, a, s: sl }));
    this.playing = s.play != null; this.startBeat = s.play || 0; this.stopBeat = s.stop == null ? Infinity : s.stop; this.next = null; this.sounding = null;
    this.pending = []; for (const [at, op] of s.pend || []) this.queue(at, op);
    this.rev++;
  }
  // a copy with every pending edit applied: what the pattern is about to be (for the panel)
  view() { const v = new AcidSeq(); v.load(this.snapshot()); v.applyUpTo(Infinity); return v; }
}

// ---------- the panel, under Acid Line Lite's knobs ----------
// env: { h, edit(op), view(), now(), tempo, playAt(), stopAt() }
export function makeAcidPanel(env) {
  const { h } = env;
  const ui = { sel: 0, write: false };
  const lcd = h('div', { class: 'acid-lcd' });
  const btn = (label, title, onclick, cls = '') => h('button', { class: 'acid-btn ' + cls, title, onclick }, label);
  const play = btn('▶ PLAY', 'Start the pattern on the next bar (everyone hears it from there)', () => env.edit(['play', env.playAt()]), 'play');
  const stop = btn('■ STOP', 'Stop the pattern', () => env.edit(['stop', env.stopAt()]));
  const write = btn('WRITE', 'Keys write notes: select a step, then play a key and it goes there and moves on', () => { ui.write = !ui.write; refresh(true); });
  const rand = btn('RANDOM', 'A new random acid line', () => env.edit(['pat', randomPattern(), env.view().len]));
  const clear = btn('CLEAR', 'Rest on every step', () => env.edit(['pat', Array.from({ length: 16 }, blank), env.view().len]));
  const lenSel = h('select', { class: 'acid-sel', 'aria-label': 'Pattern length', onchange: (ev) => env.edit(['len', +ev.target.value]), onkeydown: (ev) => ev.stopPropagation() },
    ...Array.from({ length: 16 }, (_, i) => h('option', { value: i + 1 }, `${i + 1} steps`)));
  const trVal = h('span', { class: 'acid-tr' });
  const trDn = btn('−', 'Transpose down a semitone', () => env.edit(['tr', env.view().tr - 1]));
  const trUp = btn('+', 'Transpose up a semitone', () => env.edit(['tr', env.view().tr + 1]));
  const set = (i, f) => env.edit(['st', i, f]);
  const cols = Array.from({ length: 16 }, (_, i) => {
    const name = h('b'), oct = h('small');
    const head = h('button', { class: 'acid-note', title: 'Select this step (scroll or use the arrows to change its note)', onclick: () => { ui.sel = i; refresh(true); },
      onwheel: (ev) => { ev.preventDefault(); const s = env.view().steps[i]; set(i, { n: Math.max(0, Math.min(12, s.n + (ev.deltaY < 0 ? 1 : -1))), g: s.g || 1 }); } }, name, oct);
    const up = h('button', { class: 'acid-mini', title: 'Note up', onclick: () => { const s = env.view().steps[i]; set(i, s.n < 12 ? { n: s.n + 1, g: s.g || 1 } : s.o < 1 ? { n: 1, o: s.o + 1, g: s.g || 1 } : {}); } }, '▲');
    const dn = h('button', { class: 'acid-mini', title: 'Note down', onclick: () => { const s = env.view().steps[i]; set(i, s.n > 0 ? { n: s.n - 1, g: s.g || 1 } : s.o > -1 ? { n: 11, o: s.o - 1, g: s.g || 1 } : {}); } }, '▼');
    const octB = h('button', { class: 'acid-tog', title: 'Octave: down, middle, up', onclick: () => { const s = env.view().steps[i]; set(i, { o: s.o === 1 ? -1 : s.o + 1 }); } });
    const gate = h('button', { class: 'acid-tog gate', title: 'Note, rest or tie (holds the note before)', onclick: () => { const s = env.view().steps[i]; set(i, { g: (s.g + 1) % 3 }); } });
    const acc = h('button', { class: 'acid-tog', title: 'Accent: louder, with a sharper, climbing filter sweep', onclick: () => { const s = env.view().steps[i]; set(i, { a: s.a ? 0 : 1 }); } }, 'ACC');
    const sld = h('button', { class: 'acid-tog', title: 'Slide: hold this note into the next one and glide to it', onclick: () => { const s = env.view().steps[i]; set(i, { s: s.s ? 0 : 1 }); } }, 'SLD');
    const col = h('div', { class: 'acid-step' }, h('span', { class: 'acid-num' }, String(i + 1)), up, head, dn, octB, gate, acc, sld);
    return { col, name, oct, octB, gate, acc, sld };
  });
  const el = h('div', { class: 'acid-seq' },
    h('div', { class: 'acid-bar' }, play, stop, h('span', { class: 'acid-sep' }), lenSel, h('span', { class: 'acid-hint' }, 'KEY'), trDn, trVal, trUp, h('span', { class: 'acid-sep' }), write, rand, clear, lcd),
    h('div', { class: 'acid-steps' }, ...cols.map((c) => c.col)));
  let lastRev = -1;
  function refresh(force = false) {
    const v = env.view(), sq = env.seq();
    const now = env.now(), playing = sq.playing && now >= env.tempo.timeOf(sq.startBeat);
    const head = playing ? Math.floor((env.tempo.beatAt(now) - sq.startBeat) * 4) % v.len : -1;
    const rev = sq.rev * 100 + sq.pending.length;
    cols.forEach((c, i) => {
      c.col.classList.toggle('head', i === head);
      c.col.classList.toggle('sel', ui.write && i === ui.sel);
      if (!force && rev === lastRev) return;
      const s = v.steps[i];
      c.col.classList.toggle('off', i >= v.len);
      c.col.classList.toggle('rest', s.g === 0);
      c.name.textContent = s.g === 2 ? '—' : NOTE_NAMES[s.n];
      c.oct.textContent = s.o > 0 ? '↑' : s.o < 0 ? '↓' : '';
      c.octB.textContent = s.o > 0 ? 'UP' : s.o < 0 ? 'DN' : 'MID';
      c.gate.textContent = ['REST', 'NOTE', 'TIE'][s.g];
      c.gate.classList.toggle('on', s.g === 1); c.gate.classList.toggle('tie', s.g === 2);
      c.acc.classList.toggle('on', !!s.a); c.sld.classList.toggle('on', !!s.s);
    });
    if (force || rev !== lastRev) {
      lenSel.value = String(v.len);
      trVal.textContent = (v.tr > 0 ? '+' : '') + v.tr;
      play.classList.toggle('on', v.playing); write.classList.toggle('on', ui.write);
    }
    lcd.textContent = ui.write ? `WRITE · STEP ${ui.sel + 1} · play a key` : `${v.playing ? '▶' : '■'} ${v.len} STEPS${head >= 0 ? ` · ${head + 1}` : ''}`;
    lastRev = rev;
  }
  // a key played while WRITE is on: it becomes the selected step's note (relative to C2, transposed), and moves on
  function keyed(note) {
    if (!ui.write) return false;
    const v = env.view(), rel = note - BASE - v.tr;
    const o = Math.max(-1, Math.min(1, Math.floor(rel / 12))), n = Math.max(0, Math.min(12, rel - 12 * o));
    env.edit(['st', ui.sel, { n, o, g: 1 }]);
    ui.sel = (ui.sel + 1) % v.len;
    refresh(true);
    return true;
  }
  refresh(true);
  return { el, refresh, keyed };
}
