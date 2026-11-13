// The band's Dropbox, linked in this browser: where a studio's takes live long-term (studio/home.js says how the
// pieces fit). MEGAjam is a Dropbox "app folder" app, so it only ever sees Dropbox/Apps/<app name>/, never the rest
// of anyone's Dropbox. Linking happens in a small pop-up (Dropbox returns it to the app's address; index.html passes it to dropbox.html), with PKCE: no secret anywhere, and the
// sign-in itself is between the person and Dropbox. What this browser keeps: a refresh token and which account it
// is, in localStorage. Nothing about it is sent to MEGAjam's servers except the account id (so bandmates' browsers
// know whose Dropbox a studio uses) and the share links of the takes.

const STORE = 'megajam.dropbox';
const AUTH = 'https://www.dropbox.com/oauth2/authorize', TOKEN = 'https://api.dropboxapi.com/oauth2/token';
const API = 'https://api.dropboxapi.com/2/', CONTENT = 'https://content.dropboxapi.com/2/';

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
// Dropbox-API-Arg is a header: JSON in plain ASCII
const argHeader = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
// a name Dropbox (and every computer it syncs to) accepts
export const safeName = (s, n = 80) => String(s || '').replace(/[\\/:?*"<>|\u0000-\u001f]+/g, ' ').replace(/[·•]/g, '-').replace(/\s+/g, ' ').trim().slice(0, n).replace(/[. ]+$/, '') || 'untitled';

// o: { key (the Dropbox app key), redirect (dropbox.html's address) }
export function makeDropbox(o) {
  let saved = null; try { saved = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (_) {}
  const st = { refresh: saved?.refresh || '', account: saved?.account || '', name: saved?.name || '', access: '', until: 0 };
  const keep = () => { try { if (st.refresh) localStorage.setItem(STORE, JSON.stringify({ refresh: st.refresh, account: st.account, name: st.name })); else localStorage.removeItem(STORE); } catch (_) {} };

  async function token() {
    if (st.access && Date.now() < st.until - 60_000) return st.access;
    if (!st.refresh) throw new Error('Dropbox is not linked here');
    const r = await fetch(TOKEN, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: st.refresh, client_id: o.key }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { if (r.status === 400 || r.status === 401) { st.refresh = ''; keep(); } throw new Error(j.error_description || 'Dropbox said no (' + r.status + ')'); }
    st.access = j.access_token; st.until = Date.now() + (j.expires_in || 3600) * 1000;
    return st.access;
  }
  async function rpc(path, body) {
    const r = await fetch(API + path, { method: 'POST', headers: { authorization: 'Bearer ' + await token(), 'content-type': 'application/json' }, body: JSON.stringify(body ?? null) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error_summary || 'Dropbox error ' + r.status); e.status = r.status; e.body = j; throw e; }
    return j;
  }

  return {
    get configured() { return !!o.key; },
    get linked() { return !!st.refresh; },
    get account() { return st.account; },
    get name() { return st.name; },

    // link this browser to a Dropbox: call from a click (it opens the pop-up). Resolves with { account, name }.
    connect() {
      if (!o.key) return Promise.reject(new Error('Dropbox is not set up for this site (MP_DROPBOX_KEY)'));
      const verifier = random(48), state = random(16);
      const pop = window.open('', 'megajam-dropbox', 'width=560,height=720');
      if (!pop) return Promise.reject(new Error('the pop-up was blocked: allow pop-ups for this site and try again'));
      return (async () => {
        const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
        pop.location.href = AUTH + '?' + new URLSearchParams({ client_id: o.key, response_type: 'code', redirect_uri: o.redirect, code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline', state });
        const code = await new Promise((resolve, reject) => {
          const done = (f, v) => { removeEventListener('message', onMsg); clearInterval(watch); f(v); };
          const onMsg = (e) => {
            if (e.origin !== location.origin || e.data?.type !== 'megajam-dropbox' || e.data.state !== state) return;
            if (e.data.error) done(reject, new Error(e.data.error === 'access_denied' ? 'Dropbox access was not allowed' : e.data.error)); else done(resolve, e.data.code);
          };
          addEventListener('message', onMsg);
          const watch = setInterval(() => { if (pop.closed) done(reject, new Error('the Dropbox window was closed')); }, 600);
        });
        const r = await fetch(TOKEN, { method: 'POST', body: new URLSearchParams({ code, grant_type: 'authorization_code', code_verifier: verifier, client_id: o.key, redirect_uri: o.redirect }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.refresh_token) throw new Error(j.error_description || 'Dropbox didn\'t link (' + r.status + ')');
        Object.assign(st, { refresh: j.refresh_token, access: j.access_token, until: Date.now() + (j.expires_in || 3600) * 1000, account: j.account_id || '' });
        try { const me = await rpc('users/get_current_account'); st.account = me.account_id || st.account; st.name = me.name?.display_name || ''; } catch (_) {}
        keep();
        return { account: st.account, name: st.name };
      })();
    },
    async disconnect() {
      try { if (st.refresh) await rpc('auth/token/revoke'); } catch (_) {}
      Object.assign(st, { refresh: '', access: '', until: 0, account: '', name: '' }); keep();
    },

    // put a file at path (inside the app folder). An existing file there is left alone (same take, two browsers).
    async upload(path, bytes) {
      const r = await fetch(CONTENT + 'files/upload', { method: 'POST', headers: { authorization: 'Bearer ' + await token(), 'content-type': 'application/octet-stream', 'dropbox-api-arg': argHeader({ path, mode: 'add', autorename: false, mute: true }) }, body: bytes });
      if (r.ok) return 'uploaded';
      const j = await r.json().catch(() => ({}));
      if (r.status === 409 && /conflict/.test(j.error_summary || '')) return 'there';
      throw new Error(j.error_summary || 'Dropbox upload failed (' + r.status + ')');
    },
    // the file's public share link (made, or the one it has)
    async shareLink(path) {
      try { return (await rpc('sharing/create_shared_link_with_settings', { path, settings: { audience: 'public', access: 'viewer' } })).url; } catch (e) {
        const there = e.body?.error?.shared_link_already_exists?.metadata?.url; if (there) return there;
        if (e.status !== 409) throw e;
        const l = await rpc('sharing/list_shared_links', { path, direct_only: true });
        if (l.links?.[0]?.url) return l.links[0].url;
        if (/settings_error/.test(e.message)) return (await rpc('sharing/create_shared_link_with_settings', { path })).url;
        throw e;
      }
    },
  };
}

// a take straight from the band's Dropbox, in a browser: the share link's undocumented dl.dropboxusercontent.com
// form is the one browsers can fetch (studio/home.js). null if that doesn't work, and the studio server fetches it.
export async function fetchDirect(link) {
  const m = String(link || '').match(/^https:\/\/www\.dropbox\.com\/((?:scl\/fi|s)\/[^?#]+)\?(.*)$/); if (!m) return null;
  const q = new URLSearchParams(m[2]); q.set('dl', '1');
  try { const r = await fetch(`https://dl.dropboxusercontent.com/${m[1]}?${q}`); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; } catch (_) { return null; }
}
