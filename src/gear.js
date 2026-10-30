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
  function relayRaw(bytes, ch) {
    for (const e of x.targetsFor(ch)) {
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
        h('button', { class: 'btn small ghost', onclick: () => x.setOwned(id, null) }, 'Unlink'));
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
      ...(found.length ? [h('h3', {}, 'Found on MIDI')] : []), ...found,
      !linked.length && !found.length ? h('p', { class: 'help' }, 'No MIDI devices yet: plug one in, or pick your synth in the list below and choose its port.') : null,
      sysex);
  }

  return { guessUnit, relayRaw, onSysex, receiveRaw, receiveSx, onReal, sharePatch, realMsg, check, render, link, play, allowSysex, hostsOf: live, onPreq: (p, m) => sharePatch(x.entry(m.r), [p.id], 'again'), identify, ver };
}
