// Playing: MIDI keyboards and controllers (Web MIDI, every channel), the computer keyboard, or the on-screen keys.
// Each note is reported with its MIDI channel (0 = computer or on-screen keys), so one corner can hold several
// instruments: a drum machine listening on channel 10 and a synth on channel 1, say.
// The sustain pedal is resolved here, before anything goes on the network, so the wire only ever carries
// plain note-ons and note-offs (a sustained note's note-off is sent when the pedal comes up).

const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17 };
const key = (ch, note) => ch * 128 + note;

export class Input {
  constructor({ note, cc, bend, status }) {
    this.cb = { note, cc, bend, status };
    this.octave = 4; this.velocity = 100;
    this.sustain = new Set();     // channels with the pedal down
    this.sustained = new Set();   // keys held only by the pedal
    this.down = new Set();
    this.keysDown = new Map();
    this.midi = null; this.inputs = []; this.outputs = []; this.lastChannel = 0;
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.panic());
  }

  press(note, vel, ch = 0) {
    if (note < 0 || note > 127) return;
    const k = key(ch, note);
    if (this.down.has(k) || this.sustained.has(k)) { this.sustained.delete(k); this.cb.note(false, note, 0, ch); }
    this.down.add(k);
    this.cb.note(true, note, vel, ch);
  }
  release(note, ch = 0, force = false) {
    const k = key(ch, note);
    if (!this.down.has(k) && !(force && this.sustained.has(k))) return;
    this.down.delete(k);
    if (this.sustain.has(ch) && !force) { this.sustained.add(k); return; }
    this.sustained.delete(k);
    this.cb.note(false, note, 0, ch);
  }
  pedal(on, ch = 0) {
    if (on) { this.sustain.add(ch); return; }
    this.sustain.delete(ch);
    for (const k of [...this.sustained]) if (Math.floor(k / 128) === ch) { this.sustained.delete(k); if (!this.down.has(k)) this.cb.note(false, k % 128, 0, ch); }
  }
  panic() {
    for (const k of [...this.down, ...this.sustained]) { this.down.delete(k); this.sustained.delete(k); this.cb.note(false, k % 128, 0, Math.floor(k / 128)); }
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
    if (k === 'z') { this.octave = Math.max(0, this.octave - 1); this.cb.status(); return; }
    if (k === 'x') { this.octave = Math.min(8, this.octave + 1); this.cb.status(); return; }
    if (k === 'c') { this.velocity = Math.max(20, this.velocity - 15); this.cb.status(); return; }
    if (k === 'v') { this.velocity = Math.min(127, this.velocity + 15); this.cb.status(); return; }
    if (KEYMAP[k] === undefined) return;
    const note = 12 * (this.octave + 1) + KEYMAP[k];
    this.keysDown.set(k, note);
    this.press(note, this.velocity, 0);
  }

  async enableMIDI() {
    if (!navigator.requestMIDIAccess) { this.cb.status('Web MIDI isn\'t available in this browser (try Chrome, Edge or Firefox).'); return false; }
    try { this.midi = await navigator.requestMIDIAccess({ sysex: false }); }
    catch (_) { this.cb.status('MIDI access was refused.'); return false; }
    const refresh = () => {
      this.inputs = [...this.midi.inputs.values()];
      this.outputs = [...this.midi.outputs.values()];
      for (const i of this.inputs) i.onmidimessage = (m) => this.onMIDI(m);
      this.cb.status();
    };
    this.midi.onstatechange = refresh;
    refresh();
    return true;
  }

  onMIDI({ data }) {
    const [st, a = 0, b = 0] = data, type = st & 0xf0, ch = (st & 15) + 1;
    if (type < 0x80 || type > 0xe0) return;
    this.lastChannel = ch;
    if (type === 0x90 && b > 0) this.press(a, b, ch);
    else if (type === 0x80 || (type === 0x90 && b === 0)) this.release(a, ch);
    else if (type === 0xb0) {
      if (a === 64) this.pedal(b >= 64, ch);
      else if (a === 123 || a === 120) { for (const k of [...this.down]) if (Math.floor(k / 128) === ch) this.release(k % 128, ch); this.pedal(false, ch); }
      else this.cb.cc(a, b, ch);
    } else if (type === 0xe0) this.cb.bend((((b << 7) | a) - 8192) / 8192 * 2, ch);
  }
}

// MIDI to a jammer's own hardware, scheduled with Web MIDI timestamps so it plays in lockstep with everyone's twins
export function sendToHardware(port, bytes, localPerfMs) {
  if (!port) return;
  try { port.send(bytes, Math.max(performance.now(), localPerfMs)); } catch (_) {}
}
