// Your gear: the hardware synths you brought, linked once, and what happens when a bandmate has the same one.
//
// Linking: MEGAjam guesses each MIDI port's synth from its name (an "OB-6" port is a Sequential OB-6), you confirm
// it, and it is remembered in this browser (S.owned: unit id -> {port, ch}). Play it and the band hears it as its
// software twin, unless they have linked the same model, in which case they hear it on their own (autoOwn in main).
//
// Same model on both sides: the player's synth's knob moves (CC and NRPN, a parameter number and its value kept
// together), program changes and pressure go to the bandmate's synth, stamped like notes so they land with them.
// And its current sound: where the model has a known edit-buffer request (hardware.json "dump"), the player's
// browser asks the synth for it over SysEx and sends the reply, which the bandmate's browser plays into their synth
// on the next bar line. That loads it as the current sound; nobody's saved programs are written. A synth with no
// request command can still send a dump from its front panel: any SysEx it sends is passed on.
// Before trusting a dump, each side asks its synth who it is (the universal identity request): a firmware
// difference is pointed out.

const hex = (s) => String(s || '').trim().split(/[\s,]+/).filter(Boolean).map((x) => parseInt(x, 16));
const NOTE = (n) => ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'][n % 12] + (Math.floor(n / 12) - 1);
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const GENERIC = /^(usb|midi|iac|network|session|through|thru|bus|port|in|out|interface|audio|device|driver|\d)+$/;
const IDENTITY_REQ = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];
// what to set on the synth so its knob moves reach a bandmate's same synth
const KNOBS = { nrpn: 'set it to send its knobs as NRPN', 'nrpn+cc': 'set it to send its knobs as NRPN', cc: 'set it to send its knobs as CC', sysex: 'its knob moves go as SysEx' };

export function makeGear(x) {
  const { h, S, engine, input, room, clock } = x;
  const hosts = new Map();   // your entry r -> Map(bandmate pid -> {sysex}) playing your part on their own same synth
  const ver = new Map();     // unit id -> firmware version your own unit reported
  const asked = new Set();   // port names already asked about ("is this your OB-6?") this session
  let wait = null, chain = Promise.resolve();
  const who = (pid) => S.players.get(pid)?.name || 'A bandmate';
  const names = (pids) => pids.map(who).join(' and ');
  const model = (id) => engine.unit(id)?.model || 'synth';
  const live = (r) => { const m = hosts.get(r); if (!m) return []; for (const pid of [...m.keys()]) if (!S.players.has(pid)) m.delete(pid); return [...m.keys()]; };

  // ---- which synth is this port? the longest model name found in the port's name
  function guessUnit(name) {
    const n = squash(name); if (!n || GENERIC.test(n)) return null;
    let best = null, bl = 0;
    for (const u of engine.hardware.hardware) {
      const m = squash(u.model); if (m.length < 3 || !n.includes(m)) continue;
      const score = m.length + (n.includes(squash(u.maker)) ? 0.5 : 0);
      if (score > bl) { best = u; bl = score; }
    }
    return best;
  }
  const portName = (id) => input.outputs.find((o) => o.id === id)?.name || '';
  const myPort = (e) => S.owned.get(e.cfg.hw)?.port || e.midiOut || '';

  // ---- asking your synth something over SysEx: one question at a time, answered within a couple of seconds
  // A request can be several messages (a Roland synth answers one block of its sound per RQ1): each goes once the
  // last one's answer has gone quiet. `want`: how many replies make the whole answer, when the model says.
  function ask(portId, req, match, want = 1, ms = 2000) {
    const reqs = split(req);
    const run = () => new Promise((res) => {
      const port = x.outPort(portId); if (!port || !input.sysex || !reqs.length) { res(null); return; }
      const w = { match, got: [] }; let i = 0, quiet = 0, hard = 0;
      const finish = () => { clearTimeout(quiet); clearTimeout(hard); if (wait === w) wait = null; res(w.got.length ? w.got : null); };
      const next = () => {
        if (i >= reqs.length) { finish(); return; }
        x.sendToHardware(port, reqs[i++], performance.now());
        clearTimeout(hard); hard = setTimeout(i >= reqs.length ? finish : next, ms);
      };
      w.onGot = () => {
        clearTimeout(quiet);
        if (reqs.length === 1 && typeof want === 'number' && w.got.length >= want) { finish(); return; }
        quiet = setTimeout(next, 150);
      };
      wait = w; next();
    });
    const p = chain.then(run); chain = p.catch(() => {}); return p;
  }
  // the messages in a byte string (F0 … F7, F0 … F7)
  function split(bytes) { const out = []; let cur = null; for (const b of bytes) { if (b === 0xf0) cur = [b]; else if (cur) { cur.push(b); if (b === 0xf7) { out.push(cur); cur = null; } } } return out; }
  // Korg and Yamaha put the MIDI channel in a byte of the header: the asking synth's channel, or the receiving one's
  const withChannel = (bytes, spec, ch) => (spec?.deviceIdByte != null && (bytes[1] === 0x42 || bytes[1] === 0x43) && bytes.length > spec.deviceIdByte
    ? bytes.map((b, i) => (i === spec.deviceIdByte ? (b & 0xf0) | ((ch - 1) & 15) : b)) : bytes);
  const prefix = (spec) => { const p = hex(spec.reply); return (b) => p.every((v, i) => i === spec.deviceIdByte || b[i] === v); };
  async function identify(portId) {
    const got = await ask(portId, IDENTITY_REQ, (b) => b[1] === 0x7e && b[3] === 0x06 && b[4] === 0x02, 1, 800);
    const b = got?.[0]; return b && b.length >= 10 ? b.slice(-5, -1).map((v) => v.toString(16).padStart(2, '0')).join('.') : null;
  }
  async function sysexOn() { const ok = await input.enableSysex(); if (ok) for (const [id, o] of S.owned) if (o.port && !ver.has(id)) identify(o.port).then((v) => v && ver.set(id, v)); return ok; }

  // ---- the player's side
  // knob moves, program changes, pressure from your synth: to the bandmates playing your part on theirs
  let refetch = 0;
  function relayRaw(bytes, ch, port = '') {
    for (const e of x.targetsFor(ch, port)) {
      if (!e.cfg.hw) continue;
      const to = live(e.r); if (!to.length) continue;
      const at = clock.now() + x.partLook(e);
      for (const pid of to) room.send({ k: 'mx', r: e.r, d: bytes, at }, pid);
      // a program change brings a different sound: send it once the synth has loaded it
      if ((bytes[0] & 0xf0) === 0xc0) { clearTimeout(refetch); refetch = setTimeout(() => sharePatch(e, to, 'program'), 350); }
    }
  }
  function onSysex(bytes) {
    if (wait && wait.match(bytes)) { wait.got.push(bytes); wait.onGot(); return; }
    if (bytes[1] === 0x7e) return;   // universal messages (identity replies and the like) aren't sounds
    // something your synth sent on its own (a dump from its front panel, or a model that reports knobs as SysEx)
    for (const e of x.rack()) {
      if (!e.cfg.hw) continue; const to = live(e.r); if (!to.length) continue;
      const spec = engine.unit(e.cfg.hw)?.dump; if (spec?.reply && !prefix({ reply: spec.reply.split(' ').slice(0, 3).join(' '), deviceIdByte: spec.deviceIdByte })(bytes)) continue;   // another maker's SysEx
      const big = bytes.length > 64;
      send(e, [bytes], big ? patchAt() : clock.now() + x.partLook(e), big ? 'patch' : 'live', to);
      if (big) x.chat(`Sent your ${model(e.cfg.hw)}'s dump to ${names(to)}.`);
      return;
    }
  }
  function patchAt() {
    const tr = x.song().transport, now = clock.now(); if (!tr?.on) return now + 300;
    const m = x.song().meter || 4, b = x.tempo.beatAt(now + 400), s = tr.start || 0;
    return x.tempo.timeOf(s + Math.ceil((b - s) / m) * m);   // the next bar line, so the sound changes in time
  }
  function send(e, msgs, at, why, to, v) { for (const pid of to) room.send({ k: 'sx', r: e.r, hw: e.cfg.hw, d: msgs, at, why, ver: v || ver.get(e.cfg.hw) || null }, pid); }
  async function sharePatch(e, to, why) {
    if (!e?.cfg.hw || !to.length) return false;
    const spec = engine.unit(e.cfg.hw)?.dump, port = myPort(e), nm = model(e.cfg.hw);
    if (!spec?.request) {
      if (why !== 'program') x.chat(`${names(to)} ${to.length > 1 ? 'have' : 'has'} a ${nm} too. To give them your sound, send a program dump from your ${nm}${spec?.manualDump ? ` (${spec.manualDump})` : ''}; MEGAjam passes it on.`);
      return false;
    }
    if (!port) { x.chat(`Link your ${nm}'s MIDI port in My gear, and MEGAjam can copy its sound to ${names(to)}.`); return false; }
    if (!(await sysexOn())) return false;
    const v = ver.get(e.cfg.hw) || await identify(port); if (v) ver.set(e.cfg.hw, v);
    const ch = S.owned.get(e.cfg.hw)?.ch || 1, req = split(hex(spec.request)).flatMap((m) => withChannel(m, spec, ch));
    const got = await ask(port, req, prefix(spec), spec.replies || 1, 2500);
    if (!got) { x.chat(`Your ${nm} didn't answer the request for its sound. Is SysEx turned on in its global settings, on the port MEGAjam uses?`); return false; }
    send(e, got, patchAt(), 'patch', to, v);
    x.chat(why === 'program' ? `Your new ${nm} sound went to ${names(to)}.` : `Your ${nm}'s sound is copied to ${names(to)}'s ${nm}.`);
    return true;
  }
  // a bandmate starts (or stops) playing your part on their own same synth
  function onReal(p, m) {
    const nm = model(m.hw), map = hosts.get(m.r) || new Map(); hosts.set(m.r, map);
    if (m.on) { const fresh = !map.has(p.id); map.set(p.id, { sysex: !!m.sysex }); if (fresh) x.chat(`${who(p.id)} has a ${nm} too: they hear your part on their own${m.sysex ? ', and get your sound' : ''}.`); if (m.sysex) sharePatch(x.entry(m.r), [p.id], 'handshake'); }
    else if (map.delete(p.id)) x.chat(`${who(p.id)} is back to hearing your ${nm} as its twin.`);
    x.render();
  }

  // ---- the bandmate's side
  function receiveRaw(p, m) {
    const r = S.routes.get(x.key(p.id, m.r)); if (!r?.same || !r.port || !Array.isArray(m.d)) return;
    const port = x.outPort(r.port); if (!port) return;
    const oc = ((r.ch || 1) - 1) & 15, out = m.d.map((b) => (b >= 0x80 && b < 0xf0 ? (b & 0xf0) | oc : b & 0x7f));   // on your synth's channel
    x.sendToHardware(port, out, clock.toLocal(m.at) - (r.lat || 0));
  }
  const pending = new Map();
  function receiveSx(p, m) {
    const k = x.key(p.id, m.r), r = S.routes.get(k); if (!r?.same || !r.port || !Array.isArray(m.d)) return;
    if (!input.sysex) { if (m.why === 'patch') { pending.set(k, { p, m }); x.chat(`${who(p.id)} sent their ${model(m.hw)}'s sound. Allow SysEx in My gear to load it into yours.`); x.render(); } return; }
    const port = x.outPort(r.port); if (!port) return;
    const t = Math.max(performance.now() + 5, clock.toLocal(m.at) - (r.lat || 0));
    const spec = engine.unit(m.hw)?.dump;
    for (const d of m.d) if (Array.isArray(d) && d[0] === 0xf0 && d[d.length - 1] === 0xf7 && d.length < 65536) x.sendToHardware(port, withChannel(d, spec, r.ch || 1), t);
    if (m.why === 'patch') {
      const mine = ver.get(m.hw);
      x.chat(`${who(p.id)}'s ${model(m.hw)} sound is on yours now (as the current sound; your saved programs are untouched).${m.ver && mine && m.ver !== mine ? ` Your firmware differs (${mine}, theirs ${m.ver}), so it may not come across exactly.` : ''}`);
    }
  }
  async function allowSysex() {
    if (!(await sysexOn())) return;
    for (const [k, { p, m }] of pending) { pending.delete(k); receiveSx(p, m); }
    for (const [pid, pl] of S.players) for (const y of pl.rack || []) if (y.cfg?.hw && S.routes.get(x.key(pid, y.r))?.same) room.send({ k: 'real', r: y.r, hw: y.cfg.hw, on: true, sysex: true }, pid);
    x.render();
  }
  const realMsg = (r, hw, on) => ({ k: 'real', r, hw, on, sysex: on && input.sysex });

  // ---- linking: the "is this your OB-6?" prompt, and the My gear panel
  function check() {
    if (!input.midi) return;
    for (const o of input.outputs) {
      if (asked.has(o.name) || [...S.owned.values()].some((v) => v.port === o.id)) continue;
      const u = guessUnit(o.name); if (!u || S.owned.has(u.id)) continue;
      asked.add(o.name); prompt(u, o); return;
    }
  }
  function prompt(u, o) {
    document.querySelector('.gearprompt')?.remove();
    const box = h('div', { class: 'gearprompt', role: 'dialog', 'aria-label': `Link your ${u.model}` },
      h('b', {}, `Is this your ${u.maker} ${u.model}?`), h('span', { class: 'help' }, `“${o.name}” just showed up.`),
      h('button', { class: 'btn small hot', onclick: () => { box.remove(); link(u.id, o.id, 1); x.openGear(); } }, 'Yes, link it'),
      h('button', { class: 'btn small ghost', onclick: () => box.remove() }, 'Not now'));
    document.body.append(box);
    setTimeout(() => box.remove(), 30000);
  }
  function link(id, port, ch) {
    x.setOwned(id, { port, ch: ch || 1 });
    setupOpen = id;   // show its set-up steps straight away
    if (input.sysex) identify(port).then((v) => v && ver.set(id, v));
    x.status(`Your ${model(id)} is linked. Put it on your desk to play it; a bandmate's ${model(id)} part plays on it.`);
  }
  function play(id) {
    const own = S.owned.get(id), u = engine.unit(id); if (!u) return;
    const twin = engine.twinCandidates(u)[0]?.inst;
    const e = x.addEntry({ hw: id, inst: twin }); if (!e) return;
    if (own?.ch) e.midiCh = own.ch;
    x.closeDrawers(); x.renderRack();
    x.status(`Your ${u.model} is on your desk. Play it: bandmates with a ${u.model} linked hear it on theirs, the rest hear ${engine.defs.get(twin)?.name || 'its twin'}.`);
  }
  // ---- setting a synth up: its own steps (hardware.json "setup", from its manual) or general ones, ticked off as
  // you go, then a check that MEGAjam can really reach it: who are you (identity), and can you send your sound
  let setupOpen = null;
  const tested = new Map();   // unit id -> {ok, text}
  const doneKey = (id) => 'megajam.setup.' + id;
  const doneOf = (id) => { try { return new Set(JSON.parse(localStorage.getItem(doneKey(id)) || '[]')); } catch (_) { return new Set(); } };
  function stepsFor(u) {
    if (Array.isArray(u.setup) && u.setup.length) return u.setup;
    const knobs = u.dump?.params === 'cc' ? 'CC' : u.dump?.params === 'sysex' ? 'SysEx' : 'NRPN (or CC, if that is all it offers)';
    return [
      `Connect it: USB from the ${u.model} to this computer, or its MIDI OUT and MIDI IN to your MIDI interface (both directions).`,
      `Set its MIDI channel in its MIDI or global settings, and pick the same channel here.`,
      u.dump || u.midi !== false ? 'Turn on SysEx in its MIDI settings, both sending and receiving if it asks (it may be called "SysEx receive" and "SysEx transmit").' : null,
      `Set it to send and receive its knob moves as ${knobs}.`,
      u.dump?.manualDump ? `To share its sound, send a dump from the front panel: ${u.dump.manualDump}` : null,
    ].filter(Boolean);
  }
  async function test(id) {
    const o = S.owned.get(id), u = engine.unit(id); if (!o || !u) return;
    tested.set(id, { busy: true, text: 'Asking your ' + u.model + '…' }); render();
    if (!(await sysexOn())) { tested.set(id, { ok: false, text: 'SysEx wasn\'t allowed, so MEGAjam can\'t ask it anything. Notes and knob moves still work.' }); render(); return; }
    const v = await identify(o.port); if (v) ver.set(id, v);
    let text = v ? `It answered: firmware ${v}.` : "It didn't say who it is (many synths don't; that's fine).", ok = !!v;
    if (u.dump?.request) {
      const req = split(hex(u.dump.request)).flatMap((m) => withChannel(m, u.dump, o.ch || 1));
      const got = await ask(o.port, req, prefix(u.dump), u.dump.replies || 1, 2500);
      ok = !!got;
      text += got ? ` And it sent its current sound (${got.reduce((a, m) => a + m.length, 0)} bytes): sharing will work.` : ` But it didn't send its sound when asked: check SysEx is on, the channel matches${u.dump.deviceIdByte != null ? ' (and its device ID is the default)' : ''}, and both MIDI cables (or USB) are connected.`;
    } else if (u.dump?.manualDump || u.dump?.reply) text += ' This model has no request for its sound: send a dump from its front panel when you want to share it.';
    else text += ' MEGAjam has no sound request for this model yet, so bandmates get your knob moves but not your whole sound.';
    tested.set(id, { ok, text }); render();
  }
  function setupPanel(id) {
    const u = engine.unit(id), steps = stepsFor(u), done = doneOf(id), t = tested.get(id);
    const tick = (i) => { const d = doneOf(id); if (d.has(i)) d.delete(i); else d.add(i); try { localStorage.setItem(doneKey(id), JSON.stringify([...d])); } catch (_) {} render(); };
    return h('div', { class: 'gearsetup' },
      h('b', {}, `Set up your ${u.model}`), h('small', { class: 'help' }, u.setupSource ? 'From its manual. Menu names can differ a little between firmware versions.' : 'General steps: your manual has the exact menu names.'),
      h('ol', {}, ...steps.map((st, i) => h('li', { class: done.has(i) ? 'done' : '' }, h('label', {}, h('input', { type: 'checkbox', checked: done.has(i), onchange: () => tick(i) }), ' ', st))),
        h('li', { class: input.sysex ? 'done' : '' }, h('label', {}, h('input', { type: 'checkbox', checked: input.sysex, disabled: true }), ' ', input.sysex ? 'SysEx is allowed in this browser.' : 'Allow SysEx in this browser (the button below).'))),
      h('div', { class: 'row' }, h('button', { class: 'btn small hot', disabled: !!t?.busy || !input.outputs.some((p) => p.id === S.owned.get(id)?.port), onclick: () => test(id) }, t?.busy ? 'Checking…' : 'Check it works'),
        t && !t.busy ? h('span', { class: 'help ' + (t.ok ? 'ok' : 'warn') }, (t.ok ? '✓ ' : '') + t.text) : null));
  }
  // ---- adding a sequencer (a Cirklon, a Hapax, a DAW…): listen while it plays, list every port and channel that
  // has notes, say what plays each one (a synth you linked, or a software instrument), and they go on your desk
  let listening = null, redraw = 0;
  const seqPick = new Map(), seqRoom = new Map();
  let clockPort = null, clockAhead = true;
  function heard(port, ch, note) {
    if (!listening || listening.done || !port) return;
    const k = port + '|' + ch, st = listening.streams.get(k) || { port, ch, n: 0, lo: 127, hi: 0, notes: new Set() };
    st.n++; st.lo = Math.min(st.lo, note); st.hi = Math.max(st.hi, note); st.notes.add(note); listening.streams.set(k, st);
    if (!redraw) redraw = setTimeout(() => { redraw = 0; render(); }, 300);
  }
  function listen(sec = 8) {
    listening = { streams: new Map(), done: false, until: performance.now() + sec * 1000 };
    clearTimeout(listen.t); listen.t = setTimeout(() => { if (listening) listening.done = true; render(); }, sec * 1000);
    render();
  }
  const inName = (id) => input.inputs.find((i) => i.id === id)?.name || 'a MIDI port';
  function guessFor(st) {
    // a linked synth on that channel (on the first port that uses it), else something that suits the notes
    const first = [...(listening?.streams.values() || [])].filter((y) => y.ch === st.ch).sort((a, b) => a.port.localeCompare(b.port))[0];
    if (!first || first === st) for (const [id, o] of S.owned) if ((o.ch || 1) === st.ch) return 'gear:' + id;
    if (st.ch === 10) return engine.defs.has('studio') ? 'studio' : 'machina';   // the drum channel by convention
    if (st.hi < 55) return 'monolith';
    return 'juniper';
  }
  function addStreams(list) {
    let added = 0, full = false;
    for (const st of list) {
      const k = st.port + '|' + st.ch, v = seqPick.get(k) ?? guessFor(st); if (!v || v === 'skip') continue;
      let e;
      if (v.startsWith('gear:')) {
        const id = v.slice(5), u = engine.unit(id), own = S.owned.get(id);
        e = x.addEntry({ hw: id, inst: engine.twinCandidates(u)[0]?.inst });
        if (e && seqRoom.get(k) && own?.port) { e.midiOut = own.port; e.outCh = own.ch || 1; }
      } else e = x.addEntry({ inst: v });
      if (!e) { full = true; break; }
      e.midiIn = st.port; e.midiCh = st.ch; e.seq = true; e.budget = 'balanced'; added++;
    }
    if (clockPort) x.setClock({ port: clockPort, on: true, ahead: clockAhead, aheadMs: Math.max(30, x.lookahead() + 10) });
    listening = null; x.renderRack();
    x.status(full ? `Your desk is full: ${added} of the sequencer's parts went on it.` : `${added} part${added === 1 ? '' : 's'} from your sequencer on your desk${clockPort ? (clockAhead ? ', and it runs a lookahead ahead of the room so every part lands on the beat' : ', following the room\'s clock') : ''}.`);
    render();
  }
  function seqSection() {
    const defs = [...engine.defs.values()].filter((d) => !d.internal && !d.lib);
    if (!listening) return h('div', { class: 'gearrow seqadd' }, h('span', {}, h('b', {}, 'Add a sequencer'),
      h('small', {}, 'A Cirklon, Hapax, OXI or a DAW sending many parts over USB. Set its tracks to its USB ports (a Cirklon: usb1–usb6) and its clock to follow USB, start it playing, then listen: every port and channel with notes gets an instrument on your desk.')),
      h('button', { class: 'btn small hot', onclick: () => listen() }, 'Listen for it'));
    const list = [...listening.streams.values()].sort((a, b) => a.port.localeCompare(b.port) || a.ch - b.ch);
    const rows = list.map((st) => {
      const k = st.port + '|' + st.ch, v = seqPick.get(k) ?? guessFor(st), gearId = v.startsWith('gear:') ? v.slice(5) : null;
      const pick = h('select', { class: 'lcdsel', 'aria-label': `What plays ${inName(st.port)} channel ${st.ch}`, onchange: (ev) => { seqPick.set(k, ev.target.value); render(); } },
        S.owned.size ? h('optgroup', { label: 'My gear' }, ...[...S.owned.keys()].map((id) => h('option', { value: 'gear:' + id, selected: v === 'gear:' + id }, `My ${model(id)}`))) : null,
        h('optgroup', { label: 'A software instrument' }, ...defs.map((d) => h('option', { value: d.id, selected: v === d.id }, d.name))),
        h('option', { value: 'skip', selected: v === 'skip' }, 'Leave it out'));
      return h('div', { class: 'seqrow' }, h('b', {}, `${inName(st.port)} · ch ${st.ch}`), h('small', { class: 'help' }, `${st.n} note${st.n === 1 ? '' : 's'}${st.n ? ` · ${NOTE(st.lo)}–${NOTE(st.hi)}` : ''}`), pick,
        gearId && S.owned.get(gearId)?.port ? h('label', { class: 'help', title: `Your ${model(gearId)} gets its notes from MEGAjam, at the moment the band hears them, so you hear the same beat they do. Otherwise it plays straight from the sequencer, a lookahead ahead of the band.` },
          h('input', { type: 'checkbox', checked: !!seqRoom.get(k), onchange: (ev) => seqRoom.set(k, ev.target.checked) }), ' MEGAjam plays it, in time with the band') : h('span', {}));   // keeps the columns lined up
    });
    const outs = input.outputs, guessOut = clockPort ?? (outs.find((o) => list.some((st) => squash(inName(st.port)).slice(0, 5) === squash(o.name).slice(0, 5)))?.id || '');
    if (clockPort == null && guessOut) clockPort = guessOut;
    const clockSel = h('select', { class: 'lcdsel', 'aria-label': 'Send the room clock to', onchange: (ev) => { clockPort = ev.target.value; } }, h('option', { value: '' }, 'no clock'), ...outs.map((o) => h('option', { value: o.id, selected: o.id === clockPort }, o.name)));
    return h('div', { class: 'gearrow seqadd open' },
      h('span', {}, h('b', {}, listening.done ? `Heard ${list.length} part${list.length === 1 ? '' : 's'}` : `Listening… ${list.length} part${list.length === 1 ? '' : 's'} so far`), h('small', {}, list.length ? 'Say what plays each one. Linked synths are matched by channel.' : 'Nothing yet: is the sequencer playing, and sending to its USB ports?')),
      listening.done ? h('button', { class: 'btn small ghost', onclick: () => listen() }, 'Listen again') : null,
      h('button', { class: 'btn small ghost', onclick: () => { listening = null; render(); } }, 'Cancel'),
      h('div', { class: 'seqrows' }, ...rows),
      list.length ? h('div', { class: 'row seqclock' }, h('span', { class: 'help' }, 'Room clock to'), clockSel,
        h('label', { class: 'help', title: 'MEGAjam sends the sequencer its clock one lookahead early. What it plays reaches the room one lookahead later, so it lands on the beat for everyone. Nobody is playing it by hand, so the head start costs nothing.' },
          h('input', { type: 'checkbox', checked: clockAhead, onchange: (ev) => { clockAhead = ev.target.checked; } }), ' run it a lookahead ahead (lands on the beat for everyone)'),
        h('span', { style: 'flex:1' }), h('button', { class: 'btn small hot', onclick: () => addStreams(list) }, `Put ${list.filter((st) => (seqPick.get(st.port + '|' + st.ch) ?? guessFor(st)) !== 'skip').length} on my desk`)) : null);
  }
  // the top of the My gear drawer
  function render(box = document.querySelector('#gearMine')) {
    if (!box) return;
    if (!input.midi) {
      box.replaceChildren(h('div', { class: 'gearrow' }, h('span', {}, h('b', {}, 'Plug in your synths'), h('small', {}, 'USB, or through a MIDI interface. MEGAjam finds them and you say which is which.')),
        h('button', { class: 'btn small hot', onclick: async () => { await input.enableMIDI(); render(box); check(); } }, 'Turn on MIDI')));
      return;
    }
    const linked = [...S.owned.entries()].map(([id, o]) => {
      const u = engine.unit(id); if (!u) return null;
      const twin = engine.defs.get(engine.twinCandidates(u)[0]?.inst);
      const here = input.outputs.some((p) => p.id === o.port), onDesk = x.rack().some((e) => e.cfg.hw === id);
      const mine = x.rack().filter((e) => e.cfg.hw === id).flatMap((e) => live(e.r));
      const theirs = [...S.players].filter(([pid, pl]) => (pl.rack || []).some((y) => y.cfg?.hw === id && S.routes.get(x.key(pid, y.r))?.same)).map(([pid]) => pid);
      const ch = h('select', { class: 'lcdsel', 'aria-label': `${u.model}'s MIDI channel`, onchange: (ev) => x.setOwned(id, { ...o, ch: +ev.target.value }) }, ...Array.from({ length: 16 }, (_, i) => h('option', { value: i + 1, selected: (o.ch || 1) === i + 1 }, `ch ${i + 1}`)));
      return h('div', { class: 'gearrow linked' + (here ? '' : ' gone') },
        h('span', {}, h('b', {}, u.model), h('small', {}, [here ? portName(o.port) : 'not plugged in', `the band hears ${twin?.name || 'a twin'} if they don't have one`, KNOBS[u.dump?.params] || null, ver.get(id) ? `firmware ${ver.get(id)}` : null].filter(Boolean).join(' · '))),
        ch,
        mine.length ? h('span', { class: 'chip', title: 'They play your part on their own' }, `${names(mine)} on theirs`) : null,
        theirs.length ? h('span', { class: 'chip' }, `playing ${names(theirs)}'s`) : null,
        theirs.length && input.sysex ? h('button', { class: 'btn small ghost', title: 'Ask for their current sound again', onclick: () => { for (const pid of theirs) for (const y of S.players.get(pid)?.rack || []) if (y.cfg?.hw === id) room.send({ k: 'preq', r: y.r }, pid); } }, 'Get their sound') : null,
        mine.length ? h('button', { class: 'btn small ghost', title: 'Copy your current sound to theirs again', onclick: () => { for (const e of x.rack()) if (e.cfg.hw === id) sharePatch(e, live(e.r), 'again'); } }, 'Send my sound') : null,
        onDesk ? h('span', { class: 'help' }, 'on your desk') : h('button', { class: 'btn small hot', disabled: !here, onclick: () => play(id) }, 'Play it'),
        h('button', { class: 'btn small ghost', 'aria-expanded': String(setupOpen === id), onclick: () => { setupOpen = setupOpen === id ? null : id; render(); } }, setupOpen === id ? 'Hide setup' : 'Set up'),
        h('button', { class: 'btn small ghost', onclick: () => x.setOwned(id, null) }, 'Unlink'),
        setupOpen === id ? setupPanel(id) : null);
    }).filter(Boolean);
    const free = input.outputs.filter((p) => ![...S.owned.values()].some((v) => v.port === p.id));
    const found = free.map((p) => {
      const g = guessUnit(p.name);
      const pick = h('select', { class: 'lcdsel', 'aria-label': `Which synth is on ${p.name}` },
        h('option', { value: '' }, g ? `${g.model}?` : 'Which synth is this?'), ...(g ? [h('option', { value: g.id, selected: true }, `${g.maker} ${g.model}`)] : []),
        h('option', { value: '__find' }, 'Find it in the list below…'));
      pick.onchange = () => { if (pick.value === '__find') { S.linkPort = p.id; pick.value = g ? g.id : ''; x.findUnit(); } };
      return h('div', { class: 'gearrow' }, h('span', {}, h('b', {}, p.name), h('small', {}, g ? `looks like a ${g.maker} ${g.model}` : 'a MIDI port')), pick,
        h('button', { class: 'btn small' + (g ? ' hot' : ''), onclick: () => { const id = pick.value; if (id && id !== '__find') link(id, p.id, 1); else { S.linkPort = p.id; x.findUnit(); } } }, 'Link'));
    });
    const sysex = h('div', { class: 'gearrow sysex' }, h('span', {}, h('b', {}, input.sysex ? '✓ Sounds are shared' : 'Share sounds with the same synth'),
      h('small', {}, input.sysex ? "When a bandmate has the same model, their current sound is copied into yours (and yours into theirs), and knob moves follow." : 'Lets MEGAjam ask your synth for its current sound (SysEx) and load a bandmate’s into yours. The browser asks you once.')),
      input.sysex ? null : h('button', { class: 'btn small', onclick: allowSysex }, 'Allow SysEx'));
    box.replaceChildren(
      ...(linked.length ? [h('h3', {}, 'Linked')] : []), ...linked,
      h('h3', {}, 'Sequencer'), seqSection(),
      ...(found.length ? [h('h3', {}, 'Found on MIDI')] : []), ...found,
      !linked.length && !found.length ? h('p', { class: 'help' }, 'No MIDI devices yet: plug one in, or pick your synth in the list below and choose its port.') : null,
      sysex);
  }

  return { heard, listen, addStreams, test, stepsFor, guessUnit, relayRaw, onSysex, receiveRaw, receiveSx, onReal, sharePatch, realMsg, check, render, link, play, allowSysex, hostsOf: live, onPreq: (p, m) => sharePatch(x.entry(m.r), [p.id], 'again'), identify, ver };
}
