# MEGAjam

A virtual studio for jamming live over the internet, in lockstep, with up to four people.

Each jammer walks into their own **corner**, racks up instruments from a shared library, and says what hardware they have. Every jammer's browser runs **everyone's** instruments, so instead of streaming audio MEGAjam sends what your hands do (notes, knob moves, instrument changes), each stamped with the moment it should sound on a clock the whole room shares. Every browser plays every event at that moment, so the whole band hears the same music. The idea comes from strategy-game networking, where every machine runs the same simulation and only the commands travel ("deterministic lockstep").

**Play it:** https://samuelling.github.io/JamJam/ (open a studio, then send the invite).

## In the studio

- **Your corner** holds up to four instruments. The computer keys and on-screen keys play the selected one; give each a MIDI channel to play several from your controllers (a drum machine on channel 10 and a synth on channel 1, say).
- **The library** (shared by everyone, hashed on load so mismatched versions are flagged):

  | Instrument | What it is |
  | --- | --- |
  | **Juniper** | Six-voice DCO poly in the spirit of the classic early-80s Japanese poly: saw + pulse/PWM, sub, noise, four-position HPF, resonant 4-pole filter, delayed LFO, stereo bucket-brigade chorus I / II / I+II. |
  | **Monolith** | Three-oscillator mono in the spirit of the 70s American classic: footage ranges, six waveforms, overdriving mixer, 4-pole transistor-ladder filter, contour and key tracking, glide, low- or last-note priority, single triggering. |
  | **Machina** | Synthesis drum machine in the spirit of the late-90s Swedish machine drum computers: nine slots on the GM drum map, each running one of four machines (TRX analog circuits, EFM FM percussion, PI modal physics, GND raw sources), with pitch, decay, tone, snap, crush, level and pan per slot. Notes from C4 up play the perc slot chromatically. |
  | **Poly** | Light two-oscillator subtractive poly with a mono/glide mode. |
  | **Tine** | Two-operator FM keys: electric pianos, bells, FM bass, plucks. |

  Juniper, Monolith and Machina render sample by sample in an AudioWorklet, with every event landing on an exact sample frame, so they render bit-identically in every browser.
- **Your hardware.** Pick your unit and MEGAjam ranks software twins from the library (best match first, with a match score), with an audition button for each. The twin you choose ships to the band, loaded with the preset for your patch type and that unit's character. You play the real thing; everyone else hears the twin. Shape the twin's knobs until it sounds like your patch; your synth's CC knobs drive the twin where the mapping is known. Choose a MIDI output (Local Control off) and MEGAjam plays your synth in lockstep too, using Web MIDI timestamps. About 35 units are catalogued in `instruments/hardware.json`; adding one is one entry.
- **Machina's sequencer.** Machina has a machine-drum panel with a 16–64 step sequencer (pages, length, play and stop on the bar) and per-trig **parameter locks**: hold a trig (or shift-click it, or use LOCK) and turn a knob, and that one step plays with that setting. The sequencer runs in lockstep in every browser from the shared pattern and clock, so sequenced parts send no notes at all, only edits. Each edit is stamped far enough ahead (lookahead plus the scheduling horizon) that every browser applies it before the step it touches, so every browser plays exactly the same trigs. `tests/seq.test.cjs` checks this across two lagged browsers.
- **Libraries: instruments from other repos.** The gear wall can open libraries beyond the built-ins: any folder with a `megajam.json` (or `jamjam.json`, the name from before the rename), from a public GitHub repo (`github:owner/repo`, served through jsDelivr), a GitHub Pages site, or a build served from your own machine (`tools/serve-library.py` adds the cross-origin headers). When you play a public library's instrument, your bandmates' browsers load it automatically. A library marked private is never shared: each jammer adds their own copy, and anyone without it hears the closest built-in stand-in (and is told so) until they do. See "Writing a library" below.
- **Band chat**, an **audio lane**, and a **wiring** panel showing every link, in panels that slide out from the side of the desk.

- **External MIDI.** "+ External MIDI" on your shelf puts any synth, drum machine or DAW track reachable over MIDI (a hub, a USB synth, or a virtual port such as IAC on a Mac or loopMIDI on Windows) in your corner. Give it a name, an output port and channel, and optionally a twin from the gear wall for the band to hear. Your notes, sustain, pitch bend and controller knobs go out to it timestamped to the moment the band hears your part (or at once, with self-monitoring on). Twin: none means bandmates hear nothing unless they route your part to their own gear.
- **The band's parts on your gear.** The MIDI panel (the DIN tab on the side) lists every bandmate's part. Pick an output and channel and that part (notes, pitch bend, knobs that have a MIDI CC, and sequencer hits) plays on your own synth or DAW at the room's moment, not on arrival, and the browser copy is muted.
- **MIDI clock out.** The same panel sends the room's tempo as MIDI clock, 24 ticks per beat from the shared tempo map, with song position and Start on the next bar, so a drum machine or sequencer on your desk runs in phase with everyone else's. `early` sends it a few ms ahead for gear that's slow to respond. `tests/midi.test.cjs` checks all three with mock ports (`?midimock=1`).

## How the timing works

| Piece | What it does |
| --- | --- |
| **Handshake** | A tiny Cloudflare relay (the Durable Object from [crush-commando](https://github.com/samuelling/crush-commando/tree/main/server), already deployed as `crush-commando-mp`) introduces the browsers. Rooms are `jj-XXXX`. |
| **Direct links** | Each pair of jammers opens WebRTC DataChannels (a full mesh: 4 jammers = 6 links). After that the relay carries nothing. A pair that can't connect directly (strict or carrier-grade NAT; there's no TURN server) passes messages through the relay instead, and the corner says so. |
| **Two channels per link** | Notes and pings go on an unordered, never-retransmitted channel, each packet carrying the previous two events as well, so a lost packet is recovered from the next one with no wait. One quick repeat goes out 20 ms later, so even in a sparse passage a loss costs at most ~20 ms. Everything is also sent on a reliable channel as a backup, and duplicates are dropped by sequence number. (On a reliable ordered channel alone, one lost packet holds back every note behind it until its retransmission, typically 200 ms or more.) |
| **Shared clock** | The earliest joiner is the clock leader. Everyone else estimates their offset NTP-style from ping/pong, trusting the shortest round trips, and slews small corrections so scheduled notes never jump. If the leader leaves, the next earliest carries on without a jump. |
| **Lookahead** | Every event is scheduled *L* ms ahead. *L* has to cover the trip to the farthest jammer, its jitter, the clock error, and that jammer's audio output latency (Bluetooth headphones can add 150 ms or more). Rather than guess, every listener measures the spare time it actually has when your notes and pings arrive and reports the worst moment of every half-second. Each report becomes an absolute "lookahead this listener needs"; your *L* follows the worst need over the last 12 reports (6 s), rising at once and settling gently, aiming for an 8 ms safety margin. You can override it. |
| **A latency budget per part** | Each instrument spends a different amount of delay. **Tight** (drums, bass, plucks): the safe lookahead plus 10 ms, never late. **Balanced**: the safe lookahead. **Loose** (pads, strings, slow attacks): about 40% of it, and you hear yourself instantly; a far listener may get a note a touch late, which plays on arrival, hidden by the slow attack. **Auto** picks from the instrument and patch. Loose parts' late arrivals don't feed the lookahead. |
| **Quantize** | With quantize on, notes snap to the next grid point at least the lookahead away, so the delay disappears into the grid. |
| **Hear myself instantly** | Off (pure lockstep): your notes sound *L* ms after you play them, at the same moment the band hears them, like a pipe organ. On: you hear yourself at once and the band hears you *L* ms later. |
| **Fingerprints** | Every 2 seconds each browser hashes every instrument's settings, plus a count of recent notes, as of a moment just past, and compares with the others. Corners show "✓ same music" or "⚠ out of sync". |
| **Tempo** | Owned by the clock leader; changes start on a future beat so everyone switches together. |

Why sending notes is faster than sending audio: the network trip is the same, but audio streaming adds an input buffer, codec frames, and a jitter buffer big enough to ride out the worst packet. A note is a few dozen bytes and is useful the moment it arrives. Lockstep then spends a small, measured lookahead to make everyone land together.

A note on clocks: with a lopsided link (much slower one way than the other) no two machines can know their true clock offset, and the shared clock can be tens of milliseconds off in absolute time. That doesn't change the music: every browser plays every note at the same room time by its own clock, so each room hears exactly the same relative timing. It only means one direction needs a little more lookahead, which the measured loop absorbs.

## Audio lane

Stream a mic, a guitar, or a synth you can't twin, NINJAM-style, alongside the notes. Every chunk is stamped with the room time it was played, and the band hears it exactly 1, 2, 4 or 8 bars later. Set the delay to the length of the loop or chord cycle and the late audio lands on the right chords. Direct links only (about 0.8 Mbit/s per listener at 48 kHz, half at 24 kHz). Use headphones.

## Benchmarks and tuning

`tests/bench.cjs` runs silent headless jammers (full timing, no synthesis) through simulated networks and reports, per profile, the lookahead each jammer settled on, the physical floor for it (worst one-way delay into any listener plus that listener's output latency), notes that arrived late, and how closely each note was heard across browsers. Tuning sweeps (`tm` = safety margin, `mem` = reports remembered), five profiles, about 2,800 notes each:

| Controller | Lookahead above the floor | Late notes |
| --- | --- | --- |
| first version (one-shot corrections, 20 ms margin, 1 s reports) | 23 ms | 0 |
| 12 ms margin, 0.5 s reports | 15 ms | 0 |
| need memory, 6 ms margin, 16 reports | 6 ms | 7 |
| **need memory, 8 ms margin, 12 reports (default)** | **11 ms** | **0** |

Packet loss, 2% each way, cross-country link:

| Transport | Lookahead it needed | Late notes |
| --- | --- | --- |
| reliable ordered channel only (`?fast=0`) | 275–439 ms | 7 (up to 245 ms late) |
| fast channel, redundant copies | 105–118 ms | 1 |
| **fast channel, redundant copies + one repeat 20 ms later (default)** | **89–96 ms** (6 ms above a lossless link) | **0** |

Notes heard on time land within about 0.1 ms of each other across browsers (bit-identical synthesis, same room time). Tuning knobs can be set per visit for experiments: `?tm=8&mem=12&settle=0.2&rise=2&rep=500&repeat=20`. `?lag=80&jitter=20&loss=0.02` delays and drops what this browser receives, to feel a long-distance link; `?fast=0` turns off the redundant fast channel.

## Writing an instrument

Instruments are single ES module files in `instruments/`, listed in `instruments/index.json`.

```js
export default {
  id: 'name', name: 'Display name', family: 'What kind of instrument', blurb: 'One line for the library',
  drums: false,                       // true: GM drum map, drum key labels, tight timing by default
  params: [{ id, name, min, max, def, curve: 'exp'?, unit?, step?, options?, cc?, group? }],
  presets: { patchType: { paramId: value, ... } },
  async init(ctx) {},                 // optional, e.g. register an AudioWorklet once per AudioContext
  create(ctx, out, initialParams) {   // -> instance
    return { noteOn(note, vel, t), noteOff(note, t), set(paramId, value, t), allOff(t), dispose() };
  },
};
```

Every call carries an AudioContext time `t`, usually in the future. The one rule is **determinism**: no `Math.random()` and no free-running state that differs between browsers. Use fixed seeds and keep a parameter's history so a note uses the setting in force at its own start. A plugin someone has already built (an AudioWorklet, a WebAssembly build of a C++ synth) fits behind the same five calls. `group` puts parameters on separate pages; `options` makes a stepped selector.

## Writing a library

A library is a folder with a `megajam.json` and instrument modules:

```json
{
  "megajam": 1, "id": "mylab", "name": "My Lab", "by": "me", "private": false,
  "instruments": [
    { "id": "wobble", "file": "wobble.js", "name": "Wobble", "family": "Poly", "blurb": "One line" },
    { "id": "big-a", "file": "bridge.js", "arg": "big-a", "name": "Big A" }
  ]
}
```

Each file is an ES module whose default export is an instrument (the contract above), or a function `(arg, { base, ctx, sha })` that returns one, so one bridge module can serve many instruments (for example, a host for a WebAssembly synth engine). Modules load only when someone picks them. Instruments get ids like `mylab/wobble`. Optional instrument fields for the gear wall and faceplate: `icon` (SVG text), `accent` (a colour for the generated cartridge icon), `presetNames` (`{slug: name}`), `hidden` on parameters the panel shouldn't show, and `contentHash` (anything that should mark two copies as different versions). `tests/fixtures/ext-lib/` is a small example.

## Run it locally

```sh
node server/dev.js                    # the site plus a local copy of the relay on http://localhost:8787
NODE_PATH=$(npm root -g) node tests/sync.test.cjs http://localhost:8787/
NODE_PATH=$(npm root -g) node tests/instruments.test.cjs http://localhost:8787/
NODE_PATH=$(npm root -g) node tests/midi.test.cjs http://localhost:8787/
NODE_PATH=$(npm root -g) node tests/bench.cjs http://localhost:8787/ "tm=8&mem=12"
```

- `sync.test.cjs`: 2–4 headless jammers through the local relay with simulated lag: direct links, clock lock, instrument and hardware-twin changes, every note heard at the same room time everywhere, fingerprints, the relay fallback, the audio lane, tempo changes.
- `instruments.test.cjs`: renders every preset offline and checks sound, no NaN, level, identical renders, and speed.
- `bench.cjs`: the timing benchmark above.
- `seq.test.cjs`: Machina's sequencer in two lagged browsers (identical trigs, locks and times).
- `library.test.cjs`: public and private libraries from two other origins, auto-loading, stand-ins.

## Files

- `index.html` – the studio and its styles
- `src/main.js` – corners and racks, lookahead loop, budgets, fingerprints, chat, UI
- `src/net.js` – relay handshake, WebRTC mesh with reliable and fast channels, relay fallback, network simulator
- `src/clock.js` – shared clock and tempo
- `src/engine.js` – instrument loading and hashing, twins, channels, scheduling
- `src/lane.js` – audio lane capture and chunk format
- `src/seq.js` – the lockstep step sequencer
- `src/skins.js` – instrument icons and faceplate styles
- `tools/serve-library.py` – serve a library folder from your machine with the cross-origin headers MEGAjam needs
- `src/input.js` – computer keyboard, Web MIDI in (all channels) and out, sustain
- `instruments/` – the library and `hardware.json`
- `server/` – local dev server and a copy of the relay's room logic
