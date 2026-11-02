// The arpeggiator. Hold notes on an instrument that has one (its params include the arp* ids below) and your
// browser plays them one at a time on the room's beat grid. The arp runs here, on the player's computer, and sends
// ordinary notes, each stamped like a quantized note: the band hears exactly the notes you hear, on the same grid
// as the drummer, and recordings and takes get the notes themselves. Steps are counted in beats on the room's
// tempo map, so a tempo change mid-arp stays on the grid.
//
// An instrument offers it by declaring these params (see instruments/monolith.js), group 'Arp':
//   arpMode (Off, Up, Down, Up-down, As played, Random), arpRate (1/4, 1/8, 1/8T, 1/16, 1/16T, 1/32),
//   arpOct (1-4 octaves), arpGate (0.05-1 of a step; a full gate ties notes together), arpLatch (Off, On).
// Its sound engine stores and ignores them, so a preset can carry arp settings like any other knob.

const RATE_BEATS = [1, 1 / 2, 1 / 3, 1 / 4, 1 / 6, 1 / 8];

export const hasArp = (def) => !!def && def.params.some((p) => p.id === 'arpMode');
export const arpOn = (e) => (e.cfg.params.arpMode ?? 0) >= 0.5;

// the notes to step through, in order, for the held notes and settings
function order(held, p) {
  const mode = Math.round(p.arpMode), oct = Math.round(p.arpOct ?? 0) + 1;
  const base = mode === 4 ? held.map((x) => x.note) : [...new Set(held.map((x) => x.note))].sort((a, b) => a - b);
  const up = [];
  for (let o = 0; o < oct; o++) for (const n of base) if (n + 12 * o <= 127) up.push(n + 12 * o);
  if (mode === 2) return up.reverse();
  if (mode === 3 && up.length > 2) return up.concat(up.slice(1, -1).reverse());   // no repeated note at either end
  return up;
}

// One arp per rack entry. `send(type, note, vel, at)` sends a note stamped for room time `at`; `look()` is the part's
// lookahead now; `tempo` is the room's tempo map; `now()` the room clock.
export class Arp {
  constructor({ send, look, tempo, now }) {
    Object.assign(this, { send, look, tempo, now });
    this.held = [];        // [{note, vel}] in the order pressed
    this.down = 0;         // keys physically down (for latch)
    this.beat = null;      // the beat of the next step while running
    this.k = 0;            // step count since the arp started
    this.pend = null;      // a full-gate note still sounding, ended by the next step
  }
  press(note, vel, p) {
    if (p.arpLatch >= 0.5 && this.down === 0) this.held = [];   // latched: a fresh chord replaces the old one
    this.down++;
    this.held = this.held.filter((x) => x.note !== note).concat({ note, vel });
    if (this.beat == null) {
      const rate = RATE_BEATS[Math.round(p.arpRate ?? 3)] || 0.25;
      this.beat = Math.ceil(this.tempo.beatAt(this.now() + this.look()) / rate - 1e-9) * rate;
      this.k = 0;
    }
  }
  release(note, p) {
    this.down = Math.max(0, this.down - 1);
    if (p.arpLatch >= 0.5) return;
    this.held = this.held.filter((x) => x.note !== note);
    if (!this.held.length) this.stop();
  }
  stop() {
    // a held full-gate note ends where its step would have
    if (this.pend != null) { this.send('off', this.pend, 0, Math.max(this.now() + this.look(), this.beat != null ? this.tempo.timeOf(this.beat) + 2 : 0)); this.pend = null; }
    this.beat = null; this.held = []; this.down = 0;
  }
  get running() { return this.beat != null; }
  // send every step that falls before the horizon (a little past the lookahead, so a timer hiccup can't make one late)
  tick(p) {
    if (this.beat == null) return;
    if (!this.held.length || (p.arpMode ?? 0) < 0.5) { this.stop(); return; }
    const rate = RATE_BEATS[Math.round(p.arpRate ?? 3)] || 0.25, horizon = this.now() + this.look() + 60;
    for (let guard = 0; guard < 64; guard++) {
      const at = this.tempo.timeOf(this.beat);
      if (at > horizon) break;
      const seq = order(this.held, p);
      const mode = Math.round(p.arpMode);
      const note = mode === 5 ? seq[Math.floor(Math.random() * seq.length)] : seq[this.k % seq.length];
      const vel = (this.held.find((x) => x.note % 12 === note % 12) || this.held[this.held.length - 1]).vel;
      const next = this.tempo.timeOf(this.beat + rate), gate = Math.max(0.05, Math.min(1, p.arpGate ?? 0.5));
      if (at >= this.now()) {
        if (gate >= 0.99) {
          // a full gate ties into the next step: the old note ends just after the new one starts, so a mono synth
          // glides on instead of restarting, and the same note twice simply keeps sounding
          if (this.pend !== note) { this.send('on', note, vel, at); if (this.pend != null) this.send('off', this.pend, 0, at + 2); this.pend = note; }
        } else {
          if (this.pend != null) { this.send('off', this.pend, 0, at); this.pend = null; }
          this.send('on', note, vel, at); this.send('off', note, 0, Math.max(at + 8, at + (next - at) * gate));
        }
      }
      this.beat += rate; this.k++;
    }
  }
}
