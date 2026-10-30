// Address of the handshake relay: the Cloudflare Durable Object relay from samuelling/crush-commando (server/),
// already deployed as crush-commando-mp. JamJam rooms live under their own names (jj-XXXX).
// The local dev server (node server/dev.js) serves its own copy of this file pointing at itself.
// Override per visit with ?server=wss://your-relay
window.MP_SERVER = window.MP_SERVER || 'wss://crush-commando-mp.samuelling.workers.dev';
