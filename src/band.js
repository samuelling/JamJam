// The virtual band: drummers the room plays (src/players.js generates the notes). This runs them: a bar at a time,
// a little ahead, in every browser alike; their corner cards; the drummer chooser on the instrument wall; and
// locking a drummer's section in as a take.
import * as VPL from './players.js';
import * as SONG from './song.js';

export function makeBand(x) {
  const { h, $, engine, tempo, clock, songStore, setSong, S, segmentsIn, positionAt, setStatus, iconEl, setText, setCls, closeDrawers, renderLibrary } = x;
  // ---------- virtual players: bandmates every browser generates the same way ----------
  // A virtual player is shared state (its settings and seed); each browser runs its generator a bar at a time, a little
  // ahead, on the room's bar grid (or the song's sections while the song plays), and plays the notes on its own channel.
  const VP = { done: new Set(), plan: new Map() };
  const vplayers = () => Object.values(songStore.song.players || {}).filter(Boolean);
  const vpKey = (vp) => 'vp:' + vp.id;
  const vpCfg = (vp) => VPL.kitOf(vp), vpPatch = (vp) => { const k = vpCfg(vp); return `${k.inst}/${k.patch}`; };
  // how much the band (people, not the song or other virtual players) played in a stretch of room time, as 0..3
  function bandDensity(t0, t1) {
    let n = 0;
    for (const [k, c] of engine.ch) { if (k.startsWith('vp:') || k.startsWith('song:')) continue; for (let i = c.notes.length - 1; i >= 0 && c.notes[i] >= t0; i--) if (c.notes[i] < t1) n++; }
    return n < 3 ? 0 : n < 10 ? 1 : n < 22 ? 2 : 3;
  }
  // the bars a virtual player plays between two room beats: [{start, n, form}]
  function vpBars(vp, b0, b1) {
    const out = [], song = songStore.song, tr = song.transport, meter = song.meter || 4;
    if (!vp.on) return out;
    if (tr && tr.on) {
      const tl = songStore.timeline();
      for (const seg of segmentsIn(tr, b0 - meter, b1)) {
        const sec = song.sections[seg.sid]; if (!sec) continue;
        // drums already locked into this section: the drummer lays out
        if (Object.values(sec.parts || {}).some((p) => p.drums && !p.muted)) continue;
        const idx = seg.idx ?? song.order.indexOf(seg.sid), label = (song.labels || [])[idx] || '';
        const kind = VPL.sectionKind(sec.name, label), bars = sec.bars, lastSeg = tr.mode === 'song' && idx === tl.length - 1;
        for (let i = 0; i < bars; i++) {
          const start = seg.start + i * meter; if (start < b0 - 1e-6 || start >= b1 || start < (seg.lo ?? seg.start) - 1e-6 || start >= (seg.hi ?? Infinity) - 1e-6) continue;
          const form = { kind, sectionBar: i, bars, pass: seg.k || 0, last: i === bars - 1, phraseEnd: i % 8 === 7 || i === bars - 1, final: lastSeg && i === bars - 1 && kind === 'ending' };
          const prev = i > 0 ? { ...form, sectionBar: i - 1, last: false, phraseEnd: (i - 1) % 8 === 7, final: false } : null;
          out.push({ start, n: Math.round((start - tr.start) / meter), form, prev });
        }
      }
      return out;
    }
    for (let n = Math.max(0, Math.ceil((b0 - vp.start) / meter - 1e-6)); vp.start + n * meter < b1; n++) out.push({ start: vp.start + n * meter, n, form: VPL.vampForm(n), prev: n > 0 ? VPL.vampForm(n - 1) : null });
    return out;
  }
  function vpGenerate(vp, bar) {
    const meter = songStore.song.meter || 4, bpm = tempo.bpm(tempo.timeOf(bar.start));
    const form = VPL.withPrevFill(vp, bar.form, bar.prev, bar.n);
    if (vp.listen) form.band = bandDensity(tempo.timeOf(bar.start - 2 * meter), tempo.timeOf(bar.start - meter));
    return VPL.drummerBar(vp, form, bar.n, meter, bpm);
  }
  function vpTick() {
    if (!engine.ctx || !S.me) return;
    // 1.5 s ahead, and a bar back: a background tab's timers may only run once a second, and the generator gives the
    // same notes whenever it runs, so a late tick still plays what's left of the bar (never anything already past)
    const now = clock.now(), b0 = tempo.beatAt(now), b1 = tempo.beatAt(now + 1500), meter = songStore.song.meter || 4;
    for (const vp0 of vplayers()) {
      const k = vpKey(vp0);
      if (!engine.ch.get(k)) { const kc = vpCfg(vpAt(vp0, b0)); engine.setCfg(k, engine.resolve({ inst: kc.inst, patch: kc.patch }), -Infinity); engine.ch.get(k).vpPatch = vpPatch(vpAt(vp0, b0)); applyVpVolume(vp0); }
      for (const [vp, from, to] of vpSpans(vp0, b0 - meter, b1)) for (const bar of vpBars(vp, from, to)) {
        const tag = `${k}@${bar.start.toFixed(4)}`; if (VP.done.has(tag)) continue; VP.done.add(tag);
        // a style with another kit: the kit changes at this bar line
        const c = engine.ch.get(k), patch = vpPatch(vp);
        if (c.vpPatch !== patch) { const kc = vpCfg(vp); engine.setCfg(k, engine.resolve({ inst: kc.inst, patch: kc.patch }), tempo.timeOf(bar.start) - 30); c.vpPatch = patch; setTimeout(() => applyVpVolume(vp0), Math.max(0, tempo.timeOf(bar.start) - clock.now())); }
        const evs = vpGenerate(vp, bar);
        VP.plan.set(vp.id, { start: bar.start, n: bar.n, evs, kind: bar.form.kind });
        for (const e of evs) { const at = tempo.timeOf(bar.start + e.b) + e.ms; if (at < now + 20) continue; engine.event(k, { type: 'on', note: e.note, vel: e.vel, at }); engine.event(k, { type: 'off', note: e.note, at: at + 80 }); }
      }
    }
    if (VP.done.size > 4000) VP.done = new Set([...VP.done].slice(-1000));
    for (const k of [...engine.ch.keys()]) if (k.startsWith('vp:') && !songStore.song.players?.[k.slice(3)]) engine.removeChannel(k);
  }
  setInterval(vpTick, 60);
  // a drummer's level: your fader, times its kit's balance (Machina's kits run much hotter than the recorded kit)
  function applyVpVolume(vp) { const c = engine.ch.get(vpKey(vp)); if (!c || !engine.ctx) return; const v = S.vol.get(vpKey(vp)) || { vol: 0.9, mute: false }, kg = vpCfg(vpAt(vp, tempo.beatAt(clock.now()))).gain ?? 1; c.out.gain.setTargetAtTime(v.mute ? 0 : v.vol * kg, engine.ctx.currentTime, 0.02); }
  function addVirtual(kind = 'drums', style = 'medium') {
    if (S.listener) return null;
    const vp = VPL.newVirtual(kind, S.me, S.name, style);
    vp.on = true; vp.start = nextBarBeat(); vp.versions = [{ from: -1e9, set: settingsOf(vp) }];
    setSong('vp:' + vp.id, vp);
    setStatus(`${vp.name} sits in. It follows the tempo${songStore.song.order.length ? ' and the song' : ''}; everyone hears the same drummer.`);
    return vp.id;
  }
  const nextBarBeat = () => { const m = songStore.song.meter || 4; return Math.ceil(tempo.beatAt(clock.now() + 900) / m) * m; };
  // Changes to a virtual player take effect at a bar line far enough ahead that no browser has generated it yet
  // (generation runs 1.5 s ahead), so every browser switches at the same bar. The player keeps a short history of
  // settings, each from its bar on.
  const VP_SETTINGS = ['style', 'kit', 'intensity', 'busy', 'fills', 'listen', 'feel', 'seed', 'on', 'start', 'name'];
  const settingsOf = (vp) => Object.fromEntries(VP_SETTINGS.map((k) => [k, vp[k]]));
  function vpAt(vp, beat) {
    let cur = null; for (const v of vp.versions || []) if (v.from <= beat + 1e-6) cur = v;
    return cur ? { ...vp, ...cur.set } : vp.versions?.length ? { ...vp, ...vp.versions[0].set } : vp;
  }
  // [settings, from, to] for each stretch of [b0, b1) that one version of the settings covers
  function vpSpans(vp, b0, b1) {
    const vs = vp.versions || []; if (!vs.length) return [[vp, b0, b1]];
    const out = [];
    vs.forEach((v, i) => { const lo = Math.max(b0, i === 0 ? -Infinity : v.from), hi = Math.min(b1, vs[i + 1]?.from ?? Infinity); if (hi > lo) out.push([{ ...vp, ...v.set }, lo, hi]); });
    return out;
  }
  function setVirtual(id, patch) {
    const vp = songStore.song.players?.[id]; if (!vp) return;
    const meter = songStore.song.meter || 4, nowB = tempo.beatAt(clock.now());
    const from = Math.ceil(tempo.beatAt(clock.now() + 2500) / meter - 1e-9) * meter;
    const latest = vp.versions?.length ? vp.versions[vp.versions.length - 1].set : settingsOf(vp);
    const set = { ...latest, ...patch };
    if (patch.style) set.name = VPL.drummerName(patch.style);
    if (patch.on === true && !latest.on) set.start = from;
    // keep what still matters: the version playing now and anything ahead of it
    const vs = (vp.versions || [{ from: -1e9, set: settingsOf(vp) }]).filter((v, i, a) => v.from > nowB || !a[i + 1] || a[i + 1].from > nowB).slice(-4);
    setSong('vp:' + id, { ...vp, ...set, versions: [...vs, { from, set }] });
  }
  function removeVirtual(id) { setSong('vp:' + id, null); }
  // Lock the drummer in: the bars it would play in a section become a take, like anyone's (no capture needed: it's
  // the same generator). Then the section plays the take and the live drummer lays out there.
  function lockVirtual(id, sid) {
    const vp0 = songStore.song.players?.[id], song = songStore.song, sec = song.sections[sid]; if (!vp0 || !sec) return;
    const vp = { ...vp0, ...(vp0.versions?.length ? vp0.versions[vp0.versions.length - 1].set : {}) };
    const meter = song.meter || 4, idx = song.order.indexOf(sid), kind = VPL.sectionKind(sec.name, (song.labels || [])[idx] || ''), evs = [];
    const n0 = songStore.timeline().find((t) => t.id === sid)?.start / meter || 0;
    for (let i = 0; i < sec.bars; i++) {
      const form = { kind, sectionBar: i, bars: sec.bars, pass: 0, last: i === sec.bars - 1, phraseEnd: i % 8 === 7 || i === sec.bars - 1, final: false };
      const prev = i > 0 ? { ...form, sectionBar: i - 1, last: false, phraseEnd: (i - 1) % 8 === 7 } : null;
      const bpm = tempo.bpm(clock.now()), msB = 60000 / bpm;
      for (const e of VPL.drummerBar(vp, VPL.withPrevFill(vp, form, prev, n0 + i), n0 + i, meter, bpm)) { const b = Math.max(0, i * meter + e.b + e.ms / msB); evs.push({ b, type: 'on', note: e.note, vel: e.vel }, { b: Math.min(sec.bars * meter - 0.001, b + 0.12), type: 'off', note: e.note }); }
    }
    const pid = 'vp-' + vp.id, old = sec.parts?.[pid];
    const take = { id: Math.random().toString(36).slice(2, 7), events: evs.sort((a, b) => a.b - b.b), by: S.me, byName: `${vp.name} (seed ${vp.seed % 1000})`, at: clock.now() };
    const takes = [...SONG.takesOf(old || {}), take].slice(-12);
    setSong(`part:${sid}:${pid}`, { name: vp.name, lane: vp.name, role: 'time', inst: vpCfg(vp).inst, patch: vpCfg(vp).patch, params: null, drums: true, by: S.me, byName: S.name, muted: false, votes: old?.votes || {}, takes, current: take.id, prev: old ? SONG.currentTake(old)?.id : null, switchAt: tempo.beatAt(clock.now() + 300) });
    setStatus(`${vp.name}'s ${sec.name} is locked in (take ${takes.length}). Reroll and lock again for another.`);
  }
  // a little picture of the bar the drummer is playing: one row per limb
  function vpRoll(vp) {
    const pl = VP.plan.get(vp.id), meter = songStore.song.meter || 4; if (!pl) return '';
    const rows = [[VPL.KIT.ride, VPL.KIT.bell, VPL.KIT.crash], [VPL.KIT.hhFoot, VPL.KIT.hhClosed], [VPL.KIT.snare, VPL.KIT.xstick, VPL.KIT.tomHi, VPL.KIT.tomMid, VPL.KIT.tomLo, VPL.KIT.floor], [VPL.KIT.kick]];
    const w = 120, ht = 34, dots = pl.evs.map((e) => { const r = rows.findIndex((x) => x.includes(e.note)); if (r < 0) return ''; return `<circle cx="${(4 + (e.b / meter) * (w - 8)).toFixed(1)}" cy="${5 + r * 8}" r="${(1 + e.vel / 60).toFixed(1)}"/>`; }).join('');
    const grid = Array.from({ length: meter }, (_, q) => `<line x1="${(4 + (q / meter) * (w - 8)).toFixed(1)}" y1="0" x2="${(4 + (q / meter) * (w - 8)).toFixed(1)}" y2="${ht}"/>`).join('');
    return `<svg viewBox="0 0 ${w} ${ht}" width="${w}" height="${ht}"><g stroke="#ffffff18">${grid}</g><g fill="currentColor">${dots}</g></svg>`;
  }
  // the bar above the desk in the Jam Room while a section plays: where you are, the chords, Lock it in

  function vpCard(vp) {
    const k = vpKey(vp), v = S.vol.get(k) || { vol: 0.9, mute: false }, tr = songStore.song.transport, def = VPL.VIRTUAL[vp.kind];
    const set = (patch) => setVirtual(vp.id, patch);
    const slider = (label, id, title) => h('label', { class: 'vpk', title }, h('small', {}, label), h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: vp[id], 'aria-label': label, onchange: (e) => set({ [id]: +e.target.value }) }));
    const vol = h('input', { type: 'range', min: 0, max: 1.5, step: 0.01, value: v.vol, 'aria-label': 'Volume in your mix', oninput: (e) => { S.vol.set(k, { ...(S.vol.get(k) || { mute: false }), vol: +e.target.value }); applyVpVolume(vp); } });
    const mute = h('button', { class: 'btn small' + (v.mute ? ' on' : ''), title: 'Mute in your mix', onclick: (e) => { const x = S.vol.get(k) || { vol: 0.9, mute: false }; x.mute = !x.mute; S.vol.set(k, x); applyVpVolume(vp); e.target.classList.toggle('on', x.mute); } }, 'M');
    const songOn = tr && tr.on, lockSid = songOn ? (tr.mode === 'loop' ? tr.sid : null) : null;
    const roll = h('div', { class: 'vproll', 'data-vproll': vp.id }); roll.innerHTML = vpRoll(vp);
    return h('div', { class: 'corner vp', style: '--c:#d8a83a' },
      h('div', { class: 'chead' }, h('div', { class: 'cname' }, vp.name, h('small', { class: 'vptag' }, ' virtual')), h('span', { class: 'help', 'data-vpstate': vp.id }),
        S.listener ? null : h('button', { class: 'gearx', 'aria-label': `Remove ${vp.name}`, title: `Send ${vp.name} home`, onclick: () => removeVirtual(vp.id) }, '×')),
      h('div', { class: 'gearrow' }, h('div', { class: 'gearitem', title: def?.blurb || '' }, iconEl(engine.defs.get(vpCfg(vp).inst) || engine.defs.get('machina')), h('span', { class: 'led', 'data-led': k, style: '--c:#d8a83a' })), roll),
      S.listener ? null : h('div', { class: 'vpctl' },
        h('select', { class: 'lcdsel', 'aria-label': 'Style', onchange: (e) => set({ style: e.target.value }) }, ...VPL.GENRES.map((g) => h('optgroup', { label: g }, ...VPL.STYLES.filter((st) => st.genre === g).map((st) => h('option', { value: st.id, selected: st.id === vp.style }, st.name))))),
        h('select', { class: 'lcdsel', 'aria-label': 'Drum kit', title: 'What it plays on', onchange: (e) => set({ kit: e.target.value }) }, h('option', { value: 'auto', selected: !vp.kit || vp.kit === 'auto' }, `Kit: ${VPL.kitOf({ style: vp.style }).name}`), ...VPL.KITS.map((kt) => h('option', { value: kt.id, selected: vp.kit === kt.id }, kt.name))),
        h('button', { class: 'btn small' + (vp.on ? ' on' : ''), onclick: () => set({ on: !vp.on }) }, vp.on ? '■ Stop' : '▶ Play'),
        h('button', { class: 'btn small ghost', title: 'Same style, a different drummer: a new seed', onclick: () => set({ seed: Math.floor(Math.random() * 1e9) }) }, 'Reroll'),
        lockSid ? h('button', { class: 'btn small hot', title: "Lock this section's drums in as a take (then the live drummer lays out there)", onclick: () => lockVirtual(vp.id, lockSid) }, `Lock into ${songStore.song.sections[lockSid]?.name || 'section'}`) : null),
      S.listener ? null : h('div', { class: 'vpctl' }, slider('Intensity', 'intensity', 'How hard it plays; it still builds through solos and lifts at bridges'),
        h('span', { class: 'tech vpmore' }, slider('Busy', 'busy', 'How much it comps'), slider('Fills', 'fills', 'How often it fills at phrase ends'),
          h('label', { class: 'help', title: "Plays up when the band plays more, and settles when it thins out (from two bars back, so every browser hears it the same)" }, h('input', { type: 'checkbox', checked: !!vp.listen, onchange: (e) => set({ listen: e.target.checked }) }), ' listens'),
          h('select', { class: 'lcdsel', 'aria-label': 'Feel', onchange: (e) => set({ feel: e.target.value }) }, ...[['auto', 'feel: auto'], ['2', 'in 2'], ['4', 'in 4']].map(([val, t]) => h('option', { value: val, selected: (vp.feel || 'auto') === val }, t))))),
      h('div', { class: 'cfoot' }, vol, mute));
  }

  // the drummers' corners, every frame: the LED, what it's doing, the bar it's playing
  function updateCards(now) {
    for (const vp of vplayers()) {
      const c = engine.ch.get(vpKey(vp)), led = $(`[data-led="${vpKey(vp)}"]`); if (led && c) setCls(led, 'lit', now - c.flashT < 120);
      const pl = VP.plan.get(vp.id), tr = songStore.song.transport, roll = $(`[data-vproll="${vp.id}"]`);
      if (roll && pl && roll.dataset.bar !== String(pl.start)) { roll.dataset.bar = String(pl.start); roll.innerHTML = vpRoll(vp); }
      const pos = tr && tr.on ? positionAt(tr, tempo.beatAt(clock.now())) : null, sec = pos && songStore.song.sections[pos.sid];
      const words = !vp.on ? 'stopped' : sec ? (Object.values(sec.parts || {}).some((p) => p.drums && !p.muted) ? `laying out: drums are locked in ${sec.name}` : `playing the ${sec.name}`) : tr && tr.on ? 'waiting for the top' : `playing · bar ${pl ? (pl.n % 32) + 1 : 1} of 32`;
      setText($(`[data-vpstate="${vp.id}"]`), words);
    }
  }
  // the drummer chooser on the wall: every style by genre, the kit it plays, and one click to bring it into the band
  function drummerChooser() {
    const have = vplayers()[0], kitSel = h('select', { class: 'lcdsel', 'aria-label': 'Drum kit' }, h('option', { value: 'auto' }, 'Kit: whatever suits the style'), ...VPL.KITS.map((k) => h('option', { value: k.id, selected: have?.kit === k.id }, k.name)));
    const pick = (st) => { const kit = kitSel.value; if (have) setVirtual(have.id, { style: st.id, kit, on: true }); else { const id = addVirtual('drums', st.id); if (id && kit !== 'auto') setVirtual(id, { kit }); } S.libTab = 'builtin'; closeDrawers(); };
    return [
      h('h3', { class: 'legend', style: 'margin:6px 0 0' }, have ? `Your drummer: ${have.name}` : 'A drummer for the band'),
      h('p', { class: 'help', style: 'margin:0' }, 'It keeps time in the room\'s tempo, follows the song, builds and fills, and everyone hears exactly the same drums. It takes a corner of its own.'),
      h('div', { class: 'row', style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' }, kitSel, h('span', { class: 'help' }, 'Jazz, rock and funk sound best on the recorded Studio Kit; hip-hop and electronic on Machina.')),
      h('div', { class: 'drumstyles' }, ...VPL.GENRES.map((g) => h('div', { class: 'dgenre' }, h('b', {}, g), ...VPL.STYLES.filter((st) => st.genre === g).map((st) =>
        h('button', { class: 'btn small' + (have?.style === st.id ? ' on' : ''), title: `${st.name} on ${VPL.kitOf({ style: st.id }).name}`, onclick: () => pick(st) }, st.name))))),
      have ? h('button', { class: 'btn small ghost', onclick: () => { removeVirtual(have.id); renderLibrary(); } }, `Send ${have.name} home`) : null,
    ];
  }

  return { tick: vpTick, card: vpCard, updateCards, chooser: drummerChooser, add: addVirtual, set: setVirtual, remove: removeVirtual, lock: lockVirtual, list: vplayers, plan: VP.plan, key: vpKey };
}
