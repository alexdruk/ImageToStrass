# IS-001 — IS: any image to rhinestone template, sold on Etsy

Status: spec, 18 Oct 2026. Revised 18 Oct 2026 (IS-03b): no size choice, every design is delivered
at its natural size.

Repository: `alexdruk/imagetostrass` (local: `/Users/alex/Documents/ImageToStrass`).
Source of reused code: `alexdruk/Rhinestone-Studio` (RS), pinned at commit `38cd831` (17 Oct 2026).
The RS spec this builds on is `docs/specifications/IMG-026-StrassLayoutService.md` (prompt v6, layout
service builds A–K). Where this spec and RS disagree, this spec wins for IS.

---

## 1. Product

A buyer finds the Etsy listing "Any image to rhinestone template". The listing points to the IS web
app. There the buyer:

1. uploads an image (PNG, JPG, BMP, TIFF, WebP, AVIF, SVG; at most 50 MB);
2. prepares it: background removal (on by default), crop, rotate, brightness, contrast, saturation;
3. chooses Colour or Black & white (there is no size to choose: the design has its natural size,
   shown with the result);
4. waits while IS makes the design (a few minutes);
5. sees the original and the **tinted** result side by side;
6. tries again if unhappy (at most **3 designs per code**), or picks one with "Use this design";
7. copies the code (`IS-XXXX-XXXX`), returns to Etsy, enters the code in the Personalization field
   and checks out;
8. opens the IS download page, enters the code and, once the payment is seen, downloads a ZIP with
   SVG, PDF (production sheet), AI, EPS, DXF and PNG.

A buyer who is not happy after 3 designs simply does not buy. Nothing is charged before checkout.

The buyer must believe IS does all the work. No third-party name, prompt, model or intermediate
image ever reaches the browser (section 12). The Etsy listing still carries Etsy's required AI
disclosure in generic words (section 11.1).

## 2. Decisions

| # | Decision |
| --- | --- |
| D1 | The buyer does not choose a size. Every design is delivered at its **natural size**, exactly as the strass service measures it (section 7.5), shown as width × height in mm and in. |
| D2 | **SS6** is the main stone size, with occasional **SS4**, **SS10** and **SS16** allowed. No tier multiples in the UI, the result data or the ZIP. |
| D3 | Black & white means **Jet + Crystal only**. |
| D4 | The buyer sees only two views: **Original** and **Tinted** (section 8). No mask, AI image, overlay or 3D view. |
| D5 | At most 3 designs per code. A design that fails for technical reasons, or is declined by the safety check, does not count. |
| D6 | The buyer picks the delivered design ("Use this design"). If a paid code has no pick, the latest design is delivered. |
| D7 | Uploads, prepared images, AI images, layouts and code records are kept **indefinitely** in `data/archive/`, managed by Alex by hand. Delivery ZIPs are kept **30 days** after payment, then deleted. |
| D8 | One Etsy listing, one price. |
| D9 | Production sheet as the RS exporter: A4 / Letter / A3, multi-page tiling for large designs. The page size used to follow the buyer's unit (A4 for mm, Letter for inches); with no unit choice it is open (section 19). |
| D10 | CDR is dropped. AI is a PDF-compatible file; EPS comes from Ghostscript. |
| D11 | Background removal is **on by default** and can be switched off. |
| D12 | Hosted on Alex's Mac behind a Cloudflare Tunnel. Etsy OAuth is done once through a temporary quick tunnel until the domain exists. |
| D13 | No framework, no TypeScript. Node (ES modules) + plain HTML/CSS/JS. Python only in `services/`. |

## 3. Architecture

```
Browser (public/)  ──HTTPS──  Cloudflare Tunnel  ──  Node/Express :3003   (src/server)
                                                      ├─ SQLite  data/is.sqlite
                                                      ├─ job queue (one design at a time)
                                                      ├─ image prep (sharp + shared adjust.js)
                                                      ├─ provider call (server-side only)
                                                      ├─ strass service :8000 (Python, 127.0.0.1)
                                                      │    /layout  (RS layout service)
                                                      │    /remove-background  (new)
                                                      ├─ tinted renderer + exporters (Node)
                                                      └─ Etsy poller (receipts → paid codes)
```

Folders:

```
src/
  server/      express app, routes, rate limits, static
  db/          sqlite schema and queries
  prep/        decode, sanitise, normalise, adjust (shared with browser)
  pipeline/    queue, prompt, provider client, layout client, natural size (tiers kept, unused),
               bw mapping
  stones/      copied from RS: StoneColors, CrystalColors, StoneSizes, CrystalAppearance,
               CrystalStoneRenderer, Stone, StoneLayout (+ BoundingBox)
  render/      tinted renderer, watermark
  export/      copied from RS: SvgExporter, ProductionSheetExporter, PdfDocument, DxfExporter;
               new: aiExport, epsExport, pngExport, zip
  etsy/        existing oauth, token store, api + new poller and matcher
  units/       copied from RS
public/        the web app (index.html, app.js, styles.css, adjust.js symlink/copy)
services/strass/   copied from RS services/strass-layout + new background endpoint
data/          is.sqlite, archive/, delivery/, etsy tokens (git-ignored)
docs/          this spec, listing texts, runbook
```

Stage names shown to the buyer (never anything else): "Preparing image", "Designing layout",
"Placing stones", "Preparing files".

## 4. Data

### 4.1 SQLite (`better-sqlite3`, WAL mode)

```
codes(
  code TEXT PRIMARY KEY,          -- IS-XXXX-XXXX
  created_at, ip_hash, consent_at,
  attempts_used INTEGER DEFAULT 0,
  selected_attempt INTEGER NULL,
  status TEXT,                    -- open | paid | refunded | expired
  paid_at NULL, receipt_id NULL, transaction_id NULL,
  downloads INTEGER DEFAULT 0, delivery_expires_at NULL
)
attempts(
  code, n INTEGER,                -- 1, 2, 3, ... per code, never reused
  status TEXT,                    -- queued | running | done | failed | declined
  stage TEXT, settings_json,      -- mode, bg removal, adjustments, crop, rotate
  result_json NULL,               -- stone count, sizes, colours, natural w/h, coverage
  error_code NULL, created_at, finished_at,
  counts INTEGER                  -- 1 if it uses one of the 3 designs (D5)
)
etsy_orders(receipt_id, transaction_id, listing_id, personalization, matched_code NULL,
            paid_at, status, seen_at,
            UNIQUE(transaction_id, matched_code))
events(at, code NULL, kind, detail)   -- audit log, local only
```

Attempts:

- `n` counts up per code: 1, 2, 3, ... Failed, declined and re-run attempts get their own `n`, so
  `n` can pass 3. A number is never reused, and an `attempt-<n>/` archive folder is never
  overwritten.
- The 3-design limit (D5) counts only the code's rows with `counts = 1`.

Etsy orders:

- One row per (`transaction_id`, `matched_code`): a transaction whose personalization holds two
  codes gets two rows. A transaction with no code (or no known code) gets one row with
  `matched_code` NULL.
- Re-polls upsert on that key and never add a duplicate row. Because SQLite treats NULLs as
  distinct, the key is enforced by a unique index on `(transaction_id, IFNULL(matched_code, ''))`.
- Schema changes are migrations keyed on `PRAGMA user_version`; migration 1 de-duplicates
  existing `etsy_orders` rows on that key (keeping the newest) and adds the index.

### 4.2 Files

```
data/archive/<code>/                         kept forever (D7)
  code.json                                  copy of the code row at each change
  uploads/<k>/original.<ext>                 upload as received (k = 1, 2, 3, ... never reused)
  uploads/<k>/work.png                       decoded image (section 6.1)
  uploads/<k>/cutout.png                     work.png with the background removed, if removal worked
  attempt-<n>/original.<ext>                 copy of the upload the attempt was made from
  attempt-<n>/prepared.png                   after background removal and adjustments
  attempt-<n>/settings.json
  attempt-<n>/ai.png                         provider output
  attempt-<n>/layout.json                    layout service response
  attempt-<n>/stones.json                    final StoneLayout at natural size, after bw mapping
  attempt-<n>/tinted.png                     full-resolution tinted render
data/delivery/<code>/IS-XXXX-XXXX.zip        deleted 30 days after payment
```

All of `data/` is git-ignored (already the case). The archive is written before anything is shown
to the buyer, so a crash never loses an upload.

An upload is written to `uploads/<k>/` the moment it arrives; no attempt row exists yet. A buyer
may upload several times, and "Try again" may reuse an upload. When "Create design" makes attempt
`n`, `attempt-<n>/` gets a copy of that upload's `original.<ext>`, plus `prepared.png` and
`settings.json` (which names the upload as `uploadId: k`). Like `attempt-<n>/`, an `uploads/<k>/`
folder is never overwritten.

## 5. Codes

- Format `IS-XXXX-XXXX`, 8 symbols of Crockford base32 (`0-9 A-H J K M N P-T V-Z`), from
  `crypto.randomInt`. 40 bits, collision checked against the table.
- Normalisation when read anywhere: upper-case; `O→0`, `I→1`, `L→1`; spaces, dashes and the
  `IS` prefix optional.
- A code is created at the first upload, shown on screen from the start, and kept in
  `localStorage` so the buyer can come back (`/c/<code>` resumes the session).
- Matching regex (personalization text): `/I\s*S[\s\-_]*([0-9A-Z]{4})[\s\-_]*([0-9A-Z]{4})/i`,
  then normalisation.

## 6. Upload and preparation

### 6.1 Upload

- `POST /api/upload` (multipart, `busboy`), field `image`, 50 MB hard limit while streaming,
  plus Cloudflare Turnstile token and the consent flag. Creates the code if the request has none.
- Type is decided from the file signature, not the name. Accepted: PNG, JPEG, BMP, TIFF, WebP,
  AVIF, SVG.
- Decoding: `sharp` for everything except BMP (`bmp-js` → raw RGBA → sharp). `limitInputPixels`
  100 MP. EXIF rotation applied, then all metadata stripped. CMYK converted to sRGB. Animated
  images: first frame.
- SVG: rejected if it contains `<script`, `foreignObject`, event attributes or any non-`data:`
  external `href`; rasterised by sharp (librsvg) at 2048 px on the long side.
- Result: `work.png`, sRGB, long side 2048 px max, alpha kept, stored in `uploads/<k>/` (4.2).

### 6.2 Background removal (D11)

- New endpoint on the Python service: `POST /remove-background` (PNG in, RGBA PNG out), using
  `rembg` with the model set by `REMBG_MODEL`, default `birefnet-general` (fallback
  `isnet-general-use` if memory is short; IS-03 compared both in `docs/IS-03-results.md`).
  It shares the service's one-at-a-time lock with `/layout`.
- Runs right after upload, in the background, so the cut-out is ready when the buyer reaches the
  toggle. The browser receives a 1024 px preview of both versions.
- If removal fails, the toggle is shown off with "Background could not be removed automatically".

### 6.3 Adjustments

- Crop (free rectangle), rotate (90° steps), brightness, contrast, saturation (each −100…+100),
  "Auto enhance" (stretch levels to 0.5 % / 99.5 % percentiles).
- One pure module, `src/prep/adjust.js`, works on RGBA arrays. The browser uses it for the live
  preview on a 1024 px canvas; the server runs the same function on the full image. Same code,
  same result.
- The buyer's settings are stored per attempt; "Try again" starts from the previous settings.

### 6.4 Mode

- No size input. The design has its natural size (section 7.5); the result screen shows it.
- The settings are only: Colour / Black & white (Colour default), background removal (6.2) and the
  adjustments (6.3).

## 7. Design pipeline

One queue, one design at a time (the layout service holds a process lock anyway). Queue length
and position are shown. Queue limit 10; beyond that, "IS is very busy, please try again in a few
minutes".

### 7.1 Prepared image → model input

`prepared.png` (background removed if chosen, adjusted, cropped) becomes the model input:

- Background removal on: cropped to the bounding box of the cut-out (pixels with alpha ≥ 128) plus a
  margin of 3 % of the box's longest side on every side; where the margin lies beyond the image it
  is transparent. A small subject in a wide photo so fills the input.
- Background removal off: the whole prepared image, not cropped.
- Then resized to 1024 px on the longest side, aspect kept, no padding to a square.

`prepared.png` itself is not changed (the Original view shows it).

### 7.2 Prompt

- Based on RS `server/redraw/prompt.mjs` prompt v6 (stones style only; the flat style is not
  copied). Version constant `IS_PROMPT_VERSION = 2`.
- There is no size line: the design has its natural size (7.5).
- Section 6's first rule `Square image at the highest resolution available.` becomes
  `Use the whole image at the highest resolution available, in the same shape (width to height) as
  the uploaded image.`
- The tuned "about 60 stones across" rule is unchanged until Alex decides on the IS-03b report
  (`docs/IS-03b-results.md`).
- Colour mode: palette line and ramps as v6.
- Black & white mode: section 4 and the final check sentence are replaced by Appendix A.
- The prompt is built server-side only, never logged in a file the web server serves, never sent
  to the browser.

### 7.3 Provider call

From RS `server/redraw/handler.mjs`: image edit endpoint, `OPENAI_IMAGE_MODEL`,
`OPENAI_IMAGE_QUALITY`, `size auto` (the output's shape follows the input's), `background
transparent`, `output_format png`, two attempts, safety refusal retried once, timeout 300 s not
retried, abort on cancel. The RS access code, per-IP limiter and HTTP routes are not copied (IS has
its own, section 13).

The output's pixel size (from its PNG header) is recorded in the attempt's `result_json` as
`outputPx` `{ width, height }`, for the server only. The strass service lays out square, portrait
and landscape outputs alike (checked in IS-03b).

Error mapping to buyer texts (section 12): declined → `declined`, everything else → `failed`.

### 7.4 Layout

From RS `server/redraw/jobs.mjs` `callLayoutService`: `POST http://127.0.0.1:8000/layout` with
`colorIds` = all catalogue ids and `targetPitchMm` 2.1. Timeout 180 s. Response as RS README
("Endpoints"). The design is accepted when `violations == 0`, `coverage >= 0.5` and at least 300
stones; otherwise the whole attempt is re-run once automatically and does not count (D5).

### 7.5 Size (D1, D2)

Natural size only. The design is the layout service's answer as it is: stone positions and
diameters exactly as measured (`targetPitchMm` 2.1, SS6 main stones), only moved so the stones'
footprint box starts at the origin. No scaling, no snapping, no minimum or maximum size. IS-03
measured natural longest sides of 130–168 mm on the 12 RS test layouts.

The gap check (`findOverlappingStonePairs` from StoneLayout.js and a min-gap check of 0.1 mm) runs
on the natural layout; a violation is a bug and fails the attempt.

The stone-size tier code (`applyTier` in `src/pipeline/tiers.js`: scale positions and diameters by a
tier factor, snap diameters down, stretch positions to an exact longest side) stays in
`src/pipeline/` with its tests, unused, for a possible later "more sizes" option. It only enlarges:
a longest side below the natural size is refused.

### 7.6 Black & white mapping (D3)

After 7.5, every stone colour is mapped by its catalogue fill's CIE L*: `L* < BW_THRESHOLD`
(default 55) → `jet`, otherwise → `crystal`. Pupils and outlines (dark) become Jet, the catch-light
becomes Crystal. The threshold is a setting; IS-03 checks it on the test images.

### 7.7 Result

`stones.json` (StoneLayout in mm, origin top-left), the tinted render (section 8), and
`result_json`: stone count, count per size, count per colour, natural width × height in mm
(`widthMm`, `heightMm`) and in (`widthIn`, `heightIn`), coverage, mode, and `outputPx` (server
only, 7.3). The browser gets every field except `outputPx`.

## 8. Tinted view (D4)

Definition (from the RS 30 Sep decision, sharpened here):

1. The canvas covers the design's bounding box plus a margin of 2 main-stone diameters.
2. Every pixel that is not inside a stone takes the colour of its **nearest stone**, measured to
   the stone's edge (`distance to centre − radius`), so large pupil stones claim their own gaps.
3. That colour is the stone's catalogue fill **darkened to 85 % brightness** (each sRGB channel
   × 0.85).
4. A pixel is filled only if its distance to that stone's centre is at most **1.6 × the stone's
   radius**. Beyond that (the design's outer edge and true holes) the background shows: white in
   the app, transparent in the PNG file.
5. The stones are drawn on top with the RS faceted crystal renderer
   (`CrystalStoneRenderer.drawCrystalStone`, deterministic per-stone appearance).

The result reads as a solid, painted picture, close to what the buyer expects from the photo.

Implementation: Node with `@napi-rs/canvas` (Canvas 2D compatible, so the RS renderer runs
unchanged). Nearest-stone search through a uniform grid of cell size = 2 × the largest stone
diameter. Two renders: preview (900 px long side, watermarked, sent to the browser) and full
(2400 px long side, archived and put in the ZIP).

Watermark on every preview the browser receives: tiled diagonal "IS · PREVIEW · <code>" at 18 %
opacity, plus no right-click save of the full image (best effort only; the low resolution is the
real protection).

The Original view shows `prepared.png` (what the design was made from) with a switch to the raw
upload.

## 9. Exports and ZIP

All exporters consume the final StoneLayout only (RS rule: exporters never generate geometry).

The ZIP has one size, the natural size (7.5): all six formats below, the production sheet, the
preview and README, all at that size.

| File | How |
| --- | --- |
| `IS-XXXX-XXXX.svg` | RS `stoneLayoutToSvg`, true size, `width`/`height` in mm, colour groups as `<g>` with ids |
| `IS-XXXX-XXXX-production-sheet.pdf` | RS `productionSheetToPdf`, D9 page size, multi-page tiling, mirror off, registration marks on |
| `IS-XXXX-XXXX.ai` | New `aiExport.js`: one-page true-size vector PDF of the stones (page = design + 10 mm), built with RS `PdfDocument`, saved as `.ai` (PDF-compatible; Illustrator opens it) |
| `IS-XXXX-XXXX.eps` | Ghostscript `gs -dNOPAUSE -dBATCH -sDEVICE=eps2write` from the `.ai` PDF |
| `IS-XXXX-XXXX.dxf` | RS `stoneLayoutToDxf`, one layer per colour |
| `IS-XXXX-XXXX.png` | The SVG rendered by `@resvg/resvg-js` at 300 dpi, transparent background |
| `IS-XXXX-XXXX-preview.png` | Full tinted render (section 8), no watermark |
| `README.txt` | Code, natural size (width × height in mm and in), stone count per size and per colour, file list, short how-to |

Production sheet changes (copied `ProductionSheetExporter.js`):

- title `IS design IS-XXXX-XXXX`;
- the Object line and the plate/vessel lines are removed (no products in IS);
- header keeps: production size, stone count, stone sizes with counts, gap, every colour with its
  count (RS build F rule), page / margin / mirror / registration;
- footer: `Made with IS` and the page number. No other branding.

PDF metadata: Producer and Creator `IS`. No comments or metadata in SVG/DXF/PNG naming anything
else (section 12).

The ZIP (`archiver`, deflate) is built when the code becomes paid (or at the first download if the
build was skipped), stored in `data/delivery/`, and rebuilt from the archive if the buyer
downloads again within 30 days and the file is missing.

## 10. Web app

Plain ES modules, no framework, no build step. Must feel like a standalone app: app shell with a
fixed header (IS logo, step indicator), one main panel per step, no page reloads, works on phone
widths. White background, deep blue accents (RS UI principles). IS-05 uses the frontend-design
skill for the visual direction.

Screens (one URL each, history API):

1. **Upload** `/` — drop zone + file button, accepted formats and 50 MB note, consent checkbox
   (privacy policy link), Turnstile. On success → 2.
2. **Prepare** `/c/<code>/prepare` — large preview; background removal toggle (on); crop and
   rotate tools; brightness / contrast / saturation sliders and Auto enhance; Colour / Black &
   white; "Designs left: N of 3"; button **Create design**. No size field.
3. **Working** `/c/<code>/working` — the four stage names with progress, queue position, "You can
   leave this page; your code is IS-XXXX-XXXX". Polls `GET /api/attempts/<code>/<n>` every 3 s.
4. **Result** `/c/<code>/result/<n>` — Original | Tinted side by side (stacked on phones), with a
   swipe/compare slider and zoom; the natural size W × H in mm and in, stone count, sizes and
   colours used; buttons
   **Use this design** and **Try again** (disabled at 3). Earlier designs of this code are shown
   as thumbnails to switch between.
5. **Your code** `/c/<code>/done` — big code with Copy, three numbered steps back to Etsy
   (enter the code in Personalization, check out, come back to the download page), link to the
   listing (`IS_ETSY_LISTING_URL`).
6. **Download** `/download` — code field. States: unknown code; not paid yet ("Payments usually
   appear within 10 minutes of checkout. This page checks again automatically."); ready (Download
   button, expiry date); expired; refunded.
7. Static pages: privacy, terms, contact (`/privacy`, `/terms`, `/contact`).

No view shows a mask, AI image, overlay, 3D view, model name, prompt, stage timing or raw error.

## 11. Etsy

### 11.1 Listing (manual, texts in `docs/etsy-listing.md` written in IS-06)

- Digital item, one price, Personalization **required**, instructions: "Enter your IS code, for
  example IS-7K3Q-9XPA".
- Digital file attached to the listing: `IS-how-to-download.pdf` (one page: "Go to <domain>/download
  and enter your code").
- Description: what the buyer gets, the steps, the IS address written as plain text (Etsy does not
  make it clickable), and the AI disclosure required by Etsy's Creativity Standards, in generic
  words: "Designs are created with the help of AI tools." No prices, buy buttons or contact
  collection on IS (Off-Platform Transactions policy).

### 11.2 OAuth (existing code)

- `src/etsy-oauth.js`, `token-store.js`, `etsy-api.js` stay. Scopes stay (`transactions_r` is the
  one the poller needs).
- `.env.example` gains `TOKEN_ENCRYPTION_KEY` (32 bytes base64; it is read but not listed today).
- Until the domain exists: `cloudflared tunnel --url http://127.0.0.1:3003`, register
  `https://<random>.trycloudflare.com/oauth/callback` as the Etsy callback, set
  `ETSY_REDIRECT_URI` to the same string, connect once. Refreshes need no redirect. After the domain
  exists, register `https://<domain>/oauth/callback` and reconnect once.
- `/auth/etsy` and `/oauth/callback` are reachable only from localhost or with `ADMIN_TOKEN`.

### 11.3 Poller

- Every `ETSY_POLL_SECONDS` (default 180): `GET /v3/application/shops/{shop_id}/receipts` with
  `was_paid=true`, `min_last_modified` = last run − 10 min, paginated.
- For each transaction whose `listing_id` is in `IS_ETSY_LISTING_IDS`: read the variation named
  Personalization, extract every code (section 5), store in `etsy_orders`.
- Code found and `open` → `paid`, `paid_at`, `delivery_expires_at = paid_at + 30 days`, build ZIP.
- Code not found, or no code → `etsy_orders.matched_code = NULL`, shown on the admin page.
- Quantity > 1 with several codes → each code is matched.
- Refund or cancellation on a matched receipt → `refunded`, download locked.
- The download page also triggers a poll (at most once per minute globally) when an unpaid code is
  entered.

### 11.4 Admin

`/admin` (localhost only, or `ADMIN_TOKEN` header): today's designs, queue, failures, unmatched
orders with a "match to code" action, manual unlock, poller status, disk use of `data/`.

## 12. Hiding the provider (requirement 6)

- All provider calls are server-side; the key lives only in `.env`.
- The AI image is never sent to the browser.
- API responses carry only IS fields: code, stage names, positions, results, IS error codes
  (`bad-file`, `too-large`, `declined`, `failed`, `busy`, `limit`).
- Buyer texts: declined → "This image can't be turned into a design. Please try another image.";
  failed → "Something went wrong while making your design. It didn't count — please try again."
- `x-powered-by` off; no third-party names in HTML, JS, CSS, comments, file names, ZIP contents,
  PDF/SVG metadata.
- Logs stay in `logs/` outside `public/`.
- Test (IS-08): run a fake design, grep every HTTP response body and header and every ZIP entry
  for `openai`, `gpt`, `dall`, `prompt`, the model name and the first 40 characters of the prompt;
  any match fails.

## 13. Abuse and cost

- Turnstile on upload and on Create design.
- Per IP (hashed): 6 designs per 24 h. Global: `IS_DAILY_DESIGN_CAP` (default 100) → `busy`.
- At most 3 counted designs per code (D5); new codes per IP: 5 per 24 h.
- Queue limit 10 (section 7).
- Upload limits as section 6.1; SVG sanitising; files written only under `data/`.
- Express behind the tunnel: trust `CF-Connecting-IP` only when the request comes from cloudflared
  on localhost.

## 14. Privacy and terms

- Consent checkbox on upload: "I agree to the privacy policy and confirm I have the right to use
  this image."
- Privacy page states: what is stored (uploads, generated images, designs, codes, order numbers),
  why (making and delivering the design, re-delivery, support, improving the service), that it is
  kept until the buyer asks for deletion, that images are processed by a third-party image
  processing provider (category named, provider not named on screens; name given on request),
  contact for deletion (handled manually from `data/archive/`).
- Terms: digital item, no refunds after download (Etsy digital-item rules), buyer owns rights to
  the uploaded image, no illegal or infringing images.

## 15. Hosting on the Mac

- The server binds to `127.0.0.1:3003` only. cloudflared's origin is `http://127.0.0.1:3003`
  (quick tunnel and named tunnel alike), never `localhost`, which can resolve to `::1` where
  nothing listens.
- `launchd` agents in `ops/launchd/`:
  - `com.is.strass` — `caffeinate -i services/strass/scripts/start.sh` (127.0.0.1:8000);
  - `com.is.server` — `node src/server/index.js` (binds 127.0.0.1:3003), starts after strass is healthy;
  - `com.is.tunnel` — `cloudflared tunnel run is` (named tunnel, after the domain exists; ingress
    service `http://127.0.0.1:3003`).
- `pmset` advice in the runbook: no sleep on power adapter; lid-closed operation needs external
  power.
- `GET /health` (server) checks the database, the strass service and the Etsy token age.
- Nightly at 03:30: delete expired delivery ZIPs, mark expired codes, rotate logs, copy
  `data/is.sqlite` to `data/backup/`.
- Runbook `docs/RUNBOOK.md`: start/stop, check health, reconnect Etsy, what to do when the Mac was
  off (the poller catches up with `min_last_modified`).
- Tools to install: Node 20+, `brew install ghostscript cloudflared`, Python 3.12 (already there
  for the RS layout service).

## 16. Code taken from RS (at `38cd831`)

| RS path | IS path | Change |
| --- | --- | --- |
| `services/strass-layout/` (all, incl. tests, models, scripts) | `services/strass/` | Add `/remove-background` (rembg) under the same lock; rename scripts; keep the 12 test images and golden tests |
| `server/redraw/prompt.mjs` | `src/pipeline/prompt.js` | Stones prompt only; whole-image line in section 6; B&W variant (Appendix A) |
| `server/redraw/handler.mjs` (provider call part) | `src/pipeline/provider.js` | Keep retries, safety retry, timeout, abort; drop routes, access code, limiter, fake routes |
| `server/redraw/jobs.mjs` (`callLayoutService`) | `src/pipeline/layout.js` | Keep |
| `server/redraw/fixtures/fake-layout.json`, `src/redraw/FakeRedrawProvider.js` | `src/pipeline/fake/` | For `IS_FAKE=1` |
| `src/renderer/StoneColors.js`, `CrystalColors.js`, `StoneSizes.js`, `CrystalAppearance.js`, `CrystalStoneRenderer.js` | `src/stones/` | Unchanged |
| `src/geometry/Stone.js`, `StoneLayout.js`, `BoundingBox` from `src/text/VectorPath.js` | `src/stones/` | `BoundingBox` moved into its own file |
| `src/export/SvgExporter.js`, `PdfDocument.js`, `DxfExporter.js` | `src/export/` | Unchanged (DXF dep `@tarikjabiri/dxf@2.8.9`) |
| `src/export/ProductionSheetExporter.js` | `src/export/` | Section 9 changes |
| `src/units/` | `src/units/` | Unchanged |

Not taken: 3D preview and Three.js, products, monogram, fonts and text, Design/drawing/editing,
gallery, history, autosave, legacy image pipeline (IMG-001…021), lightbox, RS UI, RS dev server.

Each copied file gets a first-line comment `// From Rhinestone-Studio @38cd831 <path>` so later RS
fixes can be ported by diff.

## 17. Builds

One Claude Code session per build. Each ends with focused tests, a commit and a short report.

**IS-01 Skeleton.** Folder layout (section 3), `CLAUDE.md` in place, SQLite schema and queries,
codes (section 5) with tests, `.env.example` complete (section 18), the existing Etsy files moved
to `src/etsy/` without behaviour change, `IS_FAKE=1` mode stub, `/health`.
*Done when:* `npm test` passes; code generation and normalisation tests cover the ambiguous
letters; the server starts and the old Etsy connect page still works.

**IS-02 Upload and preparation.** Section 6 complete: upload route, decoding of all 7 formats,
SVG sanitising, `adjust.js` shared module, Python `/remove-background`, archive writes.
*Done when:* one fixture per format decodes; a 50 MB+1 byte upload is refused while streaming; a
malicious SVG fixture is refused; `adjust.js` gives identical output for the same input in Node and
in the browser (test compares hashes); background removal works on 3 sample photos.

**IS-03 Pipeline.** Queue, prompt, provider client, layout client, tiers, B&W mapping, acceptance
checks, auto re-run, attempts accounting (D5).
*Done when:* fake mode runs end to end; real mode makes one design on the Mac; tier tests show 0
gap violations at every T for the 12 RS test layouts; the tier measurement report and the B&W
threshold check (7.6) are written to `docs/IS-03-results.md`.

**IS-03b Natural size.** No size choice (D1, D2, 6.4, 7.5); provider `size auto` and the
whole-image prompt line (7.2, 7.3); model input cropped to the cut-out (7.1); Black & white final
check (Appendix A); the "about 60 stones across" test.
*Done when:* `npm test` passes with no size in settings, results or prompt; the natural layouts of
the 12 RS test layouts pass the gap check; 9 real designs (3 test photos with and without the rule,
3 portrait or landscape subjects) are measured in `docs/IS-03b-results.md` with a recommendation on
the rule.

**IS-04 Tinted render and exports.** Section 8 and section 9.
*Done when:* tinted render matches the definition on a unit fixture (pixel at 1.5 r gets 85 % of
the nearest stone's fill, pixel at 1.7 r is background); all files open (SVG in a browser, PDF and
AI via `pdfinfo`, EPS via Ghostscript, DXF via the RS DXF test approach, PNG size equals 300 dpi
true size); ZIP contents match the table.

**IS-05 Web app.** Section 10.
*Done when:* the full flow runs in fake mode in a desktop and a 390 px-wide browser; no screen
contains the words of section 12's grep list.

**IS-06 Etsy.** Sections 11.2–11.4, listing texts, how-to PDF.
*Done when:* poller and matcher tests pass on recorded receipt JSON (codes with spaces, lower case,
O/0 swaps, two codes in one personalization, refund); OAuth connect works through a quick tunnel;
a real hidden test listing order unlocks a code.

**IS-07 Hosting.** Section 15 and the runbook.
*Done when:* after a reboot, all three agents are running and `/health` is green within 3 minutes;
the nightly job deletes an expired fixture ZIP and leaves the archive alone.

**IS-08 Hardening and launch check.** Section 12 grep test, section 13 limits, privacy/terms
pages, end-to-end real order and refund.

## 18. Settings (`.env.example`)

```
PORT=3003
PUBLIC_BASE_URL=                 # https://<domain> (or the quick tunnel URL while testing)
ADMIN_TOKEN=
IS_FAKE=                         # 1 = no provider and no layout calls
OPENAI_API_KEY=
OPENAI_IMAGE_MODEL=gpt-image-2.5-sunburst
OPENAI_IMAGE_QUALITY=high
PROVIDER_TIMEOUT_SECONDS=300
STRASS_SERVICE_URL=http://127.0.0.1:8000
REMBG_MODEL=birefnet-general
LAYOUT_TIMEOUT_SECONDS=180
BW_THRESHOLD=55
IS_DAILY_DESIGN_CAP=100
IS_DESIGNS_PER_IP_PER_DAY=6
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
ETSY_KEYSTRING=
ETSY_SHARED_SECRET=
ETSY_REDIRECT_URI=
TOKEN_ENCRYPTION_KEY=            # 32 bytes, base64
IS_ETSY_LISTING_IDS=             # comma separated
IS_ETSY_LISTING_URL=
ETSY_POLL_SECONDS=180
```

## 19. Open items

- Domain name (needed before launch; the quick tunnel is for OAuth and testing only).
- Etsy listing photos and price.
- Keep or drop the "about 60 stones across" rule (7.2), decided from `docs/IS-03b-results.md`.
- Production sheet page size now that the buyer chooses no unit (D9): A4, Letter, or both.
- The strass service sometimes picks SS20 or SS30 for pupils (outside D2); counts in
  `docs/IS-03b-results.md`. The service is not changed for it in IS-03b.

## Appendix A — Black & white section 4 and final check of the prompt

Replaces section 4 (COLOURS) of prompt v6 when the buyer chose Black & white; `{jet}` and
`{crystal}` are the catalogue preview colours.

```
4. COLOURS
Use only these two colours, with exactly these hex values, as flat fills:
Jet {jet}, Crystal {crystal}.
- Every stone is either Jet or Crystal. No greys, no other colours, no tints.
- Dark areas, outlines, pupils and shadows are Jet; light areas, highlights and the catch-light are Crystal.
- Show mid-tones only by mixing the two colours in clear patterns (rows or patches), never by inventing a grey.
- Keep the subject clearly readable from a distance: strong Jet outlines around the main shapes.
```

The final check sentence of v6 is replaced too, so it no longer mentions skin and fur ramps:

```
Before finishing, check that: every stone is a separate flat circle; no two stones touch, outline stones included; nothing is drawn in the gaps; only the three allowed sizes are used; every stone is Jet or Crystal; the background is transparent or pure magenta.
```
