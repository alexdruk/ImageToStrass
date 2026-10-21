# Connecting the Etsy shop (IS-06)

How IS is connected to the Etsy shop, how to connect it again (for example on the iMac), and how to
move the existing connection instead. Spec section 11.2. First connected on 21 Oct 2026 on the
laptop, through a quick tunnel: shop `LiveStories` (61488464).

## What a connection is

| File | What | Secret? |
| --- | --- | --- |
| `data/etsy-tokens.enc` | Etsy access and refresh token, AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY` | Yes (useless without the key) |
| `data/etsy-shop.json` | The shop's id and name, for the poller | No |
| `data/etsy-poller.json` | The poller's last runs (times and counts only) | No |

The access token lasts an hour and is refreshed by the server itself (`src/etsy/etsy-api.js`); no
redirect is involved in a refresh. The refresh token lasts 90 days from its last use, so a server
that keeps polling stays connected. `/health` and the admin page show the token's age.

All of `data/` is git-ignored: none of this is ever committed. Keep `.env` and these files off any
shared drive.

## `.env` lines

```
ETSY_KEYSTRING=<keystring of the IS app at etsy.com/developers>
ETSY_SHARED_SECRET=<shared secret of the same app>
TOKEN_ENCRYPTION_KEY=<32 random bytes, base64>
ETSY_REDIRECT_URI=https://<host>/oauth/callback
IS_ETSY_LISTING_IDS=<listing id>     # empty until the listing exists; empty = nothing is stored
IS_ETSY_LISTING_URL=https://www.etsy.com/listing/<listing id>
```

A new `TOKEN_ENCRYPTION_KEY` (only for a new connection; moving one needs the old key):

```
node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
```

Paste it into `.env` directly; don't put it in a chat, a ticket or a commit.

## A. Move the existing connection (no Etsy step)

Use this to move from the laptop to the iMac without approving on Etsy again.

1. On the laptop, stop the IS server, so only one machine refreshes the token from now on (a refresh
   can replace the refresh token; two machines would take turns invalidating each other's).
2. Copy `data/etsy-tokens.enc` and `data/etsy-shop.json` to the iMac's `data/` (AirDrop, a USB stick
   or `scp`; not a synced folder). `data/etsy-poller.json` may come too, so the poller carries on
   from the laptop's last good run; without it the first poll reads the last 30 days, which is also
   fine (re-polls never add duplicate rows).
3. Copy the same `ETSY_KEYSTRING`, `ETSY_SHARED_SECRET` and **`TOKEN_ENCRYPTION_KEY`** into the iMac's
   `.env`. With another key the token file cannot be read and the shop counts as not connected.
4. `chmod 600 data/etsy-tokens.enc`, start the server, open `http://127.0.0.1:3003/admin`: it must say
   **Connected** with the shop's name, and **Poll now** must end with "ok".
5. Delete the two files on the laptop once the iMac works (or keep its server stopped).

## B. Connect again with a quick tunnel (until the domain exists)

Needed on a machine without the token file, after a revoked or expired connection, or with a new
`TOKEN_ENCRYPTION_KEY`. Takes about five minutes.

1. `brew install cloudflared` (once).
2. Start the IS server: `npm start` (binds `127.0.0.1:3003`).
3. In a second terminal: `cloudflared tunnel --url http://127.0.0.1:3003`. Use `127.0.0.1`, never
   `localhost` (it can resolve to `::1`, where nothing listens). Note the address it prints,
   `https://<random>.trycloudflare.com`. It changes every time cloudflared starts, so keep this
   terminal open until step 8.
4. At etsy.com/developers → Your apps → **the IS app** (the one whose keystring is in `.env`), add
   the callback URL `https://<random>.trycloudflare.com/oauth/callback` and save. It must match
   exactly: `https://`, the same subdomain, no slash after `callback`.
5. In `.env`: `ETSY_REDIRECT_URI=https://<random>.trycloudflare.com/oauth/callback`. Restart the IS
   server (the tunnel can stay up).
6. On the Mac itself open `http://127.0.0.1:3003/admin` and click **Connect Etsy** (or **Reconnect
   Etsy**). Approve on Etsy. Etsy sends the browser back through the tunnel to a page that says
   **Etsy connected** and names the shop.
7. Back on `http://127.0.0.1:3003/admin`: **Connected**, shop name, then **Poll now** → "ok".
8. Stop the tunnel (Ctrl-C). Refreshes need no redirect, so the connection keeps working. The old
   trycloudflare callback can be removed from the Etsy app.

## C. Connect with the named tunnel (after the domain exists)

The same as B with a fixed address, so it is done once:

- the callback URL in the Etsy app and `ETSY_REDIRECT_URI` are `https://<domain>/oauth/callback`;
- the tunnel is the named tunnel (`cloudflared tunnel run is`, ingress `http://127.0.0.1:3003`,
  spec section 15) instead of step 3;
- set `PUBLIC_BASE_URL=https://<domain>` too, and make the listing's PDF again
  (`node tools/make-how-to-pdf.mjs https://<domain>`, `docs/etsy-listing.md`).

## Who can reach what

`/admin`, `/auth/etsy` and `/etsy/*` answer only on the Mac itself (`http://127.0.0.1:3003`) or with
the `x-admin-token: <ADMIN_TOKEN>` header; through the tunnel they are a plain 404. That is why the
admin page is opened at `127.0.0.1`, not at the tunnel address. `/oauth/callback` is reached through
the tunnel, and is accepted only with the one-time `state` of a **Connect Etsy** click made on the
Mac in the last 10 minutes.

## When it goes wrong

| What you see | Why, and what to do |
| --- | --- |
| Etsy: "The requested redirect URL is not permitted" | The callback URL is not registered, exactly, on the app whose keystring is in `.env`. Check step B4, save the app, click Connect Etsy again. (This is what happened on the first try on 21 Oct 2026.) |
| A 404 page after approving on Etsy | More than 10 minutes passed, or the server restarted between Connect Etsy and the approval (the pending state is kept in memory). Click Connect Etsy again. |
| 404 at the tunnel address for `/admin` | By design. Use `http://127.0.0.1:3003/admin`. |
| Admin page: Not connected after moving | Different `TOKEN_ENCRYPTION_KEY`, or the token file was not copied. |
| Poller: "Etsy API request failed (401)" | The token was revoked or the refresh token expired. Connect again (B or C). |
| Poller ok but nothing stored | `IS_ETSY_LISTING_IDS` is empty or does not name the listing. |
