// A factory module: one file, several instruments, chosen by the "arg" in megajam.json.
export default async function (arg) {
  const f0 = +arg || 440;
  return {
    name: `Beep ${f0}`, family: 'Test bleep', params: [{ id: 'level', name: 'Level', min: 0, max: 1, def: 0.4 }], presets: { beep: {} },
    contentHash: String(f0),
    create(ctx, out, init = {}) {
      const g = ctx.createGain(); g.gain.value = init.level ?? 0.4; g.connect(out);
      return {
        noteOn(n, v, t) { const o = ctx.createOscillator(), e = ctx.createGain(); o.type = 'square'; o.frequency.value = f0 * 2 ** ((n - 69) / 12); e.gain.setValueAtTime(0.2, t); e.gain.setTargetAtTime(0, t, 0.05); o.connect(e).connect(g); o.start(t); o.stop(t + 0.4); },
        noteOff() {}, set(id, v, t) { if (id === 'level') g.gain.setTargetAtTime(v, t, 0.01); }, allOff() {}, dispose() { g.disconnect(); },
      };
    },
  };
}
