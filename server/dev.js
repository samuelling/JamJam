// Local development server: serves the site and runs the same room logic as the Cloudflare
// Durable Object, over a minimal built-in WebSocket implementation (no dependencies).
//
//   node server/dev.js            then open http://localhost:8787/
//
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { roomOpen, roomMessage, roomClose, MAX_MSG } from './room.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +process.env.PORT || 8787;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/mp-config.js') {
    res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
    res.end("window.MP_SERVER = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;\n");
    return;
  }
  // testing aid: /__drop closes every relay connection, as a Cloudflare restart would (the browsers should reconnect)
  if (url.pathname === '/__drop') {
    let n = 0; for (const room of rooms.values()) for (const h of [...room]) { h.close(1012, 'restart'); n++; }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`dropped ${n}\n`); return;
  }
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
});

const rooms = new Map();

server.on('upgrade', (req, sock) => {
  const m = new URL(req.url, 'http://x').pathname.match(/^\/room\/([a-z0-9-]{1,32})$/);
  const key = req.headers['sec-websocket-key'];
  if (!m || !key) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);
  const code = m[1];
  if (!rooms.has(code)) rooms.set(code, new Set());
  const room = rooms.get(code);
  let meta = {}, closed = false;
  const h = {
    send(s) { if (!closed) sock.write(frame(1, Buffer.from(s))); },
    close(c, r) { if (closed) return; const b = Buffer.alloc(2); b.writeUInt16BE(c); sock.write(frame(8, Buffer.concat([b, Buffer.from(r || '')]))); sock.end(); },
    get meta() { return JSON.parse(JSON.stringify(meta)); },
    set meta(v) { meta = JSON.parse(JSON.stringify(v)); },
  };
  const others = () => [...room].filter((o) => o !== h);
  if (!roomOpen(others(), h)) return;
  room.add(h);
  const bye = () => {
    if (closed) return;
    closed = true; room.delete(h);
    roomClose(others(), h);
    if (!room.size) rooms.delete(code);
  };
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15, masked = buf[1] & 128;
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_MSG * 4) { sock.destroy(); bye(); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let data = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const mk = buf.subarray(off, off + 4); data = Buffer.from(data.map((b, i) => b ^ mk[i & 3])); }
      buf = buf.subarray(need);
      if (op === 8) { sock.end(); bye(); return; }
      if (op === 9) { sock.write(frame(10, data)); continue; }
      if (op === 1) {
        const s = data.toString('utf8');
        if (s === 'ping') h.send('pong'); else roomMessage(others(), h, s);
      }
    }
  });
  sock.on('close', bye);
  sock.on('error', bye);
});

function frame(op, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : null;
  if (!head) { const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return Buffer.concat([b, payload]); }
  return Buffer.concat([head, payload]);
}

server.listen(PORT, () => console.log(`MEGAjam dev server: http://localhost:${PORT}/`));
