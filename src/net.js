// The room: a WebSocket to the Cloudflare relay for the handshake, then direct WebRTC DataChannels to every other jammer
// (a full mesh: 4 jammers = 6 links). Each link has two channels: "jam" (reliable, ordered) for everything, and
// "fast" (unordered, never retransmitted) for notes and pings, where a lost packet is simply recovered from the
// redundant copy in the next one instead of holding every later note back while it is retransmitted. After the handshake the relay carries nothing, unless a pair of jammers can't
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
    this.lag = q.get('lag') || q.get('loss') ? { ms: +q.get('lag') || 0, jitter: +q.get('jitter') || 0, loss: +q.get('loss') || 0 } : null;
    this.fastOn = q.get('fast') !== '0';
  }

  // Your jammer id and join order are fixed for the whole visit, even if the relay connection drops and comes back
  // with a new relay id: the relay passes everyone's "state", and ours says which jammer we are, so a bandmate whose
  // direct link to us never broke just notes our new relay address instead of seeing us leave.
  join(code, name) {
    this.leave();
    this.code = code; this.name = name; this.jid = null; this.n0 = 0; this.retry = 0;
    this.connect();
  }
  connect() {
    const code = this.code, name = this.name;
    clearTimeout(this.retryT);
    let ws;
    try { ws = new WebSocket(`${this.server}/room/jj-${code.toLowerCase()}`); }
    catch (e) { this.h.status('error', "Couldn't reach the handshake server."); return; }
    this.ws = ws;
    this.h.status('connecting', 'Connecting…');
    ws.onopen = () => {
      this.retry = 0;
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
      if (!this.id) { this.h.status('error', full ? 'That room is full.' : "Couldn't reach the handshake server."); return; }
      // in the room already: keep playing over the direct links and quietly reconnect, backing off up to 30 s
      this.rid = null;
      const wait = Math.min(30000, 1000 * 2 ** this.retry++);
      if (this.retry > 2) this.h.status('relay-lost', 'Reconnecting to the handshake server… Your band keeps playing; new jammers can join once it\'s back.');
      this.retryT = setTimeout(() => { if (this.id && !this.ws) this.connect(); }, wait);
    };
  }

  leave() {
    clearInterval(this.keepalive); clearTimeout(this.retryT);
    if (this.ws) { const ws = this.ws; this.ws = null; try { ws.close(1000, 'bye'); } catch (_) {} }
    for (const p of this.peers.values()) this.closePeer(p);
    this.peers.clear();
    this.rids = new Map();   // relay id -> jammer id
    this.id = null; this.rid = null;
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
  relayEvent(jid, e) {
    const to = this.peers.get(jid)?.rid;
    if (!to) return false;
    const s = JSON.stringify(e);
    if (s.length <= RELAY_MAX) return this.relaySend({ t: 'ev', to, e });
    const id = Math.random().toString(36).slice(2, 8), parts = Math.ceil(s.length / (RELAY_MAX - 120));
    for (let i = 0; i < parts; i++) this.relaySend({ t: 'ev', to, e: { k: 'chunk', id, i, n: parts, s: s.slice(i * (RELAY_MAX - 120), (i + 1) * (RELAY_MAX - 120)) } });
    return true;
  }

  onRelay(m) {
    if (m.t === 'welcome') {
      const others = (m.peers || []).filter((p) => p && p.id);
      const first = !this.jid;
      if (first && others.length >= this.maxPeers) { this.leave(); this.h.status('error', `That room already has ${this.maxPeers} jammers.`); return; }
      this.rid = m.id;
      if (first) { this.jid = m.id; this.n0 = m.n; }
      this.id = this.jid; this.n = this.n0;
      this.relaySend({ t: 'st', s: { jid: this.jid, n: this.n0 } });
      for (const o of others) this.meet(o.id, o.st, o, true);
      if (first) this.h.status('in', others.length ? 'Connecting to the other jammers…' : 'In the room. Waiting for friends…');
      else this.h.status('relay-back', '');
      this.h.roster();
      return;
    }
    if (m.t === 'join') { this.pendingJoin = this.pendingJoin || new Map(); this.pendingJoin.set(m.id, m); return; }   // who it is arrives in its state message
    if (m.t === 'st') { const j = this.pendingJoin?.get(m.id); this.pendingJoin?.delete(m.id); this.meet(m.id, m.s, j || { id: m.id }, false); this.h.roster(); return; }
    if (m.t === 'leave') {
      this.pendingJoin?.delete(m.id);
      const jid = this.rids.get(m.id), p = jid && this.peers.get(jid); if (!p) return;
      this.rids.delete(m.id); if (p.rid === m.id) p.rid = null;
      const gone = () => { if (this.peers.get(p.id) !== p || p.rid) return; this.closePeer(p); this.peers.delete(p.id); this.h.peerLeft(p); this.h.roster(); };
      // their relay connection dropped, but a live direct link means they're still here and reconnecting
      if (p.dc && p.dc.readyState === 'open') setTimeout(() => { if (!(p.dc && p.dc.readyState === 'open')) gone(); }, 12000);
      else gone();
      return;
    }
    if (m.t === 'name') { const p = this.peers.get(this.rids.get(m.id)); if (p) { p.name = m.name; this.h.roster(); } return; }
    if (m.t === 'ev') m = { ...m, id: this.rids.get(m.id) || m.id };
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
      if (!p) { this.rids.set(m.id, m.id); p = this.addPeer({ id: m.id, rid: m.id, n: 0, name: '…' }, false); this.h.roster(); }
      if (e.k === 'sig') this.onSignal(p, e);
      else if (e.k === 'm') this.deliver(p, e.m);
    }
  }

  // a jammer seen through the relay: relay id rid, state st ({jid, n}) naming who they are
  meet(rid, st, info, initiator) {
    const jid = (st && st.jid) || rid;
    if (jid === this.jid) return;
    this.rids.set(rid, jid);
    const known = this.peers.get(jid);
    if (known) { known.rid = rid; if (info.name) known.name = info.name; return known; }   // the same jammer, back through the relay
    return this.addPeer({ id: jid, rid, n: (st && st.n) || info.n || 0, name: info.name }, initiator);
  }
  addPeer(info, initiator) {
    const p = { id: info.id, rid: info.rid || info.id, n: info.n || 0, name: info.name || 'Jammer', pc: null, dc: null, path: 'connecting', pendingIce: [], opened: false, rtt: [], bytesIn: 0 };
    this.peers.set(p.id, p);
    if (!this.p2p) { this.setPath(p, 'relay'); return p; }
    this.makePC(p);
    if (initiator) {
      this.wireDC(p, p.pc.createDataChannel('jam', { ordered: true }));
      if (this.fastOn) this.wireDC(p, p.pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }));
      p.pc.createOffer().then((o) => p.pc.setLocalDescription(o)).then(() => this.relayEvent(p.id, { k: 'sig', sdp: p.pc.localDescription.toJSON() })).catch(() => this.setPath(p, 'relay'));
    }
    p.fallbackT = setTimeout(() => { if (p.path === 'connecting') this.setPath(p, 'relay'); }, DIRECT_TIMEOUT_MS);
    return p;
  }

  makePC(p) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    p.pc = pc;
    pc.onicecandidate = (ev) => { if (ev.candidate) this.signal(p, { k: 'sig', ice: ev.candidate.toJSON() }); };
    pc.ondatachannel = (ev) => this.wireDC(p, ev.channel);
    // adding a voice track later renegotiates; over the direct link once it's open (perfect negotiation: the jammer
    // with the larger id is the polite one and gives way when both offer at once)
    p.negotiate = async () => {
      if (!p.dc || p.dc.readyState !== 'open') { p.needNeg = true; return; }   // the first handshake is driven by addPeer
      p.needNeg = false;
      try { p.makingOffer = true; await pc.setLocalDescription(); this.signal(p, { k: 'sig', sdp: pc.localDescription.toJSON() }); }
      catch (_) {} finally { p.makingOffer = false; }
    };
    pc.onnegotiationneeded = () => p.negotiate();
    pc.ontrack = (ev) => this.h.track?.(p, ev.track, ev.streams[0]);
    for (const t of this.tracks || []) { try { pc.addTrack(t.track, t.stream); } catch (_) {} }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && p.path !== 'relay') this.setPath(p, 'relay');
    };
  }

  signal(p, e) {
    if (p.dc && p.dc.readyState === 'open') { try { p.dc.send(JSON.stringify({ __sig: e })); return true; } catch (_) {} }
    return this.relayEvent(p.id, e);
  }
  // a local track (talkback) for every link, now and later
  addTrack(track, stream) {
    this.tracks = this.tracks || []; this.tracks.push({ track, stream });
    for (const p of this.peers.values()) if (p.pc) { try { p.pc.addTrack(track, stream); } catch (_) {} }
  }
  async onSignal(p, e) {
    if (!this.p2p) return;
    if (!p.pc) this.makePC(p);
    const pc = p.pc;
    try {
      if (e.sdp) {
        const collision = e.sdp.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        if (collision && String(this.jid) < String(p.id)) return;   // impolite: ignore their offer, ours wins
        await pc.setRemoteDescription(e.sdp);
        if (e.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          this.signal(p, { k: 'sig', sdp: pc.localDescription.toJSON() });
        }
        for (const c of p.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      } else if (e.ice) {
        if (pc.remoteDescription) await pc.addIceCandidate(e.ice).catch(() => {});
        else p.pendingIce.push(e.ice);
      }
    } catch (_) { /* a broken handshake just leaves this pair on the relay */ }
  }

  wireDC(p, dc) {
    dc.binaryType = 'arraybuffer';
    if (dc.label === 'fast') {
      p.fast = dc;
      dc.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        if (this.lag && this.lag.loss && Math.random() < this.lag.loss) return; // simulated loss
        let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
        this.deliver(p, m, true);
      };
      return;
    }
    p.dc = dc;
    dc.onopen = () => { clearTimeout(p.fallbackT); this.setPath(p, 'direct'); if (p.needNeg) p.negotiate?.(); };
    dc.onclose = () => { if (this.peers.get(p.id) === p && p.path === 'direct') this.setPath(p, 'relay'); };
    dc.onmessage = (ev) => {
      if (typeof ev.data === 'string') { let m; try { m = JSON.parse(ev.data); } catch (_) { return; } if (m && m.__sig) { this.onSignal(p, m.__sig); return; } this.deliver(p, m, false); }
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

  // Simulated network (testing): delay plus jitter. On the reliable channel a lost packet is retransmitted after
  // about an RTO and, being ordered, holds back everything behind it; on the fast channel it is just gone.
  lagDelay(p, fast) {
    const now = performance.now();
    let t = now + this.lag.ms + Math.random() * this.lag.jitter;
    if (fast) return t - now;
    if (this.lag.loss && Math.random() < this.lag.loss) t += 2 * this.lag.ms + 200;
    t = Math.max(p.lagLast || 0, t);
    p.lagLast = t; return t - now;
  }
  deliver(p, m, fast = false) {
    if (!m || typeof m !== 'object') return;
    if (this.lag) setTimeout(() => this.h.message(p, m), this.lagDelay(p, fast));
    else this.h.message(p, m);
  }
  // notes and pings: the fast channel when it's open, otherwise the normal path
  sendFast(m, id) {
    const targets = id ? [this.peers.get(id)].filter(Boolean) : [...this.peers.values()];
    let s = null;
    for (const p of targets) {
      if (p.fast && p.fast.readyState === 'open') { s = s || JSON.stringify(m); try { p.fast.send(s); } catch (_) {} }
      else this.send(m, p.id);
    }
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
  // binary to one jammer, waiting while their link's send buffer is full (big transfers: sync record stems)
  async sendBinaryTo(id, buf) {
    const p = this.peers.get(id); if (!p || !p.dc) return false;
    while (p.dc.readyState === 'open' && p.dc.bufferedAmount > 2 << 20) await new Promise((r) => setTimeout(r, 15));
    if (p.dc.readyState !== 'open') return false;
    try { p.dc.send(buf); return true; } catch (_) { return false; }
  }
  sendBinary(buf) {
    for (const p of this.peers.values()) {
      if (p.dc && p.dc.readyState === 'open' && p.dc.bufferedAmount < 1 << 20) { try { p.dc.send(buf); } catch (_) {} }
    }
  }

  closePeer(p) {
    clearTimeout(p.fallbackT);
    try { p.dc && p.dc.close(); } catch (_) {}
    try { p.fast && p.fast.close(); } catch (_) {}
    try { p.pc && p.pc.close(); } catch (_) {}
    p.dc = p.fast = p.pc = null;
  }
}
