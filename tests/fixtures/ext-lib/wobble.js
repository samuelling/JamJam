// A tiny library instrument (same contract as JamJam's instruments/): a vibrato sine.
const PARAMS = [{ id: 'rate', name: 'Wobble', min: 0, max: 12, def: 5, unit: 'Hz' }, { id: 'level', name: 'Level', min: 0, max: 1, def: 0.5 }];
export default {
  id: 'wobble', name: 'Wobble', family: 'Test poly', params: PARAMS, presets: { soft: { rate: 3 }, fast: { rate: 10 } },
  create(ctx, out, init = {}) {
    const p = { rate: init.rate ?? 5, level: init.level ?? 0.5 }, voices = new Map(), bus = ctx.createGain();
    bus.gain.value = p.level; bus.connect(out);
    return {
      noteOn(n, v, t) {
        const o = ctx.createOscillator(), g = ctx.createGain(), l = ctx.createOscillator(), lg = ctx.createGain();
        o.frequency.value = 440 * 2 ** ((n - 69) / 12); l.frequency.value = p.rate; lg.gain.value = 6;
        l.connect(lg).connect(o.frequency); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.3 * v / 127, t + 0.01);
        o.connect(g).connect(bus); o.start(t); l.start(t); voices.set(n, { o, g, l });
      },
      noteOff(n, t) { const x = voices.get(n); if (!x) return; voices.delete(n); x.g.gain.setTargetAtTime(0, t, 0.05); x.o.stop(t + 0.4); x.l.stop(t + 0.4); },
      set(id, v, t) { p[id] = v; if (id === 'level') bus.gain.setTargetAtTime(v, t, 0.01); },
      allOff(t) { for (const n of [...voices.keys()]) this.noteOff(n, t); },
      dispose() { bus.disconnect(); },
    };
  },
};
