# exp-engine — a stone placement engine for the design concept (build 1)

Status: experiment, 25 Oct 2026, branch `exp-engine`. Production is unchanged: the engine runs only
with `IS_ENGINE=concept` (spec 7.8); the default stays today's pipeline (spec 7.5, 7.6). The strass
service is unchanged and is still used for detection (`report.discsAtMm`, pupils, face) and for the
natural size (`mmPerPx`, `offsetMm`), so designs keep their size and frame.

No provider calls were made. Material: the saved AI images of the 9 CC0 fixtures
(`tools/fixtures/is03b-ai/`), the 12 RS images (`services/strass/prototype/img/`) and the private photos
in three styles (colour, B&W halftone, B&W stencil2). Their /layout answers are the ones saved in
exp-faces; the three CC0 "norule" images had none, so the local strass service laid them out once
(`data/exp-engine/layouts/`). The private results are only in `data/private-portraits/engine.html`.

## 1. What the engine does

The AI image is only a map (concept, "Why"). `src/engine/`:

**Map** (`map.js`), on a 0.1 mm grid in the layout's mm:

- *Subject*: the AI image's closed alpha (the same mask the hole fill uses), one part per piece.
- *Discs*: every detection the service reports (`discsAtMm`), coloured from the inner 60 % of its
  pixels; each subject cell belongs to the nearest disc edge.
- *Lines*: dark ("ink") discs — colour: L\* < 28, or < 50 and 18 below their neighbourhood; B&W: Jet,
  in halftone only where the Jet share around it is at most 0.5 (so a halftone dot pattern is no
  line). The AI's own outline along the edge is left to the subject outline. The thin ink (parts
  narrower than 3.2 mm) is thinned to its centre line (RS Zhang-Suen), traced, spurs under 2 mm
  removed, pieces joined through junctions by straightest continuation, smoothed. A path shorter
  than 3 stones is no line; a path within one stone step of a longer one (a doubled strand) is
  dropped. Width class SS4 when its discs are mostly SS4, else SS6; one colour: the most common
  catalogue colour of its discs (Jet in B&W).
- *Areas*: the other discs, segmented by colour difference (Felzenszwalb–Huttenlocher on ΔE2000, k 60,
  areas under 8 discs joined to their nearest neighbour); at most 3 tones per area from the area's
  own snapped catalogue colours (a tone is added only when it cuts the area's total ΔE by 12 %);
  patches under 4 discs take their neighbours' tone; borders smoothed at about a stone's width and cut
  along every line, so where two areas meet at a line their border is the line. Stencil: solid Jet
  and solid Crystal areas. Halftone: the Jet share snapped to 0, ¼, ½, ¾, 1.
- *Outline colour* per area: the darkest catalogue colour within 25° of its hue (skin and blond hair →
  Smoked Topaz, blue → Capri Blue), Jet where the area is dark (mean L\* < 35) or grey, Jet in B&W.
- *Faces* (build 1): eye regions around both pupils and, for people, a mouth region below them, sized
  in pupil distances. The sizes come from MediaPipe landmarks measured on the exp-faces AI images
  (eye corners −0.30…+0.34, lids −0.15…+0.18, lips −0.57…+0.67 across and +0.68…+1.54 below the
  pupil line, plus margin).

Each map is saved as JSON (outline, area shapes with tones and outline colour, lines, face regions)
and as a picture (areas in their tones, borders grey, lines over a red casing, outline magenta, face
regions cyan). In the pipeline: `attempt-<n>/map.json` and `map.png`.

**Placement** (`place.js`), in the concept's priority order; every stone keeps 0.1 mm to every earlier
one, so no higher-rule stone is removed for a lower one:

1. Features: today's stones whose centre is in an eye or mouth region, unchanged.
2. Lines, longest first: stones at an even chord step (size + 0.15 mm) along the path (RS
   `resampleByChordDistance`), one colour and size; a chain stops where a stone cannot be placed and
   pieces under 3 stones are dropped.
3. Subject outline: SS6 stones on the ring one radius inside the edge (RS `computeSingleDistanceRing`),
   one closed chain per part and hole, coloured by the area beside it; colour runs under 4 stones take
   their neighbours' colour; each colour run is its own chain.
4. Areas, largest first: rows parallel to the area's outline from the outside in (RS
   `computeInwardRingPolygons`, rows 0.9 × 2.15 mm apart so each nests into the one before), walked in
   0.1 mm steps, a stone wherever it keeps 0.15 mm. Next to a chain the first row runs parallel to the
   chain's path. Tones from the map; halftone areas as a Jet/Crystal pattern of the area's share along
   each row, rows shifted by half a step.
5. Seams and remaining spaces: the hole fill of spec 7.5 (SS6, then SS4), coloured by the neighbour
   vote among the area's own stones; then a settle step (area and seam stones next to an empty circle
   over 0.96 mm move towards it as far as 0.1 mm gaps allow); then the fill once more.
6. Every area stone takes a tone of its area; patches under 4 stones take their neighbours' colour.

RS code reused, copied with the origin comment: `ContourRingSampler.js` (whole file, unchanged),
`LineDesignSampler.js` (excerpt: morphology, Zhang-Suen, skeleton tracing, smoothing, chord resampling,
spatial hash, ring walking; unchanged, an export list added). RS `GapFill.js` was not needed: the IS
hole fill closes the seams.

**Checks** (`checks.js`, concept section 8, checks 1–4), run on today's and the engine's design alike,
both against the engine's map of the same AI image:

1. Gaps: pairs under 0.1 mm rim to rim, smallest gap.
2. Lines: along every map line, from its first to its last stone in the line's colour (none: the line
   is *missing*): stones within 0.8 mm of the path of another colour or size, and breaks (a stretch over
   1.5 stone steps without a stone). Engine designs also report their own chains (every stone the
   chain's colour and size, at least 3 stones: always true).
3. Areas: stones of each map area (not on a line, not in the 1.6 mm outline band, not in a face
   region): areas with more than 3 colours, and patches (same colour, touching within 0.6 mm) under
   4 stones that border another colour of the same area. Halftone pattern patches are counted apart.
4. Holes: empty circles inside the subject wider than 1.0 mm, one per connected piece of the grid
   cells whose distance to every stone edge and to the subject's edge is above 0.5 mm.

Today's design is today's pipeline exactly (`cleanedLayout` with the hole fill, B&W from the AI image).

## 2. Results (CC0 and RS)

Time: engine per design 1.2–4.0 s (mean 2.8 s: map 0.9 s, placement 1.8 s) against today's 0.4–1.0 s,
on this Mac. Stones: within about 5 % of today's (52 thousand against 54 thousand over the 21
designs). By role over the 21 engine designs: area rows 28 695, seam fill 12 273, outline 6 354,
line chains 2 600, kept face stones 2 073. Natural size: within 1.5 mm of today's on every design
(the outline ring sits inside the subject's edge, as today's stones do).

| Set | Designs | Who | Gap pass | Clean lines | Other colour on lines | Breaks | Missing lines | Areas >3 tones | Patches <4 | Holes >1 mm | Largest hole | Stones | ms (mean / max) |
| --- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| CC0 | 9 | today | 9/9 | 47/107 | 43 | 5 | 6 | 155 | 2816 | 7193 | 1.72 | 22344 | 549 / 711 |
|  |  | engine | 9/9 | 98/107 | 1 | 0 | 7 | 0 | 1 | 6023 | 1.71 | 21706 | 2561 / 3207 |
| RS | 12 | today | 12/12 | 160/300 | 34 | 13 | 6 | 274 | 3642 | 9094 | 1.72 | 31860 | 634 / 980 |
|  |  | engine | 12/12 | 281/300 | 1 | 0 | 15 | 0 | 1 | 10770 | 1.69 | 30289 | 2940 / 3983 |

Per design (columns: stones, ms, natural size; then the four checks):

| Design | | Stones | ms | Size mm | 1 Gaps: viol. / min | 2 Lines: clean · other colour · other size · breaks · missing | 3 Areas: >3 tones (max) · patches <4 | 4 Holes >1 mm / largest |
| --- | --- | ---: | ---: | --- | --- | --- | --- | --- |
| cc0-car-rule | today | 3548 | 630 | 260 × 87.4 | 0 / 0.1 | 15/31 · 7 · 34 · 1 · 0 | 14 (8) · 307 | 1851 / 1.7 |
|  | engine | 3579 | 3207 | 259.1 × 86.7 | 0 / 0.1 | 29/31 · 0 · 0 · 0 · 1 | 0 (3) · 0 | 1016 / 1.71 |
| cc0-cat-norule | today | 3148 | 584 | 158.4 × 120.8 | 0 / 0.101 | 6/19 · 5 · 11 · 2 · 0 | 32 (10) · 705 | 979 / 1.7 |
|  | engine | 3014 | 2813 | 157.6 × 120 | 0 / 0.1 | 17/19 · 0 · 0 · 0 · 2 | 0 (3) · 0 | 1040 / 1.66 |
| cc0-cat-rule | today | 3579 | 711 | 167.8 × 125.7 | 0 / 0.101 | 4/13 · 1 · 4 · 1 · 2 | 38 (9) · 566 | 541 / 1.68 |
|  | engine | 3362 | 3115 | 167.1 × 125.2 | 0 / 0.1 | 11/13 · 0 · 0 · 0 · 2 | 0 (3) · 0 | 1060 / 1.66 |
| cc0-dachshund-rule | today | 1633 | 393 | 159.2 × 106.4 | 0 / 0.102 | 4/6 · 0 · 2 · 0 · 0 | 10 (7) · 110 | 292 / 1.65 |
|  | engine | 1520 | 1768 | 157.9 × 105.8 | 0 / 0.1 | 5/6 · 0 · 0 · 0 · 1 | 0 (3) · 1 | 397 / 1.65 |
| cc0-dog-norule | today | 2084 | 664 | 87 × 203.1 | 0 / 0.1 | 5/7 · 0 · 1 · 0 · 0 | 21 (13) · 231 | 958 / 1.66 |
|  | engine | 2077 | 2462 | 86.2 × 202.3 | 0 / 0.1 | 6/7 · 0 · 0 · 0 · 1 | 0 (3) · 0 | 581 / 1.62 |
| cc0-dog-rule | today | 2050 | 468 | 83.8 × 200.8 | 0 / 0.101 | 2/5 · 3 · 3 · 0 · 0 | 21 (8) · 248 | 914 / 1.72 |
|  | engine | 2022 | 2548 | 83.2 × 200 | 0 / 0.1 | 5/5 · 0 · 0 · 0 · 0 | 0 (3) · 0 | 609 / 1.66 |
| cc0-giraffe-rule | today | 2327 | 636 | 79.8 × 307.5 | 0 / 0.101 | 9/14 · 4 · 8 · 1 · 0 | 12 (11) · 514 | 1460 / 1.71 |
|  | engine | 2333 | 2948 | 78.4 × 307.1 | 0 / 0.1 | 14/14 · 0 · 0 · 0 · 0 | 0 (3) · 0 | 647 / 1.63 |
| cc0-mug-norule | today | 2224 | 475 | 146.5 × 109.6 | 0 / 0.102 | 2/12 · 23 · 16 · 0 · 4 | 5 (5) · 99 | 119 / 1.63 |
|  | engine | 2130 | 2434 | 145.9 × 109.2 | 0 / 0.1 | 11/12 · 1 · 0 · 0 · 0 | 0 (2) · 0 | 315 / 1.51 |
| cc0-mug-rule | today | 1751 | 382 | 130.4 × 96 | 0 / 0.103 | 0/0 · 0 · 0 · 0 · 0 | 2 (5) · 36 | 79 / 1.41 |
|  | engine | 1669 | 1758 | 130.3 × 96.4 | 0 / 0.1 | 0/0 · 0 · 0 · 0 · 0 | 0 (2) · 0 | 358 / 1.67 |
| rs-cat | today | 2162 | 449 | 103 × 130.8 | 0 / 0.1 | 8/19 · 0 · 16 · 0 · 1 | 36 (9) · 365 | 649 / 1.7 |
|  | engine | 2043 | 2206 | 102 × 130.4 | 0 / 0.1 | 13/19 · 0 · 0 · 0 · 6 | 0 (3) · 0 | 809 / 1.68 |
| rs-dog | today | 1683 | 492 | 96.6 × 160.6 | 0 / 0.102 | 3/5 · 0 · 3 · 0 · 0 | 8 (9) · 133 | 728 / 1.65 |
|  | engine | 1700 | 2185 | 95.7 × 159.9 | 0 / 0.1 | 5/5 · 0 · 0 · 0 · 0 | 0 (2) · 0 | 488 / 1.68 |
| rs-einstein | today | 3594 | 760 | 150.2 × 143.2 | 0 / 0.1 | 30/52 · 4 · 27 · 0 · 3 | 41 (7) · 412 | 648 / 1.68 |
|  | engine | 3376 | 3983 | 149.8 × 142.4 | 0 / 0.1 | 48/52 · 1 · 1 · 0 · 2 | 0 (3) · 0 | 1164 / 1.67 |
| rs-jesus | today | 3307 | 752 | 145.8 × 163.9 | 0 / 0.1 | 11/24 · 3 · 29 · 4 · 0 | 27 (8) · 335 | 1466 / 1.7 |
|  | engine | 3179 | 3632 | 145.4 × 162.7 | 0 / 0.1 | 23/24 · 0 · 0 · 0 · 1 | 0 (3) · 0 | 1442 / 1.68 |
| rs-lake | today | 4100 | 980 | 154.7 × 152.1 | 0 / 0.1 | 18/40 · 13 · 11 · 0 · 0 | 47 (10) · 548 | 1142 / 1.7 |
|  | engine | 3857 | 3962 | 153.3 × 151.3 | 0 / 0.1 | 38/40 · 0 · 0 · 0 · 1 | 0 (3) · 0 | 1564 / 1.62 |
| rs-leopard | today | 2436 | 572 | 117.3 × 153.7 | 0 / 0.101 | 21/44 · 4 · 16 · 7 · 0 | 42 (9) · 561 | 892 / 1.68 |
|  | engine | 2338 | 2838 | 116.3 × 152.7 | 0 / 0.1 | 41/44 · 0 · 0 · 0 · 3 | 0 (3) · 0 | 987 / 1.68 |
| rs-logo | today | 833 | 343 | 144.9 × 79.1 | 0 / 0.102 | 0/0 · 0 · 0 · 0 · 0 | 0 (1) · 0 | 88 / 1.37 |
|  | engine | 773 | 1225 | 144.2 × 78.3 | 0 / 0.1 | 0/0 · 0 · 0 · 0 · 0 | 0 (1) · 0 | 75 / 1.6 |
| rs-parrot | today | 2552 | 695 | 168.3 × 151.6 | 0 / 0.101 | 14/27 · 6 · 7 · 0 · 1 | 32 (9) · 338 | 1017 / 1.67 |
|  | engine | 2407 | 3436 | 167.8 × 150.5 | 0 / 0.1 | 26/27 · 0 · 0 · 0 · 1 | 0 (3) · 0 | 1134 / 1.69 |
| rs-portrait | today | 4045 | 819 | 149.5 × 166 | 0 / 0.1 | 2/21 · 1 · 30 · 1 · 1 | 25 (10) · 627 | 1064 / 1.72 |
|  | engine | 3912 | 3841 | 149.4 × 165.4 | 0 / 0.1 | 20/21 · 0 · 0 · 0 · 1 | 0 (3) · 1 | 1245 / 1.68 |
| rs-rose | today | 1846 | 411 | 121 × 130.5 | 0 / 0.101 | 24/29 · 0 · 4 · 0 · 0 | 2 (4) · 65 | 255 / 1.65 |
|  | engine | 1673 | 2008 | 120.1 × 130 | 0 / 0.1 | 28/29 · 0 · 0 · 0 · 0 | 0 (2) · 0 | 526 / 1.69 |
| rs-tulips | today | 2675 | 689 | 140.3 × 141.7 | 0 / 0.101 | 25/31 · 3 · 7 · 0 · 0 | 7 (7) · 127 | 698 / 1.66 |
|  | engine | 2537 | 3077 | 139.9 × 141.1 | 0 / 0.1 | 31/31 · 0 · 0 · 0 · 0 | 0 (2) · 0 | 720 / 1.67 |
| rs-woman | today | 2627 | 646 | 143.9 × 146.7 | 0 / 0.1 | 4/8 · 0 · 5 · 1 · 0 | 7 (5) · 131 | 447 / 1.65 |
|  | engine | 2494 | 2889 | 143.1 × 145.9 | 0 / 0.1 | 8/8 · 0 · 0 · 0 · 0 | 0 (2) · 0 | 616 / 1.69 |

## 3. What met the rules, and what did not

Met on every design: **check 1** (0 violations, smallest gap 0.1 mm), every chain one colour and size
and at least 3 stones, at most 3 tones per area (0 areas over 3 against 429 today), B&W Jet and
Crystal only. **Check 2** improves from 207 to 379 clean lines of 407 (stones of another colour on a
line 77 → 2, of another size 234 → 1, breaks 18 → 0). **Check 3** from 6 458 small patches to 2.
The private photos show the same picture in all three styles (`data/private-portraits/engine.html`).

Not met:

- **Check 4 (holes over 1.0 mm): no design passes, today's or the engine's.** Over the 21 designs the
  engine leaves 16 793 such circles against today's 16 287 (fewer on the car, the two dogs, the giraffe, RS dog, Jesus
  and logo; more on the others); on the private photos clearly fewer than today. The
  largest is 1.7 mm on every design, because the fill places an SS4 wherever 1.7 mm is free. Almost
  all are 1.0–1.2 mm: an SS4 needs 1.7 mm with its 0.1 mm gaps, so such a spot cannot be filled with
  the allowed sizes; it can only be avoided by packing. Contour-parallel rows nest well where they run
  straight and leave such spots where they bend, where rows of two areas meet and next to chains and
  kept face stones; a square arrangement of SS6 at 2.15 mm already leaves 1.04 mm. Tried: rows at 0.12
  and 0.10 mm gaps, row spacing 0.84–0.95 pitch, and the settle step (only 0.05 mm of slack per gap):
  at most about a 30 % reduction. The seam fill is about a quarter of the engine's stones.
- **Missing lines**: 22 of 407 map lines get no chain (15 on the RS images), where a line runs into a
  face region, crosses a longer line or hugs the edge, so fewer than 3 stones fit.
- **Light lines are not lines yet.** Only dark ink is traced (as the build asked); light structures the
  AI drew as chains — whiskers, lace, a white stripe on Jet — become area tones and largely disappear
  (the cat's whiskers; on the private photos the same with lace and white stripes, and in halftone the
  share smoothing also swallows one-stone light stripes). Today keeps them because it copies the AI's
  stones. This is the engine's clearest loss against today.
- **Halftone patterns** are by tone share along rows; where rows bend they read as blotches rather than
  a regular pattern.
- **Subject outline**: continuous except where a face region or a line meets the edge; split into one
  chain per colour run (each run at least 4 stones).
- **Faces**: build 1 keeps today's stones in the regions. The service reports one pupil pair, so a
  second face in a group photo gets no region. The mouth region is an estimate from the pupils.
- SS10 in large calm areas is not used.
- In the pipeline the engine runs on the main thread (3–9 s), not in the render worker.

## 4. What build 2 needs

1. Features (concept section 5) from face landmarks: the MediaPipe Face Landmarker of exp-faces (own
   venv, Apache 2.0), all faces of a photo, then check 5.
2. Light lines: trace light ink (Crystal or light tone chains on a darker area) the same way, as their
   own width class and colour.
3. Holes: either packing that guarantees the limit (a hexagonal row pattern aligned to each area's
   main direction, contour rows only near borders, a global relaxation after placement), or a check 4
   limit that matches what SS6 and SS4 at 0.1 mm can reach. This needs a decision.
4. Halftone: a regular pattern on a local lattice instead of along rows; keep thin light structures.
5. Lines: let a chain pass a crossing (share the crossing stone) instead of stopping; keep short lines
   that touch a face region.
6. Run the engine in the render worker; use SS10 in large calm areas; acceptance on checks 1–3.

## 5. Files

- `src/engine/`: `map.js`, `place.js`, `checks.js`, `faces.js`, `grid.js`, `index.js`, the RS copies.
- `src/pipeline/design.js`, `src/server/config.js`: `IS_ENGINE=concept`.
- `tools/exp-engine.mjs`: this comparison (`public`, `private`, `tables`, `page`); `tools/test-engine.mjs`.
- `docs/exp-engine/`: pictures and `results.json`; maps (JSON and PNG) in `data/exp-engine/maps/`.

## 6. Pictures

Each design: original | AI image | today | engine | map, then close-ups (AI | today | engine) at the
longest line, the longest area border, the densest seam fill and the face.

### cc0-car-rule

![whole](exp-engine/cc0-car-rule-whole.jpg)

![close-ups](exp-engine/cc0-car-rule-closeups.jpg)

### cc0-cat-norule

![whole](exp-engine/cc0-cat-norule-whole.jpg)

![close-ups](exp-engine/cc0-cat-norule-closeups.jpg)

### cc0-cat-rule

![whole](exp-engine/cc0-cat-rule-whole.jpg)

![close-ups](exp-engine/cc0-cat-rule-closeups.jpg)

### cc0-dachshund-rule

![whole](exp-engine/cc0-dachshund-rule-whole.jpg)

![close-ups](exp-engine/cc0-dachshund-rule-closeups.jpg)

### cc0-dog-norule

![whole](exp-engine/cc0-dog-norule-whole.jpg)

![close-ups](exp-engine/cc0-dog-norule-closeups.jpg)

### cc0-dog-rule

![whole](exp-engine/cc0-dog-rule-whole.jpg)

![close-ups](exp-engine/cc0-dog-rule-closeups.jpg)

### cc0-giraffe-rule

![whole](exp-engine/cc0-giraffe-rule-whole.jpg)

![close-ups](exp-engine/cc0-giraffe-rule-closeups.jpg)

### cc0-mug-norule

![whole](exp-engine/cc0-mug-norule-whole.jpg)

![close-ups](exp-engine/cc0-mug-norule-closeups.jpg)

### cc0-mug-rule

![whole](exp-engine/cc0-mug-rule-whole.jpg)

![close-ups](exp-engine/cc0-mug-rule-closeups.jpg)

### rs-cat

![whole](exp-engine/rs-cat-whole.jpg)

![close-ups](exp-engine/rs-cat-closeups.jpg)

### rs-dog

![whole](exp-engine/rs-dog-whole.jpg)

![close-ups](exp-engine/rs-dog-closeups.jpg)

### rs-einstein

![whole](exp-engine/rs-einstein-whole.jpg)

![close-ups](exp-engine/rs-einstein-closeups.jpg)

### rs-jesus

![whole](exp-engine/rs-jesus-whole.jpg)

![close-ups](exp-engine/rs-jesus-closeups.jpg)

### rs-lake

![whole](exp-engine/rs-lake-whole.jpg)

![close-ups](exp-engine/rs-lake-closeups.jpg)

### rs-leopard

![whole](exp-engine/rs-leopard-whole.jpg)

![close-ups](exp-engine/rs-leopard-closeups.jpg)

### rs-logo

![whole](exp-engine/rs-logo-whole.jpg)

![close-ups](exp-engine/rs-logo-closeups.jpg)

### rs-parrot

![whole](exp-engine/rs-parrot-whole.jpg)

![close-ups](exp-engine/rs-parrot-closeups.jpg)

### rs-portrait

![whole](exp-engine/rs-portrait-whole.jpg)

![close-ups](exp-engine/rs-portrait-closeups.jpg)

### rs-rose

![whole](exp-engine/rs-rose-whole.jpg)

![close-ups](exp-engine/rs-rose-closeups.jpg)

### rs-tulips

![whole](exp-engine/rs-tulips-whole.jpg)

![close-ups](exp-engine/rs-tulips-closeups.jpg)

### rs-woman

![whole](exp-engine/rs-woman-whole.jpg)

![close-ups](exp-engine/rs-woman-closeups.jpg)
