# MEGAjam usage stats

A small Cloudflare Worker that collects anonymous session reports from the app and serves them to the admin dashboard. It is separate from the handshake relay (`crush-commando-mp`), which this doesn't touch.

- **`worker.js`:** receives reports (`POST /report`) and serves them to the dashboard (`GET /summary`, which needs the admin key). A daily cron deletes anything older than 90 days.
- **`../src/stats.js`:** the app side. It builds one report per page load and sends it each minute and when the page closes.
- **`../admin.html`:** the dashboard, at `https://samuelling.github.io/JamJam/admin.html`. It asks once for the admin key and keeps it in that browser. `?demo=1` shows made-up data.

## What a report holds

- **Timing:**
  - how long the page was open, in a room, and with a bandmate;
  - the most bandmates at once;
  - join time.
- **Links:**
  - time linked direct vs through the server;
  - round-trip, lookahead and clock-error histograms;
  - fallbacks and handshake-server drops.
- **Notes:** played, heard, late, and the worst late.
- **The browser:**
  - main-thread stalls;
  - device and browser kind;
  - audio sample rate and output latency;
  - instrument ids;
  - features used (Compose Room, Talk, live audio, sync take, match, stems, listen-in, MIDI, tours, help, quantize);
  - JavaScript errors (message and file:line).
- **The room:** a one-way hash of the room code and the day, so one jam's sessions group together.

Never sent: names, chat, the notes played, audio, the room code. The Worker adds the country from Cloudflare and stores no IP address.

Help (Troubleshooting) tells players about this. Visiting with `?stats=0` turns it off in that browser for good; `?stats=1` turns it back on. Automated browsers (our tests and fleets) don't report unless given `?stats=<url>`.

## Deploy (once)

From this folder, logged in to the Cloudflare account that runs crush-commando-mp:

```sh
npx wrangler login
npx wrangler d1 create megajam-stats          # copy the database_id it prints into wrangler.toml
npx wrangler deploy                           # → https://megajam-stats.samuelling.workers.dev
npx wrangler secret put ADMIN_KEY             # paste a long random key; it's what the dashboard asks for
```

`mp-config.js` already points the app at `https://megajam-stats.samuelling.workers.dev`. If the Worker ends up somewhere else, change `window.MP_STATS` there.

The app pings `/ping` once per visit and only reports if the Worker answers. Until it's deployed, each visit makes that one failed request and nothing else.

## Test

`node tests/stats.test.cjs` runs the real Worker code in Node with an in-memory table and two jammers, then opens the dashboard. To run the real Worker locally: `npx wrangler dev --local --port 8788` here, with `ADMIN_KEY=…` in `.dev.vars`, then open the app with `?stats=http://localhost:8788` and `admin.html?stats=http://localhost:8788`.
