// AirPlay on iOS Safari. Safari only offers AirPlay for media elements, and the room's sound is Web Audio, so this
// sends the room's output through an <audio> element. AirPlay adds about two seconds, so it warns first: fine for
// listening, too late to play along. If Safari won't offer the speaker, Control Center's AirPlay still moves everything.
const WARNING = 'AirPlay adds about 2 seconds of delay.\n\nThat suits listening to a song. Anything you play will sound late, and you won\'t be in time with the band.\n\nIf your speaker isn\'t listed next, use AirPlay in Control Center.';

export const canAirplay = (nav = navigator, proto = globalThis.HTMLMediaElement?.prototype) => !!proto && 'webkitShowPlaybackTargetPicker' in proto && (/iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1));

export function makeAirplay(engine, btn, say) {
  if (!canAirplay()) return;
  btn.classList.remove('hide');
  let el = null, stream = null, on = false;
  const set = (v) => { on = v; btn.classList.toggle('on', v); btn.setAttribute('aria-pressed', String(v)); btn.textContent = v ? 'AirPlay on' : 'AirPlay'; };
  const stop = () => {
    if (!on) return;
    try { engine.out.disconnect(stream); } catch (_) {}
    engine.out.connect(engine.ctx.destination);
    el.pause(); el.srcObject = null; set(false); engine.ctx.resume().catch(() => {});
    say('Back on this device: no AirPlay delay.');
  };
  // starting the element can stop Web Audio on iOS, and then the stream is silent: better back on the device than quiet
  const running = async () => {
    engine.ctx.resume().catch(() => {});
    for (let i = 0; i < 15 && engine.ctx.state !== 'running'; i++) await new Promise((r) => setTimeout(r, 100));
    return engine.ctx.state === 'running';
  };
  btn.addEventListener('click', async () => {
    if (on) { stop(); return; }
    if (!engine.ctx || !confirm(WARNING)) return;
    stream = stream || engine.ctx.createMediaStreamDestination();
    if (!el) {
      el = document.createElement('audio');
      el.setAttribute('x-webkit-airplay', 'allow'); el.setAttribute('playsinline', ''); el.hidden = true;
      document.body.append(el);
    }
    engine.out.disconnect(engine.ctx.destination); engine.out.connect(stream);
    el.srcObject = stream.stream; set(true);
    try {
      const playing = el.play();   // starts inside the tap, as the picker needs
      el.webkitShowPlaybackTargetPicker();
      await playing;
      if (!await running()) throw new Error('audio stopped');
      say('AirPlay: expect about 2 seconds of delay. Tap AirPlay on to come back.');
    } catch (e) { stop(); say("Safari couldn't send this to AirPlay. Use AirPlay in Control Center instead.", 'error'); }
  });
}
