// MEGAjam studios: a band's permanent room. The song lives in a Durable Object per studio (src: core.js), the audio
// takes in R2, and anyone with the studio's link can walk in, alone or together, and find everything where the band
// left it. Separate from the handshake relay (crush-commando-mp), which this doesn't touch.
//
//   POST /studios                    { name } -> { id, name }   a new studio
//   GET  /studios/:id                 { name, rev, song: { key: value } }
//   POST /studios/:id/ops             { ops: [[key, value|null]], whole } -> { rev }   (the room's leader mirrors its song)
//   GET  /studios/:id/backups         the days with a backup;  GET /studios/:id/backups/:day  that day's song
//   GET  /studios/:id/clips           { ids: [...] }   the audio this studio holds
//   PUT  /studios/:id/clips/:clip?sr= 16-bit mono PCM (a clip is never replaced once it's there)
//   GET  /studios/:id/clips/:clip     the PCM, sample rate in x-sr
//
// The link is the key: studio ids are 16 random characters. Writes are taken only from the site (and localhost).
// Deploy steps are in README.md.

import { DurableObject } from 'cloudflare:workers';
import { StudioCore } from './core.js';
import { handle } from './api.js';

export class Studio extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.core = new StudioCore(ctx.storage); }
  init(name) { return this.core.init(name); }
  state() { return this.core.state(); }
  ops(list, whole) { return this.core.ops(list, whole); }
  backups() { return this.core.backups(); }
  backup(d) { return this.core.backup(d); }
  addBytes(n) { return this.core.addBytes(n); }
  exists() { return this.core.meta().then(Boolean); }
}

export default {
  fetch(req, env) { return handle(req, env, (id) => env.STUDIO.get(env.STUDIO.idFromName(id))); },
};
