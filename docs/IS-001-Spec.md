# IS-001 — IS: any image to rhinestone template, sold on Etsy

Status: spec, 18 Oct 2026. Revised 18 Oct 2026 (IS-03b): no size choice, every design is delivered
at its natural size. Revised 19 Oct 2026 (IS-04): EPS written by IS (no Ghostscript), overlap
cleanup after the SS16 cap, acceptance on the IS gap check. Revised 19 Oct 2026 (IS-05b): a face's
two pupils may stay SS20; designs whose pupils are not one plausible pair get no eye stage. Revised
19 Oct 2026 (IS-05b follow-up): of more than two pupils, the one plausible pair is kept; tinted
view: stones keep their catalogue lightness, gaps 4 L* darker (section 8). Revised 20 Oct 2026 (IS-05b,
second follow-up): stone colours read at the delivered stones (7.4); a stone's inner 60 % held to its
catalogue lightness, near-white gaps 8 L* darker (section 8); renders and ZIP builds in a worker thread;
AI images archived without metadata (4.2); the section 12 test exists. Revised 21 Oct 2026 (IS-05c): no
iris rings around a person's pupils and skin colours read from the inner 60 % of each stone (7.4); tinted
view: every stone's fill reaches 0.6 mm beyond its edge, and a large Jet stone's light rim is as wide as
an SS6 stone's (section 8). Revised 21 Oct 2026 (IS-05d): a shadow skin stone takes Colorado Topaz
when that is at most 3 ΔE further than Smoked Topaz (7.4). Revised 21 Oct 2026 (IS-06): Result screen
without the compare slider, tabs at phone width (10); Etsy connect, poller, refunds and admin page
as built (11.2–11.4). Revised 24 Oct 2026 (exp-holes): hole fill after the overlap cleanup (7.5);
black & white read from the AI image (7.6). Revised 24 Oct 2026 (exp-holes, dark spots): filled
stones take their neighbours' colour (7.5, 7.6). Revised 24 Oct 2026 (exp-holes, B&W render): the
tinted view's gap rule for black & white designs is a setting (section 8, `BW_GAP`); a disc reading
behind `IS_BW_FROM_DISCS=1` (7.6, removed in exp-faces). Revised 24 Oct 2026 (exp-bw-stencil): a stencil variant
of the black & white prompt behind `BW_STYLE=stencil` (7.2; halftone stays the default). Revised 24
Oct 2026 (exp-bw-stencil, eyes): the stencil variant has an eye rule (7.2, version 5). Revised 24 Oct
2026 (exp-faces, leftovers): `BW_GAP` `crystal` is the default for black & white designs (section 8);
the disc reading `IS_BW_FROM_DISCS` is removed (7.6; the service keeps `report.discsAtMm`); the leak
check skips random tokens (section 12). Revised 26 Oct 2026 (IS-07a): the strass service finds faces
with MediaPipe Face Landmarker instead of dlib; the dlib model is test-only and never used in
production (7.4, 16). Revised 26 Oct 2026 (IS-07b): the buyer picks the Black & white style, Bold
(stencil, the default) or Shaded (halftone), stored in the attempt's settings; the `BW_STYLE` setting is
gone (6.4, 7.2, 7.7, 10, 18); the expectations line on Prepare and Result and in the listing (10, 11.1).

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
| D2 | **SS6** is the main stone size, with occasional **SS4**, **SS10** and **SS16** allowed; nothing larger than SS16, except the two pupils of a face, which may be **SS20** (IS-05b): the layout service's SS30 pupils become SS20, every other stone above SS16 becomes SS16 (section 7.5). No tier multiples in the UI, the result data or the ZIP. |
| D3 | Black & white means **Jet + Crystal only**. |
| D4 | The buyer sees only two views: **Original** and **Tinted** (section 8). No mask, AI image, overlay or 3D view. |
| D5 | At most 3 designs per code. A design that fails for technical reasons, or is declined by the safety check, does not count. |
| D6 | The buyer picks the delivered design ("Use this design"). If a paid code has no pick, the latest design is delivered. |
| D7 | Uploads, prepared images, AI images, layouts and code records are kept **indefinitely** in `data/archive/`, managed by Alex by hand. Delivery ZIPs are kept **30 days** after payment, then deleted. |
| D8 | One Etsy listing, one price. |
| D9 | Production sheet as the RS exporter, multi-page tiling for large designs. With no unit choice the ZIP carries **both** an A4 sheet (mm) and a Letter sheet (inches) (IS-03b decision). |
| D10 | CDR is dropped. AI is a PDF-compatible file; EPS is written by IS directly from the stones (no Ghostscript). |
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
  stage TEXT, settings_json,      -- mode, B&W style, bg removal, adjustments, crop, rotate
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
  attempt-<n>/ai.png                         provider output, without metadata (only the chunks of its
                                             pixels: IHDR, PLTE, tRNS, IDAT, IEND; section 12)
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
- The settings are only: Colour / Black & white (Colour default), for Black & white its style,
  background removal (6.2) and the adjustments (6.3).
- Black & white style (IS-07b), `bwStyle` in the attempt's settings: **Bold** (`stencil`, the
  default) or **Shaded** (`halftone`), the two prompt variants of 7.2. Any other value is refused
  (`bad-request`); for Colour the style is not stored. It is stored with the attempt, so "Try again"
  starts from it and can switch it, and the automatic re-run (7.4) keeps it. Attempts made before
  IS-07b have no style; they were made with the then `BW_STYLE` setting.

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
  copied). Version constant `IS_PROMPT_VERSION = 3`.
- There is no size line: the design has its natural size (7.5).
- Section 6's first rule `Square image at the highest resolution available.` becomes
  `Use the whole image at the highest resolution available, in the same shape (width to height) as
  the uploaded image.`
- Rule 1's sentence `Make the stones large: about 60 stones across the full width of the image.` is
  removed (IS-03b decision, from `docs/IS-03b-results.md`: with non-square images it does not set the
  stone size). Every other stone rule of v6 is kept.
- Colour mode: palette line and ramps as v6.
- Black & white mode: section 4 and the final check sentence are replaced by Appendix A.
- Black & white style (exp-bw-stencil; the buyer's choice since IS-07b, 6.4): the attempt's
  `bwStyle` picks the black & white variant: `stencil` (Bold, the default) replaces section 4 and
  the final check with solid Jet and Crystal areas and no mixing of the two, and an eye rule (eyes
  never part of a dark area, kept apart from dark shadows and eyebrows by Crystal) (text in
  `src/pipeline/prompt.js` only), prompt version `IS_STENCIL_PROMPT_VERSION = 5`; `halftone`
  (Shaded) is Appendix A. The browser sees only the style's id and its name (Bold, Shaded), never
  the prompt or the request (section 12).
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
("Endpoints"). Acceptance is decided on the design after the SS16 cap and the overlap cleanup
(7.5), not on the service's own `violations`: the design is accepted when the cleanup removed fewer
than 3 % of the stones, the coverage after the cleanup is at least 0.5, the IS gap check finds 0
violations and at least 300 stones are left; otherwise the whole attempt is re-run once
automatically and does not count (D5).

Stone colours (IS's strass copy, rule `sample_delivered`, on in `DEFAULT`, IS-05b): the service reads
each stone's colour from the AI image at the stone's delivered position, from the inner 60 % of its
radius, after its ordered layout has moved it, instead of at the detection it came from; the stones it
adds to fill holes read their own pixels too. RS 38cd831 reads them at the detections and gives fill stones the nearest
detection's or their neighbours' colour (`services/strass/ORIGIN.md`, `docs/IS-05b-results.md`).

Eyes and skin (IS's strass copy, IS-05c, `docs/IS-05c-results.md`): `DEFAULT` has `human_iris` off, so a
person's pupil gets no rings of SS4 iris stones (they took the AI's eye white and turned Grey and Silver,
so the eyes looked like goggles); animals keep theirs. The new rule `skin_nearest_inner` (on in `DEFAULT`)
makes the skin step `skin_nearest` read each stone's colour from the inner 60 % of its radius, as the
colours above are read, instead of its whole disc, which reached into the AI's dark gaps and turned warm
shadow skin into Smoked Topaz. RS 38cd831 has `human_iris` on and reads the whole disc.

Shadow skin (IS's strass copy, IS-05d, `docs/IS-05d-results.md`): with the rule `warm_shadow` (on in
`DEFAULT`, `warm_shadow_de` 3), a skin stone whose nearest skin colour is Smoked Topaz takes Colorado
Topaz when Colorado Topaz is at most 3 ΔE2000 further from its sampled colour. Only those near ties
change; stones, sizes, faces and pupils do not. RS 38cd831 has no such rule.

Faces (IS's strass copy, IS-07a, `docs/is-07a-landmarks.md`): the service finds a face (a person,
as opposed to an animal or no face) and the eye boxes its pupils are looked for in with MediaPipe
Face Landmarker (library and model Apache 2.0, `services/strass/models/mediapipe/`), installed
into the service's own environment (`mediapipe==0.10.15`, `pip --no-deps`). RS 38cd831 uses dlib's
68-point model, which was trained on iBUG 300-W, whose licence excludes commercial use: **the dlib
model must never be shipped or used in production.** It stays only as a test-only dependency of the
equivalence test against the RS prototype, skipped when the model is absent, and `setup_mac.sh`
downloads it only with `--with-dlib-tests`.

### 7.5 Size (D1, D2)

Natural size only. The design is the layout service's answer as it is: stone positions and
diameters as measured (`targetPitchMm` 2.1, SS6 main stones), only moved so the stones' footprint
box starts at the origin. No scaling, no minimum or maximum size. IS-03 measured natural longest
sides of 130–168 mm on the 12 RS test layouts.

Size cap (D2): after the layout, every stone larger than SS16 is snapped down to SS16 at the same
centre, except the pupil stones of a face: when the service's report has `face` set (not null) and
exactly two pupils in `pupilsAtMm` (IS-05b; the pupil stones' centres), the stones at those two
centres are only capped at SS20 (an SS30 pupil becomes SS20, an SS20 pupil stays). The service
sets `face` to null, and places no eye stones, when its pupils are not one plausible pair (two of
very different sizes, far from level or too far apart for the subject; of more than two, none or
several plausible pairs: the IS-03b car's wheels gave 19 "pupils" and 31 plausible pairs). Of more
than two pupils with exactly one plausible pair, that pair is kept and the others are laid out as
ordinary stones (the IS-03b giraffe: its two eyes kept, the false pupils on an ossicone and the
neck dropped). A layout without `pupilsAtMm` gets the SS16 cap for every
stone. The footprint box is that of the capped stones. Shrinking a stone only widens its gaps, so
the cap never creates an overlap. The number of capped stones goes to the design's event log
(server only). Why SS20: capped to SS16, a pupil sits small inside the gap the service left for
it, and the tinted view paints a black ring around it (`docs/IS-05b-results.md`).

Overlap cleanup (`src/pipeline/cleanup.js`), after the cap: for every pair of stones whose rim gap
(centre distance minus both radii) is below 0.1 mm, the smaller stone is removed; on equal size the
one with fewer neighbours (other stones with a rim gap below 0.5 mm, counted once on the capped
stones), and on equal neighbours the later one in the layout. Pairs are taken worst gap first; a
pair with a stone already removed is skipped. The footprint box is that of the stones left. The
number of removed stones goes to the design's event log (server only).

Hole fill (`src/pipeline/holes.js`, exp-holes, `docs/exp-holes.md`), after the cleanup; on unless
`IS_FILL_HOLES=0`. A hole is a spot inside the subject where an SS6 stone, or failing that an SS4
stone, fits with at least 0.1 mm to every stone. The subject is the AI image's alpha (alpha ≥ 128)
closed with a disc of 1 mm across, and every enclosed transparent area of at most two SS6 stones'
area (6.3 mm²) filled. The holes are filled greedily, the free spot farthest from everything first,
SS6 while one fits, then SS4; the whole stone lies inside the subject (measured at 20 px per mm)
and its rim gap to every stone is at least 0.1 mm (exact). A filled stone sits between stones,
where the AI painted its gaps, so it does not read its own pixels: it takes its neighbours' colour.
Among the stones within 1 mm of its edge, each weighs 1 − gap / 1 mm (nearer stones count more), and
the colour with the largest total weight wins; on a tie the nearest stone's colour. Filled stones
next to filled stones are decided in rounds, each round voting with the colours decided before it;
a filled stone with no decided stone within 1 mm takes the nearest decided stone's colour. (Before,
filled stones read the AI image's pixels and showed the dark gap paint as lone dark stones,
`docs/exp-holes.md` section 9.) The number of filled stones goes to the design's event log (server
only). Holes come mostly from the
service's fill after the eye stage (it keeps 0.15 mm from every stone), the eye stage and the
ordered layout's filters; on the 21 CC0 and RS test designs the fill took 235 holes to none, all 21
stay accepted and their natural size is unchanged. The strass copy's rules `fill_exact` and
`fill_cover_mask` (the same holes fixed in the service's fill) stay off everywhere.

Service fill stones (`IS_SERVICE_FILL_NEIGHBOURS=1`, off by default): the stones the service's own
fills placed (its report's `fillAtMm`, IS's strass copy) take their neighbours' colour by the same
vote, in one vote with the filled stones. The service colours them from their own pixels
(`sample_delivered`), which can be the AI's gap paint too.

Coverage after the cleanup: the service's `coverage` (the share of subject-mask pixels under a
stone) times the area under the delivered stones (filled stones included) over the area under the
service's stones, both rasterised at the service's 10 px per mm. It includes the cap's shrinking.

The IS gap check (`findOverlappingStonePairs` from StoneLayout.js and a min-gap check of 0.1 mm)
then runs on the cleaned layout, and acceptance (7.4) uses its result. The rejected IS-03b car (148
service violations, 145 after the cap) loses 79 SS4 stones of 3716 (2.1 %), its coverage goes from
0.633 to 0.624, and it is accepted. (Those numbers are the RS 38cd831 rules; with IS-05b's
plausible-pupil rule the car gets no eye stage and the cleanup removes nothing from it.) The cleanup removes nothing from the 12 RS test layouts and the
8 accepted IS-03b designs.

The stone-size tier code (`applyTier` in `src/pipeline/tiers.js`: scale positions and diameters by a
tier factor, snap diameters down, stretch positions to an exact longest side) stays in
`src/pipeline/` with its tests, unused, for a possible later "more sizes" option. It only enlarges:
a longest side below the natural size is refused.

### 7.6 Black & white mapping (D3)

After 7.5, every delivered stone is read from the AI image itself, not from the service's colour:
the mean CIE L\* of the image's pixels composited on white within the inner 60 % of the stone's
radius (at least 2 px), at the stone's delivered position. `L* < BW_THRESHOLD` (a setting, default
55) → `jet`, otherwise → Crystal (`crystal-clear`). The stones whose colour 7.5 takes from their
neighbours (the filled stones; with `IS_SERVICE_FILL_NEIGHBOURS=1` the service's fill stones too)
are not read: they take Jet or Crystal from their neighbours by the vote of 7.5, the neighbours
read as above. Positions and sizes are unchanged. `mapBlackAndWhiteFromImage` in
`src/pipeline/bw.js`. Before exp-holes each stone's catalogue colour was mapped by its fill's L\*;
that put the service's colour snapping (skin and chroma rules, the eye stage's colours) between the
AI's Jet/Crystal drawing and the result (`docs/exp-holes.md`, section 6, also on the choice of the
threshold).

The service's report keeps `discsAtMm` (`[x, y, d]` in the stones' mm: every stone the service
detected in the AI image except the tiny ones, shadows, painted gap dots and interstitial dots), for
experiments; the disc reading tried in exp-holes (`IS_BW_FROM_DISCS`, `docs/exp-holes.md` section 10)
was removed in exp-faces.

### 7.7 Result

`stones.json` (StoneLayout in mm, origin top-left), the tinted render (section 8), and
`result_json`: stone count, count per size, count per colour, natural width × height in mm
(`widthMm`, `heightMm`) and in (`widthIn`, `heightIn`), coverage, mode, for Black & white `bwStyle`
(6.4), and `outputPx` (server only, 7.3). The browser gets every field except `outputPx`.

## 8. Tinted view (D4)

Definition (from the RS 30 Sep decision, sharpened here):

1. The canvas covers the design's bounding box plus a margin of 2 main-stone diameters.
2. Every pixel that is not inside a stone takes the colour of its **nearest stone**, measured to
   the stone's edge (`distance to centre − radius`), so large pupil stones claim their own gaps.
3. That colour is the stone's catalogue fill **darkened by 4 L\*, plus 0.05 L\* per L\* above 80,
   and by at least 8 L\* when the fill's L\* is above 85** (CIE L\*: a fill of L\* 70 is darkened by 4,
   silver (L\* 88) and crystal (L\* 96) by 8). The fill's linear RGB is scaled so the gap has that
   L\* (its hue is kept), rounded to 8 bits so the step is never less than the rule's. Every gap is
   thus at least 4 L\* darker than its stone, the darkest (jet, L\* 6) included, and at least 8 on
   near-white fills, whose 4–5 L\* gaps were hard to see.
4. A pixel is filled only if its distance to that stone's edge is at most **0.6 mm**, 0.6 × an
   SS6 stone's radius, the same for every size (IS-05c; before, 1.6 × the stone's own radius, which
   is the same for an SS6 stone but let an SS20 pupil claim a 1.4 mm ring of its dark gap colour, a
   wide black octagon around the eye). Beyond that (the design's outer edge and true holes) the
   background shows: white in the app, transparent in the PNG file.
   Black & white designs (exp-holes, `docs/exp-holes.md` section 10) fill those pixels by the
   setting `BW_GAP`: `crystal` (the default since exp-faces): as `nearest`, but where the
   second-nearest stone's edge is within 0.6 mm too and its colour differs, the gap colour of the
   lighter of the two, so a Jet stone among Crystal stones gets Crystal's light gap and the dark
   gap shows only between Jet stones (a Jet stone with no other stone within reach keeps its own);
   `nearest`: steps 2–3; `white` and `black`: the fabric, `#ffffff` and `#111111`. The colour
   designs keep steps 2–3. The
   AI draws mid-tones in B&W as Jet and Crystal stones side by side; with `nearest` each Jet stone
   among Crystal sits in a black octagon of its own gap colour and reads larger than it is.
5. The stones are drawn on top with the RS faceted crystal renderer
   (`CrystalStoneRenderer.drawCrystalStone`, deterministic per-stone appearance; the RS file is
   unchanged). The RS renderer strokes each stone's edge 0.09 radii wide in its catalogue stroke
   colour, which for Jet is light grey, so a large Jet stone (a pupil) had a light ring 2.35 times
   as wide as an SS6 one. A stone above SS6 whose stroke is lighter than its fill (only Jet) has its
   edge redrawn by IS at an SS6 stone's width: the RS edge band is painted over, inside the stone
   with its edge colour and outside with its gap colour (the fabric with `BW_GAP` `white` or
   `black`), and the edge stroked again (IS-05c).
6. Each drawn stone's lightness is brought to its catalogue fill's L\*, over the pixels whose
   centre lies inside its disc, in two zones. First the **inner 60 %** of the radius, where the
   renderer puts its highlight: its mean L\* is brought to within **4** of the fill's. Then the
   **whole stone**: its mean L\* is brought to within **2**, by changing the whole stone evenly when
   that keeps the inner zone within 4, else only outside the inner zone. A zone drawn too light (the
   central highlight of mid-dark and dark stones, and jet's light rim) has its linear RGB scaled
   down; one drawn too dark (crystal, silver) is screened towards white. The change fades out over a
   ring of 0.2 radii outside the inner zone, so no edge shows. The facets, highlights and sparkle
   keep their relative contrast; a stone already within both is left as drawn. Every stone is so
   within 3 L\* of its fill as a whole and within 5 in its inner 60 % (8-bit rounding included).

The result reads as a solid, painted picture, close to what the buyer expects from the photo.

Why these values (IS-05b, `docs/IS-05b-results.md`): before, the renderer lifted every colour below
L\* 45 by 10–16 L\* and the 85 % tint took 8–19 L\* off every colour above L\* 60, so dark hair turned
grey-brown and light skin mid-brown. The gap rule was tuned on the 21 test designs against the AI
images (mean ΔE2000 of 2 mm cells, the AI cell being the mean colour of its stones): the less the
gaps are darkened the closer the picture, so the rule is the visibility limit of 4 L\*; a step
growing with lightness was no better (4 + 0.05 per L\* above 80 is the best of the grid by 0.01),
lightening the gaps of very dark stones was worse, and a reach of 1.7 or 1.8 radii gained less than
0.1, so the reach stayed 1.6 (IS-05c then fixed it at an SS6 stone's 0.6 mm for every size). Mean cell ΔE over the 21 designs: 10.8 before (RS layouts, 85 % tint,
stones as drawn), 8.7 after. The second follow-up (20 Oct 2026) held the inner 60 % of each stone to
its catalogue lightness too (before, the highlight left mid-dark stones' centres 10–13 L\* light,
while the whole stone averaged right) and set 8 L\* for near-white gaps at Alex's request
(`docs/IS-05b-results.md` section 7).

Implementation: Node with `@napi-rs/canvas` (Canvas 2D compatible, so the RS renderer runs
unchanged), `src/render/tinted.js` (`GAP_RULE`, `STONE_LIGHTNESS`, `BW_GAPS`). `BW_GAP` applies when a
render is made: the full render when the design is made, the preview when the browser asks for it. The renders run in a worker
thread (`src/render/offthread.js`, `worker_threads`), so the server keeps answering polls and pages
while one runs. Nearest-stone search: a pixel can only be filled when its
nearest stone's edge is at most 0.6 mm (`FILL_MARGIN_MM`) away, so each stone writes its edge
distance into the pixels within that margin and the smallest wins; this is exact for every pixel
that can be filled. The rim of step 5 is `drawStone` in the same file. "Main stone" is the most common stone size. Two renders: preview (900 px long
side, white background, watermarked, sent to the browser) and full (2400 px long side, transparent,
written to `attempt-<n>/tinted.png` in the "Preparing files" stage and put in the ZIP).

Watermark on every preview the browser receives: tiled diagonal "IS · PREVIEW · <code>" at 18 %
opacity, plus no right-click save of the full image (best effort only; the low resolution is the
real protection).

The Original view shows `prepared.png` (what the design was made from) with a switch to the raw
upload.

## 9. Exports and ZIP

All exporters consume the final StoneLayout only (RS rule: exporters never generate geometry).

The ZIP has one size, the natural size (7.5): all six formats below, both production sheets (D9),
the preview and README, all at that size.

| File | How |
| --- | --- |
| `IS-XXXX-XXXX.svg` | RS `stoneLayoutToSvg` in its grouped form, true size, `width`/`height` in mm, one `<g>` per colour and size with an id such as `jet-ss6` (the empty regions group left out) |
| `production-sheet-A4.pdf` | RS `productionSheetToPdf`, A4, mm, multi-page tiling, mirror off, registration marks on |
| `production-sheet-Letter.pdf` | The same on Letter, inches (D9) |
| `IS-XXXX-XXXX.ai` | New `aiExport.js`: one-page true-size vector PDF of the stones (page = design + 10 mm, 5 mm on every side), built with RS `PdfDocument`, saved as `.ai` (PDF-compatible; Illustrator opens it) |
| `IS-XXXX-XXXX.eps` | New `epsExport.js`: EPSF-3.0 written directly from the StoneLayout; `%%BoundingBox` and `%%HiResBoundingBox` in points at true size (the design, no margin), `%%Creator: IS`, `%%Title` the design, no other tool named; one filled circle per stone in its catalogue fill colour, grouped by colour, y flipped (origin bottom-left) |
| `IS-XXXX-XXXX.dxf` | RS `stoneLayoutToDxf`, one layer per colour; header `$LASTSAVEDBY` set to `IS` |
| `IS-XXXX-XXXX.png` | The SVG rendered by `@resvg/resvg-js` at 300 dpi (size = mm / 25.4 × 300, rounded), transparent background (the SVG's white rectangle left out), a `pHYs` chunk of 300 dpi and no other metadata |
| `IS-XXXX-XXXX-preview.png` | Full tinted render (section 8), no watermark |
| `README.txt` | Code, natural size (width × height in mm and in), stone count per size and per colour, file list, short how-to |

Production sheet changes (copied `ProductionSheetExporter.js`):

- title `IS design IS-XXXX-XXXX`;
- the Object line and the plate/vessel lines are removed (no products in IS);
- header keeps: production size, stone count, stone sizes with counts, gap, every colour with its
  count (RS build F rule), page / margin / mirror / registration;
- the gap is the minimum gap of the gap check, `0.1 mm`, printed in mm on both sheets (in inches it
  would round to 0);
- footer: `Made with IS · Page i of N` on every page, inside the bottom margin. No other branding.

Both sheets: margin 10 mm, mirror off, registration marks on; A4 with sizes in mm, Letter in inches.

PDF metadata: Producer and Creator `IS`, Title `IS design IS-XXXX-XXXX`, added to the
`PdfDocument` output as an incremental update (`src/export/pdfInfo.js`), so `PdfDocument.js` stays
unchanged. No comments or metadata in SVG/DXF/PNG naming anything else (section 12).

The ZIP (`archiver`, deflate; `buildDeliveryZip` in `src/export/zip.js`, from `attempt-<n>/stones.json`
and `tinted.png`, never writing to the archive; in the render worker of section 8) is built when the code becomes paid (or at the first download if the
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
   white; with Black & white, the two styles (6.4) as two choices, each with a small example
   picture and one line: **Bold** "Solid black and clear areas: strong and graphic." and **Shaded**
   "Black and clear stones mixed to show light and shade." (Bold chosen unless the previous
   settings say Shaded); "Designs left: N of 3"; button **Create design**. No size field. Under the
   photo, the expectations line (below). The example pictures (`public/examples/bw-bold.png`,
   `bw-shaded.png`) are made by `tools/make-bw-examples.mjs` from the CC0 cat fixture without a
   provider call: the same stones coloured as each style draws, shown with the tinted renderer.
3. **Working** `/c/<code>/working` — the four stage names with progress, queue position, "You can
   leave this page; your code is IS-XXXX-XXXX". Polls `GET /api/attempts/<code>/<n>` every 3 s.
4. **Result** `/c/<code>/result/<n>` — Original | Tinted side by side on wide screens; at phone
   width (640 px and less) two tabs, **Original | Tinted**, one view at a time, Tinted shown first
   (IS-06: the compare slider is gone). Zoom on both views, which scroll together; the Original view
   switches between the prepared image and the upload. The natural size W × H in mm and in, stone
   count, sizes and colours used; buttons
   **Use this design** and **Try again** (disabled at 3), the expectations line next to them. The
   subtitle names the mode, for Black & white with its style ("Black & white, Bold"). Earlier
   designs of this code are shown as thumbnails to switch between.
5. **Your code** `/c/<code>/done` — big code with Copy, three numbered steps back to Etsy
   (enter the code in Personalization, check out, come back to the download page), link to the
   listing (`IS_ETSY_LISTING_URL`).
6. **Download** `/download` — code field. States: unknown code; not paid yet ("Payments usually
   appear within 10 minutes of checkout. This page checks again automatically."); ready (Download
   button, expiry date); expired; refunded.
7. Static pages: privacy, terms, contact (`/privacy`, `/terms`, `/contact`).

Expectations line (IS-07b), on Prepare and Result: "Your design is an artistic rhinestone version of
your photo; faces are stylised, not photographic. You can try up to 3 designs and only buy if you like
one."

No view shows a mask, AI image, overlay, 3D view, model name, prompt, stage timing or raw error.

## 11. Etsy

### 11.1 Listing (manual, texts in `docs/etsy-listing.md` written in IS-06)

- Digital item, one price, Personalization **required**, instructions: "Enter your IS code, for
  example IS-7K3Q-9XPA".
- Digital file attached to the listing: `IS-how-to-download.pdf` (one page: "Go to <domain>/download
  and enter your code").
- Description: what the buyer gets, the steps, the IS address written as plain text (Etsy does not
  make it clickable), and the AI disclosure required by Etsy's Creativity Standards, in generic
  words: "Designs are created with the help of AI tools." A "What to expect" paragraph (IS-07b): the
  design is an artistic rhinestone version of the photo, faces are stylised rather than
  photographic, the buyer can try up to 3 designs and only buys if they like one; and "Black & white
  comes in two styles: Bold and Shaded." No prices, buy buttons or contact
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
  "Localhost" means a request made on the Mac itself: loopback peer, no `CF-Connecting-IP` header
  (cloudflared adds it to everything through the tunnel) and a loopback `Host`. `ADMIN_TOKEN` is
  sent in the `x-admin-token` header. Anyone else gets the plain 404 of an unknown path.
- `/oauth/callback` is where Etsy sends the browser back, through the tunnel, so it cannot carry the
  header. It is also accepted with the `state` of an authorization an admin started at `/auth/etsy`
  in the last 10 minutes (random, used once, bound to the PKCE verifier only the server holds)
  (IS-06). After the token exchange it saves the shop (`data/etsy-shop.json`) for the poller.
- The Etsy read routes kept from before IS (`/etsy/status`, `/etsy/listings`,
  `/etsy/listings/<id>/personalization`) are admin-only too. The receipt routes (`/etsy/orders`,
  superseded by the poller and the admin page) and the route that wrote a hard-coded test listing's
  personalization were removed (IS-06).
- Tokens stay in `data/etsy-tokens.enc` (AES-256-GCM with `TOKEN_ENCRYPTION_KEY`). Moving the
  connection to another Mac = copying that file with the same key (`docs/IS-06-connect-shop.md`).

### 11.3 Poller

- Every `ETSY_POLL_SECONDS` (default 180), and once at start-up: `GET
  /v3/application/shops/{shop_id}/receipts` with `was_paid=true`, `min_last_modified` = last run −
  10 min, paginated (100 per page). "Last run" is the start of the last good run, kept in
  `data/etsy-poller.json` with its time and counts (no buyer data), so a restart or a Mac that was
  off catches up. With no good run yet it reads the last 30 days.
- For each transaction whose `listing_id` is in `IS_ETSY_LISTING_IDS`: read the variation named
  Personalization (Etsy property 54), extract every code (section 5), store in `etsy_orders`. Other
  listings' transactions are not stored at all; with `IS_ETSY_LISTING_IDS` empty nothing is stored.
- Code found and `open` → `paid`, `paid_at` (the transaction's Etsy paid time),
  `delivery_expires_at = paid_at + 30 days`, `receipt_id`, `transaction_id`, build ZIP (render
  worker, section 9). A code that is already paid, refunded or expired is not changed.
- Code not found, or no code → `etsy_orders.matched_code = NULL`, shown on the admin page. Once a
  transaction is matched (also by hand), its NULL row is removed and later polls keep the match.
- Quantity > 1 with several codes → each code is matched.
- Refund or cancellation on a matched receipt (receipt status Canceled, Fully Refunded or Partially
  Refunded, or any entry in its `refunds`) → `refunded`, download locked; `etsy_orders.status`
  becomes `refunded`. This happens when the order turns refunded, not on every later poll, so a
  manual unlock after a refund stands. The delivery ZIP stays until the nightly job.
- The download page also triggers a poll (at most once per minute globally) when an unpaid code is
  entered.
- Poll errors are kept (short, one line) for the admin page and logged once per new error.

### 11.4 Admin

`/admin` (localhost only, or `ADMIN_TOKEN` header): today's designs, queue, failures, unmatched
orders with a "match to code" action, manual unlock, poller status, disk use of `data/`.

As built (IS-06): server-made HTML and forms, no script; the Etsy connection (shop, token age) with
a **Connect Etsy** button (`/auth/etsy`); the poller (listings, last run and its counts, last error)
with **Poll now**; matched orders. Designs show IS fields only (status, IS error code, mode, stones),
never event details (section 12). Every form carries a token made at start-up, so another web page
open on the Mac cannot post to it. Manual unlock makes the code `paid` and downloadable for 30 days
from now (also after a refund) and builds its ZIP. "Match to code" gives an unmatched order a code,
which then becomes paid (or refunded, if the order was).

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
- Test `tools/test-no-provider-leak.mjs` (part of `npm test`; word list `tools/leak-words.mjs`):
  run a fake design, check every HTTP response body and header, every file the server sends (pages,
  scripts, images, the ZIP) and every ZIP entry for `openai`, `gpt`, `dall`, `prompt`, the model
  name and the first 40 characters of the prompt, image and document metadata included (PNG text,
  XMP, EXIF, ICC and C2PA chunks, JPEG APP segments, PDF info and streams, SVG and DXF comments);
  any match, or any metadata chunk in a file the buyer gets, fails. A scripted provider whose image
  carries such metadata and whose errors name it must leave no trace either. The generic words
  (`openai`, `gpt`, `dall`, `prompt`) are not matched inside random tokens, which can spell them by
  chance (exp-faces): IS codes, the Turnstile widget's ids (`cf-chl-widget-` and five random
  characters), and runs of letters, digits, `-` and `_` of at least 12 characters that switch
  between lower case, upper case and digits at least 3 times (nonces, ETags, ids); the model name
  and the prompt text are matched everywhere.
- The AI image is archived without metadata (4.2): provider outputs carry C2PA chunks that name
  the provider.

## 13. Abuse and cost

- Turnstile on upload and on Create design. `tools/test-turnstile.mjs` checks the wiring with
  Cloudflare's test keys (always-pass and always-fail secrets, always-pass and always-block site
  keys) against the real Turnstile service; the real keys stay empty until launch (IS-06).
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
- Tools to install: Node 20+, `brew install cloudflared`, Python 3.12 (already there for the RS
  layout service). No PDF or PostScript tools are needed: IS writes the EPS itself, and the tests
  open the PDFs with pdf.js (`pdfjs-dist`, a dev dependency).

## 16. Code taken from RS (at `38cd831`)

| RS path | IS path | Change |
| --- | --- | --- |
| `services/strass-layout/` (all, incl. tests, models, scripts) | `services/strass/` | Add `/remove-background` (rembg) under the same lock; rename scripts; keep the 12 test images and golden tests; face landmarks from MediaPipe instead of dlib, dlib model test-only, never in production (IS-07a, 7.4) |
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
the nearest stone's fill, since IS-05b its gap colour; pixel at 1.7 r is background; since IS-05c
0.5 mm and 0.7 mm beyond the edge); all files open (SVG in a browser, PDF and
AI via pdf.js with page count and page size, EPS by a structure check with its bounding box equal to
the design size and one circle per stone, DXF via the RS DXF test approach, PNG size equals 300 dpi
true size); ZIP contents match the table; the overlap cleanup (7.5) is measured on the rejected
car, the 8 accepted IS-03b designs and the 12 RS test layouts; one ZIP is built end to end from an
archive.

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
IS_FILL_HOLES=1                  # 0 = no hole fill (7.5)
IS_SERVICE_FILL_NEIGHBOURS=0     # 1 = the service's fill stones take their neighbours' colour (7.5)
BW_GAP=crystal                   # B&W tinted gaps: crystal, nearest, white or black (8)
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
