# IS-05 results

Build IS-05 (web app, spec section 10), 19 Oct 2026, on the production Mac. Fake mode only: no
provider call and no strass call.

## How this was checked

- `tools/test-webapp-browser.mjs` (part of `npm test`) runs the whole flow in an isolated headless
  Chrome (throw-away profile, started and stopped by the test) at **1280 px** and at **390 px**
  (phone emulation): upload, prepare (brightness, crop), working, result, compare view, try again
  (settings restored, Black & white), second result with thumbnails, use this design, code screen,
  download in every state (not paid, ready plus the ZIP itself, expired, refunded, unknown code),
  privacy, terms, contact, and `/c/<code>` resuming the session. Both widths pass, with no page
  wider than the screen.
- `tools/shoot-is05.mjs` runs the same flow (`tools/webapp-flow.mjs`) and took the screenshots below.
- The server is `tools/fake-server.mjs`: the app with `IS_FAKE=1` on a temporary data folder, so
  nothing under `data/` is read or written. For the Working screen to be visible, each fake
  pipeline stage is held a moment (`--stage-ms`); the design is always the fixture layout (the RS
  cat), whatever image is uploaded.

## Section 12 words

Checked words: `openai`, `gpt`, `dall`, `prompt`, the model name and the first 40 characters of
both prompt variants (taken from the code by `tools/leak-words.mjs`; the words themselves are not
written to `docs/`). Case-insensitive.

| Where | Checked | Found |
| --- | --- | --- |
| Every HTTP response of the browser flow, headers and text bodies (HTML, JS, CSS, JSON, SVG) | 63 responses per width | 0 |
| Page source (`outerHTML`) and visible text of every screen | 17 screens per width | 0 |
| Every file in `public/` (names and contents) | `tools/test-webapp.mjs` | 0 |
| Every API route of the app, headers and text bodies | `tools/test-webapp.mjs` | 0 |

Image bodies (PNG) are checked by their headers only: their compressed bytes contain random
three-letter matches. The ZIP's text files are covered by IS-04's export tests; the full grep over
ZIP entries is IS-08.

## Test-only payment switch (until IS-06)

`POST /api/test/payment/<code>` with `{ "state": "paid" | "refunded" | "expired" | "open" }`
(`src/server/webapp.js`). `paid` sets `paid_at`, `delivery_expires_at` = paid + 30 days and builds
the delivery ZIP. It is guarded twice:

1. The route is only registered when the server starts with `IS_FAKE=1`. Without it the path does
   not exist (404, tested with a real code that stays `open`).
2. Even in fake mode it answers only a request made on the Mac itself: the peer must be loopback
   and there must be no `CF-Connecting-IP` header, so nothing coming through the Cloudflare Tunnel
   can reach it (404, tested).

## Screens

Desktop at 1280 px (left), phone at 390 px (right). Full-page screenshots.

### 1 Upload

`/` — drop zone and file button, formats and 50 MB note, consent checkbox with the privacy link. (Turnstile shows only when `TURNSTILE_SITE_KEY` is set; it is not set in fake mode.)

| 1280 px | 390 px |
| --- | --- |
| ![1 Upload, desktop](IS-05-results/desktop-upload.jpg) | ![1 Upload, phone](IS-05-results/phone-upload.jpg) |

### 2 Prepare

`/c/<code>/prepare` — large live preview (adjust.js in the browser), background removal on, rotate, crop, brightness / contrast / saturation, Auto enhance, Colour / Black & white, "Designs left: 3 of 3", **Create design**. No size field.

| 1280 px | 390 px |
| --- | --- |
| ![2 Prepare, desktop](IS-05-results/desktop-prepare.jpg) | ![2 Prepare, phone](IS-05-results/phone-prepare.jpg) |

### 2 Prepare, crop

Free-rectangle crop with corner handles (drag to move or resize), then Done.

| 1280 px | 390 px |
| --- | --- |
| ![2 Prepare, crop, desktop](IS-05-results/desktop-prepare-crop.jpg) | ![2 Prepare, crop, phone](IS-05-results/phone-prepare-crop.jpg) |

### 3 Working

`/c/<code>/working` — the four stage names with progress, queue line when waiting, "You can leave this page; your code is …". Polls every 3 s. (Taken with each fake stage held 2.5 s.)

| 1280 px | 390 px |
| --- | --- |
| ![3 Working, desktop](IS-05-results/desktop-working.jpg) | ![3 Working, phone](IS-05-results/phone-working.jpg) |

### 4 Result

`/c/<code>/result/<n>` — Original and Tinted (watermarked preview) side by side (stacked on phones), zoom, Original switch Prepared / Uploaded; natural size in mm and in, stone count, sizes, colours (first 8, then "+N more"); **Use this design**, **Try again**.

| 1280 px | 390 px |
| --- | --- |
| ![4 Result, desktop](IS-05-results/desktop-result.jpg) | ![4 Result, phone](IS-05-results/phone-result.jpg) |

### 4 Result, compare

The compare slider: Tinted over Original, drag the image or the slider.

| 1280 px | 390 px |
| --- | --- |
| ![4 Result, compare, desktop](IS-05-results/desktop-result-compare.jpg) | ![4 Result, compare, phone](IS-05-results/phone-result-compare.jpg) |

### Try again

Back on Prepare with the previous settings (brightness +12, the crop) and "Designs left: 2 of 3".

| 1280 px | 390 px |
| --- | --- |
| ![Try again, desktop](IS-05-results/desktop-try-again.jpg) | ![Try again, phone](IS-05-results/phone-try-again.jpg) |

### Result, second design

Black & white design 2, with both designs as thumbnails to switch between.

| 1280 px | 390 px |
| --- | --- |
| ![Result, second design, desktop](IS-05-results/desktop-result-2.jpg) | ![Result, second design, phone](IS-05-results/phone-result-2.jpg) |

### 5 Your code

`/c/<code>/done` — big code with Copy, three numbered steps back to Etsy, link to the download page (and to the listing when `IS_ETSY_LISTING_URL` is set).

| 1280 px | 390 px |
| --- | --- |
| ![5 Your code, desktop](IS-05-results/desktop-code.jpg) | ![5 Your code, phone](IS-05-results/phone-code.jpg) |

### 6 Download, not paid

`/download` — "Payments usually appear within 10 minutes of checkout. This page checks again automatically." (every 30 s).

| 1280 px | 390 px |
| --- | --- |
| ![6 Download, not paid, desktop](IS-05-results/desktop-download-unpaid.jpg) | ![6 Download, not paid, phone](IS-05-results/phone-download-unpaid.jpg) |

### 6 Download, ready

After the test-only payment switch: Download ZIP button and the expiry date (paid + 30 days).

| 1280 px | 390 px |
| --- | --- |
| ![6 Download, ready, desktop](IS-05-results/desktop-download-ready.jpg) | ![6 Download, ready, phone](IS-05-results/phone-download-ready.jpg) |

### 6 Download, expired

| 1280 px | 390 px |
| --- | --- |
| ![6 Download, expired, desktop](IS-05-results/desktop-download-expired.jpg) | ![6 Download, expired, phone](IS-05-results/phone-download-expired.jpg) |

### 6 Download, refunded

| 1280 px | 390 px |
| --- | --- |
| ![6 Download, refunded, desktop](IS-05-results/desktop-download-refunded.jpg) | ![6 Download, refunded, phone](IS-05-results/phone-download-refunded.jpg) |

### 6 Download, unknown code

| 1280 px | 390 px |
| --- | --- |
| ![6 Download, unknown code, desktop](IS-05-results/desktop-download-unknown.jpg) | ![6 Download, unknown code, phone](IS-05-results/phone-download-unknown.jpg) |

### 7 Privacy (draft)

Placeholder text from spec section 14, marked DRAFT.

| 1280 px | 390 px |
| --- | --- |
| ![7 Privacy (draft), desktop](IS-05-results/desktop-privacy.jpg) | ![7 Privacy (draft), phone](IS-05-results/phone-privacy.jpg) |

### 7 Terms (draft)

| 1280 px | 390 px |
| --- | --- |
| ![7 Terms (draft), desktop](IS-05-results/desktop-terms.jpg) | ![7 Terms (draft), phone](IS-05-results/phone-terms.jpg) |

### 7 Contact (draft)

| 1280 px | 390 px |
| --- | --- |
| ![7 Contact (draft), desktop](IS-05-results/desktop-contact.jpg) | ![7 Contact (draft), phone](IS-05-results/phone-contact.jpg) |

## Notes and open items

- The frontend-design skill was not available in this session. The look follows CLAUDE.md's UI
  principles directly: white, deep blue (`#123a8c`), system fonts, no external assets.
- Turnstile is wired on Upload and Create design but untested: fake mode has no site key.
- The compare slider lays Tinted over Original in the tinted image's frame. The two framings differ
  (the design is cropped to the subject, the prepared image is not), so the overlay is approximate.
- `/` is now the web app. The old page linking to "Connect Etsy" is gone; `/auth/etsy` still works
  when opened directly (its localhost guard is IS-06).
- Privacy, terms and contact texts are drafts for review, marked DRAFT on the pages.
