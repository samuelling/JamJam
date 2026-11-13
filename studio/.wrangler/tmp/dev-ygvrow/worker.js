var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
import { DurableObject } from "cloudflare:workers";

// home.js
var PARK_DAYS = 14;
var WAV_HEADER = 44;
function dropboxLink(s) {
  let u;
  try {
    u = new URL(String(s || ""));
  } catch (_) {
    return null;
  }
  if (u.protocol !== "https:" || !/^(www\.)?dropbox\.com$/.test(u.hostname) || u.username || u.password || u.port) return null;
  const scl = u.pathname.match(/^\/scl\/fi\/([A-Za-z0-9]{6,64})\/([^/]{1,255})$/), old = u.pathname.match(/^\/s\/([A-Za-z0-9]{6,64})\/([^/]{1,255})$/);
  if (scl) {
    const rl = u.searchParams.get("rlkey") || "";
    if (!/^[A-Za-z0-9]{6,64}$/.test(rl)) return null;
    return `https://www.dropbox.com/scl/fi/${scl[1]}/${scl[2]}?rlkey=${rl}&dl=0`;
  }
  if (old) return `https://www.dropbox.com/s/${old[1]}/${old[2]}?dl=0`;
  return null;
}
__name(dropboxLink, "dropboxLink");
var officialFile = /* @__PURE__ */ __name((link) => link.replace(/([?&])dl=0$/, "$1dl=1"), "officialFile");
async function linkServes(get, link, bytes) {
  try {
    const r = await get(officialFile(link), { headers: { range: "bytes=0-43" }, redirect: "follow" });
    const total = r.status === 206 ? +((r.headers.get("content-range") || "").split("/")[1] || 0) : r.status === 200 ? +(r.headers.get("content-length") || 0) : 0;
    try {
      await r.body?.cancel();
    } catch (_) {
    }
    return total === WAV_HEADER + bytes;
  } catch (_) {
    return false;
  }
}
__name(linkServes, "linkServes");
async function clearParking(core, bucket, id, get, now = Date.now()) {
  let cleared = 0, kept = 0;
  for (const [clip, rec] of await core.due(now)) {
    if (await linkServes(get, rec.home, rec.bytes)) {
      await bucket.delete(`c/${id}/${clip}`);
      await core.cleared(clip);
      cleared++;
    } else kept++;
  }
  return { cleared, kept, next: await core.nextDue(now) };
}
__name(clearParking, "clearParking");

// core.js
var KEY_RE = /^(title|bpm|key|meter|order|labels|rule|master|share|studio|(sec|part|lane|var):[A-Za-z0-9_.:-]{1,80})$/;
var MAX_VALUE = 19e5;
var MAX_KEYS = 4e3;
var KEEP_BACKUPS = 14;
var MAX_BYTES = 2 * 1024 ** 3;
var DAY = 864e5;
var day = /* @__PURE__ */ __name((t) => new Date(t).toISOString().slice(0, 10), "day");
async function delMany(st, keys) {
  for (let i = 0; i < keys.length; i += 100) await st.delete(keys.slice(i, i + 100));
}
__name(delMany, "delMany");
var StudioCore = class {
  static {
    __name(this, "StudioCore");
  }
  constructor(storage) {
    this.st = storage;
  }
  async meta() {
    return await this.st.get("meta") || null;
  }
  async init(name, id = "", now = Date.now()) {
    if (await this.meta()) return { error: "exists" };
    const meta = { id: String(id || ""), name: String(name || "Studio").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) || "Studio", created: now, last: now, visits: 0, rev: 0, bytes: 0 };
    await this.st.put("meta", meta);
    return { meta };
  }
  // everything a browser needs to open the studio: its name and the song, key by key
  async state(now = Date.now()) {
    const meta = await this.meta();
    if (!meta) return null;
    const rows = await this.st.list({ prefix: "k:" }), song = {};
    for (const [k, v] of rows) song[k.slice(2)] = v;
    meta.visits++;
    meta.last = now;
    await this.st.put("meta", meta);
    return { name: meta.name, rev: meta.rev, created: meta.created, home: meta.home || null, song };
  }
  // ops: [[key, value | null], ...]; whole: these are all the keys there are (anything else goes)
  async ops(list, whole = false, now = Date.now()) {
    const meta = await this.meta();
    if (!meta) return { error: "missing", status: 404 };
    if (!Array.isArray(list) || list.length > MAX_KEYS) return { error: "bad ops", status: 400 };
    for (const op of list) {
      if (!Array.isArray(op) || op.length !== 2 || !KEY_RE.test(op[0])) return { error: "bad key " + String(op?.[0]).slice(0, 40), status: 400 };
      if (op[1] !== null && JSON.stringify(op[1]).length > MAX_VALUE) return { error: "too big: " + op[0], status: 413 };
    }
    const today = day(now);
    if (!await this.st.get("b:" + today)) {
      const rows = await this.st.list({ prefix: "k:" });
      if (rows.size) {
        const copy = Object.fromEntries([...rows].map(([k, v]) => [k.slice(2), v]));
        if (JSON.stringify(copy).length <= MAX_VALUE) await this.st.put("b:" + today, copy);
        const old = [...(await this.st.list({ prefix: "b:" })).keys()].sort().slice(0, -KEEP_BACKUPS);
        if (old.length) await delMany(this.st, old);
      }
    }
    if (whole) {
      const keep = new Set(list.map(([k]) => "k:" + k)), gone = [...(await this.st.list({ prefix: "k:" })).keys()].filter((k) => !keep.has(k));
      if (gone.length) await delMany(this.st, gone);
    }
    const dels = list.filter(([, v]) => v === null).map(([k]) => "k:" + k);
    if (dels.length) await delMany(this.st, dels);
    const puts = list.filter(([, v]) => v !== null);
    for (let i = 0; i < puts.length; i += 100) await this.st.put(Object.fromEntries(puts.slice(i, i + 100).map(([k, v]) => ["k:" + k, v])));
    meta.rev++;
    meta.last = now;
    await this.st.put("meta", meta);
    return { rev: meta.rev };
  }
  async backups() {
    return [...(await this.st.list({ prefix: "b:" })).keys()].map((k) => k.slice(2)).sort();
  }
  async backup(d) {
    return await this.st.get("b:" + d) || null;
  }
  // ---- audio ----
  // Each take's audio is a clip: 'c:<clip>' = { at, bytes, sr, home?, gone? }. It's parked in R2 when it arrives;
  // home is its share link in the band's Dropbox, and gone means the parked copy has been cleared (the link is all).
  // a clip arriving: room to park it? (never replaced once it's here)
  async park(clip, n, sr, now = Date.now()) {
    const meta = await this.meta();
    if (!meta) return { error: "missing", status: 404 };
    if (await this.st.get("c:" + clip)) return { exists: true };
    if (meta.bytes + n > MAX_BYTES) return { error: "this studio is full (2 GB of takes parked). Keep its takes in the band's Dropbox to make room.", status: 507 };
    meta.bytes += n;
    await this.st.put({ meta, ["c:" + clip]: { at: now, bytes: n, sr } });
    return { bytes: meta.bytes };
  }
  async clip(clip) {
    return await this.st.get("c:" + clip) || null;
  }
  // what's parked, what has a home, and where the band keeps its takes
  async clips() {
    const meta = await this.meta();
    if (!meta) return null;
    const parked = [], homes = {};
    for (const [k, r] of await this.st.list({ prefix: "c:" })) {
      const c = k.slice(2);
      if (!r.gone) parked.push(c);
      if (r.home) homes[c] = r.home;
    }
    return { ids: parked, homes, home: meta.home || null, bytes: meta.bytes };
  }
  // the band keeps its takes in this Dropbox (or nowhere: null). home: { kind: 'dropbox', account, by, folder }
  async setHomeInfo(home, now = Date.now()) {
    const meta = await this.meta();
    if (!meta) return { error: "missing", status: 404 };
    if (home !== null) {
      const clean = /* @__PURE__ */ __name((s, n) => String(s || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, n), "clean");
      if (!home || home.kind !== "dropbox" || !/^dbid:[A-Za-z0-9_-]{10,80}$/.test(home.account || "")) return { error: "bad home", status: 400 };
      home = { kind: "dropbox", account: home.account, by: clean(home.by, 40) || "a bandmate", folder: clean(home.folder, 120), since: now };
    }
    meta.home = home;
    await this.st.put("meta", meta);
    return { home };
  }
  // a clip has its home: its share link in the band's Dropbox. Returns when its parked copy can go.
  async setHome(clip, link, now = Date.now()) {
    const url = dropboxLink(link);
    if (!url) return { error: "not a Dropbox file link", status: 400 };
    const rec = await this.st.get("c:" + clip);
    if (!rec) return { error: "no such clip", status: 404 };
    rec.home = url;
    rec.homed = now;
    await this.st.put("c:" + clip, rec);
    return { home: url, due: rec.gone ? null : Math.max(rec.at + PARK_DAYS * DAY, now) };
  }
  // parked clips with a home, parked long enough
  async due(now = Date.now()) {
    return [...await this.st.list({ prefix: "c:" })].filter(([, r]) => r.home && !r.gone && r.at + PARK_DAYS * DAY <= now).map(([k, r]) => [k.slice(2), r]);
  }
  async cleared(clip) {
    const meta = await this.meta(), rec = await this.st.get("c:" + clip);
    if (!meta || !rec || rec.gone) return;
    rec.gone = true;
    meta.bytes = Math.max(0, meta.bytes - rec.bytes);
    await this.st.put({ meta, ["c:" + clip]: rec });
  }
  // when to look again (a link that didn't check out is tried again a day later); null: nothing waiting
  async nextDue(now = Date.now()) {
    let t = null;
    for (const [, r] of await this.st.list({ prefix: "c:" })) {
      if (!r.home || r.gone) continue;
      let when = r.at + PARK_DAYS * DAY;
      if (when <= now) when = now + DAY;
      if (t === null || when < t) t = when;
    }
    return t;
  }
};

// api.js
var ID = /^[a-z0-9]{16}$/;
var CLIP = /^[a-z0-9]{8}$/;
var MAX_CLIP = 40 * 1024 * 1024;
var ALLOW = /* @__PURE__ */ __name((env) => String(env.ORIGINS || "https://samuelling.github.io").split(",").map((s) => s.trim()), "ALLOW");
function cors(req, env) {
  const o = req.headers.get("origin") || "";
  const ok = ALLOW(env).includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return { ok, h: ok ? { "access-control-allow-origin": o, "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, PUT, OPTIONS", "access-control-expose-headers": "x-sr, x-format", vary: "origin" } : { vary: "origin" } };
}
__name(cors, "cors");
var json = /* @__PURE__ */ __name((obj, status, h) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...h } }), "json");
var newId = /* @__PURE__ */ __name(() => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join(""), "newId");
async function handle(req, env, stubOf) {
  const url = new URL(req.url), { ok, h } = cors(req, env), p = url.pathname.split("/").filter(Boolean);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  const write = req.method === "POST" || req.method === "PUT";
  if (write && !ok) return json({ error: "origin" }, 403, h);
  if (p[0] !== "studios") return new Response("MEGAjam studios\n", { status: p.length ? 404 : 200, headers: { "content-type": "text/plain", ...h } });
  if (p.length === 1 && req.method === "POST") {
    let body = {};
    try {
      body = await req.json();
    } catch (_) {
    }
    const id2 = newId(), r = await stubOf(id2).init(body.name, id2);
    return r.error ? json(r, 409, h) : json({ id: id2, name: r.meta.name }, 200, h);
  }
  const id = p[1];
  if (!ID.test(id || "")) return json({ error: "no such studio" }, 404, h);
  const stub = stubOf(id);
  if (p.length === 2 && req.method === "GET") {
    const s = await stub.state();
    return s ? json(s, 200, h) : json({ error: "no such studio" }, 404, h);
  }
  if (p[2] === "ops" && req.method === "POST") {
    const text = await req.text();
    if (text.length > 8e6) return json({ error: "too big" }, 413, h);
    let body;
    try {
      body = JSON.parse(text);
    } catch (_) {
      return json({ error: "bad json" }, 400, h);
    }
    const r = await stub.ops(body.ops, !!body.whole);
    return r.error ? json(r, r.status || 400, h) : json(r, 200, h);
  }
  if (p[2] === "backups" && req.method === "GET") {
    if (!await stub.exists()) return json({ error: "no such studio" }, 404, h);
    if (p[3]) {
      const b = await stub.backup(p[3]);
      return b ? json({ day: p[3], song: b }, 200, h) : json({ error: "no backup" }, 404, h);
    }
    return json({ days: await stub.backups() }, 200, h);
  }
  if (p[2] === "home" && req.method === "POST" && p.length === 3) {
    let body;
    try {
      body = await req.json();
    } catch (_) {
      return json({ error: "bad json" }, 400, h);
    }
    const r = await stub.setHomeInfo(body.home ?? null);
    return r.error ? json(r, r.status || 400, h) : json(r, 200, h);
  }
  if (p[2] === "clips") {
    if (p.length === 3 && req.method === "GET") {
      const c = await stub.clips();
      return c ? json(c, 200, h) : json({ error: "no such studio" }, 404, h);
    }
    const clip = p[3];
    if (!CLIP.test(clip || "")) return json({ error: "bad clip id" }, 400, h);
    const k = `c/${id}/${clip}`;
    if (p[4] === "home" && req.method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch (_) {
        return json({ error: "bad json" }, 400, h);
      }
      const r = await stub.setHome(clip, body.url);
      return r.error ? json(r, r.status || 400, h) : json(r, 200, h);
    }
    if (p.length !== 4) return json({ error: "not found" }, 404, h);
    if (req.method === "GET") {
      const o = await env.CLIPS.get(k);
      if (o) return new Response(o.body, { headers: { "content-type": "application/octet-stream", "cache-control": "private, max-age=31536000, immutable", "x-sr": o.customMetadata?.sr || "24000", "x-format": "pcm16", ...h } });
      const rec = await stub.clip(clip);
      if (!rec) return json({ error: "no such clip" }, 404, h);
      if (!rec.home) return json({ error: "not here yet" }, 404, h);
      if (url.searchParams.get("via") !== "home") return json({ error: "in the band's Dropbox", home: rec.home }, 404, h);
      const get = env.FETCH || fetch;
      let r;
      try {
        r = await get(officialFile(rec.home), { redirect: "follow" });
      } catch (_) {
        return json({ error: "the band's Dropbox is unreachable" }, 502, h);
      }
      const len = +(r.headers.get("content-length") || 0);
      if (!r.ok || len && len !== WAV_HEADER + rec.bytes) {
        try {
          await r.body?.cancel();
        } catch (_) {
        }
        return json({ error: "the take is missing from the band's Dropbox" }, 410, h);
      }
      return new Response(r.body, { headers: { "content-type": "audio/wav", "cache-control": "private, max-age=86400", "x-format": "wav", "x-sr": String(rec.sr), ...h } });
    }
    if (req.method === "PUT") {
      const sr = Math.round(+url.searchParams.get("sr") || 0);
      if (!(sr >= 8e3 && sr <= 96e3)) return json({ error: "bad sample rate" }, 400, h);
      const buf = await req.arrayBuffer();
      if (!buf.byteLength || buf.byteLength % 2 || buf.byteLength > MAX_CLIP) return json({ error: "bad clip size" }, 400, h);
      const room = await stub.park(clip, buf.byteLength, sr);
      if (room.error) return json(room, room.status, h);
      if (room.exists) return json({ ok: true, exists: true }, 200, h);
      await env.CLIPS.put(k, buf, { customMetadata: { sr: String(sr) } });
      return json({ ok: true }, 200, h);
    }
  }
  return json({ error: "not found" }, 404, h);
}
__name(handle, "handle");

// worker.js
var Studio = class extends DurableObject {
  static {
    __name(this, "Studio");
  }
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new StudioCore(ctx.storage);
  }
  init(name, id) {
    return this.core.init(name, id);
  }
  state() {
    return this.core.state();
  }
  ops(list, whole) {
    return this.core.ops(list, whole);
  }
  backups() {
    return this.core.backups();
  }
  backup(d) {
    return this.core.backup(d);
  }
  exists() {
    return this.core.meta().then(Boolean);
  }
  park(clip, n, sr) {
    return this.core.park(clip, n, sr);
  }
  clip(c) {
    return this.core.clip(c);
  }
  clips() {
    return this.core.clips();
  }
  setHomeInfo(home) {
    return this.core.setHomeInfo(home);
  }
  async setHome(clip, url) {
    const r = await this.core.setHome(clip, url);
    if (r.due) {
      const cur = await this.ctx.storage.getAlarm();
      if (!cur || cur > r.due) await this.ctx.storage.setAlarm(r.due);
    }
    return r;
  }
  // clear parking: needs this studio's id for its R2 keys, kept in meta when the studio is made
  async alarm() {
    const meta = await this.core.meta();
    if (!meta?.id) return;
    const r = await clearParking(this.core, this.env.CLIPS, meta.id, fetch);
    if (r.next) await this.ctx.storage.setAlarm(r.next);
  }
};
var worker_default = {
  fetch(req, env) {
    return handle(req, env, (id) => env.STUDIO.get(env.STUDIO.idFromName(id)));
  }
};

// ../../../../tmp/stats-dev/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../tmp/stats-dev/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-eBxKR7/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../../tmp/stats-dev/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-eBxKR7/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Studio,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
