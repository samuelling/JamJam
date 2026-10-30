// The Pads instrument's screen: a 4×4 grid of pads (MPC order: pad 1 bottom left), the picked pad's editor, and
// loading sounds: drop files on a pad, pick files, or sample your live audio. A loaded sound becomes a shared clip
// (src/blobs.js) under its content address, with a small analysed description for the stand-in bandmates hear
// until it arrives.
import { blobId, toPcm16 } from './blobs.js';

export const PAD_BASE = 36;
// the computer keys on the grid, top row to bottom
export const PAD_KEYS = { 1: 12, 2: 13, 3: 14, 4: 15, q: 8, w: 9, e: 10, r: 11, a: 4, s: 5, d: 6, f: 7, z: 0, x: 1, c: 2, v: 3 };
const KEY_OF = Object.fromEntries(Object.entries(PAD_KEYS).map(([k, i]) => [i, k.toUpperCase()]));
const MAX_S = 30, SR = 44100;

// what kind of hit a sound is, roughly: enough to sketch it until the real thing arrives
export function analyse(pcm, sr) {
  let peak = 0, pi = 0; for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) { peak = a; pi = i; } }
  if (peak < 1e-4) return { kind: 'click', decay: 0.05, bright: 0.5 };
  const fr = Math.round(sr * 0.005), rms = [];
  for (let i = 0; i < pcm.length; i += fr) { let s = 0; const e = Math.min(pcm.length, i + fr); for (let j = i; j < e; j++) s += pcm[j] * pcm[j]; rms.push(Math.sqrt(s / Math.max(1, e - i))); }
  const top = Math.max(...rms), ti = rms.indexOf(top); let end = ti; while (end < rms.length && rms[end] > top * 0.03) end++;
  const decay = Math.max(0.02, ((end - ti) * fr) / sr);
  const w0 = pi, w1 = Math.min(pcm.length, pi + Math.round(sr * 0.15));
  let zc = 0, lo = 0, all = 0, y = 0; const a = 1 - Math.exp((-2 * Math.PI * 150) / sr);
  for (let i = w0 + 1; i < w1; i++) { if ((pcm[i] >= 0) !== (pcm[i - 1] >= 0)) zc++; y += (pcm[i] - y) * a; lo += y * y; all += pcm[i] * pcm[i]; }
  const zcr = zc / Math.max(1e-3, (w1 - w0) / sr), low = lo / Math.max(1e-9, all);
  // periodicity: autocorrelation just after the attack
  // (the shortest lag that correlates nearly as well as the best: the period, not a multiple of it)
  let best = 0, lag = 0; const s0 = Math.min(pcm.length - 2048, pi + Math.round(sr * 0.01)), rs = [];
  if (s0 > 0) for (let L = Math.round(sr / 1000); L < Math.round(sr / 40); L++) { let c = 0, n0 = 0, n1 = 0; for (let i = 0; i < 1024; i++) { const u = pcm[s0 + i], v = pcm[s0 + i + L]; c += u * v; n0 += u * u; n1 += v * v; } const r = c / Math.sqrt(n0 * n1 + 1e-12); rs.push([L, r]); if (r > best) best = r; }
  for (let k = 1; k < rs.length - 1; k++) if (rs[k][1] >= best * 0.9 && rs[k][1] >= rs[k - 1][1] && rs[k][1] >= rs[k + 1][1]) { lag = rs[k][0]; break; }
  const f = lag ? sr / lag : 0, bright = Math.min(1, zcr / 6000);
  const kind = low > 0.5 && zcr < 900 ? 'kick' : zcr > 4000 ? 'hat' : best > 0.6 && decay > 0.25 ? 'tone' : low > 0.25 && zcr < 1600 ? 'tom' : decay < 0.08 ? 'click' : 'snare';
  return { kind, f: Math.round(kind === 'kick' && (!f || f > 120) ? 55 : f || 200), decay: +decay.toFixed(3), bright: +bright.toFixed(2) };
}
// any audio file, as mono 16-bit PCM at 44.1 kHz (at most 30 s)
export async function decodeFile(arrayBuffer) {
  const ab = await new OfflineAudioContext(1, 1, SR).decodeAudioData(arrayBuffer);
  const n = Math.min(ab.length, MAX_S * SR), out = new Float32Array(n);
  for (let c = 0; c < ab.numberOfChannels; c++) { const d = ab.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / ab.numberOfChannels; }
  return out;
}

export function makePadsUI(x) {
  // x: { h, blobs, setKit(e, kit), press(note), release(note), status(text, kind), sampleLive(beats) -> Float32Array|null, liveOn(), defOf(e), audition }
  const { h } = x;
  let sel = 0;
  async function load(e, i, pcm, name) {
    const pcm16 = toPcm16(pcm), id = await blobId(new Uint8Array(pcm16.buffer));
    x.blobs.put(id, pcm16, SR);
    const kit = [...(e.cfg.params.kit || [])]; while (kit.length < 16) kit.push(null);
    kit[i] = { id, name: String(name || 'Sound').replace(/\.[a-z0-9]+$/i, '').slice(0, 14), start: 0, end: 1, tune: 0, gain: 0, choke: kit[i]?.choke || 0, recipe: analyse(pcm, SR) };
    x.setKit(e, kit); x.blobs.send(id);
  }
  async function loadFiles(e, i, files) {
    let k = i;
    for (const f of files) {
      if (k > 15) break;
      try { await load(e, k, await decodeFile(await f.arrayBuffer()), f.name); k++; }
      catch (_) { x.status(`Couldn't read ${f.name} as audio.`, 'error'); }
    }
    if (k > i) x.status(`${k - i} sound${k - i > 1 ? 's' : ''} on the pads. Your bandmates get ${k - i > 1 ? 'them' : 'it'} once and keep ${k - i > 1 ? 'them' : 'it'}.`);
  }
  function wave(id, w = 120, ht = 26, a = 0, z = 1) {
    const c = id && x.blobs.pcm(id); if (!c) return '';
    const n = 60, len = c.pcm16.length, pts = [];
    for (let k = 0; k < n; k++) { let m = 0; for (let j = Math.floor((k * len) / n); j < Math.floor(((k + 1) * len) / n); j += 8) m = Math.max(m, Math.abs(c.pcm16[j])); pts.push(m / 32768); }
    const bars = pts.map((v, k) => `<rect x="${((k / n) * w).toFixed(1)}" y="${(ht / 2 - v * (ht / 2)).toFixed(1)}" width="${(w / n - 0.6).toFixed(1)}" height="${Math.max(1, v * ht).toFixed(1)}" fill="${k / n >= a && k / n < z ? 'currentColor' : '#ffffff22'}"/>`).join('');
    return `<svg viewBox="0 0 ${w} ${ht}" width="100%" height="${ht}" preserveAspectRatio="none">${bars}</svg>`;
  }
  function render(e, plate, foot) {
    const kit = e.cfg.params.kit || [], pad = kit[sel];
    const file = h('input', { type: 'file', accept: 'audio/*,.wav,.aif,.aiff,.mp3,.ogg,.flac', multiple: true, style: 'display:none', onchange: (ev) => { loadFiles(e, sel, [...ev.target.files]); ev.target.value = ''; } });
    const grid = h('div', { class: 'padgrid' }, ...[12, 8, 4, 0].flatMap((row) => [0, 1, 2, 3].map((c) => {
      const i = row + c, p = kit[i], here = p && (p.src || x.blobs.has(p.id));
      const b = h('button', { class: 'padbtn' + (i === sel ? ' sel' : '') + (p ? '' : ' empty'), 'data-padbtn': i, title: p ? `${p.name} · pad ${i + 1}${here ? '' : ' · on its way (a sketch plays meanwhile)'}` : `Pad ${i + 1}: drop a sound here` },
        h('span', { class: 'pnum' }, String(i + 1)), h('span', { class: 'pkey' }, KEY_OF[i] || ''), h('b', {}, p ? p.name : '—'), p && !here ? h('i', { class: 'pwait', 'aria-hidden': 'true' }) : null);
      if (p?.id) { const wv = h('span', { class: 'pwave' }); wv.innerHTML = wave(p.id, 80, 16); b.append(wv); }
      b.addEventListener('pointerdown', (ev) => { ev.preventDefault(); b.setPointerCapture(ev.pointerId); b.classList.add('hit'); const r = b.getBoundingClientRect(); const vel = Math.round(40 + 87 * Math.min(1, Math.max(0, 1 - (ev.clientY - r.top) / r.height) * 0.5 + 0.5)); x.press(PAD_BASE + i, vel); if (sel !== i) { sel = i; render(e, plate, foot); } });
      const up = () => { b.classList.remove('hit'); x.release(PAD_BASE + i); };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
      b.addEventListener('dragover', (ev) => { ev.preventDefault(); b.classList.add('drop'); });
      b.addEventListener('dragleave', () => b.classList.remove('drop'));
      b.addEventListener('drop', (ev) => { ev.preventDefault(); b.classList.remove('drop'); const fs = [...(ev.dataTransfer?.files || [])]; if (fs.length) loadFiles(e, i, fs); });
      return b;
    })));
    const set = (patch) => { const k = [...(e.cfg.params.kit || [])]; while (k.length < 16) k.push(null); k[sel] = { ...k[sel], ...patch }; x.setKit(e, k); };   // the kit as it is now, not as drawn
    const num = (label, id, min, max, step, unit, v) => h('label', { class: 'pedit' }, h('small', {}, label), h('input', { type: 'range', min, max, step, value: v, 'aria-label': label, onchange: (ev) => set({ [id]: +ev.target.value }), oninput: (ev) => { ev.target.nextSibling.textContent = `${(+ev.target.value).toFixed(step < 1 ? 2 : 0)}${unit}`; } }), h('span', { class: 'mono help' }, `${(+v).toFixed(step < 1 ? 2 : 0)}${unit}`));
    const editor = h('div', { class: 'padedit' },
      h('div', { class: 'row' }, h('b', { class: 'pname' }, `Pad ${sel + 1}`),
        pad ? h('input', { class: 'rmlabel', value: pad.name, maxlength: 14, 'aria-label': 'Pad name', onkeydown: (ev) => ev.stopPropagation(), onchange: (ev) => set({ name: ev.target.value.trim().slice(0, 14) || 'Sound' }) }) : h('span', { class: 'help' }, 'empty: drop a sound on it'),
        h('span', { style: 'flex:1' }),
        h('button', { class: 'btn small hot', onclick: () => file.click() }, pad ? 'Replace…' : 'Load sound…'),
        x.liveOn() ? h('button', { class: 'btn small', title: 'Put the last bar of your live audio on this pad', onclick: () => { const pcm = x.sampleLive(); if (pcm) load(e, sel, pcm, 'Live sample'); else x.status('No live audio from the last bar here yet.', 'error'); } }, '🎙 Sample my live audio') : null,
        pad ? h('button', { class: 'btn small ghost', onclick: () => { const k = [...(e.cfg.params.kit || [])]; k[sel] = null; x.setKit(e, k); } }, 'Clear') : null, file),
      pad ? h('div', { class: 'pwavebig' }) : null,
      pad ? h('div', { class: 'row' }, num('Start', 'start', 0, 0.95, 0.01, '', pad.start || 0), num('End', 'end', 0.05, 1, 0.01, '', pad.end ?? 1), num('Tune', 'tune', -24, 24, 1, ' st', pad.tune || 0), num('Gain', 'gain', -24, 12, 1, ' dB', pad.gain || 0),
        h('label', { class: 'pedit' }, h('small', {}, 'Choke'), h('select', { class: 'lcdsel', 'aria-label': 'Choke group', onchange: (ev) => set({ choke: +ev.target.value }) }, ...['none', 'A', 'B', 'C', 'D'].map((t, k) => h('option', { value: k, selected: (pad.choke || 0) === k }, t))))) : null);
    const wb = editor.querySelector('.pwavebig'); if (wb) wb.innerHTML = wave(pad.id, 600, 44, pad.start || 0, pad.end ?? 1) || `<span class="help">${pad.src ? 'one of the kit\'s own sounds' : 'on its way: a sketch plays until it arrives'}</span>`;
    plate.replaceChildren(
      h('div', { class: 'devtop' }, h('div', { class: 'brand' }, h('div', { class: 'name' }, 'Pads'),
        x.kits ? h('select', { class: 'lcdsel kitsel', 'aria-label': 'Kit', title: 'Load a kit onto the pads (your own sounds on them are replaced)', onchange: (ev) => x.pickKit(e, ev.target.value) },
          ...x.kits(e).map(([id, name]) => h('option', { value: id, selected: id === e.cfg.patch }, name))) : null, h('div', { class: 'fam' }, 'Sample pads · drop sounds on them'), x.kitSource?.(e) ? h('div', { class: 'fam credit' }, 'sounds: ' + x.kitSource(e)) : null),
        h('div', { class: 'screen lcd' }, h('div', { class: 'wide' }, 'Play them with the mouse, a MIDI pad controller (notes 36 to 51) or the keys 1234 · QWER · ASDF · ZXCV. Record a few passes with Record every pass, then fix and quantize the hits in the Compose Room.'))),
      h('div', { class: 'padwrap' }, grid, editor), foot);
  }
  return { render, loadFiles, load, select: (i) => { sel = i; } };
}
