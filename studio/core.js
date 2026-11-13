// The studio's memory, independent of Cloudflare so it can be tested in Node: one band studio's song, kept key by
// key exactly as the room shares it ('title', 'order', 'sec:<id>', 'part:<sid>:<pid>', 'lane:<id>', ...), plus a
// daily backup of the whole song and a little bookkeeping. `storage` is a Durable Object's storage, or any object
// with the same async get / put / delete / list({ prefix }) shape.
//
// Who writes: one browser at a time, the room's clock leader (whoever's been in longest). It mirrors every change
// the room makes, and when the leader changes, the new one sends the whole song. So the stored song is always the
// room's song as of a moment ago, with no merging to do here.

export const KEY_RE = /^(title|bpm|key|meter|order|labels|rule|master|share|studio|(sec|part|lane|var):[A-Za-z0-9_.:-]{1,80})$/;
export const MAX_VALUE = 1_900_000;     // characters of JSON per key (a Durable Object value can be 2 MB)
export const MAX_KEYS = 4000;
export const KEEP_BACKUPS = 14;          // days
export const MAX_BYTES = 2 * 1024 ** 3; // audio parked per studio
const DAY = 86_400_000;

import { dropboxLink, PARK_DAYS } from './home.js';

const day = (t) => new Date(t).toISOString().slice(0, 10);
// a Durable Object deletes (and puts) at most 128 keys a call
async function delMany(st, keys) { for (let i = 0; i < keys.length; i += 100) await st.delete(keys.slice(i, i + 100)); }

export class StudioCore {
  constructor(storage) { this.st = storage; }

  async meta() { return (await this.st.get('meta')) || null; }

  async init(name, id = '', now = Date.now()) {
    if (await this.meta()) return { error: 'exists' };
    const meta = { id: String(id || ''), name: String(name || 'Studio').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || 'Studio', created: now, last: now, visits: 0, rev: 0, bytes: 0 };
    await this.st.put('meta', meta);
    return { meta };
  }

  // everything a browser needs to open the studio: its name and the song, key by key
  async state(now = Date.now()) {
    const meta = await this.meta(); if (!meta) return null;
    const rows = await this.st.list({ prefix: 'k:' }), song = {};
    for (const [k, v] of rows) song[k.slice(2)] = v;
    meta.visits++; meta.last = now; await this.st.put('meta', meta);
    return { name: meta.name, rev: meta.rev, created: meta.created, home: meta.home || null, song };
  }

  // ops: [[key, value | null], ...]; whole: these are all the keys there are (anything else goes)
  async ops(list, whole = false, now = Date.now()) {
    const meta = await this.meta(); if (!meta) return { error: 'missing', status: 404 };
    if (!Array.isArray(list) || list.length > MAX_KEYS) return { error: 'bad ops', status: 400 };
    for (const op of list) {
      if (!Array.isArray(op) || op.length !== 2 || !KEY_RE.test(op[0])) return { error: 'bad key ' + String(op?.[0]).slice(0, 40), status: 400 };
      if (op[1] !== null && JSON.stringify(op[1]).length > MAX_VALUE) return { error: 'too big: ' + op[0], status: 413 };
    }
    // the first change of each day keeps a copy of the song as it was, so a bad day can be undone
    const today = day(now);
    if (!(await this.st.get('b:' + today))) {
      const rows = await this.st.list({ prefix: 'k:' });
      if (rows.size) {
        const copy = Object.fromEntries([...rows].map(([k, v]) => [k.slice(2), v]));
        if (JSON.stringify(copy).length <= MAX_VALUE) await this.st.put('b:' + today, copy);
        const old = [...(await this.st.list({ prefix: 'b:' })).keys()].sort().slice(0, -KEEP_BACKUPS);
        if (old.length) await delMany(this.st, old);
      }
    }
    if (whole) {
      const keep = new Set(list.map(([k]) => 'k:' + k)), gone = [...(await this.st.list({ prefix: 'k:' })).keys()].filter((k) => !keep.has(k));
      if (gone.length) await delMany(this.st, gone);
    }
    const dels = list.filter(([, v]) => v === null).map(([k]) => 'k:' + k);
    if (dels.length) await delMany(this.st, dels);
    const puts = list.filter(([, v]) => v !== null);
    for (let i = 0; i < puts.length; i += 100) await this.st.put(Object.fromEntries(puts.slice(i, i + 100).map(([k, v]) => ['k:' + k, v])));
    meta.rev++; meta.last = now; await this.st.put('meta', meta);
    return { rev: meta.rev };
  }

  async backups() { return [...(await this.st.list({ prefix: 'b:' })).keys()].map((k) => k.slice(2)).sort(); }
  async backup(d) { return (await this.st.get('b:' + d)) || null; }

  // ---- audio ----
  // Each take's audio is a clip: 'c:<clip>' = { at, bytes, sr, home?, gone? }. It's parked in R2 when it arrives;
  // home is its share link in the band's Dropbox, and gone means the parked copy has been cleared (the link is all).

  // a clip arriving: room to park it? (never replaced once it's here)
  async park(clip, n, sr, now = Date.now()) {
    const meta = await this.meta(); if (!meta) return { error: 'missing', status: 404 };
    if (await this.st.get('c:' + clip)) return { exists: true };
    if (meta.bytes + n > MAX_BYTES) return { error: 'this studio is full (2 GB of takes parked). Keep its takes in the band\'s Dropbox to make room.', status: 507 };
    meta.bytes += n; await this.st.put({ meta, ['c:' + clip]: { at: now, bytes: n, sr } });
    return { bytes: meta.bytes };
  }
  async clip(clip) { return (await this.st.get('c:' + clip)) || null; }
  // what's parked, what has a home, and where the band keeps its takes
  async clips() {
    const meta = await this.meta(); if (!meta) return null;
    const parked = [], homes = {};
    for (const [k, r] of await this.st.list({ prefix: 'c:' })) { const c = k.slice(2); if (!r.gone) parked.push(c); if (r.home) homes[c] = r.home; }
    return { ids: parked, homes, home: meta.home || null, bytes: meta.bytes };
  }
  // the band keeps its takes in this Dropbox (or nowhere: null). home: { kind: 'dropbox', account, by, folder }
  async setHomeInfo(home, now = Date.now()) {
    const meta = await this.meta(); if (!meta) return { error: 'missing', status: 404 };
    if (home !== null) {
      const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
      if (!home || home.kind !== 'dropbox' || !/^dbid:[A-Za-z0-9_-]{10,80}$/.test(home.account || '')) return { error: 'bad home', status: 400 };
      home = { kind: 'dropbox', account: home.account, by: clean(home.by, 40) || 'a bandmate', folder: clean(home.folder, 120), since: now };
    }
    meta.home = home; await this.st.put('meta', meta);
    return { home };
  }
  // a clip has its home: its share link in the band's Dropbox. Returns when its parked copy can go.
  async setHome(clip, link, now = Date.now()) {
    const url = dropboxLink(link); if (!url) return { error: 'not a Dropbox file link', status: 400 };
    const rec = await this.st.get('c:' + clip); if (!rec) return { error: 'no such clip', status: 404 };
    rec.home = url; rec.homed = now; await this.st.put('c:' + clip, rec);
    return { home: url, due: rec.gone ? null : Math.max(rec.at + PARK_DAYS * DAY, now) };
  }
  // parked clips with a home, parked long enough
  async due(now = Date.now()) {
    return [...(await this.st.list({ prefix: 'c:' }))].filter(([, r]) => r.home && !r.gone && r.at + PARK_DAYS * DAY <= now).map(([k, r]) => [k.slice(2), r]);
  }
  async cleared(clip) {
    const meta = await this.meta(), rec = await this.st.get('c:' + clip); if (!meta || !rec || rec.gone) return;
    rec.gone = true; meta.bytes = Math.max(0, meta.bytes - rec.bytes);
    await this.st.put({ meta, ['c:' + clip]: rec });
  }
  // when to look again (a link that didn't check out is tried again a day later); null: nothing waiting
  async nextDue(now = Date.now()) {
    let t = null;
    for (const [, r] of await this.st.list({ prefix: 'c:' })) {
      if (!r.home || r.gone) continue;
      let when = r.at + PARK_DAYS * DAY; if (when <= now) when = now + DAY;
      if (t === null || when < t) t = when;
    }
    return t;
  }
}
