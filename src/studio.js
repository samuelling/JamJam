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
// A studio's link (?studio=<id>) is its key: anyone with it can walk in. This browser remembers the studios it has
// been in, for the lobby.

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

// o: { endpoint, songStore, isLeader(), blobs, clipIds() -> [id], extras() -> { bpm, key }, say(text, kind), onSaved() }
export function makeStudio(o) {
  const st = { id: null, name: '', loaded: false, pending: new Set(), sentWhole: false, server: null, busy: false, failing: 0, lastOk: 0 };
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

  // audio the song uses that the server doesn't have yet: the leader sends what it has
  async function syncClips() {
    if (!st.id || !st.loaded || !o.isLeader()) return;
    try {
      if (!st.server) st.server = new Set((await call(`/${st.id}/clips`)).ids);
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

  const timers = [setInterval(() => flush(), 1500), setInterval(() => syncClips(), 8000)];
  addEventListener('pagehide', () => flush(true));
  void timers;

  return {
    get id() { return st.id; }, get name() { return st.name; }, get loaded() { return st.loaded; },
    get saved() { return st.id && !st.pending.size && st.sentWhole ? st.lastOk : 0; },
    link: (id = st.id) => `${location.origin}${location.pathname}?studio=${id}`,
    create: (name) => call('', { method: 'POST', body: JSON.stringify({ name }) }),
    open: (id) => call(`/${id}`),
    // this room now keeps its song in studio id (loaded: the song here is already the studio's)
    attach(id, name, loaded = false) {
      if (st.id === id) { if (loaded) st.loaded = true; return; }
      Object.assign(st, { id, name, loaded, sentWhole: false, server: null, failing: 0 }); st.pending.clear();
      rememberStudio(id, name);
    },
    markLoaded() { st.loaded = true; },
    leader() { st.sentWhole = false; },            // a new leader sends the whole song
    detach() { flush(true); Object.assign(st, { id: null, name: '', loaded: false, server: null }); st.pending.clear(); },
    flush, syncClips,
    // a clip from the server, for a browser that's missing it
    async fetchClip(id) {
      if (!st.id) return null;
      try {
        const r = await fetch(url(`/${st.id}/clips/${id}`)); if (!r.ok) return null;
        const sr = +(r.headers.get('x-sr') || 24000), buf = await r.arrayBuffer();
        return { pcm16: new Int16Array(buf), sr };
      } catch (_) { return null; }
    },
  };
}
