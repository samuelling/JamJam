# JamJam

Jam live with up to four people over the internet, in lockstep.

Every jammer's browser runs **everyone's** instrument from the same shared library. Instead of streaming audio, JamJam sends what your hands do (notes, knob moves, instrument changes), each stamped with the moment it should sound on a clock the whole room shares. Every browser plays every event at that same moment, so everyone hears the same music at the same instant. The approach comes from strategy-game networking, where every machine runs the same simulation and only the commands travel ("deterministic lockstep").

**Play it:** https://samuelling.github.io/JamJam/ (start a room, then send the invite link).

## How it works

| Piece | What it does |
| --- | --- |
| **Handshake** | A tiny Cloudflare relay (the Durable Object from [crush-commando](https://github.com/samuelling/crush-commando/tree/main/server), already deployed as `crush-commando-mp`) introduces the browsers. Rooms are `jj-XXXX`. |
| **Direct links** | Each pair of jammers opens a WebRTC DataChannel (a full mesh: 4 jammers = 6 links). After that the relay carries nothing. A pair that can't connect directly (strict or carrier-grade NAT; there's no TURN server) falls back to passing messages through the relay, and the jammer card says so. |
| **Shared clock** | The earliest joiner is the clock leader. Everyone else estimates their offset NTP-style from ping/pong, trusting the shortest round trips, and slews small corrections so scheduled notes never jump. If the leader leaves, the next earliest joiner carries on without a jump. |
| **Lookahead** | Every event is scheduled *L* ms in the future. *L* has to cover the trip to the farthest jammer, the jitter on that link, clock error, and that jammer's audio output latency (Bluetooth headphones can add 150 ms or more). Rather than guess, every listener measures the spare time it actually has when your notes and pings arrive and reports it once a second; your *L* closes in on the smallest value that keeps every listener at least 20 ms early. You can override it by hand. |
| **Quantize** | With quantize on, notes snap to the next grid point at least *L* away, so the lookahead disappears into the grid. |
| **Hear myself instantly** | Off (pure lockstep): your own notes also sound *L* ms after you play, at the same moment as everyone else hears them, like a pipe organ. On: you hear yourself at once and the others hear you *L* ms later. |
| **Fingerprints** | Every 2 seconds each browser hashes every jammer's instrument and parameters, plus a count of recent notes, as of a moment just past, and compares with the others. The jammer cards show "✓ same music" or "⚠ out of sync". Instrument files are hashed on load too, so mismatched versions get flagged. |
| **Tempo** | Owned by the clock leader; changes start on a future beat so everyone switches together. Anyone can ask for a change. |

Why sending MIDI is faster than sending audio: the network trip is the same, but audio streaming adds an input buffer, codec frames, and a jitter buffer that has to hold back enough audio to ride out the worst packet. A note message is a few dozen bytes and is useful the moment it arrives. Lockstep then spends a small, measured lookahead to make everyone land together.

## Hardware twins

Pick **My hardware** and choose your synth or drum machine. You play the real thing; everyone else hears a software twin from the same family (`instruments/hardware.json`): the twin instrument, loaded with the preset for your patch type, with that unit's character on top. Shape the knobs until the twin sounds like your patch; your synth's CC knobs drive the twin's knobs where the mapping is known.

- **Lockstep with hardware:** choose your synth's MIDI output and turn Local Control off on the synth. JamJam sends it each note with a Web MIDI timestamp, so your synth plays at the same moment as everyone's twin. The latency slider compensates for the synth's own delay.
- **Instant:** leave the output on None and play the synth directly.

Twins are family resemblances, not emulations. Adding a unit is one JSON entry.

## Audio lane

Stream a mic, a guitar, or a synth only you own, NINJAM-style, alongside the notes. Every chunk is stamped with the room time it was played, and the others hear it exactly 1, 2, 4 or 8 bars later. Set the delay to the length of the loop or chord cycle you're jamming over and the late audio lands on the right chords. Audio goes over the direct links only (about 0.8 Mbit/s per listener at 48 kHz, half that at 24 kHz). Use headphones.

## Playing

- Computer keyboard: `A W S E D F T G Y H U J K` (and on), `Z`/`X` octave, `C`/`V` velocity, `Space` sustain.
- MIDI keyboard: **Enable MIDI** (Chrome, Edge, Firefox). Sustain pedal, pitch bend and mapped CCs work. The sustain pedal is resolved before sending, so the wire only carries note-ons and note-offs.
- On-screen keys; coloured dots show what the others are holding.
- `?lag=80&jitter=20` in the address delays everything this browser receives, to feel a long-distance link.

## Writing an instrument

Instruments are single ES module files in `instruments/`, listed in `instruments/index.json`. Every jammer loads the same file from the site, and the app hashes it.

```js
export default {
  id: 'name', name: 'Display name', family: 'What kind of instrument',
  params: [{ id, name, min, max, def, curve: 'exp'?, unit?, step?, cc?, group? }],
  presets: { patchType: { paramId: value, ... } },
  async init(ctx) {},                 // optional: e.g. register an AudioWorklet once per AudioContext
  create(ctx, out, initialParams) {   // -> instance
    return { noteOn(note, vel, t), noteOff(note, t), set(paramId, value, t), allOff(t), dispose() };
  },
};
```

Every call carries an AudioContext time `t` (often in the future). The one rule is **determinism**: no `Math.random()` and no free-running state that differs between browsers. Use a fixed seed for noise and keep a parameter's history so a note uses the setting in force at its own start time. A plugin someone has already built (for example as an AudioWorklet or a WebAssembly build) fits behind the same five calls.

## Run it locally

```sh
node server/dev.js                   # serves the site and a local copy of the relay on http://localhost:8787
NODE_PATH=$(npm root -g) node tests/sync.test.cjs http://localhost:8787/
```

The test opens 2–4 headless jammers through the local relay with simulated lag, and checks direct links, clock lock, that every note is heard at the same room time in every browser, fingerprints, the relay fallback, the audio lane, and tempo changes.

## Files

- `index.html` – page and styles
- `src/main.js` – room logic, lookahead loop, fingerprints, UI
- `src/net.js` – relay handshake, WebRTC mesh, relay fallback
- `src/clock.js` – shared clock and tempo
- `src/engine.js` – instrument loading and hashing, channels, scheduling
- `src/lane.js` – audio lane capture and chunk format
- `src/input.js` – computer keyboard, Web MIDI in/out, sustain
- `instruments/` – the shared library and `hardware.json`
- `server/` – local dev server and a copy of the relay's room logic
