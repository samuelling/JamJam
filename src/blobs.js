// Shared audio: the clips a room needs everywhere but can't regenerate (a locked pass of live audio, a pad's
// sample). Each clip is mono 16-bit PCM under a short id; the room's state only ever names it. The owner sends the
// bytes to each bandmate once, as binary chunks over the direct links; any browser that's missing a clip (a late
// joiner, a dropped transfer) asks for it; and clips are kept in this browser (IndexedDB), so a kit you used last
// week is here before anyone sends it.
//
// Chunk layout (little-endian): [u32 magic][u32 sample rate][u32 byte offset][u32 total bytes][8 id bytes] PCM.

const MAGIC = 0x54445541, HDR = 24, CHUNK = 16000;
export const isBlobChunk = (buf) => buf.byteLength >= HDR && new DataView(buf).getUint32(0, true) === MAGIC;

// a content address: the same PCM gives the same id in every browser
export async function blobId(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let n = 0n; for (let i = 0; i < 6; i++) n = (n << 8n) | BigInt(d[i]);
  return n.toString(36).padStart(8, '0').slice(-8);
}
export function toPcm16(f32) { const o = new Int16Array(f32.length); for (let i = 0; i < f32.length; i++) o[i] = Math.max(-1, Math.min(1, f32[i])) * 32767; return o; }

export class Blobs {
  // room: { peers: Map, send(msg, to?), sendBinaryTo(to, buf) }; onReady(id) when a clip arrives
  constructor(room, onReady = () => {}) {
    this.room = room; this.onReady = onReady;
    this.bytes = new Map(); this.rate = new Map(); this.inbound = new Map(); this.asked = new Map();
    this.db = null;
    try {
      const req = indexedDB.open('megajam', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('blobs');
      req.onsuccess = () => { this.db = req.result; };
    } catch (_) { /* private mode: no cache, the network still works */ }
  }
  has(id) { return this.bytes.has(id); }
  pcm(id) { const b = this.bytes.get(id); return b ? { pcm16: new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1), sr: this.rate.get(id) || 44100 } : null; }
  put(id, pcm16, sr, keep = true) {
    const b = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
    this.bytes.set(id, b); this.rate.set(id, sr);
    if (keep && this.db) { try { this.db.transaction('blobs', 'readwrite').objectStore('blobs').put({ b: b.slice(), sr }, id); } catch (_) {} }
  }
  // send a clip to one bandmate (or to all)
  async send(id, to) {
    if (!to) { for (const p of this.room.peers.keys()) this.send(id, p); return; }
    const d = this.bytes.get(id); if (!d) return;
    const sr = this.rate.get(id) || 44100;
    for (let o = 0; o < d.length; o += CHUNK) {
      const part = d.subarray(o, Math.min(d.length, o + CHUNK)), buf = new ArrayBuffer(HDR + part.length), v = new DataView(buf);
      v.setUint32(0, MAGIC, true); v.setUint32(4, sr, true); v.setUint32(8, o, true); v.setUint32(12, d.length, true);
      for (let i = 0; i < 8; i++) v.setUint8(16 + i, id.charCodeAt(i) || 48);
      new Uint8Array(buf, HDR).set(part);
      if (!(await this.room.sendBinaryTo(to, buf))) return;
    }
  }
  onChunk(buf) {
    const v = new DataView(buf), sr = v.getUint32(4, true), o = v.getUint32(8, true), total = v.getUint32(12, true);
    let id = ''; for (let i = 0; i < 8; i++) id += String.fromCharCode(v.getUint8(16 + i));
    if (this.bytes.has(id) || total > 64e6 || total % 2) return;
    const inb = this.inbound.get(id) || this.inbound.set(id, { buf: new Uint8Array(total), got: 0, seen: new Set() }).get(id);
    if (inb.seen.has(o)) return; inb.seen.add(o);
    const part = new Uint8Array(buf, HDR); inb.buf.set(part, o); inb.got += part.length;
    if (inb.got >= total) { this.inbound.delete(id); this.put(id, new Int16Array(inb.buf.buffer, 0, total >> 1), sr); this.onReady(id); }
  }
  // the clips these ids name that aren't here: from this browser's cache first, else ask (the owner, else anyone)
  want(list) {
    const now = performance.now();
    for (const { id, from } of list) {
      if (!id || this.bytes.has(id) || this.inbound.has(id) || now - (this.asked.get(id) || -1e9) < 8000) continue;
      this.asked.set(id, now);
      this.fromCache(id).then((ok) => {
        if (ok) { this.onReady(id); return; }
        if (!this.room.peers.size) return;
        if (from && this.room.peers.has(from)) this.room.send({ k: 'aud-get', id }, from); else this.room.send({ k: 'aud-get', id });
      });
    }
  }
  fromCache(id) {
    return new Promise((res) => {
      if (!this.db) { res(false); return; }
      try {
        const r = this.db.transaction('blobs').objectStore('blobs').get(id);
        r.onsuccess = () => { const v = r.result; if (!v) { res(false); return; } this.put(id, new Int16Array(v.b.buffer, v.b.byteOffset, v.b.byteLength >> 1), v.sr, false); res(true); };
        r.onerror = () => res(false);
      } catch (_) { res(false); }
    });
  }
  // a bandmate asked: send it if it's here (or in the cache)
  async serve(id, to) { if (!this.bytes.has(id)) await this.fromCache(id); if (this.bytes.has(id)) this.send(id, to); }
}
