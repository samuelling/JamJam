// The room: a WebSocket to the Cloudflare relay for the handshake, then a direct WebRTC DataChannel to every other jammer
// (a full mesh: 4 jammers = 6 links). After the handshake the relay carries nothing, unless a pair of jammers can't
// connect directly (some strict or carrier-grade NATs), in which case that pair falls back to passing messages
// through the relay. Audio-lane chunks are only ever sent directly.

const ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const RELAY_MAX = 1900;          // the relay drops messages over 2048 characters
const DIRECT_TIMEOUT_MS = 8000;  // after this, a pair that hasn't connected directly falls back to the relay

export class Room {
  constructor({ server, maxPeers = 4, p2p = true, handlers }) {
    this.server = server.replace(/\/$/, '');
    this.maxPeers = maxPeers;
    this.p2p = p2p;
    this.h = handlers;
    this.peers = new Map();
    this.ws = null;
    this.id = null;
    this.n = 0;
    this.code = '';
    this.relayed = 0;
    this.chunks = new Map();
    // testing aid: ?lag=80&jitter=20 delays everything this browser receives, to feel a long-distance link
    const q = new URLSearchParams(location.search);
    this.lag = q.get('lag') ? { ms: +q.get('lag') || 0, jitter: +q.get('jitter') || 0 } : null;
  }

  join(code, name) {
    this.leave();
    this.code = code;
    let ws;
    try { ws = new WebSocket(`${this.server}/room/jj-${code.toLowerCase()}`); }
    catch (e) { this.h.status('error', "Couldn't reach the handshake server."); return; }
    this.ws = ws;
    this.h.status('connecting', 'Connecting…');
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hi', name, col: 0 }));
      this.keepalive = setInterval(() => { try { ws.send('ping'); } catch (_) {} }, 20000);
    };
    ws.onmessage = (ev) => {
      if (ev.data === 'pong' || this.ws !== ws) return;
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      this.onRelay(m);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      clearInterval(this.keepalive);
      const full = ev.code === 4001;
      this.ws = null;
      // direct links survive the relay going away; only report if we never got in
      if (!this.id) this.h.status('error', full ? 'That room is full.' : "Couldn't reach the handshake server.");
      else this.h.status('relay-lost', 'Handshake server disconnected. Existing direct links keep playing; new jammers can\'t join until you rejoin.');
    };
  }

  leave() {
    clearInterval(this.keepalive);
    if (this.ws) { const ws = this.ws; this.ws = null; try { ws.close(1000, 'bye'); } catch (_) {} }
    for (const p of this.peers.values()) this.closePeer(p);
    this.peers.clear();
    this.id = null;
  }

  relaySend(obj) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    const s = JSON.stringify(obj);
    if (s.length > 2040) return false;
    ws.send(s); this.relayed++;
    return true;
  }
  // relay events, chunked when bigger than the relay allows (SDP offers can be)
  relayEvent(to, e) {
    const s = JSON.stringify(e);
    if (s.length <= RELAY_MAX) return this.relaySend({ t: 'ev', to, e });
    const id = Math.random().toString(36).slice(2, 8), parts = Math.ceil(s.length / (RELAY_MAX - 120));
    for (let i = 0; i < parts; i++) this.relaySend({ t: 'ev', to, e: { k: 'chunk', id, i, n: parts, s: s.slice(i * (RELAY_MAX - 120), (i + 1) * (RELAY_MAX - 120)) } });
    return true;
  }

  onRelay(m) {
    if (m.t === 'welcome') {
      const others = (m.peers || []).filter((p) => p && p.id);
      if (others.length >= this.maxPeers) { this.leave(); this.h.status('error', `That room already has ${this.maxPeers} jammers.`); return; }
      this.id = m.id; this.n = m.n;
      for (const p of others) this.addPeer(p, true);
      this.h.status('in', others.length ? 'Connecting to the other jammers…' : 'In the room. Waiting for friends…');
      this.h.roster();
      return;
    }
    if (m.t === 'join') {
      const known = this.peers.get(m.id);
      if (known) { known.n = m.n; known.name = m.name || known.name; } else this.addPeer(m, false);
      this.h.roster(); return;
    }
    if (m.t === 'leave') { const p = this.peers.get(m.id); if (p) { this.closePeer(p); this.peers.delete(m.id); this.h.peerLeft(p); this.h.roster(); } return; }
    if (m.t === 'name') { const p = this.peers.get(m.id); if (p) { p.name = m.name; this.h.roster(); } return; }
    if (m.t === 'ev' && m.e && typeof m.e === 'object') {
      let e = m.e;
      if (e.k === 'chunk') {
        const key = m.id + ':' + e.id;
        const c = this.chunks.get(key) || { parts: [], got: 0 };
        if (!c.parts[e.i]) { c.parts[e.i] = e.s; c.got++; }
        this.chunks.set(key, c);
        if (c.got < e.n) return;
        this.chunks.delete(key);
        try { e = JSON.parse(c.parts.join('')); } catch (_) { return; }
      }
      let p = this.peers.get(m.id);
      if (!p) { p = this.addPeer({ id: m.id, n: 0, name: '…' }, false); this.h.roster(); }
      if (e.k === 'sig') this.onSignal(p, e);
      else if (e.k === 'm') this.deliver(p, e.m);
    }
  }

  addPeer(info, initiator) {
    const p = { id: info.id, n: info.n || 0, name: info.name || 'Jammer', pc: null, dc: null, path: 'connecting', pendingIce: [], opened: false, rtt: [], bytesIn: 0 };
    this.peers.set(p.id, p);
    if (!this.p2p) { this.setPath(p, 'relay'); return p; }
    this.makePC(p);
    if (initiator) {
      this.wireDC(p, p.pc.createDataChannel('jam', { ordered: true }));
      p.pc.createOffer().then((o) => p.pc.setLocalDescription(o)).then(() => this.relayEvent(p.id, { k: 'sig', sdp: p.pc.localDescription.toJSON() })).catch(() => this.setPath(p, 'relay'));
    }
    p.fallbackT = setTimeout(() => { if (p.path === 'connecting') this.setPath(p, 'relay'); }, DIRECT_TIMEOUT_MS);
    return p;
  }

  makePC(p) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    p.pc = pc;
    pc.onicecandidate = (ev) => { if (ev.candidate) this.relayEvent(p.id, { k: 'sig', ice: ev.candidate.toJSON() }); };
    pc.ondatachannel = (ev) => this.wireDC(p, ev.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && p.path !== 'relay') this.setPath(p, 'relay');
    };
  }

  async onSignal(p, e) {
    if (!this.p2p) return;
    if (!p.pc) this.makePC(p);
    const pc = p.pc;
    try {
      if (e.sdp) {
        await pc.setRemoteDescription(e.sdp);
        if (e.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          this.relayEvent(p.id, { k: 'sig', sdp: pc.localDescription.toJSON() });
        }
        for (const c of p.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      } else if (e.ice) {
        if (pc.remoteDescription) await pc.addIceCandidate(e.ice).catch(() => {});
        else p.pendingIce.push(e.ice);
      }
    } catch (_) { /* a broken handshake just leaves this pair on the relay */ }
  }

  wireDC(p, dc) {
    p.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => { clearTimeout(p.fallbackT); this.setPath(p, 'direct'); };
    dc.onclose = () => { if (this.peers.get(p.id) === p && p.path === 'direct') this.setPath(p, 'relay'); };
    dc.onmessage = (ev) => {
      if (typeof ev.data === 'string') { let m; try { m = JSON.parse(ev.data); } catch (_) { return; } this.deliver(p, m); }
      else {
        p.bytesIn += ev.data.byteLength;
        if (this.lag) setTimeout(() => this.h.binary(p, ev.data), this.lagDelay(p));
        else this.h.binary(p, ev.data);
      }
    };
  }

  setPath(p, path) {
    const was = p.path;
    p.path = path;
    if (!p.opened) { p.opened = true; this.h.peerOpen(p); }
    if (was !== path) this.h.roster();
  }

  // simulated delay that, like a real ordered channel, never reorders messages from one peer
  lagDelay(p) {
    const now = performance.now(), t = Math.max(p.lagLast || 0, now + this.lag.ms + Math.random() * this.lag.jitter);
    p.lagLast = t; return t - now;
  }
  deliver(p, m) {
    if (!m || typeof m !== 'object') return;
    if (this.lag) setTimeout(() => this.h.message(p, m), this.lagDelay(p));
    else this.h.message(p, m);
  }

  // send to one peer (id) or everyone (no id)
  send(m, id) {
    const targets = id ? [this.peers.get(id)].filter(Boolean) : [...this.peers.values()];
    let s = null;
    for (const p of targets) {
      if (p.dc && p.dc.readyState === 'open') { s = s || JSON.stringify(m); try { p.dc.send(s); } catch (_) {} }
      else if (p.path === 'relay') this.relayEvent(p.id, { k: 'm', m });
    }
  }
  sendBinary(buf) {
    for (const p of this.peers.values()) {
      if (p.dc && p.dc.readyState === 'open' && p.dc.bufferedAmount < 1 << 20) { try { p.dc.send(buf); } catch (_) {} }
    }
  }

  closePeer(p) {
    clearTimeout(p.fallbackT);
    try { p.dc && p.dc.close(); } catch (_) {}
    try { p.pc && p.pc.close(); } catch (_) {}
    p.dc = p.pc = null;
  }
}
