// A song with its audio in one file: "Save song" makes a .zip holding the song (song.megajam.json) and each audio
// take as a plain WAV (audio/<clip id>.wav, so a DAW can open them too), and importing that .zip brings both back.
// Good for keeping a song in the band's Dropbox or Google Drive folder, outside any studio.

// 16-bit mono WAV
// a 16-bit PCM WAV of a take: pcm16 is interleaved when ch is 2
export function wav(pcm16, sr, ch = 1) {
  const n = pcm16.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2 * ch, true); v.setUint16(32, 2 * ch, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  new Int16Array(buf, 44).set(pcm16);
  return new Uint8Array(buf);
}
export const monoWav = (pcm16, sr) => wav(pcm16, sr, 1);

// a 16-bit PCM WAV back to { pcm16 (interleaved), sr, ch }: mono and stereo as they are, more channels folded to stereo
// pairs' first two; null if it's anything else
export function readPcmWav(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let o = 12, ch = 0, sr = 0, bits = 0;
  while (o + 8 <= bytes.length) {
    const id = tag(o), size = v.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ') { ch = v.getUint16(body + 2, true); sr = v.getUint32(body + 4, true); bits = v.getUint16(body + 14, true); }
    if (id === 'data') {
      if (bits !== 16 || !ch || !sr) return null;
      const out = Math.min(ch, 2), n = Math.floor(Math.min(size, bytes.length - body) / (2 * ch)), pcm16 = new Int16Array(n * out);
      for (let i = 0; i < n; i++) for (let c = 0; c < out; c++) pcm16[i * out + c] = v.getInt16(body + (i * ch + c) * 2, true);
      return { pcm16, sr, ch: out };
    }
    o = body + size + (size & 1);
  }
  return null;
}

// a take's samples as an AudioBuffer (pcm16 interleaved when ch is 2)
export function pcmBuffer(ctx, pcm16, sr, ch = 1) {
  ch = ch === 2 ? 2 : 1;
  const n = Math.floor(pcm16.length / ch), buf = ctx.createBuffer(ch, Math.max(1, n), sr);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) d[i] = pcm16[i * ch + c] / 32768; }
  return buf;
}

// the files in a .zip: stored ones as they are, deflated ones through the browser's own decompressor
export async function unzip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = [];
  let e = bytes.length - 22; while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("That isn't a zip file.");
  let p = v.getUint32(e + 16, true);
  const count = v.getUint16(e + 10, true);
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), lo = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const start = lo + 30 + v.getUint16(lo + 26, true) + v.getUint16(lo + 28, true), raw = bytes.subarray(start, start + csize);
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8 && typeof DecompressionStream !== 'undefined') out.push({ name, data: new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()) });
  }
  return out;
}
