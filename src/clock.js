// Shared clock and shared tempo.
//
// Every jammer keeps "room time" = performance.now() + offset. The clock leader (the earliest joiner still in the room)
// defines room time; everyone else estimates their offset from ping/pong exchanges, NTP-style, trusting the sample
// with the shortest round trip (its error is at most half that round trip). If the leader leaves, the next earliest
// joiner simply keeps its own estimate, so room time carries on without a jump.

export class SharedClock {
  constructor() {
    this.offset = 0;
    this.locked = true;     // the leader is locked by definition; followers lock after their first good samples
    this.isLeader = true;
    this.samples = [];
    this.errMs = 0;         // half the best round trip: the worst-case error of the current offset
  }
  now() { return performance.now() + this.offset; }
  toLocal(roomMs) { return roomMs - this.offset; }
  setLeader(isLeader) {
    if (isLeader === this.isLeader) return;
    this.isLeader = isLeader;
    this.samples = [];
    if (isLeader) { this.locked = true; this.errMs = 0; } else this.locked = false;
  }
  // a = local send time, b = leader's room time when it answered, c = local receive time (all ms)
  sample(a, b, c) {
    if (this.isLeader) return;
    const rtt = c - a;
    if (!(rtt >= 0) || rtt > 3000) return;
    this.samples.push({ rtt, off: b - (a + c) / 2 });
    if (this.samples.length > 24) this.samples.shift();
    const best = this.samples.reduce((x, y) => (y.rtt < x.rtt ? y : x));
    const d = best.off - this.offset;
    if (!this.locked || Math.abs(d) > 25) { this.offset = best.off; this.locked = this.samples.length >= 3; }
    else this.offset += d * 0.25; // slew small corrections so scheduled notes never jump
    this.errMs = best.rtt / 2;
  }
}

// Tempo as a list of segments {at, bpm, beat0}: from room time `at`, beat = beat0 + (t - at) * bpm / 60000.
// Only the clock leader edits tempo; changes always start on a future beat, so everyone switches together.
export class Tempo {
  constructor(bpm = 96) { this.segs = [{ at: 0, bpm, beat0: 0 }]; }
  seg(t) { let s = this.segs[0]; for (const x of this.segs) { if (x.at <= t) s = x; else break; } return s; }
  bpm(t) { return this.seg(t).bpm; }
  beatAt(t) { const s = this.seg(t); return s.beat0 + ((t - s.at) * s.bpm) / 60000; }
  timeOf(beat) {
    let s = this.segs[0];
    for (const x of this.segs) { if (x.beat0 <= beat) s = x; else break; }
    return s.at + ((beat - s.beat0) * 60000) / s.bpm;
  }
  // next time >= t that lands on a multiple of `q` beats
  nextGrid(t, q) { const b = this.beatAt(t); return this.timeOf(Math.ceil(b / q - 1e-9) * q); }
  beatMs(t) { return 60000 / this.bpm(t); }
  start(now, bpm) { this.segs = [{ at: now, bpm, beat0: 0 }]; }
  // leader: schedule a tempo change on the first whole beat after `after`
  change(after, bpm) {
    const at = this.nextGrid(after, 1);
    const seg = { at, bpm, beat0: Math.round(this.beatAt(at)) };
    this.segs = this.segs.filter((s) => s.at < at).concat(seg).slice(-4);
    return seg;
  }
  load(segs) { if (Array.isArray(segs) && segs.length) this.segs = segs.map((s) => ({ at: +s.at, bpm: +s.bpm, beat0: +s.beat0 })).sort((a, b) => a.at - b.at); }
  toJSON() { return this.segs; }
}
