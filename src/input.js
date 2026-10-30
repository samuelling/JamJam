// Playing: a MIDI keyboard (Web MIDI), the computer keyboard, or the on-screen keys.
// The sustain pedal is resolved here, before anything goes on the network, so the wire only ever carries
// plain note-ons and note-offs (and a sustained note's note-off is sent when the pedal comes up).

const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17 };

export class Input {
  constructor({ note, cc, bend, status }) {
    this.cb = { note, cc, bend, status };
    this.octave = 4; this.velocity = 100;
    this.sustain = false; this.sustained = new Set(); this.down = new Set();
    this.keysDown = new Map();
    this.midi = null; this.inputs = []; this.outputs = []; this.selectedIn = 'all';
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => { for (const n of [...this.down]) this.release(n); for (const n of [...this.sustained]) this.release(n, true); });
  }

  press(note, vel) {
    if (note < 0 || note > 127) return;
    if (this.down.has(note) || this.sustained.has(note)) { this.sustained.delete(note); this.cb.note(false, note, 0); }
    this.down.add(note);
    this.cb.note(true, note, vel);
  }
  release(note, force = false) {
    if (!this.down.has(note) && !(force && this.sustained.has(note))) return;
    this.down.delete(note);
    if (this.sustain && !force) { this.sustained.add(note); return; }
    this.sustained.delete(note);
    this.cb.note(false, note, 0);
  }
  pedal(on) {
    this.sustain = on;
    if (!on) for (const n of [...this.sustained]) { this.sustained.delete(n); if (!this.down.has(n)) this.cb.note(false, n, 0); }
  }

  onKey(e, isDown) {
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|SELECT|TEXTAREA/.test(tag) && e.target.type !== 'range') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); if (!e.repeat) this.pedal(isDown); return; }
    if (!isDown) {
      const n = this.keysDown.get(k);
      if (n !== undefined) { this.keysDown.delete(k); this.release(n); }
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
    this.press(note, this.velocity);
  }

  async enableMIDI() {
    if (!navigator.requestMIDIAccess) { this.cb.status('Web MIDI isn\'t available in this browser (try Chrome, Edge or Firefox).'); return false; }
    try { this.midi = await navigator.requestMIDIAccess({ sysex: false }); }
    catch (_) { this.cb.status('MIDI access was refused.'); return false; }
    const refresh = () => {
      this.inputs = [...this.midi.inputs.values()];
      this.outputs = [...this.midi.outputs.values()];
      for (const i of this.inputs) i.onmidimessage = (m) => this.onMIDI(i, m);
      this.cb.status();
    };
    this.midi.onstatechange = refresh;
    refresh();
    return true;
  }

  onMIDI(port, { data }) {
    if (this.selectedIn !== 'all' && port.id !== this.selectedIn) return;
    const [st, a = 0, b = 0] = data, type = st & 0xf0;
    if (type === 0x90 && b > 0) this.press(a, b);
    else if (type === 0x80 || (type === 0x90 && b === 0)) this.release(a);
    else if (type === 0xb0) {
      if (a === 64) this.pedal(b >= 64);
      else if (a === 123 || a === 120) { for (const n of [...this.down]) this.release(n); this.pedal(false); }
      else this.cb.cc(a, b);
    } else if (type === 0xe0) this.cb.bend((((b << 7) | a) - 8192) / 8192 * 2);
  }
}

// MIDI to the jammer's own hardware synth, scheduled with Web MIDI timestamps so it plays in lockstep too
export function sendToHardware(port, bytes, localPerfMs) {
  if (!port) return;
  try { port.send(bytes, Math.max(performance.now(), localPerfMs)); } catch (_) {}
}
