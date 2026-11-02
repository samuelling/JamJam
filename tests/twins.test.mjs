// Twin ranking over the hardware catalog, with no browser: node tests/twins.test.mjs
import fs from 'node:fs';
import { Engine } from '../src/engine.js';
const hw = JSON.parse(fs.readFileSync(new URL('../instruments/hardware.json', import.meta.url)));
const e = Object.create(Engine.prototype);
e.hardware = hw;
e.defs = new Map(['juniper', 'monolith', 'poly', 'tine', 'machina'].map((id) => [id, { id, name: id, params: [], presets: {} }]));
e.defs.set('none', { id: 'none', internal: true });
e.defs.set('acid', { id: 'acid', name: 'acid', params: [], presets: {}, traits: { arch: ['subtractive'], osc: ['vco'], filter: ['diode'], voices: 1 } });
e.defs.set('ensemble', { id: 'ensemble', name: 'ensemble', params: [], presets: {}, traits: { arch: ['strings'], osc: ['divide'], voices: 128 } });
let fail = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fail++; };
const top = (id) => { const u = hw.hardware.find((x) => x.id === id); return e.twinCandidates(u); };
const ids = new Set();
for (const u of hw.hardware) {
  if (ids.has(u.id)) check(false, 'duplicate id ' + u.id); ids.add(u.id);
  if (!hw.families[u.family]) check(false, `${u.id}: unknown family ${u.family}`);
  if (!e.twinCandidates(u).length) check(false, `${u.id}: no twin`);
}
check(hw.hardware.length >= 200, `the catalog holds ${hw.hardware.length} units`);
check(top('roland-juno-106')[0].inst === 'juniper', 'Juno-106 → Juniper');
check(top('moog-moog-one')[0].inst !== 'monolith' && top('moog-moog-one').find((c) => c.inst === 'monolith'), `Moog One → a poly first (${top('moog-moog-one').map((c) => c.inst + ' ' + c.score.toFixed(2)).join(', ')})`);
check(top('moog-minimoog-d')[0].inst === 'monolith', 'Minimoog → Monolith');
check(top('roland-tr-808')[0].inst === 'machina', 'TR-808 → Machina');
check(top('yamaha-dx7')[0].inst === 'tine', 'DX7 → Tine');
check(top('arp-solina-string-ensemble')[0].inst === 'ensemble', 'Solina → Ensemble');
check(top('arp-solina-string-ensemble')[1].inst === 'juniper', 'with Juniper next');
check(top('roland-tb-303')[0].inst === 'acid' && top('behringer-td-3')[0].inst === 'acid', 'TB-303 and its clones → Acid Line Lite');
check(top('moog-taurus')[0].inst !== 'acid', `but a Taurus isn't an acid box (${top('moog-taurus')[0].inst})`);
// a library instrument that declares it models a unit wins for that unit
e.defs.set('lab/onemodel', { id: 'lab/onemodel', lib: 'lab', name: 'One Model', family: 'Analog polysynth', traits: { arch: ['subtractive'], osc: ['vco'], filter: ['ladder'], voices: 16, models: ['moog-moog-one'] }, params: [], presets: {} });
check(top('moog-moog-one')[0].inst === 'lab/onemodel', 'a library instrument modelled on the unit ranks first');
check(top('sequential-prophet-5')[0].inst !== 'lab/onemodel', 'but not for other units');
console.log(fail ? `${fail} FAILED` : 'ALL PASS'); process.exit(fail ? 1 : 0);
