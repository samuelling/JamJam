// Studios: a band's permanent room. Walk in alone or together, any day, and the song is where you left it, with
// every take and its audio; lock in a few takes and leave them for the others to hear, pick or rearrange.
//
// The song lives on the studio server (studio/worker.js), key by key exactly as the room shares it, and the audio
// takes in its file store. Who keeps it up to date: the room's clock leader (whoever has been in longest). It
// mirrors each change the room makes a moment later, and a new leader sends the whole song once, so the server
// always holds the room's song with nothing to merge. Whoever walks into an empty studio loads the song from the
// server; anyone joining a busy one gets it from the band as usual. Audio a browser is missing comes from the
// server first, so a take plays even when the person who recorded it isn't around.
//
// Long-term, a studio's takes can live in the band's own Dropbox (src/dropbox.js, studio/home.js): the studio is
// short-term parking. A bandmate links the band's Dropbox once ("Keep takes in Dropbox"); from then on, whenever
// their browser is in the studio it carries each new take there as a WAV and gives the studio its share link, and
// two weeks on the parked copy goes. Anyone playing a take that has gone home gets it from the band's Dropbox
// (straight from it, or through the studio server when that doesn't work), without signing in to anything.
//
// A studio's link (?studio=<id>) is its key: anyone with it can walk in. This browser remembers the studios it has
// been in, for the lobby.

import { wav, readPcmWav } from './songzip.js';
import { fetchDirect, safeName } from './dropbox.js';

const SKIP = (k) => k === 'transport' || k === 'studio' || k.startsWith('vp:');   // live-only state stays in the room
const LIST_KEY = 'megajam.studios';

export const studioRoom = (id) => 'st-' + id;            // the relay room a studio's band meets in
export const isStudioId = (id) => /^[a-z0-9]{16}$/.test(id || '');

export function myStudios() { try { return JSON.parse(localStorage.getItem(LIST_KEY) || '[]').filter((s) => isStudioId(s.id)); } catch (_) { return []; } }
export function rememberStudio(id, name) {
  try {
    const list = myStudios().filter((s) => s.id !== id);
    list.unshift({ id, name: String(name || 'Studio').slice(0, 40), last: Date.now() });
    localStorage.setItem(LIST_KEY, JSON.stringify(list.slice(0, 20)));
  } catch (_) {}
}
export function forgetStudio(id) { try { localStorage.setItem(LIST_KEY, JSON.stringify(myStudios().filter((s) => s.id !== id))); } catch (_) {} }

// o: { endpoint, songStore, isLeader(), blobs, clipIds() -> [id], extras() -> { bpm, key }, say(text, kind), onSaved(),
//      dropbox (src/dropbox.js), clipName(id) -> a file name for a take, clipCh(id) -> its channels (2: stereo) }
export function makeStudio(o) {
  const st = { id: null, name: '', loaded: false, pending: new Set(), sentWhole: false, server: null, busy: false, failing: 0, lastOk: 0,
    home: null, homes: {}, parked: [], porting: null, portErr: '' };
  const base = () => String(o.endpoint || '').replace(/\/$/, '');
  const url = (p) => `${base()}/studios${p}`;
  async function call(p, opt = {}) {
    const r = await fetch(url(p), { cache: 'no-store', ...opt, headers: { 'content-type': 'application/json', ...(opt.headers || {}) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return j;
  }

  // the room's changes, as the leader sees them
  o.songStore.listeners.add((k) => { if (st.id && st.loaded && !SKIP(k) && o.isLeader()) st.pending.add(k); });

  async function flush(keepalive = false) {
    if (!st.id || !st.loaded || st.busy || !o.isLeader()) return;   // never send a song that isn't the studio's yet
    const whole = !st.sentWhole;
    const keys = whole ? Object.keys(o.songStore.stamps).filter((k) => !SKIP(k)) : [...st.pending];
    // the room's tempo and key aren't song keys: they ride along whenever they change
    const ex = o.extras ? o.extras() : {}, exSig = JSON.stringify(ex), exOps = whole || exSig !== st.exSig ? Object.entries(ex) : [];
    if (whole && !keys.length) { st.sentWhole = true; return; }   // nothing here yet: never wipe the studio with an empty song
    if (!keys.length && !exOps.length) return;
    st.busy = true;
    const ops = [...keys.map((k) => [k, o.songStore.valueOf(k)]), ...exOps];
    const sent = new Set(st.pending); st.pending.clear();
    try {
      await call(`/${st.id}/ops`, { method: 'POST', body: JSON.stringify({ ops, whole }), keepalive });
      if (whole) st.sentWhole = true;
      st.exSig = exSig;
      st.failing = 0; st.lastOk = Date.now(); o.onSaved?.();
    } catch (e) {
      for (const k of sent) st.pending.add(k);
      if (++st.failing === 3) o.say?.(`Couldn't save to the studio (${e.message}). Keep playing: it saves when the connection is back.`, 'error');
    } finally { st.busy = false; }
  }

  // what the studio has: parked takes, takes gone home, and where home is
  async function refresh() {
    const c = await call(`/${st.id}/clips`);
    st.server = new Set([...c.ids, ...Object.keys(c.homes || {})]); st.parked = c.ids; st.homes = c.homes || {};
    const was = JSON.stringify(st.home); st.home = c.home || null; if (JSON.stringify(st.home) !== was) o.onSaved?.();
    return c;
  }
  // audio the song uses that the server doesn't have yet: the leader sends what it has
  async function syncClips() {
    if (!st.id || !st.loaded || !o.isLeader()) return;
    try {
      if (!st.server) await refresh();
      for (const id of o.clipIds()) {
        if (!id || st.server.has(id)) continue;
        if (!o.blobs.has(id)) await o.blobs.fromCache(id);
        const p = o.blobs.pcm(id); if (!p) continue;
        const bytes = new Uint8Array(p.pcm16.buffer, p.pcm16.byteOffset, p.pcm16.byteLength);
        const r = await fetch(url(`/${st.id}/clips/${id}?sr=${p.sr}`), { method: 'PUT', body: bytes });
        if (r.ok) st.server.add(id);
      }
    } catch (_) { /* next time */ }
  }

  // the porter: when this browser has the band's Dropbox linked, carry each parked take home
  const mine = () => !!(st.home && o.dropbox?.linked && st.home.account === o.dropbox.account);
  function portTakes() {
    if (st.porting) return st.porting;   // one run at a time: a second call waits for the one going
    if (!st.id || !st.loaded || !mine()) return Promise.resolve();
    st.porting = port().finally(() => { st.porting = null; });
    return st.porting;
  }
  async function port() {
    try {
      await refresh();
      const todo = st.parked.filter((c) => !st.homes[c]).slice(0, 12);
      for (const clip of todo) {
        let p = o.blobs.pcm(clip);
        if (!p && await o.blobs.fromCache(clip)) p = o.blobs.pcm(clip);
        if (!p) { p = await api.fetchClip(clip); if (p) o.blobs.put(clip, p.pcm16, p.sr); }
        if (!p) continue;
        const path = `/${st.home.folder}/${safeName(o.clipName?.(clip) || 'take', 110)} ${clip}.wav`;
        await o.dropbox.upload(path, wav(p.pcm16, p.sr, o.clipCh?.(clip) || 1));
        const url = await o.dropbox.shareLink(path);
        const r = await call(`/${st.id}/clips/${clip}/home`, { method: 'POST', body: JSON.stringify({ url }) });
        st.homes[clip] = r.home;
      }
      if (st.portErr) { st.portErr = ''; o.onSaved?.(); } else if (todo.length) o.onSaved?.();
    } catch (e) {
      if (st.portErr !== e.message) { st.portErr = e.message; o.say?.(`Couldn't put takes in the band's Dropbox (${e.message}). They stay in the studio meanwhile.`, 'error'); o.onSaved?.(); }
    }
  }

  const timers = [setInterval(() => flush(), 1500), setInterval(() => syncClips(), 8000), setInterval(() => portTakes(), 20000)];
  addEventListener('pagehide', () => flush(true));
  void timers;

  const api = {
    get id() { return st.id; }, get name() { return st.name; }, get loaded() { return st.loaded; },
    // where this studio keeps its takes: { home, mine (this browser carries them there), waiting, kept, error }
    get takesHome() { return st.id ? { home: st.home, mine: mine(), waiting: st.parked.filter((c) => !st.homes[c]).length, kept: Object.keys(st.homes).length, error: st.portErr } : null; },
    get saved() { return st.id && !st.pending.size && st.sentWhole ? st.lastOk : 0; },
    link: (id = st.id) => `${location.origin}${location.pathname}?studio=${id}`,
    create: (name) => call('', { method: 'POST', body: JSON.stringify({ name }) }),
    open: (id) => call(`/${id}`),
    // this room now keeps its song in studio id (loaded: the song here is already the studio's)
    attach(id, name, loaded = false) {
      if (st.id === id) { if (loaded) st.loaded = true; return; }
      Object.assign(st, { id, name, loaded, sentWhole: false, server: null, failing: 0, home: null, homes: {}, parked: [], portErr: '' }); st.pending.clear();
      rememberStudio(id, name);
      refresh().then(() => setTimeout(portTakes, 1500)).catch(() => {});
    },
    // keep this studio's takes in the Dropbox linked here (link it first: dropbox.connect())
    async keepInDropbox() {
      if (!st.id || !o.dropbox?.linked) throw new Error('link Dropbox first');
      const home = { kind: 'dropbox', account: o.dropbox.account, by: o.dropbox.name, folder: `${safeName(st.name, 60)} (${st.id.slice(0, 4)})` };
      st.home = (await call(`/${st.id}/home`, { method: 'POST', body: JSON.stringify({ home }) })).home;
      o.onSaved?.(); portTakes();
      return st.home;
    },
    // stop sending takes to Dropbox (the ones there stay there; new ones stay parked)
    async stopDropbox() { if (!st.id) return; st.home = (await call(`/${st.id}/home`, { method: 'POST', body: JSON.stringify({ home: null }) })).home; o.onSaved?.(); },
    portTakes, refresh,
    markLoaded() { st.loaded = true; },
    leader() { st.sentWhole = false; },            // a new leader sends the whole song
    detach() { flush(true); Object.assign(st, { id: null, name: '', loaded: false, server: null, home: null, homes: {}, parked: [] }); st.pending.clear(); },
    flush, syncClips,
    // a clip for a browser that's missing it: parked in the studio, or from the band's Dropbox (directly, or
    // through the studio server when a browser can't)
    async fetchClip(id) {
      if (!st.id) return null;
      try {
        const r = await fetch(url(`/${st.id}/clips/${id}`));
        if (r.ok) { const sr = +(r.headers.get('x-sr') || 24000), buf = await r.arrayBuffer(); return { pcm16: new Int16Array(buf), sr }; }
        const j = await r.json().catch(() => ({})); if (!j.home) return null;
        let bytes = await fetchDirect(j.home);
        if (!bytes) { const v = await fetch(url(`/${st.id}/clips/${id}?via=home`)); if (!v.ok) return null; bytes = new Uint8Array(await v.arrayBuffer()); }
        return readPcmWav(bytes);
      } catch (_) { return null; }
    },
  };
  return api;
}
