// The demo studio: a whole little song for a beginner to explore and pull apart, made fresh for each person who opens
// it (a studio of their own, so nothing they try spoils it for anyone else). It's a Song preset (src/presets.js)
// with what presets don't have: a Lead with two takes to compare (Robin's and Kai's), a recorded guitar take on the
// Verse (live audio, made here by plucking virtual strings), and a tip in each section's notes. The "Explore the demo
// song" tour (src/tutorial.js) walks through it.
import { GENRES, presetSong, chordOf, parseKey } from './presets.js';

export const DEMO_TITLE = 'Demo Song';
export const DEMO_CLIP = 'demogtr1';
const SR = 24000, BPM = 100;
const TIPS = {
  Intro: 'Welcome! Columns are sections, rows are tracks. Press Play the song to hear it all, or Loop it to repeat one section.',
  Verse: 'Guitar here is a recorded take (live audio): it lives in the studio and plays even when nobody who played it is here.',
  Chorus: 'The Lead has two takes, by Robin and Kai. Open the Lead box to compare them and pick one (or let the band vote).',
  Outro: 'Your turn: Jam this section to play along, or + Add track. This studio is yours to change; nothing here can break.',
};

// a small seeded random, so every demo is the same
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// the Lead: Robin plays it simply (a long chord tone each half bar), Kai busier (eighths up and down the chord)
function lead(chords, key, busy) {
  const ev = [];
  chords.forEach((name, bar) => {
    const c = chordOf(['I', 'ii', 'iii', 'IV', 'V', 'vi'].find((t) => chordOf(t, key).name === name) || 'I', key);
    const tones = c.tones.map((t) => { const n = 60 + ((c.root + t) % 12); return n < 64 ? n + 12 : n; }).sort((x, y) => x - y);   // E4 to D♯5
    const at = bar * 4;
    if (!busy) [[0, tones[2] ?? tones[0], 1.9], [2, tones[1], 1.9]].forEach(([b, n, l]) => ev.push({ b: at + b, type: 'on', note: n, vel: 92 }, { b: at + b + l, type: 'off', note: n }));
    else [0, 1, 2, 1, 0, 1, 2, 1].forEach((i, k) => { const n = tones[i] + (k === 2 ? 12 : 0); ev.push({ b: at + k / 2, type: 'on', note: n, vel: k % 2 ? 70 : 96 }, { b: at + k / 2 + 0.42, type: 'off', note: n }); });
  });
  return ev.sort((a, b) => a.b - b.b || (a.type === 'off' ? -1 : 1));
}

// a strummed acoustic guitar, plucked string by string (Karplus-Strong), two strums a bar, following the chords
const SHAPES = { C: [48, 52, 55, 60, 64], G: [43, 47, 50, 55, 59, 67], Am: [45, 52, 57, 60, 64], F: [41, 48, 53, 57, 60, 65], Em: [40, 47, 52, 55, 59, 64], Dm: [50, 57, 62, 65] };
export function guitarTake(chords, bpm = BPM, sr = SR) {
  const spb = 60 / bpm, frames = Math.round(chords.length * 4 * spb * sr), out = new Float32Array(frames), rand = rng(7);
  chords.forEach((name, bar) => {
    const shape = SHAPES[name] || SHAPES.C;
    for (const [beat, down, amp] of [[0, true, 1], [2, true, 0.8], [3, false, 0.55]]) {
      const t0 = Math.round((bar * 4 + beat) * spb * sr), len = Math.round((beat === 3 ? 1 : beat === 2 ? 1 : 2) * spb * sr) + Math.round(0.25 * sr);
      (down ? shape : [...shape].reverse()).forEach((note, i) => {
        const f = 440 * 2 ** ((note - 69) / 12), N = Math.max(2, Math.round(sr / f)), buf = new Float32Array(N);
        for (let k = 0; k < N; k++) buf[k] = (rand() * 2 - 1) * 0.5;
        const start = t0 + Math.round(i * 0.012 * sr * (down ? 1 : 0.7)), g = amp * (0.5 + rand() * 0.15);
        let j = 0, prev = 0;
        for (let s = start; s < Math.min(frames, start + len); s++) {
          const v = buf[j]; out[s] += v * g; const nx = 0.996 * 0.5 * (v + prev); prev = v; buf[j] = nx; j = (j + 1) % N;
        }
      });
    }
  });
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  const pcm16 = new Int16Array(frames), k = peak ? 0.6 / peak : 0;
  for (let i = 0; i < frames; i++) pcm16[i] = Math.round(out[i] * k * 32767);
  const peaks = Array.from({ length: 120 }, (_, p) => { let m = 0; for (let i = Math.floor((p * frames) / 120); i < Math.floor(((p + 1) * frames) / 120); i++) m = Math.max(m, Math.abs(pcm16[i]) / 32767); return Math.round(m * 100) / 100; });
  return { pcm16, sr, frames, peaks };
}

// the demo song, and the audio it needs: { song, clips: [{ id, pcm16, sr }] }
export function demoSong() {
  const gi = GENRES.findIndex((g) => g.name === 'Pop');
  const song = presetSong(gi, 0, [DEMO_TITLE, 'C', BPM, 'IVCVCO', { I: [4, 'I V'], V: [8, 'I V vi IV'], C: [8, 'IV I V vi'], O: [4, 'I'] }]);
  const key = parseKey('C'), clips = [];
  for (const id of new Set(song.order)) {
    const sec = song.sections[id];
    sec.notes = TIPS[sec.name] || sec.notes;
    if (sec.name === 'Chorus') {
      const take = (who, busy, at) => ({ id: `demo-${who.toLowerCase()}`, events: lead(sec.chords, key, busy), by: 'import', byName: who, at });
      sec.parts['l-lead'] = { id: 'l-lead', name: 'Lead', lane: 'Lead', role: 'melody', inst: 'juniper', patch: 'lead', drums: false, takes: [take('Robin', false, 1), take('Kai', true, 2)], current: 'demo-robin', by: 'import' };
    }
    if (sec.name === 'Verse') {
      const g = guitarTake(sec.chords);
      clips.push({ id: DEMO_CLIP, pcm16: g.pcm16, sr: g.sr });
      sec.parts['l-guitar'] = { id: 'l-guitar', name: 'Guitar (recorded)', lane: 'Guitar (recorded)', role: 'texture', kind: 'audio', inst: 'audio', patch: '', drums: false,
        takes: [{ id: 'demo-gtr', events: [], audio: { id: DEMO_CLIP, sr: g.sr, frames: g.frames, from: 0, beats: sec.bars * 4, bpm: BPM, peaks: g.peaks }, by: 'import', byName: 'Robin', at: 1 }], current: 'demo-gtr', by: 'import' };
    }
  }
  return { song, clips };
}
