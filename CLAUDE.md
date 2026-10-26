# CLAUDE.md — IS (imagetostrass)

Read this file and `docs/IS-001-Spec.md` before making any change. The spec is the source of
truth for what IS does; this file says how to work on it.

## What IS is

The public name is **PatternNifty** (patternnifty.com, codes `PN-XXXX-XXXX`); IS is only the internal name, never shown to a buyer.

A standalone web app, sold through one Etsy listing. A buyer uploads an image, IS turns it into a
production-ready rhinestone template, shows the original and a tinted preview, and gives a code.
The buyer enters the code on Etsy, pays, and downloads a ZIP (SVG, production-sheet PDF, AI, EPS,
DXF, PNG) from IS.

It runs on Alex's Mac behind a Cloudflare Tunnel: Node/Express on 127.0.0.1:3003 and the Python
strass service on 127.0.0.1:8000.

## Architecture rules

```
prepared image → provider call → strass /layout → stone list (mm)
→ natural size / B&W mapping → StoneLayout → tinted render + exporters
```

- Exactly one StoneLayout per design. Renderers and exporters consume it and never create,
  move or resize stones.
- Stone geometry changes (tiers, colour mapping) happen only in `src/pipeline/`.
- `src/prep/adjust.js` is the only implementation of the image adjustments; the browser and the
  server both use it.
- Code copied from Rhinestone Studio keeps its first-line comment
  `// From Rhinestone-Studio @<commit> <path>`. Change copied files only where the spec says so,
  so RS fixes can still be ported by diff.
- Python lives only in `services/strass/`. Nothing in `src/` or `public/` imports it; Node reaches
  it only over HTTP on 127.0.0.1.

## Hard rules

- **Never expose the provider.** No provider name, model name, prompt text, AI image or raw
  provider error may reach the browser, an HTTP header, a log under `public/`, a file name, a
  ZIP entry or file metadata. Buyer-facing errors use the IS error codes and texts in spec
  section 12. The grep test in `tools/test-no-provider-leak.mjs` must pass.
- The browser only ever sees: the original/prepared image, the watermarked tinted preview, stats
  and codes. Never a mask, AI image, overlay or 3D view.
- Never delete anything under `data/archive/`. Alex manages it by hand. Only
  `data/delivery/` ZIPs are deleted (30 days after payment) by the nightly job.
- Never commit `.env`, `data/`, tokens, models over 50 MB or buyer images.
- No payment, prices or contact collection on IS; payment happens only on Etsy.
- Never ship or use the dlib 68-point face model (`shape_predictor_68_face_landmarks.dat`) in
  production: its iBUG 300-W training data excludes commercial use. The strass service finds faces
  with MediaPipe Face Landmarker (Apache 2.0); dlib is a test-only dependency of the equivalence
  test (`setup_mac.sh --with-dlib-tests`), and nothing under `strass_layout/` or `app.py` may
  import it.

## Technology

- Node 20+, ES modules, plain JavaScript. No TypeScript, no frontend framework, no build step.
- Express 5, better-sqlite3, sharp, busboy, @napi-rs/canvas, @resvg/resvg-js, archiver,
  @tarikjabiri/dxf@2.8.9; pdfjs-dist (dev only, the tests open the PDFs with it). cloudflared
  from Homebrew. No Ghostscript or poppler: IS writes the EPS itself.
- Add a dependency only when it removes real risk or work, and say why in the commit.
- The public web app targets current evergreen browsers (the RS Chrome 103 baseline does not
  apply here).
- Strass service face landmarks: `mediapipe==0.10.15` (`requirements-nodeps.txt`, installed with
  `pip --no-deps`; the last release whose Intel Mac binaries run on macOS 13) and the committed
  `models/mediapipe/face_landmarker.task`.

## UI principles

Standalone-app look: app shell, fixed header with the IS logo and step indicator, one panel per
step, no page reloads, works at 390 px width. White background, deep blue accents, calm and
minimal. Clarity over features.

## Testing

- Tests are plain Node scripts in `tools/test-*.mjs`, run by `npm test`.
- `IS_FAKE=1` runs the whole flow with no provider and no strass calls (fixture layout).
- During a build, run the tests for the area you touched; run `npm test` before committing.
- Strass service tests: `cd services/strass && .venv/bin/python -m unittest -v`
  (`STRASS_SKIP_EQUIVALENCE=1` to skip the slow equivalence test; it is skipped anyway without the
  test-only dlib model).
- Browser checks: use an isolated browser instance. Never close or quit Chrome, and never close
  windows named **main** or **airbnb**.

## Workflow

1. Audit the repository (never assume something is missing).
2. Design within the spec; if the spec is wrong or silent, stop and ask.
3. Implement the smallest correct change.
4. Focused tests, then `npm test`.
5. Commit with a focused message, push the branch.
6. Report what changed, what was tested, and anything left open. Stop.

Do not merge, tag releases or delete branches without explicit approval.
