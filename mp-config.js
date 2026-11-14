// Address of the handshake relay: the Cloudflare Durable Object relay from samuelling/crush-commando (server/),
// already deployed as crush-commando-mp. MEGAjam rooms live under their own names (jj-XXXX).
// The local dev server (node server/dev.js) serves its own copy of this file pointing at itself.
// Override per visit with ?server=wss://your-relay
window.MP_SERVER = window.MP_SERVER || 'wss://crush-commando-mp.samuelling.workers.dev';

// Where the app sends its anonymous usage stats (stats/worker.js, read by admin.html). Override per visit with
// ?stats=https://your-worker, or turn reporting off in a browser with ?stats=0.
window.MP_STATS = window.MP_STATS || 'https://megajam-stats.samuelling.workers.dev';

// The studio server: band studios that keep their song and audio between sessions (studio/worker.js).
window.MP_STUDIO = window.MP_STUDIO || 'https://megajam-studio.samuelling.workers.dev';

// The Dropbox app a studio's takes go home to (src/dropbox.js): its App key, which is public by design (the app has
// no secret in use: linking is PKCE). Empty: no Dropbox option. Override per visit with ?dropbox=<app key>.
window.MP_DROPBOX_KEY = window.MP_DROPBOX_KEY || 'ef7jrsv13huhd2e';
