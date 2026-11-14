# MEGAjam studios

A band's permanent room. Anyone with a studio's link can walk in, alone or together, and find the song, every take and the audio of every live-audio take where the band left them. It's separate from the handshake relay (`crush-commando-mp`), which this doesn't touch, and from the stats Worker.

- **`core.js`:** the song store for one studio, kept key by key exactly as the room shares it (`title`, `order`, `sec:<id>`, `part:<sid>:<pid>`, `lane:<id>`…).
  - A daily backup of the whole song is kept for 14 days.
  - Each studio holds up to 2 GB of audio.
  - It runs in a Durable Object, and in Node for tests.
- **`api.js`:** the HTTP API (routes are listed at the top of `worker.js`).
- **`worker.js`:** the Cloudflare Worker and the Durable Object class.
- **`../src/studio.js`:** the app side. The room's clock leader mirrors every change a moment later; a new leader sends the whole song once. Whoever walks into an empty studio loads the song from here. Audio a browser is missing comes from here first.
- **`home.js`:** the band's Dropbox as the long-term home of takes: share-link checks, and clearing parked copies
  (a Durable Object alarm) once a take has been home for 14 days and its link serves the whole WAV.
- **`../src/dropbox.js`, `../dropbox.html`:** linking a Dropbox in the browser (PKCE in a pop-up), uploads, share links.
- **`../src/songzip.js`:** **Save song** with audio takes makes a .zip of the song plus a WAV per take, for keeping in Dropbox or Drive; **Import** brings it back.

## Who can get in

The link is the key: studio ids are 16 random characters, unguessable but shareable. Writes are only accepted from the site's own pages (and localhost); reads need only the id. Help (Chapter 15) tells players to share the link only with the band.

## What's stored

- the song, key by key, plus a backup per day for 14 days;
- each live-audio take's 16-bit mono PCM, in R2 at `c/<studio>/<clip>` (sample rate in the object's metadata);
- the studio's name, when it was made and last opened, how many visits, and how much audio it holds.

Nothing about who played: names inside the song are the ones the band typed.

## Deploy (once)

Logged in to the Cloudflare account that runs crush-commando. R2 must be enabled on the account (Cloudflare dashboard → R2 → enable).

```sh
cd studio
npx wrangler r2 bucket create megajam-clips
npx wrangler deploy        # → https://megajam-studio.samuelling.workers.dev (creates the Durable Object class)
```

`mp-config.js` already points the app there (`window.MP_STUDIO`). With a token instead of a login, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token needs Workers Scripts: Edit and Workers R2 Storage: Edit (both are in the "Edit Cloudflare Workers" template).

## Test

`node tests/studio.test.cjs` runs this code in Node with in-memory storage and walks several browsers in and out. To try the real thing locally: `npx wrangler dev --local --port 8791` here, then open the app with `?studios=http://localhost:8791`.

## The band's Dropbox (optional)

Takes are parked in R2 and, for a studio whose band has linked Dropbox, carried there by that bandmate's browser.
Browsers read a take that has gone home through the share link's `dl.dropboxusercontent.com` form (CORS allowed,
undocumented), and fall back to `GET /studios/:id/clips/:clip?via=home`, where this Worker fetches the official link.

Setup, once, by the account owner, at dropbox.com/developers/apps:

1. **Create app** › **Scoped access** › **App folder**, named e.g. *MEGAjam Studio*.
2. **Permissions:** `files.content.write`, `files.content.read`, `sharing.write`, `sharing.read` (and Submit).
3. **Settings:** Redirect URIs `https://samuelling.github.io/JamJam/` and `http://localhost:8787/` (index.html hands
   the pop-up on to dropbox.html);
   "Allow public clients (Implicit Grant & PKCE)": Allow.
4. Put the **App key** (public; the secret is never used) in `../mp-config.js` as `MP_DROPBOX_KEY` (MEGAjam's is `ef7jrsv13huhd2e`). Without it there is
   no Dropbox option. Until Dropbox approves the app for production, only a limited number of people can link it.
