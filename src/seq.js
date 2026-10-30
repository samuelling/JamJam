// A step sequencer that runs in lockstep: every browser holds the same pattern and plays it from the shared clock,
// so no notes travel for sequenced parts at all, only edits. An edit is stamped with a room time `at` far enough
// ahead (lookahead + the scheduling horizon) that it reaches every browser before any of them has scheduled the
// step it affects, and every browser applies it when its scheduler reaches `at`. So every browser plays exactly the
// same trigs, with the same parameter locks, on the same steps.
//
// Pattern: up to 64 sixteenth-note steps per track, a shared length (16, 32, 48 or 64), trigs on/off, and per-trig
// parameter locks ("p-locks"), the way the Swedish grooveboxes do it: hold a trig, turn a knob, and that one step
// plays with that setting.

export const MAX_STEPS = 64;

export class StepSeq {
  constructor(tracks) {
    this.nt = tracks;
    this.len = 16;
    this.trig = Array.from({ length: tracks }, () => new Uint8Array(MAX_STEPS));
    this.locks = new Map();        // "track:step" -> {param: value}
    this.playing = false; this.startBeat = 0; this.stopBeat = Infinity;
    this.pending = [];             // [{at, op}] sorted by at
    this.next = null;              // next step number to schedule (counted from startBeat)
    this.pos = -1; this.posT = 0;  // last scheduled step (for the playhead)
    this.rev = 0;                  // bumps whenever the pattern changes (UI refresh)
  }

  queue(at, op) {
    let i = this.pending.length;
    while (i > 0 && this.pending[i - 1].at > at) i--;
    this.pending.splice(i, 0, { at, op });
  }
  applyUpTo(t) { while (this.pending.length && this.pending[0].at <= t) this.apply(this.pending.shift().op); }

  apply(op) {
    const [k, a, b, c, d] = op;
    const ok = (tr, st) => tr >= 0 && tr < this.nt && st >= 0 && st < MAX_STEPS;
    if (k === 't' && ok(a, b)) this.trig[a][b] = c ? 1 : 0;
    else if (k === 'l' && ok(a, b)) {
      const key = a + ':' + b, cur = this.locks.get(key) || {};
      if (d == null) delete cur[c]; else cur[c] = d;
      if (Object.keys(cur).length) this.locks.set(key, cur); else this.locks.delete(key);
    } else if (k === 'L' && ok(a, b)) this.locks.delete(a + ':' + b);
    else if (k === 'len') this.len = [16, 32, 48, 64].includes(a) ? a : 16;
    else if (k === 'clr' && a >= 0 && a < this.nt) { this.trig[a].fill(0); for (const key of [...this.locks.keys()]) if (+key.split(':')[0] === a) this.locks.delete(key); }
    else if (k === 'play') { this.playing = true; this.startBeat = a; this.stopBeat = Infinity; this.next = null; }
    else if (k === 'stop') { this.stopBeat = a; }
    this.rev++;
  }

  // the steps due in (from, to] of room time, applying edits as their times come up
  due(tempo, now, horizon) {
    const out = [];
    this.applyUpTo(now);
    if (!this.playing) return out;
    if (this.next == null) this.next = Math.max(0, Math.ceil((tempo.beatAt(now) - this.startBeat) * 4 - 1e-9));
    for (let guard = 0; guard < 64; guard++) {
      const beat = this.startBeat + this.next / 4;
      const t = tempo.timeOf(beat);
      if (t > horizon) break;
      this.applyUpTo(t);
      if (beat >= this.stopBeat) { this.playing = false; this.pos = -1; this.rev++; break; }
      const step = this.next % this.len;
      if (t >= now - 30) {
        const trigs = [];
        for (let tr = 0; tr < this.nt; tr++) if (this.trig[tr][step]) trigs.push({ track: tr, locks: this.locks.get(tr + ':' + step) || null });
        out.push({ t, step, trigs });
      }
      this.pos = step; this.posT = t;
      this.next++;
    }
    return out;
  }

  snapshot() {
    return {
      len: this.len,
      tr: this.trig.map((a) => [...a].join('')),
      lk: [...this.locks.entries()],
      play: this.playing ? this.startBeat : null, stop: this.stopBeat === Infinity ? null : this.stopBeat,
      pend: this.pending.map((p) => [p.at, p.op]),
    };
  }
  load(s) {
    if (!s) return;
    this.len = [16, 32, 48, 64].includes(s.len) ? s.len : 16;
    (s.tr || []).forEach((str, i) => { if (i < this.nt) for (let j = 0; j < MAX_STEPS; j++) this.trig[i][j] = str[j] === '1' ? 1 : 0; });
    this.locks = new Map((s.lk || []).filter((x) => Array.isArray(x) && typeof x[1] === 'object'));
    this.playing = s.play != null; this.startBeat = s.play || 0; this.stopBeat = s.stop == null ? Infinity : s.stop; this.next = null;
    this.pending = []; for (const [at, op] of s.pend || []) this.queue(at, op);
    this.rev++;
  }
}
