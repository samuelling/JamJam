// The audio editor (Compose Room): open an audio take, pick a stretch of it on the waveform and cut, copy, paste,
// delete or keep just that (trim), or shape it: louder or quieter, normalize, fade in or out, reverse, silence,
// repeat. Every step undoes (and redoes). Saving never overwrites: the edit becomes a new take on the block
// ("Sam's edit of Matt's take"), so the original stays one click away in the take list.
//
//   openAudioEditor({ h, take, pcm: { pcm16, sr }, title, meter, sectionBeats, color, ctx, out, save, onClose })
//     take: the audio take ({ audio: { sr, ch, frames, from, beats, bpm } }); save({ chs, sr }) keeps the edit.
//
// The waveform is drawn against the song's grid: bar and beat lines from where the take starts in its section, and
// the section's end (audio past it doesn't play). Snap (off / beat / bar) keeps picks on the grid.
// Keys while it's open: Space play/stop, ⌘Z undo, ⇧⌘Z or ⌘Y redo, ⌘X ⌘C ⌘V, Delete, ⌘A all, Esc close.

const UNDO_MAX = 40;
let clip = null;   // what Copy or Cut took: { chs, sr }, kept across takes so you can paste between them

const copyOf = (chs, a, b) => chs.map((c) => c.slice(a, b));
const join = (...parts) => { const n = parts.reduce((s, p) => s + p.length, 0), o = new Float32Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
// a clip made to fit: this rate and this many channels (mono ↔ stereo), resampled (linear) when the rates differ
function fit(c, sr, nch) {
  let chs = c.chs;
  if (c.sr !== sr) { const n = Math.max(1, Math.round((chs[0].length * sr) / c.sr)), k = c.sr / sr; chs = chs.map((x) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i * k, j = Math.floor(t), f = t - j; o[i] = j + 1 < x.length ? x[j] + (x[j + 1] - x[j]) * f : x[Math.min(j, x.length - 1)] || 0; } return o; }); }
  if (chs.length === nch) return chs;
  if (nch === 2) return [chs[0], chs[0].slice()];
  const m = new Float32Array(chs[0].length); for (let i = 0; i < m.length; i++) m[i] = (chs[0][i] + chs[1][i]) / 2; return [m];
}

export function openAudioEditor(o) {
  const { h, take } = o, A = take.audio, sr = o.pcm.sr || A.sr, meter = o.meter || 4, bpm = A.bpm, nch = A.ch === 2 ? 2 : 1;
  const fpb = (sr * 60) / bpm;                       // frames per beat at the take's tempo
  let chs = Array.from({ length: nch }, (_, c) => { const n = Math.floor(o.pcm.pcm16.length / nch), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = o.pcm.pcm16[i * nch + c] / 32768; return x; });
  let sel = [0, 0], view = [0, chs[0].length], snap = 'off', undo = [], redo = [], dirty = false, say = '', play = null;
  const len = () => chs[0].length;
  const beatAt = (f) => A.from + f / fpb;            // a frame's beat in its section
  const where = (f) => { const b = beatAt(f), bar = Math.floor(b / meter) + 1, bt = b - (bar - 1) * meter + 1; return `bar ${bar} beat ${Math.round(bt * 100) / 100}`; };
  const secs = (f) => `${(f / sr).toFixed(2)} s`;
  const snapF = (f) => { if (snap === 'off') return f; const q = snap === 'bar' ? meter : 1, b = beatAt(f), s = Math.round(b / q) * q; return Math.round((s - A.from) * fpb); };
  const clamp = (f) => Math.max(0, Math.min(len(), Math.round(f)));
  const hasSel = () => sel[1] - sel[0] > 0;

  // ---- editing: every change goes through edit(), which keeps what undo needs
  // a view that showed all of it keeps showing all of it as the length changes; a zoomed one stays put
  const keepView = (f) => { const all = view[0] <= 0 && view[1] >= len(); f(); if (all) view = [0, len()]; else { view = [Math.max(0, Math.min(view[0], len() - 1)), Math.min(len(), view[1])]; if (view[1] - view[0] < 16) view = [0, len()]; } };
  function edit(what, f) {
    undo.push({ chs, sel: [...sel], what }); if (undo.length > UNDO_MAX) undo.shift(); redo = [];
    keepView(f); dirty = true; say = what; stop(); draw();
  }
  function step(from, to) { const s = from.pop(); if (!s) return; to.push({ chs, sel: [...sel], what: s.what }); keepView(() => { chs = s.chs; sel = s.sel; }); dirty = true; say = (from === undo ? 'Undid: ' : 'Redid: ') + s.what; stop(); draw(); }
  const doUndo = () => step(undo, redo), doRedo = () => step(redo, undo);
  const region = (fn) => { const [a, b] = hasSel() ? sel : [0, len()]; chs = chs.map((c) => { const x = c.slice(); fn(x, a, b); return x; }); };
  const ops = {
    cut: () => { if (!hasSel()) return; clip = { chs: copyOf(chs, ...sel), sr }; edit('Cut', () => { const [a, b] = sel; chs = chs.map((c) => join(c.subarray(0, a), c.subarray(b))); sel = [a, a]; }); },
    copy: () => { if (!hasSel()) return; clip = { chs: copyOf(chs, ...sel), sr }; say = `Copied ${secs(sel[1] - sel[0])}`; draw(); },
    paste: () => { if (!clip) return; const add = fit(clip, sr, nch); edit(hasSel() ? 'Paste over the pick' : 'Paste', () => { const [a, b] = sel; chs = chs.map((c, k) => join(c.subarray(0, a), add[k], c.subarray(b))); sel = [a, a + add[0].length]; }); },
    del: () => { if (!hasSel()) return; edit('Delete', () => { const [a, b] = sel; chs = chs.map((c) => join(c.subarray(0, a), c.subarray(b))); sel = [a, a]; }); },
    trim: () => { if (!hasSel()) return; view = [0, len()]; edit('Trim to the pick', () => { chs = copyOf(chs, ...sel); sel = [0, len()]; }); },
    silence: () => edit('Silence', () => region((x, a, b) => x.fill(0, a, b))),
    gain: (db) => edit(`${db > 0 ? '+' : ''}${db} dB`, () => { const g = 10 ** (db / 20); region((x, a, b) => { for (let i = a; i < b; i++) x[i] *= g; }); }),
    normalize: () => { const [a, b] = hasSel() ? sel : [0, len()]; let m = 0; for (const c of chs) for (let i = a; i < b; i++) m = Math.max(m, Math.abs(c[i])); if (m < 1e-6) return; const g = 0.891 / m; edit('Normalize', () => region((x) => { for (let i = a; i < b; i++) x[i] *= g; })); },
    fadeIn: () => edit('Fade in', () => region((x, a, b) => { const n = Math.max(1, b - a); for (let i = a; i < b; i++) x[i] *= (i - a) / n; })),
    fadeOut: () => edit('Fade out', () => region((x, a, b) => { const n = Math.max(1, b - a); for (let i = a; i < b; i++) x[i] *= (b - i) / n; })),
    reverse: () => edit('Reverse', () => region((x, a, b) => x.subarray(a, b).reverse())),
    repeat: () => { if (!hasSel()) return; edit('Repeat the pick', () => { const [a, b] = sel; chs = chs.map((c) => join(c.subarray(0, b), c.subarray(a, b), c.subarray(b))); sel = [b, b + (b - a)]; }); },
    all: () => { sel = [0, len()]; draw(); },
  };

  // ---- the window
  const cv = h('canvas', { class: 'aewave', 'aria-label': 'Waveform: drag to pick a stretch, click to set where Play and Paste start' });
  const info = h('span', { class: 'aeinfo' }), msg = h('span', { class: 'aemsg', role: 'status' });
  const btn = (label, title, f, cls = '') => h('button', { class: 'btn small ' + cls, title, onclick: () => { f(); cv.focus(); } }, label);
  const playB = btn('▶ Play', 'Play the pick, or from the cursor (Space)', () => (play ? stop() : start()), 'hot aeplay');
  const undoB = btn('↶ Undo', 'Undo (⌘Z)', doUndo), redoB = btn('↷ Redo', 'Redo (⇧⌘Z)', doRedo);
  const gainSel = h('select', { class: 'lcdsel', 'aria-label': 'Louder or quieter', title: 'Louder or quieter: the pick, or all of it', onchange: (e) => { const v = +e.target.value; e.target.value = ''; if (v) ops.gain(v); cv.focus(); } },
    h('option', { value: '' }, 'Volume…'), ...[12, 6, 3, -3, -6, -12].map((d) => h('option', { value: String(d) }, `${d > 0 ? '+' : ''}${d} dB`)));
  const snapSel = h('select', { class: 'lcdsel', 'aria-label': 'Snap', title: 'Snap picks to the song\'s grid', onchange: (e) => { snap = e.target.value; cv.focus(); } },
    h('option', { value: 'off' }, 'Snap: off'), h('option', { value: 'beat' }, 'Snap: beats'), h('option', { value: 'bar' }, 'Snap: bars'));
  const zoom = (k, at) => { const w = view[1] - view[0], c = at ?? (view[0] + view[1]) / 2, nw = Math.max(Math.min(len(), 64), Math.min(len(), w * k)); let a = c - (c - view[0]) * (nw / w); a = Math.max(0, Math.min(len() - nw, a)); view = [a, a + nw]; draw(); };
  const saveB = btn('Save as a new take', 'Keep the edit as a new take on this block; the original stays in the take list', () => doSave(), 'hot');
  const dlg = h('div', { class: 'aedit', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Edit audio: ${o.title}` },
    h('div', { class: 'aehead' }, h('b', {}, `✎ ${o.title}`), info, h('span', { style: 'flex:1' }), btn('×', 'Close (Esc)', () => close(), 'ghost')),
    h('div', { class: 'aetools' }, playB, undoB, redoB, h('span', { class: 'aesep' }),
      btn('✂ Cut', 'Cut the pick (⌘X)', ops.cut), btn('Copy', 'Copy the pick (⌘C)', ops.copy), btn('Paste', 'Paste at the cursor, or over the pick (⌘V); works between takes', ops.paste), btn('Delete', 'Delete the pick (⌫)', ops.del), btn('Trim', 'Keep only the pick', ops.trim),
      h('span', { class: 'aesep' }), gainSel, btn('Normalize', 'As loud as it goes without clipping (the pick, or all of it)', ops.normalize), btn('Fade in', 'Fade in across the pick (or all of it)', ops.fadeIn), btn('Fade out', 'Fade out across the pick (or all of it)', ops.fadeOut),
      btn('Reverse', 'Play the pick backwards', ops.reverse), btn('Silence', 'Silence the pick', ops.silence), btn('Repeat', 'Play the pick twice in a row', ops.repeat)),
    cv,
    h('div', { class: 'aefoot' }, btn('−', 'Zoom out', () => zoom(2)), btn('+', 'Zoom in (⌘ scroll)', () => zoom(0.5)), btn('Fit', 'See all of it', () => { view = [0, len()]; draw(); }), btn('To the pick', 'Zoom to the pick', () => { if (hasSel()) { const p = (sel[1] - sel[0]) * 0.05; view = [Math.max(0, sel[0] - p), Math.min(len(), sel[1] + p)]; draw(); } }), snapSel,
      msg, h('span', { style: 'flex:1' }), btn('Cancel', 'Close without saving', () => close(), 'ghost'), saveB));
  const veil = h('div', { class: 'aeveil', onpointerdown: (e) => { if (e.target === veil) close(); } }, dlg);
  document.body.append(veil);

  function draw() {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, W = Math.max(200, Math.round(r.width * dpr)), H = Math.max(120, Math.round(r.height * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d'), [v0, v1] = view, span = Math.max(1, v1 - v0), X = (f) => ((f - v0) / span) * W, F = (x) => v0 + (x / W) * span;
    g.fillStyle = '#121418'; g.fillRect(0, 0, W, H);
    // where the section ends: audio past here doesn't play
    const endF = (o.sectionBeats - A.from) * fpb; if (endF < v1) { g.fillStyle = '#ff3d3d14'; g.fillRect(Math.max(0, X(endF)), 0, W, H); }
    // the grid: bars and beats from the section's top
    const b0 = Math.floor(beatAt(v0)), b1 = Math.ceil(beatAt(v1)), px = (fpb / span) * W;
    for (let b = b0; b <= b1; b++) { const bar = b % meter === 0; if (!bar && px < 8) continue; const x = X((b - A.from) * fpb); g.fillStyle = bar ? '#ffffff30' : '#ffffff12'; g.fillRect(Math.round(x), 0, Math.max(1, dpr), H); if (bar && px * meter > 30 * dpr) { g.fillStyle = '#ffffff70'; g.font = `${10 * dpr}px system-ui`; g.fillText(String(b / meter + 1), x + 3 * dpr, 11 * dpr); } }
    if (hasSel()) { g.fillStyle = '#3d8bff40'; g.fillRect(X(sel[0]), 0, Math.max(1, X(sel[1]) - X(sel[0])), H); }
    // the wave: each channel in its own band, min/max per pixel column
    const bh = H / nch;
    g.fillStyle = o.color || '#ECEBE5';
    chs.forEach((c, k) => { const mid = bh * k + bh / 2; for (let x = 0; x < W; x++) { const a = Math.max(0, Math.floor(F(x))), z = Math.min(c.length, Math.max(a + 1, Math.floor(F(x + 1)))); let lo = 0, hi = 0; const st = Math.max(1, Math.floor((z - a) / 400)); for (let i = a; i < z; i += st) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; } if (a >= c.length) break; g.fillRect(x, mid - hi * (bh / 2) * 0.95, 1, Math.max(1, (hi - lo) * (bh / 2) * 0.95)); } });
    if (endF >= v0 && endF <= v1) { g.fillStyle = '#ff5c5c'; g.fillRect(X(endF), 0, Math.max(1, dpr), H); }
    if (!hasSel()) { g.fillStyle = '#ffcf26'; g.fillRect(X(sel[0]), 0, Math.max(1, 1.5 * dpr), H); }
    if (play) { const f = play.at(); if (f != null) { g.fillStyle = '#3ddc84'; g.fillRect(X(f), 0, Math.max(1, 2 * dpr), H); } }
    // the readout
    info.textContent = `${secs(len())}${len() > endF ? ` · ${secs(len() - Math.max(0, endF))} runs past the section's end` : ''}`;
    msg.textContent = (hasSel() ? `Picked ${where(sel[0])} to ${where(sel[1])} (${secs(sel[1] - sel[0])})` : `Cursor at ${where(sel[0])}`) + (say ? ` · ${say}` : '');
    undoB.disabled = !undo.length; redoB.disabled = !redo.length; saveB.disabled = !dirty;
    playB.textContent = play ? '■ Stop' : hasSel() ? '▶ Play the pick' : '▶ Play';
  }

  // ---- picking with the mouse; ⌘ scroll zooms, scroll pans
  const fAt = (e) => { const r = cv.getBoundingClientRect(); return view[0] + ((e.clientX - r.left) / Math.max(1, r.width)) * (view[1] - view[0]); };
  cv.tabIndex = 0;
  cv.addEventListener('pointerdown', (e) => {
    if (e.button) return; e.preventDefault(); cv.focus(); cv.setPointerCapture(e.pointerId);
    const anchor = e.shiftKey ? (Math.abs(fAt(e) - sel[0]) < Math.abs(fAt(e) - sel[1]) ? sel[1] : sel[0]) : clamp(snapF(fAt(e)));
    const moveTo = (ev) => { const f = clamp(snapF(fAt(ev))); sel = [Math.min(anchor, f), Math.max(anchor, f)]; draw(); };
    moveTo(e);
    const mv = (ev) => moveTo(ev), up = () => { cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up); if (play) { stop(); start(); } };
    cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', up);
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoom(e.deltaY > 0 ? 1.25 : 0.8, fAt(e));
    else { const w = view[1] - view[0], d = ((e.deltaX || e.deltaY) / 600) * w, a = Math.max(0, Math.min(len() - w, view[0] + d)); view = [a, a + w]; draw(); }
  }, { passive: false });

  // ---- listening: the pick, or from the cursor to the end
  function start() {
    const ctx = o.ctx; if (!ctx) { say = 'Sound is off: tap anywhere on the page first'; draw(); return; }
    const a = sel[0], b = hasSel() ? sel[1] : len(); if (b - a < 2) return;
    const buf = ctx.createBuffer(nch, b - a, sr); chs.forEach((c, k) => buf.copyToChannel(c.subarray(a, b), k));
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(o.out || ctx.destination);
    const t0 = ctx.currentTime + 0.03; src.start(t0);
    play = { src, at: () => { const f = a + (ctx.currentTime - t0) * sr; return f >= b ? null : Math.max(a, f); } };
    src.onended = () => { if (play?.src === src) { play = null; draw(); } };
    const tick = () => { if (play?.src !== src) return; draw(); requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    draw();
  }
  function stop() { if (!play) return; const p = play; play = null; try { p.src.stop(); } catch (_) {} }

  // ---- keys: everything stays in here while it's open (no notes from the keyboard)
  const onKey = (e) => {
    if (!document.body.contains(veil)) return;
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) { if (e.key === 'Escape') close(); return; }
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    const run = (f) => { e.preventDefault(); e.stopPropagation(); f(); };
    if (e.key === 'Escape') return run(close);
    if (e.key === ' ') return run(() => (play ? stop() : start()));
    if (mod && k === 'z') return run(e.shiftKey ? doRedo : doUndo);
    if (mod && k === 'y') return run(doRedo);
    if (mod && k === 'x') return run(ops.cut);
    if (mod && k === 'c') return run(ops.copy);
    if (mod && k === 'v') return run(ops.paste);
    if (mod && k === 'a') return run(ops.all);
    if (e.key === 'Delete' || e.key === 'Backspace') return run(ops.del);
    if (!mod) { e.stopPropagation(); if (e.key.length === 1) e.preventDefault(); }   // no stray notes
  };
  window.addEventListener('keydown', onKey, true); window.addEventListener('keyup', stopUp, true);
  function stopUp(e) { if (document.body.contains(veil) && !(e.target instanceof HTMLInputElement)) e.stopPropagation(); }
  const ro = new ResizeObserver(() => draw()); ro.observe(cv);

  function close(force) {
    if (!force && dirty && !window.confirm('Close without saving your edit?')) return;
    stop(); ro.disconnect(); window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', stopUp, true); veil.remove(); o.onClose?.();
  }
  async function doSave() {
    if (!dirty) return; stop();
    if (len() < 16) { say = 'Nothing left to keep'; draw(); return; }
    try { await o.save({ chs, sr }); dirty = false; close(true); } catch (e) { say = `Couldn't save: ${e.message}`; draw(); }
  }
  requestAnimationFrame(() => { draw(); cv.focus(); });
  // for tests
  return { ops, undo: doUndo, redo: doRedo, select: (a, b) => { sel = [clamp(a), clamp(b)]; draw(); }, state: () => ({ frames: len(), sel: [...sel], undo: undo.length, redo: redo.length, dirty, chs }), close, save: doSave, start, stop };
}
