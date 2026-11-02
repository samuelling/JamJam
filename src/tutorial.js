// Guided tours for someone who has never used a DAW: "Your first jam" (the Jam Room) and "Write your first song"
// (the Compose Room). Each step points at one thing (the rest of the page dims), says what it is and what to do, and
// waits until you've done it; "Show me" does it for you. The last step lets go: "You're all set".
//
// Nothing is blocked: the page works as usual under the tour, and the tour just watches. Steps check the app's
// state a few times a second (api below) rather than listening for particular clicks, so any way of doing the thing
// counts (a MIDI keyboard instead of the computer keys, say).
//
// api (from main.js): inStudio(), where(), goRoom(w), rack() [{r, inst, lane}], notes() (note-ons you've played),
// key() {root, mode}, setKey(root, mode), bpm(), setBpm(bpm), players() (virtual bandmates), tapes(), taping(),
// toggleTape(), closeDrawers(), firstPick(), instName(inst), lockOn(), song(), transport(), play(mode, sid), stop(), playNote(on, note, vel), pad(i, down),
// addInstrument(inst, patch), jamLane(id), lockIn(r), draftPart(spec), editTake(sid, pid, events, what, base),
// setSong(k, v), audio() {ctx, out}, def(inst), resolve({inst, patch, hw})

import { Fitter, analyze } from './match.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DONE_KEY = 'megajam.tour';
const remember = (k) => { try { localStorage.setItem(`${DONE_KEY}.${k}`, '1'); } catch (_) {} };
export const toured = (k) => { try { return localStorage.getItem(`${DONE_KEY}.${k}`) === '1'; } catch (_) { return false; } };

export function makeTutorial(api, { h, $ }) {
  let tour = null;   // { name, steps, i, ctx, timer, el: {shade, bubble}, passed }
  const firstSec = () => { const s = api.song(); return (s.order || []).map((id) => s.sections[id]).find(Boolean) || null; };
  const lanes = () => Object.values(api.song().lanes || {}).filter((t) => t.kind !== 'audio');
  const partOf = (sid, lane) => Object.values(api.song().sections[sid]?.parts || {}).find((p) => p.laneId === lane || p.id === lane);
  const onsIn = (p) => { if (!p) return 0; const t = (p.takes || []).find((q) => q.id === p.current) || (p.takes || []).at(-1); return (t?.events || []).filter((e) => e.type === 'on').length; };
  const btnText = (root, re) => [...(root ? root.querySelectorAll('button') : [])].find((b) => re.test(b.textContent.trim()));
  // on screen: laid out (not display:none anywhere above it) and not hidden (a .hide class can be overridden by a room)
  const visible = (el) => !!el && el.getClientRects().length > 0 && (typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true }));
  // a short phrase on whatever is selected on your desk, for "Show me" on the playing steps
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;   // a phone or tablet: tap, not type
  const phrase = async (notes, ms = 260) => { for (const n of notes) { api.playNote(true, n, 96); await sleep(ms * 0.8); api.playNote(false, n, 0); await sleep(ms * 0.2); } };

  // ---------- the two tours ----------
  const JAM = [
    { id: 'name', lobby: true, title: 'Welcome to MEGAjam', text: 'A shared studio where you and up to three friends play together, live, from anywhere. First, type your name: it\'s what the band sees.',
      target: () => $('#nameIn'), wait: () => ($('#nameIn')?.value || '').trim().length > 0, show: () => { const i = $('#nameIn'); i.value = 'Guest'; i.dispatchEvent(new Event('input', { bubbles: true })); } },
    { id: 'start', lobby: true, title: 'Open your studio', text: 'Press Start a jam. You\'ll get a studio of your own, with a code your friends can use to walk in.',
      target: () => $('#startBtn'), wait: () => api.inStudio(), show: () => $('#startBtn')?.click() },
    // a first visit walks into a hall with two doors, then the wall opens on "What do you want to play?"
    { id: 'door', title: 'Two rooms', text: 'The Jam Room is for playing together live; the Compose Room is for building a song. Go into the Jam Room.',
      skip: () => !visible($('#hall')) && api.where() === 'jam', target: () => $('#hall .door2.jam') || $('#roomSeg [data-room="jam"]'), wait: () => !visible($('#hall')) && api.where() === 'jam', show: () => api.goRoom('jam') },
    { id: 'pick', title: 'What do you want to play?', text: 'Pick something to play. Play some keys is a good start; you can add more instruments any time.',
      skip: () => !api.firstPick() && api.rack().length > 0, target: () => (visible($('#quickPicks')) ? $('#quickPicks') : null), wait: () => !api.firstPick() && api.rack().length > 0 && !visible($('#libDrawer')),
      show: async () => { const q = [...document.querySelectorAll('#quickPicks .quick')].find((b) => /keys/i.test(b.textContent)); if (q) { q.click(); await sleep(400); } if (!api.rack().length) api.addInstrument('juniper', 'keys'); api.closeDrawers(); } },
    { id: 'corner', title: 'This is your corner', text: 'Each player gets a corner along the wall: yours is lit. Friends who join take the empty ones. Every browser plays every player\'s instruments, so the whole band hears the same music at the same moment.',
      target: () => $('.corner.me'), setup: () => { if (api.where() !== 'jam') api.goRoom('jam'); }, next: true },
    { id: 'desk', title: 'Your desk', text: () => `This is the instrument you're playing: ${api.instName(api.rack()[0]?.inst) || 'Juniper'}. Its knobs change the sound; the Add slot on the left puts more instruments on your desk.`,
      target: () => $('#device .devtop') || $('#device .md-top') || $('#device'), setup: () => { if (!api.rack().length) api.addInstrument('juniper', 'keys'); }, next: true },
    { id: 'play', title: 'Play some notes', text: touch ? 'This is a piano: tap the keys at the bottom of the screen to play. Play a few notes now.' : 'Your computer keyboard is a piano: A S D F G H J K are the white keys, W E T Y U the black ones. Play a few notes now (a MIDI keyboard works too).',
      target: () => $('.keybed'), setup: (c) => { c.n0 = api.notes(); }, wait: (c) => api.notes() - c.n0 >= 6, show: () => phrase([60, 62, 64, 65, 67, 65, 64, 62]) },
    { id: 'key', title: 'Pick a key for the room', text: 'A key is the set of notes that sound good together. The whole band shares one. Choose A minor from this list: the right keys light up, and chord buttons appear.',
      target: () => $('#keySel'), wait: () => !!api.key()?.mode, show: () => api.setKey(9, 'minor') },
    { id: 'pads', title: 'Whole chords, one key each', text: touch ? 'These chord pads play a full chord at a time. Tap a few: try the first, then the sixth, the fourth and the fifth.' : 'These chord pads play a full chord at a time. Press the number keys 1 to 6 (or click the pads). Try 1, then 6, then 4, then 5.',
      target: () => $('#pads'), setup: (c) => { c.p = 0; c.on = (e) => { if (/^Digit[1-7]$/.test(e.code) && !e.repeat) c.p++; }; document.addEventListener('keydown', c.on, true); c.clk = (e) => { if (e.target.closest?.('#pads .pad')) c.p++; }; document.addEventListener('pointerdown', c.clk, true); },
      wait: (c) => c.p >= 3, done: (c) => { document.removeEventListener('keydown', c.on, true); document.removeEventListener('pointerdown', c.clk, true); },
      show: async (c) => { for (const i of [0, 5, 3, 4]) { api.pad(i, true); await sleep(450); api.pad(i, false); c.p++; await sleep(80); } } },
    { id: 'add', title: 'Add a bandmate', text: 'Nobody else here yet? Bring in a virtual drummer: they keep time and follow the band. Click Add.',
      target: () => $('#addSlot'), wait: () => visible($('#libDrawer')) || api.players() > 0, show: () => $('#addSlot')?.click() },
    { id: 'drummer', title: 'The Drummer', text: 'This wall holds every instrument. Click the Drummer tile.',
      target: () => $('#libCards .tile.drums'), wait: () => !!$('#libExtra .dgenre') || api.players() > 0, show: () => $('#libCards .tile.drums .face')?.click() },
    { id: 'style', title: 'Pick a style', text: 'Every style plays differently. Rock is a good start; try Funk or Hip hop later.',
      target: () => [...document.querySelectorAll('#libExtra .dgenre')].find((g) => /^Rock/i.test(g.querySelector('b')?.textContent || '')) || $('#libExtra'), wait: () => api.players() > 0, show: () => (btnText($('#libExtra'), /^Rock/) || $('#libExtra .dgenre button'))?.click() },
    // a definite target (four presses of +), and the card counts along as you go
    { id: 'tempo', title: 'Set the speed', live: true,
      text: (c) => { const now = api.bpm(), left = c.goal - now; return `The tempo (BPM, beats per minute) sets how fast the band plays, and everyone shares it. Speed it up from ${c.b0} to ${c.goal}: ${touch ? 'tap' : 'press'} + four times${touch ? '' : ' (or drag the number up)'}. ` + (now >= c.goal ? `It's at ${now}. Hear the drummer speed up?` : `It's at ${now}: ${left} to go.`); },
      target: () => $('#bpmLcd')?.closest('.readout'), setup: (c) => { c.b0 = api.bpm(); c.goal = Math.min(240, c.b0 + 4); }, wait: (c) => api.bpm() >= c.goal, show: (c) => api.setBpm(c.goal) },
    { id: 'lock', title: 'No wrong notes', text: 'Lock to key makes every key you press land on a note of the room\'s key. Turn it on.',
      target: () => $('#lockBtn'), wait: () => api.lockOn(), show: () => $('#lockBtn')?.click() },
    { id: 'jam', title: 'Jam with the drummer', text: 'Now play along. Anything you play fits the key, so just follow the beat. Play a dozen notes or so.',
      target: () => $('.keybed'), setup: (c) => { c.n0 = api.notes(); }, wait: (c) => api.notes() - c.n0 >= 12, show: () => phrase([57, 60, 64, 62, 60, 57, 55, 57, 60, 62, 64, 67], 300) },
    { id: 'record', title: 'Record it', text: 'The red button records the whole room. Click it, play a little, then click it again to stop. Your recording opens in a drawer: play it back if you like, then close it.',
      target: () => (visible($('#tapeDrawer')) ? $('#tapeDrawer') : $('#tapeBtn')), setup: (c) => { c.t0 = api.tapes(); }, wait: (c) => api.tapes() > c.t0 && !visible($('#tapeDrawer')),
      show: async (c) => { if (api.tapes() <= c.t0) { if (!api.taping()) await api.toggleTape(); await phrase([57, 60, 64, 67, 64, 60], 300); await sleep(600); if (api.taping()) await api.toggleTape(); await sleep(400); } api.closeDrawers(); } },
    { id: 'invite', title: 'Bring your friends', text: 'Invite copies a link to this studio. Send it to up to three friends: they click it and walk into the empty corners, and you all play together.',
      target: () => $('#copyBtn'), next: true },
    { id: 'end', title: 'You\'re all set!', text: 'That\'s a jam: an instrument, a key, a drummer, a tempo and a recording. Everything else is yours to explore. Two more tours wait under Help, up here, whenever you want them: Write your first song turns a jam into a song, and Jam with a friend shows how playing together works. There\'s a written manual there too, if you\'d rather read.',
      target: () => $('#helpBtn'), end: true, nextTour: 'compose' },
  ];
  const COMPOSE = [
    { id: 'room', title: 'The Compose Room', text: 'The Jam Room is for playing live. The Compose Room is where a jam becomes a song you can play back, change and share. Click Compose Room.',
      target: () => (visible($('#hall')) ? $('#hall .door2.comp') : $('#roomSeg [data-room="compose"]')), wait: () => api.where() === 'compose' && !visible($('#hall')), show: () => api.goRoom('compose') },
    { id: 'board', title: 'Your song, laid out', text: 'Sections run left to right (Verse, Chorus…), and each row under them is a track: one instrument. Each box is what that track plays in that section. Let\'s fill one in.',
      target: () => $('.arranger'), setup: (c) => tidySection(c), next: true },
    { id: 'chords', title: 'Give it some chords', text: 'Type one chord per bar. Click the first box and type C, press Enter, then Am, F and G.',
      target: () => chordBox(), wait: () => (firstSec()?.chords || []).filter(Boolean).length >= 4,
      show: () => { const s = firstSec(); if (s) api.setSong('sec:' + s.id, { name: s.name, bars: s.bars, chords: Array.from({ length: s.bars }, (_, i) => ['C', 'Am', 'F', 'G'][i % 4]), notes: s.notes || '' }); } },
    { id: 'drumtrack', title: 'Add a drum track', text: 'Click + Add track.',
      target: () => $('.addtrack:not(.open) button') || $('.addtrack.open'), wait: () => !!$('.addtrack.open') || lanes().some((t) => t.drums), show: () => $('.addtrack:not(.open) button')?.click() },
    { id: 'drumpick', title: 'Choose drums', text: 'Pick Machina (a drum machine) as the instrument, then press Add.',
      target: () => $('.addtrack.open'), wait: () => lanes().some((t) => t.drums), show: () => addTrackVia('machina') },
    { id: 'beat', title: 'Write a beat', text: 'This grid is the drum track in the Verse: time runs left to right, one row per drum. Click to place a hit: Kick on beats 1 and 3, Snare on beats 2 and 4. Click a hit twice to remove it.',
      target: () => $('.lvroll'), setup: (c) => { c.lane = lanes().find((t) => t.drums)?.id; }, wait: (c) => onsIn(partOf(firstSec()?.id, c.lane)) >= 4,
      show: (c) => { const s = firstSec(), d = s && api.draftPart({ lane: c.lane }); if (!d) return; const ev = []; for (let bar = 0; bar < s.bars; bar++) for (const [b, n] of [[0, 36], [1, 38], [2, 36], [3, 38], [0, 42], [1, 42], [2, 42], [3, 42], [0.5, 42], [1.5, 42], [2.5, 42], [3.5, 42]]) ev.push({ b: bar * 4 + b, type: 'on', note: n, vel: n === 42 ? 70 : 110 }, { b: bar * 4 + b + 0.2, type: 'off', note: n }); ev.sort((p, q) => p.b - q.b); api.editTake(s.id, d.id, ev, 'write', d); } },
    { id: 'loop', title: 'Hear it', text: 'Press Loop it: the Verse plays round and round, for everyone in the room.',
      target: () => btnText($('#compose'), /Loop it/), wait: () => !!api.transport()?.on && api.transport().mode === 'loop', show: () => api.play('loop', firstSec()?.id) },
    { id: 'basstrack', title: 'Now a bass', text: 'Add another track: + Add track again.',
      target: () => $('.addtrack:not(.open) button') || $('.addtrack.open'), setup: (c) => { c.n = lanes().length; }, wait: (c) => !!$('.addtrack.open') || lanes().length > c.n, show: () => $('.addtrack:not(.open) button')?.click() },
    { id: 'basspick', title: 'Choose a bass', text: 'Pick Monolith (a bass synth), then press Add.',
      target: () => $('.addtrack.open'), setup: (c) => { c.n = lanes().filter((t) => !t.drums).length; }, wait: (c) => lanes().filter((t) => !t.drums).length > c.n, show: () => addTrackVia('monolith') },
    { id: 'jamit', title: 'Jam it in', text: 'This time, play the part instead of clicking it in. Jam it puts the bass on your desk, tied to this track.',
      target: () => btnText($('.trackbar'), /^Jam it$/), setup: (c) => { c.lane = lanes().filter((t) => !t.drums).at(-1)?.id; if (!api.transport()?.on) api.play('loop', firstSec()?.id); }, wait: (c) => api.rack().some((e) => e.lane === c.lane), show: (c) => api.jamLane(c.lane) },
    { id: 'jamsec', title: 'Into the Jam Room', text: 'Jam this section takes you to the Jam Room with the Verse looping and your bass on the desk, ready to play.',
      target: () => btnText($('#compose'), /^Jam this section$/), wait: () => api.where() === 'jam' && !!api.transport()?.on, show: () => { api.play('loop', firstSec()?.id); api.goRoom('jam'); } },
    { id: 'bassplay', title: 'Play along', text: touch ? 'The bar at the top counts you through the loop. Tap out a bass line on the keys: one low note at the start of each bar is plenty (C, then A, F, G).' : 'The bar at the top counts you through the loop. Play a bass line on your keys: press Z twice to drop two octaves first, then low notes on beat 1 of each bar are plenty: C, then A, F, G.',
      target: () => $('.keybed'), setup: (c) => { c.n0 = api.notes(); c.lane = lanes().filter((t) => !t.drums).at(-1)?.id; if (!api.transport()?.on) api.play('loop', firstSec()?.id); }, wait: (c) => api.notes() - c.n0 >= 8,
      show: () => phrase([36, 36, 45, 45, 41, 41, 43, 43], 500) },
    { id: 'lock', title: 'Lock it in', text: 'Happy with what you played? Lock in keeps your last full pass of the loop as a take on the bass track. Play a pass you like, then press it.',
      target: () => btnText($('#secbar'), /^Lock in/), setup: (c) => { c.lane = lanes().filter((t) => !t.drums).at(-1)?.id; }, wait: (c) => onsIn(partOf(firstSec()?.id, c.lane)) > 0,
      show: (c) => { const e = api.rack().find((x) => x.lane === c.lane); if (e && api.lockIn(e.r)) return; if (onsIn(partOf(firstSec()?.id, c.lane))) return; const s = firstSec(), d = s && api.draftPart({ lane: c.lane }); if (!d) return; const root = { C: 36, Am: 45, F: 41, G: 43 }; const ev = []; for (let bar = 0; bar < s.bars; bar++) { const n = root[(s.chords || [])[bar]] || 36; ev.push({ b: bar * 4, type: 'on', note: n, vel: 100 }, { b: bar * 4 + 1.5, type: 'off', note: n }, { b: bar * 4 + 2, type: 'on', note: n, vel: 90 }, { b: bar * 4 + 3.5, type: 'off', note: n }); } api.editTake(s.id, d.id, ev, 'write', d); } },
    { id: 'back', title: 'Back to the song', text: 'Your take is now part of the song, on the bass track. Go back to the Compose Room to see it.',
      target: () => $('#roomSeg [data-room="compose"]'), wait: () => api.where() === 'compose', show: () => api.goRoom('compose') },
    { id: 'mix', title: 'Mix it', text: 'Each track has M to mute it (for everyone), S to solo it (just for you), a volume slider, and a bin to delete it (with Undo). Click a track\'s name to see its notes and settings.',
      target: () => $('.arow .lhead.pick'), next: true },
    { id: 'song', title: 'Play the song', text: 'Play the song runs every section in order, start to finish. Try it.',
      target: () => $('.playsong'), setup: () => { if (api.transport()?.on && api.transport().mode !== 'song') api.stop(); }, wait: () => !!api.transport()?.on && api.transport().mode === 'song', show: () => api.play('song') },
    { id: 'more', title: 'Grow it and share it', text: 'Add a section for a Chorus, or start from a Song preset with a whole band. Song options has the rest: export stems and an Ableton Live set, save MIDI, or save the song.',
      target: () => $('.moretoggle'), next: true },
    { id: 'end', title: 'You\'re all set!', text: 'You wrote a song: chords, a beat you clicked in and a bass you played. Now make your own: invite the band, jam a section, lock in the takes you like. Stop the song any time with the same button.', end: true, nextTour: 'friends' },
  ];
  // ---------- a pretend bandmate: this very app in a hidden frame, walking into your room as Robin ----------
  // It's a real second player (the same code a friend runs: notes over the network, a corner, chat), just silent and
  // pretending to be about 60 ms away (?lag=60), so the timing you see is the timing you'd get.
  const friend = {
    frame: null, timer: null, r: null,
    R() { try { return this.frame?.contentWindow?.JJ || null; } catch (_) { return null; } },
    corner() { return [...document.querySelectorAll('.corner')].find((c) => /^Robin\b/.test(c.querySelector('.cname')?.textContent || '')) || null; },
    here() { return api.band().find((p) => p.name === 'Robin') || null; },
    summon() {
      if (this.frame) return;
      const q = new URLSearchParams({ room: api.roomCode(), bot: '1', silent: '1', name: 'Robin', lag: '60', empty: '1' }); if (api.server()) q.set('server', api.server());
      const f = h('iframe', { src: `${location.pathname}?${q}`, title: 'Robin, a pretend bandmate', 'aria-hidden': 'true', tabindex: '-1', class: 'tour-friend' });
      document.body.append(f); this.frame = f;
    },
    async play(inst, patch, hw) {   // put an instrument on Robin's desk (a linked hardware unit too) and select it
      for (let t = 0; t < 80 && !(this.R()?.S?.me && this.R().clock?.locked && this.R().engine?.defs?.size); t++) await sleep(150);
      const R = this.R(); if (!R) return;
      const r = R.addEntry({ inst, patch, hw }); if (r != null) { R.select(r); this.r = r; }
    },
    groove(kind) {   // a riff in the room's key, one note per eighth, on the room's beat
      clearInterval(this.timer); let last = -1;
      const k = api.key(), root = k?.mode ? k.root : 9, minor = !k?.mode || k.mode === 'minor';
      const bass = [0, 0, 12, 0, minor ? 3 : 4, 5, 7, minor ? 10 : 9].map((d) => 33 + root + d), pads = [[0, minor ? 3 : 4, 7], [minor ? 8 : 9, 12, minor ? 15 : 16]];
      this.timer = setInterval(() => {
        const R = this.R(); if (!R?.input || !R.clock?.locked) return;
        const beat = R.tempo.beatAt(R.clock.now()), step = Math.floor(beat * 2); if (step === last) return; last = step;
        if (kind === 'pad') { if (step % 8) return; const ch = pads[Math.floor(step / 8) % 2].map((d) => 57 + root + d); ch.forEach((n) => R.input.press(n, 80)); setTimeout(() => ch.forEach((n) => R.input.release(n)), (60000 / R.tempo.bpm(R.clock.now())) * 3.6); return; }
        const n = bass[step % 8]; R.input.press(n, step % 2 ? 84 : 104); setTimeout(() => R.input.release(n), (60000 / R.tempo.bpm(R.clock.now())) * 0.4);
      }, 20);
    },
    say(text) { try { this.R()?.chat(text); } catch (_) {} },
    leave() {   // say goodbye properly (the room drops the corner at once), then take the frame away
      clearInterval(this.timer); this.timer = null; const f = this.frame; this.frame = null; this.r = null; if (!f) return;
      try { f.contentWindow?.document.querySelector('#leaveBtn')?.click(); } catch (_) {}
      setTimeout(() => f.remove(), 800);
    },
  };
  // ---------- Match my sound, demonstrated. A hidden synth set the way Robin set the "real OB-6" (a punchy brass)
  // stands in for the hardware; Robin's twin starts on the soft pad it was guessed as. The real one's phrase is rendered
  // here; the twin's, Robin plays over the network. Match my sound's own fitter learns from the real one's notes and
  // works on the twin out of earshot while the phrases play; between rounds Robin's twin glides to the best it found
  // (to every browser, as with a real synth). It only glides to a candidate that beats the twin on all the evidence.
  // Progress lives in c.demo: {phase, round, sim0, sim}.
  const PH = { held: 0.55, gap: 0.75 };
  async function renderPhrase(def, params, notes, sr) {
    const ctx = new OfflineAudioContext(2, Math.ceil(sr * (notes.length * PH.gap + 1.2)), sr);
    if (def.init) await def.init(ctx);
    const insts = notes.map((n, i) => { const g = ctx.createGain(); g.connect(ctx.destination); const x = def.create(ctx, g, params); const t = 0.03 + i * PH.gap; x.noteOn(n, 100, t); x.noteOff(n, t + PH.held); return x; });
    const hold = ctx.suspend(256 / sr).then(async () => { await sleep(30); ctx.resume(); });   // worklet instruments' first messages
    const buf = await ctx.startRendering(); await hold;
    for (const x of insts) { try { x.dispose(); } catch (_) {} }
    return buf;
  }
  const rms = (buf) => { const x = buf.getChannelData(0); let e = 0; for (let i = 0; i < x.length; i++) e += x[i] * x[i]; return Math.sqrt(e / x.length) || 1e-9; };
  async function matchDemo(c) {
    const d = c.demo = { phase: 'prep', round: 0, sim0: null, sim: null };
    const live = () => !c.stop && !!friend.frame;
    const R = friend.R(), e = R?.S?.rack.find((x) => x.r === friend.r), A = api.audio(), def = e && api.def(e.cfg.inst);
    if (!R || !e || !A || !def) { d.phase = 'fail'; return; }
    friend.groove(null);
    const k = api.key(), root = k?.mode ? k.root : 9;
    const notes = [0, 7, 12].map((x) => 48 + (root % 12) + x);   // root, fifth, octave: C3-B3 and up
    const start = { ...e.cfg.params };
    const real = { ...start, pulse: 0, pwm: 0, chorus: 0, attack: 0.05, decay: 0.6, sustain: 0.7, release: 0.35, cutoff: 1100, envAmt: 0.4, reso: 0.2 };
    const sr = A.ctx.sampleRate, refBuf = await renderPhrase(def, real, notes, sr), twinBuf = await renderPhrase(def, start, notes, sr);
    const refGain = Math.min(4, rms(twinBuf) / rms(refBuf));   // the same loudness, so you compare the sound, not the level
    const fit = new Fitter(def, start, { batch: 6, perBatch: 2 }), ch = refBuf.getChannelData(0);
    [0, 2].forEach((i) => { const s0 = Math.round((0.03 + i * PH.gap) * sr), o = analyze(ch.slice(s0, s0 + Math.round((PH.held + 0.45) * sr)), sr, notes[i], PH.held); if (o) { o.vel = 100; fit.observe(o); } });
    const alike = async (p) => fit.similarity(await fit.scoreAll(p));
    let kept = { ...start }, keptSim = d.sim0 = d.sim = await alike(start);
    // the fitter, in the background: a few batches, then check the best on all the evidence; keep it only if it's better
    const search = (async () => {
      while (live() && d.phase !== 'done') {
        for (let i = 0; i < 3 && live(); i++) { await fit.step(); await sleep(120); }
        if (!live()) return;
        const s1 = await alike(fit.best);
        if (s1 > keptSim + 0.005) { kept = { ...fit.best }; keptSim = s1; } else fit.best = { ...kept };
      }
    })();
    let src = null;
    c.halt = () => { try { src?.stop(); } catch (_) {} for (const n of notes) try { R.input.release(n); } catch (_) {} };
    const playReal = () => new Promise((res) => { if (!live()) return res(); const g = A.ctx.createGain(); g.gain.value = refGain; g.connect(A.out); src = A.ctx.createBufferSource(); src.buffer = refBuf; src.connect(g); src.onended = () => { g.disconnect(); res(); }; src.start(); });
    const playTwin = async () => { for (const n of notes) { if (!live()) return; R.input.press(n, 100); await sleep(PH.held * 1000); R.input.release(n); await sleep((PH.gap - PH.held) * 1000); } await sleep(900); };
    const both = async () => { d.phase = 'real'; await playReal(); if (!live()) return; await sleep(450); d.phase = 'twin'; await playTwin(); };
    await sleep(600); await both();
    for (d.round = 1; d.round <= 3 && live(); d.round++) {
      d.phase = 'fit';
      for (let t = 0; t < 40 && live() && keptSim <= d.sim + 0.005; t++) await sleep(250);   // wait for something better (up to 10 s)
      if (!live()) return;
      const to = { ...kept }, ids = fit.space.map((P) => P.id).filter((id) => to[id] !== undefined && to[id] !== e.cfg.params[id]), from = { ...e.cfg.params };
      for (let i = 1; i <= 6 && live(); i++) {   // glide there, as Match my sound does
        for (const id of ids) { const P = fit.space.find((x) => x.id === id), a = from[id] ?? P.def, b = to[id]; R.setParam(id, P.step ? (i === 6 ? b : a) : P.curve === 'exp' ? a * (b / a) ** (i / 6) : a + (b - a) * (i / 6)); }
        await sleep(250);
      }
      d.sim = Math.max(d.sim, keptSim);
      if (live()) await both();
    }
    if (!live()) return;
    d.phase = 'done'; await search.catch(() => {});
    if (live()) friend.groove('pad');
  }
  const FRIENDS = [
    { id: 'hello', title: 'Jam with a friend', text: 'Let\'s practice with a pretend friend called Robin. Robin is a bit of a robot (they live in this tab), but everything you\'ll see works just the same with a real friend across town. Ready? Press Next and Robin walks in.',
      setup: () => { if (api.where() !== 'jam') api.goRoom('jam'); }, next: true },
    { id: 'arrive', title: 'Robin walks in', live: true, text: (c) => 'Robin is joining with your room\'s four-letter code, the one next to Invite. Friends you invite get a corner, just like yours…' +
        (c.t0 && Date.now() - c.t0 > 15000 && !friend.corner() ? ' Robin is taking a while: check you\'re online. Close the tour and try again if Robin doesn\'t show.' : ''),
      target: () => friend.corner() || $('#roomCode')?.closest('.readout'), setup: (c) => { c.t0 = Date.now(); friend.summon(); }, wait: () => !!friend.corner() && !!friend.here() },
    { id: 'listen', title: 'Only the notes travel', text: 'That\'s Robin on bass. Here\'s the clever bit: Robin\'s sound never crosses the internet. Only Robin\'s notes do (which key, how hard, and when), and your browser plays Robin\'s bass itself. So it sounds clean on your end, never crackly, even on a slow connection.',
      target: () => friend.corner(), setup: async () => { await friend.play('monolith', 'bass'); friend.groove('bass'); }, next: true },
    { id: 'together', title: 'Play along', text: touch ? 'Join in: tap some notes on the keys. Anything goes; Robin will keep the groove.' : 'Join in: play some notes on your keys (A S D F…). Anything goes; Robin will keep the groove.',
      target: () => $('.keybed'), setup: (c) => { c.n0 = api.notes(); if (!api.rack().length) api.addInstrument('juniper', 'keys'); }, wait: (c) => api.notes() - c.n0 >= 8, done: () => friend.say('ooh nice, keep going!'), show: () => phrase([57, 60, 64, 62, 60, 57, 64, 67], 300) },
    { id: 'clock', title: 'One clock for the whole band', text: 'How do you stay together when a note takes time to travel? Every note is stamped with a moment on a clock the whole band shares, set a tiny bit in the future. It arrives everywhere before that moment, and everyone hears it at the same instant. Click the gear to see the timing.',
      target: () => $('#techBtn'), wait: () => api.tech(), show: () => $('#techBtn')?.click() },
    { id: 'look', title: 'The lookahead', live: true, text: () => `This is the lookahead: how far ahead your notes are planned so they reach Robin in time. Robin is pretending to be about 60 ms away (a friend in another city), so right now it's ${api.look()} ms: the trip, plus a margin so nothing ever arrives late. With a friend in the same town it's much smaller. The app measures it by itself, so there's nothing to set.`,
      target: () => $('.lookbar'), next: true },
    { id: 'feel', title: 'Make it feel right', text: 'If your own notes ever feel a hair late under your fingers, turn on Hear myself: you hear yourself instantly, and the band still hears you in sync. Drums and bass keep strict time automatically; slow pads and strings are relaxed about it. Rhythm help nudges early notes onto the beat.',
      target: () => $('#selfBtn'), next: true },
    { id: 'chat', title: 'Say hi', text: 'There\'s a band chat, and Robin just wrote in it. Open the chat (the lit-up speech bubble) and say hi back.',
      target: () => (visible($('#panel-chat')) ? $('#panel-chat') : $('.sidetab[data-panel="panel-chat"]')), setup: (c) => { c.m0 = api.myChats(); friend.say('hey! 👋 Robin here'); }, wait: (c) => api.myChats() > c.m0, done: () => setTimeout(() => friend.say('glad you made it 🎶'), 600),
      show: async () => { document.querySelector('.sidetab[data-panel="panel-chat"]')?.click(); await sleep(300); const i = $('#chatIn'); if (i) { i.value = 'hi Robin!'; $('#chatSend')?.click(); } } },
    { id: 'talk', title: 'Or just talk', text: 'Talk turns on your microphone for the band: click to leave it on, or hold it while you speak. Headphones stop the music from echoing back through your mic.',
      target: () => $('#talkBtn'), setup: () => { for (const b of document.querySelectorAll('#panel-chat [data-closepanel]')) b.click(); }, next: true },
    { id: 'styles', title: 'Ways to jam', text: 'Jam freely like this. Or loop a section and take turns locking in parts, which builds a song as you go (the Compose Room tour shows how). Or bring a real mic or guitar with Live audio: it reaches the band a bar or two late, on purpose, landing on the same chords one loop later.',
      target: () => $('.sidetab[data-panel="panel-lane"]'), next: true },
    { id: 'twin', title: 'Real synths, and twins', live: true, text: () => { const t = friend.here()?.rack.find((x) => x.hw); return `Robin just plugged in a real synth, an OB-6, and linked it in My gear. You don't own one, so your browser plays its twin: the closest software instrument, here ${api.instName(t?.inst) || 'a matching synth'}. Robin hears the real OB-6, and you hear a close match.`; },
      target: () => friend.corner(), setup: async () => { friend.groove(null); await friend.play('juniper', 'pad', 'sequential-ob-6'); friend.groove('pad'); }, wait: () => !!friend.here()?.rack.some((x) => x.hw), },
    { id: 'onetoo', title: 'I have one too', text: 'Got the same synth as a friend? Link yours in My gear, and the friend\'s part can play on your real one, with their sound copied across. You both hear the real thing.',
      target: () => $('#addHwBtn'), next: true },
    { id: 'match', title: 'Match my sound', live: true, text: (c) => {
        const d = c.demo || {}, pc = (v) => `${Math.round(100 * v)}%`;
        const now = { prep: 'Robin set the real OB-6 to a punchy brass sound. The twin you hear started as a guess: a soft pad. Listen…',
          real: '▶ Robin\'s real OB-6, as Robin hears it.',
          twin: `▶ Its twin, in your browser: ${pc(d.sim ?? 0)} alike.`,
          fit: `Match my sound is trying settings on the twin, out of earshot… (round ${d.round} of 3)`,
          done: `Matched: from ${pc(d.sim0 ?? 0)} to ${pc(d.sim ?? 0)} alike. Every browser glided to the same settings, so the whole band now hears something close to the real OB-6.`,
          fail: 'Match my sound listens to your real synth through your audio input as you play, and nudges its twin until it sounds like yours.' }[d.phase || 'prep'];
        return `${now} With your own synth, this runs quietly while you play. (Here a hidden synth, set the way Robin set the OB-6, stands in for it; the matching is the real thing.)`;
      },
      target: () => friend.corner(), setup: (c) => { matchDemo(c).catch(() => { if (c.demo) c.demo.phase = 'fail'; }); }, done: (c) => { c.stop = true; c.halt?.(); if (friend.frame && c.demo?.phase !== 'done') friend.groove('pad'); }, next: true },
    { id: 'sync', title: 'Keep the good take', text: 'Caught something great? Sync take has everyone record their own true sound, real synths and mics included, and gathers it all into one folder of lined-up tracks to mix later.',
      target: () => $('#syncBtn'), next: true },
    { id: 'bye', title: 'Robin heads home', text: 'That\'s it from Robin. To jam with a real friend: Invite copies a link to this studio. Send it, and they walk into an empty corner just like Robin did.',
      target: () => $('#copyBtn'), setup: () => { friend.say('gotta run, that was fun! 👋'); setTimeout(() => friend.leave(), 1500); }, next: true },
    { id: 'end', title: 'You\'re all set!', text: 'You know how jamming together works: notes travel, a shared clock keeps everyone together, twins stand in for gear your friends don\'t have, and the chat and Talk keep you talking. Now go find your band.', end: true },
  ];
  const TOURS = { jam: { title: 'Your first jam', steps: JAM }, compose: { title: 'Write your first song', steps: COMPOSE }, friends: { title: 'Jam with a friend', steps: FRIENDS } };

  // a short Verse to work in: the song's first section, cut to 4 bars when it's still empty
  function tidySection() {
    const s = firstSec();
    if (!s) { api.setSong('sec:tv', { name: 'Verse', bars: 4, chords: ['', '', '', ''], notes: '' }); api.setSong('order', ['tv']); return; }
    if (!Object.keys(s.parts || {}).length && !(s.chords || []).some(Boolean) && s.bars !== 4) api.setSong('sec:' + s.id, { name: s.name, bars: 4, chords: ['', '', '', ''], notes: s.notes || '' });
  }
  function chordBox() { const s = firstSec(); if (!s) return null; const el = $(`[data-cell="${s.id}:0"]`); if (!el) { $(`#compose .shead[data-sec="${s.id}"]`)?.click(); } return $(`[data-cell="${s.id}:0"]`)?.closest('.row') || $(`[data-cell="${s.id}:0"]`); }
  async function addTrackVia(inst) {
    if (!$('.addtrack.open')) { $('.addtrack:not(.open) button')?.click(); await sleep(150); }
    const sel = $('.addtrack.open select[aria-label="Instrument"]'); if (!sel) return;
    sel.value = inst; sel.dispatchEvent(new Event('change', { bubbles: true })); await sleep(50);
    $('.addtrack.open button.hot')?.click();
  }

  // ---------- the overlay: a lit hole round the target, and a card beside it ----------
  function build() {
    const shade = h('div', { class: 'tour-shade', 'aria-hidden': 'true' });
    const bubble = h('div', { class: 'tour-card', role: 'dialog', 'aria-live': 'polite', 'aria-label': 'Tour' });
    document.body.append(shade, bubble);
    return { shade, bubble };
  }
  // Back goes to the last step that still applies: not the lobby once you're in, not one that would skip itself
  function prevIdx() {
    for (let j = tour.i - 1; j >= 0; j--) { const s = tour.steps[j]; let sk = false; try { sk = !!s.skip?.(); } catch (_) {} if (!(s.lobby && api.inStudio()) && !sk) return j; }
    return -1;
  }
  function render() {
    if (!tour) return;
    const st = tour.steps[tour.i], c = tour.ctx, n = tour.steps.filter((s) => !s.lobby || !tour.skipLobby).length;
    const at = tour.steps.slice(0, tour.i + 1).filter((s) => !s.lobby || !tour.skipLobby).length;
    const btn = (label, cls, fn, title) => h('button', { class: 'btn small ' + cls, title: title || '', onclick: (e) => { e.currentTarget.blur(); fn(); } }, label);
    const actions = st.end
      ? [st.nextTour ? btn(`${TOURS[st.nextTour].title} →`, 'hot', () => { remember(tour.name); start(st.nextTour); }) : null, btn('Done', st.nextTour ? 'ghost' : 'hot', () => stop(true))]
      : [prevIdx() >= 0 ? btn('Back', 'ghost', () => go(prevIdx())) : null, h('span', { style: 'flex:1' }),
        st.show && !st.next && !c.passed ? btn(c.showing ? 'Doing it…' : 'Show me', 'ghost tour-show', async () => { if (c.showing) return; c.showing = true; render(); try { await st.show(c); } catch (_) {} c.showing = false; if (!c.passed) render(); }, 'Do this step for me') : null,
        st.next || c.passed ? btn(c.passed ? 'Next ✓' : 'Next', 'hot tour-next', () => go(tour.i + 1)) : h('span', { class: 'tour-wait help' }, 'waiting for you…')];
    tour.el.bubble.replaceChildren(
      h('div', { class: 'tour-top' }, h('small', { class: 'tour-count' }, st.end ? TOURS[tour.name].title : `${TOURS[tour.name].title} · ${at} of ${n}`), h('button', { class: 'tour-x', 'aria-label': 'Leave the tour', title: 'Leave the tour (start it again from ? any time)', onclick: () => stop(false) }, '×')),
      h('b', { class: 'tour-title' }, (c.passed && !st.next ? '✓ ' : '') + st.title), h('p', {}, typeof st.text === 'function' ? st.text(c) : st.text), h('div', { class: 'tour-actions' }, ...actions.filter(Boolean)));
    place();
  }
  // Where the overlay lives: inside the box that scrolls the target (the studio, the lobby) or the fixed panel that
  // holds it (a drawer), placed in that box's own coordinates. It then scrolls with the page natively, and any offset
  // the browser adds to client coordinates (iOS Safari's zoom after focusing a text field, its moving address bar)
  // cancels out, since both rects are read the same way. Nothing found: fixed, over the window.
  function hostOf(el) {
    for (let a = el && el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (a.id === 'studio' || a.id === 'lobby') return a;
      if (getComputedStyle(a).position === 'fixed') return a;
    }
    return null;
  }
  function adopt(node, host) {
    const want = host || document.body;
    if (node.parentElement !== want) want.append(node);
    node.style.position = host ? 'absolute' : 'fixed';
  }
  // the part of the screen you can actually see, in client coordinates: the visual viewport (on a phone: above the
  // browser's toolbar and the on-screen keyboard), cut to the host's box
  function windowFor(host) {
    const vv = window.visualViewport, vw = document.documentElement.clientWidth || innerWidth;
    const v = vv ? { left: vv.offsetLeft, top: vv.offsetTop, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height } : { left: 0, top: 0, right: vw, bottom: innerHeight };
    const hr = host ? host.getBoundingClientRect() : v;
    return { left: Math.max(v.left, hr.left), top: Math.max(v.top, hr.top), right: Math.min(v.right, hr.right), bottom: Math.min(v.bottom, hr.bottom) };
  }
  // Before placing: make room. If the target isn't fully on screen, or there's no side of it where the card fits
  // without covering it, scroll the box that holds it so the target sits near the top with the card's room below
  // (or as much of it as fits). Once per target per step, so you can still scroll away yourself.
  function makeRoom(el) {
    const c = tour.ctx; if (!el || c.roomFor === el || (c.roomTries || 0) >= 3) return; c.roomFor = el;
    const host = hostOf(el), win = windowFor(host), r = el.getBoundingClientRect(), { bubble } = tour.el, bh = bubble.offsetHeight || 220, bw = bubble.offsetWidth || 380, pad = 8, gap = 14;
    const inView = r.top >= win.top && r.bottom <= win.bottom && r.left >= win.left && r.right <= win.right;
    const fits = r.bottom + pad + gap + bh <= win.bottom - 8 || r.top - pad - gap - bh >= win.top + 8 || r.right + pad + gap + bw <= win.right - 8 || r.left - pad - gap - bw >= win.left + 8;
    if (inView && fits) return;
    c.roomTries = (c.roomTries || 0) + 1;
    // bring it into view through every box that scrolls (a pane inside the studio, the studio itself), then set the
    // outer one so the target sits near the top, leaving the card its room underneath
    const room = r.height + pad * 2 + gap + bh + 16 <= win.bottom - win.top;   // target and card both fit, one above the other
    el.scrollIntoView({ block: room ? 'start' : 'center', inline: 'nearest' });
    if (!host || host.scrollHeight <= host.clientHeight + 1 || getComputedStyle(host).position === 'fixed' && !/(auto|scroll)/.test(getComputedStyle(host).overflowY)) return;
    const r2 = el.getBoundingClientRect(), w2 = windowFor(host);
    host.scrollTop += r2.top - (room ? w2.top + pad + 8 : w2.top + Math.max(8, (w2.bottom - w2.top - r2.height) / 2));
  }
  function place() {
    if (!tour) return;
    const st = tour.steps[tour.i], el = st.target?.(tour.ctx), { shade, bubble } = tour.el, pad = 8, gap = 14;
    if (el && visible(el)) makeRoom(el);
    const r = el && visible(el) ? el.getBoundingClientRect() : null, host = r ? hostOf(el) : null;
    adopt(shade, host); adopt(bubble, host);
    // the visible window, in client coordinates: the host's box cut to the viewport
    const hr = host ? host.getBoundingClientRect() : null, win = windowFor(host);
    const toHost = (x, y) => (host ? [x - hr.left - host.clientLeft + host.scrollLeft, y - hr.top - host.clientTop + host.scrollTop] : [x, y]);
    const bw = bubble.offsetWidth || 380, bh = bubble.offsetHeight || 200;
    let bx, by;
    if (!r) {
      const [x, y] = toHost((win.left + win.right) / 2, (win.top + win.bottom) / 2);
      shade.style.left = `${x}px`; shade.style.top = `${y}px`; shade.style.width = '0px'; shade.style.height = '0px';
      bx = (win.left + win.right) / 2 - bw / 2; by = (win.top + win.bottom) / 2 - bh / 2;
    } else {
      const [x, y] = toHost(r.left - pad, r.top - pad);
      shade.style.left = `${x}px`; shade.style.top = `${y}px`; shade.style.width = `${r.width + pad * 2}px`; shade.style.height = `${r.height + pad * 2}px`;
      bx = r.left + r.width / 2 - bw / 2;
      if (r.bottom + pad + gap + bh <= win.bottom) by = r.bottom + pad + gap;
      else if (r.top - pad - gap - bh >= win.top) by = r.top - pad - gap - bh;
      else if (r.right + pad + gap + bw <= win.right) { bx = r.right + pad + gap; by = r.top; }
      else if (r.left - pad - gap - bw >= win.left) { bx = r.left - pad - gap - bw; by = r.top; }
      else by = win.bottom - bh - 12;   // no room beside it (a tall target on a phone): the card sits at the bottom
    }
    bx = Math.max(win.left + 8, Math.min(win.right - bw - 8, bx)); by = Math.max(win.top + 8, Math.min(win.bottom - bh - 8, by));
    const [cx, cy] = toHost(bx, by);
    bubble.style.left = `${cx}px`; bubble.style.top = `${cy}px`;
  }
  function go(i) {
    if (!tour) return;
    const prev = tour.steps[tour.i]; try { prev?.done?.(tour.ctx); } catch (_) {}
    if (i < 0 || i >= tour.steps.length) return stop(true);
    tour.i = i; tour.ctx = {}; const st = tour.steps[i];
    let skip = false; try { skip = !!st.skip?.(); } catch (_) {}
    if (skip) return go(i + 1);
    try { st.setup?.(tour.ctx); } catch (_) {}
    // a drawer left open (the wall, the tapes) would hide what this step points at: close it
    const el = st.target?.(tour.ctx);
    if (el && !el.closest('.drawer, #hall') && [...document.querySelectorAll('.drawer')].some(visible)) api.closeDrawers();
    render();
  }
  function tick() {
    if (!tour) return;
    const st = tour.steps[tour.i], c = tour.ctx;
    if (st.lobby && api.inStudio()) { go(tour.i + 1); return; }
    if (st.live && typeof st.text === 'function') { const t = tour.el.bubble.querySelector('p'); const s = st.text(c); if (t && t.textContent !== s) t.textContent = s; }
    if (!st.next && !st.end && !c.passed) {
      let ok = false; try { ok = !!st.wait?.(c); } catch (_) {}
      if (ok) { c.passed = true; render(); const at = tour.i; setTimeout(() => { if (tour && tour.i === at) go(at + 1); }, 900); }
    }
    place();
  }
  function start(name) {
    stop(false, true);
    if (name === 'friends' && !api.inStudio()) return;   // Robin needs a room to walk into
    const T = TOURS[name]; if (!T) return;
    tour = { name, steps: T.steps, i: 0, ctx: {}, el: build(), skipLobby: api.inStudio() };
    document.body.classList.add('touring');
    tour.timer = setInterval(tick, 200);
    addEventListener('resize', place); addEventListener('scroll', place, true);
    go(tour.skipLobby ? T.steps.findIndex((s) => !s.lobby) : 0);
  }
  function stop(finished, quiet) {
    if (!tour) return;
    try { tour.steps[tour.i]?.done?.(tour.ctx); } catch (_) {}
    if (finished) remember(tour.name);
    if (tour.name === 'friends') friend.leave();
    clearInterval(tour.timer); removeEventListener('resize', place); removeEventListener('scroll', place, true);
    tour.el.shade.remove(); tour.el.bubble.remove(); tour = null;
    document.body.classList.remove('touring');
    if (!quiet) for (const b of document.querySelectorAll('.tourbtn')) b.classList.toggle('fresh', !toured('jam'));
  }
  // the ? menu in the studio: either tour
  function menu(anchor) {
    document.querySelector('.tour-menu')?.remove();
    const m = h('div', { class: 'tour-menu', role: 'menu' },
      h('b', {}, 'Guided tours'),
      ...Object.entries(TOURS).map(([k, T]) => h('button', { class: 'btn small' + (toured(k) ? '' : ' hot'), role: 'menuitem', onclick: () => { m.remove(); start(k); } }, `${T.title}${toured(k) ? ' ✓' : ''}`)),
      h('small', { class: 'help' }, 'Step by step, about five minutes each. Leave any time with ×.'),
      h('a', { class: 'btn small ghost tour-manual', role: 'menuitem', href: 'help.html', target: '_blank', rel: 'noopener', onclick: () => m.remove() }, 'Read the manual ↗'));
    document.body.append(m);
    const r = anchor.getBoundingClientRect(); m.style.top = `${r.bottom + 8}px`; m.style.left = `${Math.max(12, Math.min(innerWidth - m.offsetWidth - 12, r.right - m.offsetWidth))}px`;
    const away = (e) => { if (!m.contains(e.target) && e.target !== anchor) { m.remove(); removeEventListener('pointerdown', away, true); } };
    setTimeout(() => addEventListener('pointerdown', away, true), 0);
  }
  return { start, stop, menu, target: () => (tour ? tour.steps[tour.i].target?.(tour.ctx) || null : null), active: () => tour && { name: tour.name, step: tour.steps[tour.i].id, passed: !!tour.ctx.passed, demo: tour.ctx.demo || null }, steps: (k) => TOURS[k].steps.map((s) => s.id) };
}
