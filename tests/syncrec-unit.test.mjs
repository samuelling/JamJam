// Sync record's pure parts, no browser: input-latency measurement, room-time resampling, MIDI and zip.
//   node tests/syncrec-unit.test.mjs
import * as SR from '../src/syncrec.js';
import { Tempo } from '../src/clock.js';
let fail = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fail++; };
const sr = 48000;

// an input recording of plucks that arrive 37 ms after their notes (audio interface latency), with some noise
const notes = [100, 620, 1130, 1500, 2210, 2600, 3075];
const n = sr * 4, L = new Float32Array(n), R = new Float32Array(n);
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
for (let i = 0; i < n; i++) L[i] = R[i] = rnd() * 0.004;
for (const t of notes) { const i0 = Math.round(((t + 37) / 1000) * sr); for (let k = 0; k < 6000 && i0 + k < n; k++) { const v = Math.sin(k * 0.06) * Math.exp(-k / 1500) * 0.5; L[i0 + k] += v; R[i0 + k] += v; } }
const lag = SR.measureLag({ L, R }, notes, sr);
check(Math.abs(lag - 37) <= 5, `input latency measured from note onsets (${lag} ms, true 37 ms)`);
const fixed = SR.shiftEarlier({ L, R }, lag, sr);
const onset = (() => { for (let i = 0; i < n; i++) if (Math.abs(fixed.L[i]) > 0.05) return (i / sr) * 1000; })();
check(Math.abs(onset - notes[0]) < 6, `after shifting, the first pluck sits on its note (${onset.toFixed(1)} vs ${notes[0]} ms)`);

// the audio clock runs 50 ppm fast against the room's: anchors pull the stem back onto room time
const frames = sr * 600, anchors = [];
for (let t = 0; t <= 600; t += 1) anchors.push([Math.round(t * sr * (1 + 50e-6)), 10000 + t * 1000]);
const clickAt = 599000;   // a click 599 s in on the room's clock lands at this audio frame:
const fClick = Math.round((clickAt / 1000) * sr * (1 + 50e-6));
const rec = { first: 0, L: new Float32Array(frames + sr), R: new Float32Array(frames + sr) }; rec.L[fClick] = rec.R[fClick] = 1;
const out = SR.toRoomTime(rec, anchors, 10000 + clickAt - 50, 10000 + clickAt + 50, sr);
let pk = 0, at = 0; for (let i = 0; i < out.L.length; i++) if (Math.abs(out.L[i]) > pk) { pk = Math.abs(out.L[i]); at = i; }
check(Math.abs((at / sr) * 1000 - 50) < 0.1, `a 50 ppm clock drift over 10 minutes is corrected (click at ${((at / sr) * 1000).toFixed(2)} ms of 50; uncorrected it would be 30 ms off)`);

// MIDI on the room's beat grid, with a tempo change
const tempo = new Tempo(120); tempo.start(0, 120); tempo.change(4000, 90);
const mid = SR.midiFile([{ type: 'on', note: 60, vel: 100, at: 1000 }, { type: 'off', note: 60, at: 1500 }, { type: 'on', note: 62, vel: 90, at: 6000 }], tempo, 1000, 7000, 'test');
check(String.fromCharCode(...mid.slice(0, 4)) === 'MThd' && String.fromCharCode(...mid.slice(14, 18)) === 'MTrk', 'MIDI file header and track');
const tempos = []; for (let i = 0; i < mid.length - 5; i++) if (mid[i] === 0xff && mid[i + 1] === 0x51 && mid[i + 2] === 3) tempos.push(Math.round(60e6 / ((mid[i + 3] << 16) | (mid[i + 4] << 8) | mid[i + 5])));
check(tempos.join() === '120,90', `tempo meta events follow the room (${tempos.join(', ')} bpm)`);

// zip
const z = SR.zip([{ name: 'a/one.txt', data: new TextEncoder().encode('hello') }, { name: 'a/two.bin', data: new Uint8Array([1, 2, 3]) }]);
const zb = new Uint8Array(await z.arrayBuffer());
check(zb[0] === 0x50 && zb[1] === 0x4b && zb.length > 60, `a zip archive (${zb.length} bytes)`);
console.log(fail ? `${fail} FAILED` : 'ALL PASS'); process.exit(fail ? 1 : 0);
