// A band's own Dropbox as the long-term home of its takes. The studio is short-term parking: a new take lands in R2
// so everyone hears it straight away; a bandmate whose browser has the band's Dropbox linked copies it there (as a
// WAV) and gives the studio the file's share link; PARK_DAYS later, once the link is checked to serve the whole
// take, the parked copy goes and the studio keeps only the link.
//
// Reading a take from a link: browsers can't fetch an ordinary share link (www.dropbox.com sends no CORS headers),
// but the same link on dl.dropboxusercontent.com can be fetched (checked from the live site, Nov 2026). That form
// isn't documented and could stop working, so the studio server also fetches the official link itself (dl=1)
// and hands the bytes over: slower, never silent.

export const PARK_DAYS = 14;
export const WAV_HEADER = 44;   // src/songzip.js monoWav

// a Dropbox file share link, in one canonical form, or null. Only these are ever stored or fetched.
export function dropboxLink(s) {
  let u; try { u = new URL(String(s || '')); } catch (_) { return null; }
  if (u.protocol !== 'https:' || !/^(www\.)?dropbox\.com$/.test(u.hostname) || u.username || u.password || u.port) return null;
  const scl = u.pathname.match(/^\/scl\/fi\/([A-Za-z0-9]{6,64})\/([^/]{1,255})$/), old = u.pathname.match(/^\/s\/([A-Za-z0-9]{6,64})\/([^/]{1,255})$/);
  if (scl) {
    const rl = u.searchParams.get('rlkey') || '';
    if (!/^[A-Za-z0-9]{6,64}$/.test(rl)) return null;
    return `https://www.dropbox.com/scl/fi/${scl[1]}/${scl[2]}?rlkey=${rl}&dl=0`;
  }
  if (old) return `https://www.dropbox.com/s/${old[1]}/${old[2]}?dl=0`;
  return null;
}
// the file itself, as the studio server fetches it
export const officialFile = (link) => link.replace(/([?&])dl=0$/, '$1dl=1');
// the file itself, as a browser can fetch it (the undocumented form)
export const directFile = (link) => officialFile(link).replace('https://www.dropbox.com/', 'https://dl.dropboxusercontent.com/');

// does the link serve the whole take? (its WAV is the header and bytes of PCM)
export async function linkServes(get, link, bytes) {
  try {
    const r = await get(officialFile(link), { headers: { range: 'bytes=0-43' }, redirect: 'follow' });
    const total = r.status === 206 ? +((r.headers.get('content-range') || '').split('/')[1] || 0) : r.status === 200 ? +(r.headers.get('content-length') || 0) : 0;
    try { await r.body?.cancel(); } catch (_) {}
    return total === WAV_HEADER + bytes;
  } catch (_) { return false; }
}

// clear parking: every take that's been home long enough and whose link checks out leaves R2.
// core: StudioCore, bucket: R2, id: the studio's id, get: fetch. Returns what's left to do later.
export async function clearParking(core, bucket, id, get, now = Date.now()) {
  let cleared = 0, kept = 0;
  for (const [clip, rec] of await core.due(now)) {
    if (await linkServes(get, rec.home, rec.bytes)) { await bucket.delete(`c/${id}/${clip}`); await core.cleared(clip); cleared++; } else kept++;
  }
  return { cleared, kept, next: await core.nextDue(now) };
}
