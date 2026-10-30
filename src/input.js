// Playing: MIDI keyboards and controllers (Web MIDI, every channel), the computer keyboard, or the on-screen keys.
// Each note is reported with its MIDI channel (0 = computer or on-screen keys), so one corner can hold several
// instruments: a drum machine listening on channel 10 and a synth on channel 1, say.
// The sustain pedal is resolved here, before anything goes on the network, so the wire only ever carries
// plain note-ons and note-offs (a sustained note's note-off is sent when the pedal comes up).

const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17 };
// a key is a note on a channel of a port: two ports (a sequencer's usb1 and usb2, say) can both use channel 3
const slots = new Map();   // port id -> a small number
export const srcOf = (ch, port = '') => (port ? (slots.get(port) || slots.set(port, slots.size + 1).get(port)) * 17 : 0) + ch;
const portOfSrc = (src) => { const n = Math.floor(src / 17); if (!n) return ''; for (const [id, k] of slots) if (k === n) return id; return ''; };
const key = (ch, note, port = '') => srcOf(ch, port) * 128 + note;
const NRPN_CC = new Set([99, 98, 101, 100, 6, 38, 96, 97]);   // parameter number, data entry, increment/decrement

// read once at load: the app rewrites the address bar to ?room=… after you walk in
const MIDI_MOCK = typeof location !== 'undefined' && new URLSearchParams(location.search).get('midimock') === '1';

export class Input {
  constructor({ note, cc, bend, status, plugged, raw, sysex, heard }) {
    this.cb = { note, cc, bend, status, plugged, raw, sysex, heard };
    this.sysex = false;            // SysEx access granted (asked for only when patches are shared)
    this.nrpn = new Map();         // channel -> a parameter message being gathered (CC 99/98/6/38 arrive one by one)
    this.octave = 4; this.velocity = 100;
    this.sustain = new Set();     // channels with the pedal down
    this.sustained = new Set();   // keys held only by the pedal
    this.down = new Set();
    this.keysDown = new Map();
    this.midi = null; this.inputs = []; this.outputs = []; this.lastChannel = 0; this.padKeys = null;
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.panic());
  }

  press(note, vel, ch = 0, port = '') {
    if (note < 0 || note > 127) return;
    const k = key(ch, note, port);
    if (this.down.has(k) || this.sustained.has(k)) { this.sustained.delete(k); this.cb.note(false, note, 0, ch, port); }
    this.down.add(k);
    this.cb.note(true, note, vel, ch, port);
  }
  release(note, ch = 0, force = false, port = '') {
    const k = key(ch, note, port);
    if (!this.down.has(k) && !(force && this.sustained.has(k))) return;
    this.down.delete(k);
    if (this.sustain.has(srcOf(ch, port)) && !force) { this.sustained.add(k); return; }
    this.sustained.delete(k);
    this.cb.note(false, note, 0, ch, port);
  }
  pedal(on, ch = 0, port = '') {
    const src = srcOf(ch, port);
    if (on) { this.sustain.add(src); return; }
    this.sustain.delete(src);
    for (const k of [...this.sustained]) if (Math.floor(k / 128) === src) { this.sustained.delete(k); if (!this.down.has(k)) this.cb.note(false, k % 128, 0, ch, port); }
  }
  panic() {
    for (const k of [...this.down, ...this.sustained]) { this.down.delete(k); this.sustained.delete(k); const src = Math.floor(k / 128); this.cb.note(false, k % 128, 0, src % 17, portOfSrc(src)); }
    this.sustain.clear(); this.keysDown.clear();
  }

  onKey(e, isDown) {
    const t = e.target, tag = (t && t.tagName) || '';
    if (/INPUT|SELECT|TEXTAREA/.test(tag) && t.type !== 'range') return;
    if (t && t.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); if (!e.repeat) this.pedal(isDown, 0); return; }
    if (!isDown) {
      const n = this.keysDown.get(k);
      if (n !== undefined) { this.keysDown.delete(k); this.release(n, 0); }
      return;
    }
    if (e.repeat) return;
    // a pad instrument on the desk: the keys are its 4×4 grid, laid out like it (Z X C V the bottom row, up to 1 2 3 4)
    if (this.padKeys && this.padKeys[k] !== undefined) { const note = this.padKeys[k]; this.keysDown.set(k, note); this.press(note, this.velocity, 0); return; }
    if (k === 'z') { this.octave = Math.max(0, this.octave - 1); this.cb.status(); return; }
    if (k === 'x') { this.octave = Math.min(8, this.octave + 1); this.cb.status(); return; }
    if (k === 'c') { this.velocity = Math.max(20, this.velocity - 15); this.cb.status(); return; }
    if (k === 'v') { this.velocity = Math.min(127, this.velocity + 15); this.cb.status(); return; }
    if (KEYMAP[k] === undefined) return;
    const note = 12 * (this.octave + 1) + KEYMAP[k];
    this.keysDown.set(k, note);
    this.press(note, this.velocity, 0);
  }

  // SysEx needs its own permission: asked for when you share patches between two of the same synth, not before
  async enableSysex() {
    if (this.sysex) return true;
    if (MIDI_MOCK) { if (!this.midi) await this.enableMIDI(); this.sysex = true; return true; }
    if (!navigator.requestMIDIAccess) return false;
    try { const m = await navigator.requestMIDIAccess({ sysex: true }); this.midi = null; await this.enableMIDI(m); this.sysex = true; return true; }
    catch (_) { this.cb.status('SysEx access was refused: patches can\'t be shared, but notes and knob moves still are.'); return false; }
  }

  async enableMIDI(granted) {
    // testing aid: ?midimock=1 gives two fake output ports that record what they're sent (window.JJ.midiLog)
    if (MIDI_MOCK) {
      this.mockLog = [];
      // a mock port can answer like a synth (tests set input.mockReply(data, portId) -> replies)
      const port = (id, name) => ({ id, name, send: (data, ts) => {
        this.mockLog.push({ port: id, data: [...data], ts: ts ?? performance.now(), sent: performance.now() });
        const rep = this.mockReply?.(data, id); if (rep) setTimeout(() => { for (const d of rep) this.onMIDI({ data: d, target: { id: 'in:' + id } }); }, 15);
      } });
      this.midi = { inputs: new Map(), outputs: new Map([['mock-a', port('mock-a', 'Mock Synth A')], ['mock-b', port('mock-b', 'Mock Drum Machine')]]) };
      this.inputs = []; this.outputs = [...this.midi.outputs.values()];
      this.cb.status();
      return true;
    }
    if (!navigator.requestMIDIAccess) { this.cb.status('Web MIDI isn\'t available in this browser (try Chrome, Edge or Firefox).'); return false; }
    try { this.midi = granted || await navigator.requestMIDIAccess({ sysex: false }); }
    catch (_) { this.cb.status('MIDI access was refused.'); return false; }
    let known = null;
    const refresh = () => {
      const live = [...this.midi.inputs.values()].filter((i) => i.state !== 'disconnected');
      // say so when a device is plugged in or pulled out after MIDI is on (not for the ones already there)
      if (known) { for (const i of live) if (!known.has(i.id)) this.cb.plugged?.(i.name || 'A MIDI device', true); for (const [id, n] of known) if (!live.some((i) => i.id === id)) this.cb.plugged?.(n, false); }
      known = new Map(live.map((i) => [i.id, i.name || 'MIDI device']));
      this.inputs = live;
      this.outputs = [...this.midi.outputs.values()];
      for (const i of this.inputs) i.onmidimessage = (m) => this.onMIDI(m);
      this.cb.status();
    };
    this.midi.onstatechange = refresh;
    refresh();
    return true;
  }

  onMIDI({ data, target }) {
    const [st, a = 0, b = 0] = data, type = st & 0xf0, ch = (st & 15) + 1, port = target?.id || '';
    if (st === 0xf0) { this.cb.sysex?.([...data], port); return; }
    if (type < 0x80 || type > 0xe0) return;
    this.lastChannel = ch;
    if (type === 0x90 && b > 0) { this.cb.heard?.(port, ch, a); this.press(a, b, ch, port); }
    else if (type === 0x80 || (type === 0x90 && b === 0)) this.release(a, ch, false, port);
    else if (type === 0xb0) {
      if (NRPN_CC.has(a)) { this.gather(ch, st, a, b, port); return; }
      this.flush(ch, port);
      if (a === 64) this.pedal(b >= 64, ch, port);
      else if (a === 123 || a === 120) { const src = srcOf(ch, port); for (const k of [...this.down]) if (Math.floor(k / 128) === src) this.release(k % 128, ch, false, port); this.pedal(false, ch, port); }
      else { this.cb.cc(a, b, ch, port); this.cb.raw?.([st, a, b], ch, port); }
    } else if (type === 0xe0) this.cb.bend((((b << 7) | a) - 8192) / 8192 * 2, ch, port);
    else if (type === 0xc0 || type === 0xd0) { this.flush(ch, port); this.cb.raw?.([st, a], ch, port); }   // program change, channel pressure
    else if (type === 0xa0) this.cb.raw?.([st, a, b], ch, port);                                           // poly pressure
  }
  // NRPN and RPN: a parameter number (CC 99/98 or 101/100) then a value (CC 6, maybe 38), sent as separate messages.
  // They travel as one group, so a bandmate's synth can't get the value of one parameter applied to another.
  gather(ch, st, a, b, port = '') {
    const src = srcOf(ch, port);
    let g = this.nrpn.get(src); if (!g) this.nrpn.set(src, (g = { bytes: [], timer: 0 }));
    if ((a === 99 || a === 101) && g.bytes.some((x, i) => i % 3 === 1 && (x === 6 || x === 38))) this.flush(ch, port);   // a new parameter starts
    g.bytes.push(st, a, b);
    clearTimeout(g.timer);
    if (a === 38) this.flush(ch, port); else g.timer = setTimeout(() => this.flush(ch, port), 4);
  }
  flush(ch, port = '') {
    const g = this.nrpn.get(srcOf(ch, port)); if (!g || !g.bytes.length) return;
    clearTimeout(g.timer); const bytes = g.bytes; g.bytes = [];
    this.cb.raw?.(bytes, ch, port);
  }
}

// MIDI out, scheduled with Web MIDI timestamps (performance.now() time) so it lands in lockstep with the room
export function sendToHardware(port, bytes, localPerfMs) {
  if (!port) return;
  try { port.send(bytes, Math.max(performance.now(), localPerfMs)); } catch (_) {}
}
// MEGAjam's pitch bend (semitones, ±2 full scale) as a 14-bit MIDI bend message
export function bendBytes(ch, semis) {
  const v = Math.max(0, Math.min(16383, Math.round(8192 + (semis / 2) * 8191)));
  return [0xe0 | ((ch - 1) & 15), v & 127, v >> 7];
}
