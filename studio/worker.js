// MEGAjam studios: a band's permanent room. The song lives in a Durable Object per studio (src: core.js), the audio
// takes in R2, and anyone with the studio's link can walk in, alone or together, and find everything where the band
// left it. Separate from the handshake relay (crush-commando-mp), which this doesn't touch.
//
//   POST /studios                    { name } -> { id, name }   a new studio
//   GET  /studios/:id                 { name, rev, song: { key: value } }
//   POST /studios/:id/ops             { ops: [[key, value|null]], whole } -> { rev }   (the room's leader mirrors its song)
//   GET  /studios/:id/backups         the days with a backup;  GET /studios/:id/backups/:day  that day's song
//   GET  /studios/:id/clips           { ids: [parked], homes: { clip: share link }, home }   the studio's audio
//   PUT  /studios/:id/clips/:clip?sr= 16-bit mono PCM, parked (a clip is never replaced once it's there)
//   GET  /studios/:id/clips/:clip     the parked PCM (sample rate in x-sr), or 404 { home: link } once it has gone
//                                     home; ?via=home fetches it from the band's Dropbox (a WAV)
//   POST /studios/:id/home            { home: { kind: 'dropbox', account, by, folder } | null }   where takes go
//   POST /studios/:id/clips/:clip/home { url }   this take is in the band's Dropbox, at this share link
//
// Takes are parked for PARK_DAYS (home.js); once a take is in the band's Dropbox and its link checks out, an alarm
// clears its parked copy. Takes without a home stay parked.
//
// The link is the key: studio ids are 16 random characters. Writes are taken only from the site (and localhost).
// Deploy steps are in README.md.

import { DurableObject } from 'cloudflare:workers';
import { StudioCore } from './core.js';
import { handle } from './api.js';
import { clearParking } from './home.js';

export class Studio extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.core = new StudioCore(ctx.storage); }
  init(name, id) { return this.core.init(name, id); }
  state() { return this.core.state(); }
  ops(list, whole) { return this.core.ops(list, whole); }
  backups() { return this.core.backups(); }
  backup(d) { return this.core.backup(d); }
  exists() { return this.core.meta().then(Boolean); }
  park(clip, n, sr) { return this.core.park(clip, n, sr); }
  clip(c) { return this.core.clip(c); }
  clips() { return this.core.clips(); }
  setHomeInfo(home) { return this.core.setHomeInfo(home); }
  async setHome(clip, url) {
    const r = await this.core.setHome(clip, url);
    if (r.due) { const cur = await this.ctx.storage.getAlarm(); if (!cur || cur > r.due) await this.ctx.storage.setAlarm(r.due); }
    return r;
  }
  // clear parking: needs this studio's id for its R2 keys, kept in meta when the studio is made
  async alarm() {
    const meta = await this.core.meta(); if (!meta?.id) return;
    const r = await clearParking(this.core, this.env.CLIPS, meta.id, fetch);
    if (r.next) await this.ctx.storage.setAlarm(r.next);
  }
}

export default {
  fetch(req, env) { return handle(req, env, (id) => env.STUDIO.get(env.STUDIO.idFromName(id))); },
};
