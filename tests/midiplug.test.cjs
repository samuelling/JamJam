// Plugging in MIDI gear: if the browser already allowed MIDI it switches on by itself, a device plugged in later is
// announced by name and plays the selected instrument, and pulling it out is announced too. Web MIDI is faked.
//   node server/dev.js &  (8787)        node tests/midiplug.test.cjs
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  try {
    const c = await browser.newContext(); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript(() => {
      const access = { inputs: new Map(), outputs: new Map(), onstatechange: null };
      window.__midi = { access, plug(id, name) { const port = { id, name, state: 'connected', onmidimessage: null }; access.inputs.set(id, port); access.onstatechange?.({ port }); return port; },
        unplug(id) { const port = access.inputs.get(id); port.state = 'disconnected'; access.inputs.delete(id); access.onstatechange?.({ port }); } };
      navigator.requestMIDIAccess = async () => access;
      const q = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (d) => (d && d.name === 'midi' ? Promise.resolve({ state: 'granted' }) : q(d));
    });
    await p.goto('http://localhost:8787/?lag=25'); await p.fill('#nameIn', 'Sam');
    await p.click('#startBtn'); await p.waitForSelector('#studio:not(.hide)');
    await sleep(800);
    check(await p.evaluate(() => !!JJ.input.midi), 'MIDI is on without pressing Enable MIDI, since the browser already allowed it');
    await p.evaluate(() => { window.__port = window.__midi.plug('op1', 'OP-1 field'); });
    await sleep(300);
    const said = await p.evaluate(() => document.body.innerText);
    check(/OP-1 field connected/.test(said), 'plugging in the OP-1 field is announced by name');
    check(/MIDI IN: OP-1 field/.test(await p.textContent('#inputStatus')), 'and the keys bar names it');
    const before = await p.evaluate(() => JJ.engine.log.filter((e) => e.type === 'on').length);
    await p.evaluate(() => { window.__port.onmidimessage({ data: new Uint8Array([0x90, 60, 100]) }); setTimeout(() => window.__port.onmidimessage({ data: new Uint8Array([0x80, 60, 0]) }), 200); });
    await sleep(600);
    check((await p.evaluate(() => JJ.engine.log.filter((e) => e.type === 'on').length)) > before, 'a key on it plays the selected instrument');
    await p.evaluate(() => window.__midi.unplug('op1'));
    await sleep(300);
    check(/OP-1 field unplugged/.test(await p.evaluate(() => document.body.innerText)), 'pulling it out is announced');
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } catch (e) { console.error(e); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
