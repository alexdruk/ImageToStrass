# exp-holes — holes in the designs (experiment)

Status: experiment, 23 Oct 2026, branch `exp-holes`. `DEFAULT` and the production path are
unchanged; every fix is behind a flag that is off by default:

- IS hole fill: `IS_FILL_HOLES=1` (`config.fillHoles`; `cleanedLayout(layout, { fillHolesIn })` in
  `src/pipeline/cleanup.js`, the search and fill in `src/pipeline/holes.js`);
- strass copy: rules `fill_exact` and `fill_cover_mask` (off in every rule set, `DEFAULT` included;
  `services/strass/ORIGIN.md`).

Designs measured here: the 9 CC0 AI images of IS-03b (`tools/fixtures/is03b-ai/`) and the 12 RS
test images (`services/strass/prototype/img/`), each laid out again today with `DEFAULT` (no
provider call). The private portraits were measured the same way (colour and B&W); their results
stay in `data/private-portraits/holes.html` and are not part of this file.

Reproduce: `services/strass/scripts/holes_trace.py` (layouts and stage traces), then
`node tools/exp-holes.mjs data/exp-holes/manifest.json data/exp-holes/out`. The pictures below are
written to `data/exp-holes/out/` (git-ignored, regenerate to view), and `data/exp-holes/index.html`
shows them all.

## 1. What a hole is

A spot inside the subject where an SS6 stone, or failing that an SS4 stone, fits with at least
0.1 mm to every neighbour.

- **Subject**: the AI image's alpha (alpha ≥ 128), closed with a disc of 1 mm across (the gaps
  between the AI's stones), then every enclosed transparent area of at most two SS6 stones' area
  (6.3 mm²) filled. Larger transparent areas inside the outline (between an arm and the body, say)
  stay outside the subject.
- **Fits**: the whole stone inside the subject (measured on a 20 px/mm grid in the layout's mm) and
  a rim gap of at least 0.1 mm to every stone of the design (exact, not rasterised).
- **Counted** greedily on the design after the SS16 cap and the overlap cleanup (7.5): the free
  spot farthest from everything first, SS6 while one fits, then SS4. The count of SS6 holes is
  the number of SS6 stones that would fit, and so on.
- **Hole area**: the holes' disc area over the subject area. **Largest empty circle**: the largest
  circle inside the subject that touches no stone (no gap kept).

## 2. Holes before and after the IS fill

| design | stones | SS6 holes | SS4 holes | hole area | largest empty mm | holes, IS fill | after, mm | causes | fill_exact | fill-both | coverage before / after |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | --- |
| car-rule | 3531 | 0 | 17 | 0.17 % | 2.18 | 17 → 0 | 1.70 | check 1, fill-margin 16 | 3 | 3 | 0.626 / 0.628 |
| cat-norule | 3140 | 0 | 8 | 0.10 % | 2.02 | 8 → 0 | 1.69 | eyes 2, rows 5, fill-margin 1 | 2 | 2 | 0.645 / 0.646 |
| cat-rule | 3573 | 0 | 6 | 0.06 % | 2.17 | 6 → 0 | 1.70 | check 1, eyes 2, rows 3 | 3 | 3 | 0.67 / 0.671 |
| dachshund-rule | 1628 | 0 | 5 | 0.12 % | 1.78 | 5 → 0 | 1.67 | eyes 4, fill-margin 1 | 3 | 3 | 0.678 / 0.679 |
| dog-norule | 2071 | 2 | 11 | 0.25 % | 2.45 | 13 → 0 | 1.69 | eyes 10, rows 1, fill-margin 2 | 11 | 11 | 0.64 / 0.643 |
| dog-rule | 2039 | 3 | 8 | 0.24 % | 2.22 | 11 → 0 | 1.70 | eyes 9, rows 2 | 10 | 10 | 0.643 / 0.645 |
| giraffe-rule | 2286 | 1 | 40 | 0.65 % | 2.60 | 41 → 0 | 1.70 | eyes 3, rows 15, fill-margin 23 | 14 | 14 | 0.589 / 0.595 |
| mug-norule | 2224 | 0 | 0 | 0.00 % | 1.68 | 0 → 0 | 1.68 | – | 0 | 0 | 0.698 / 0.698 |
| mug-rule | 1751 | 0 | 0 | 0.00 % | 1.42 | 0 → 0 | 1.42 | – | 0 | 0 | 0.7 / 0.7 |
| rs-cat | 2150 | 0 | 12 | 0.21 % | 1.77 | 12 → 0 | 1.70 | eyes 3, rows 2, fill-declined 1, fill-margin 6 | 5 | 3 | 0.647 / 0.649 |
| rs-dog | 1670 | 2 | 11 | 0.31 % | 2.39 | 13 → 0 | 1.66 | eyes 9, rows 1, fill-declined 1, fill-margin 2 | 9 | 7 | 0.628 / 0.632 |
| rs-einstein | 3590 | 0 | 4 | 0.04 % | 1.79 | 4 → 0 | 1.69 | eyes 1, fill-declined 1, fill-margin 2 | 2 | 0 | 0.671 / 0.671 |
| rs-jesus | 3297 | 0 | 10 | 0.11 % | 1.78 | 10 → 0 | 1.70 | rows 3, fill-margin 7 | 4 | 4 | 0.629 / 0.63 |
| rs-lake | 4089 | 0 | 11 | 0.10 % | 2.19 | 11 → 0 | 1.69 | check 1, fill-declined 3, fill-margin 7 | 7 | 4 | 0.66 / 0.661 |
| rs-leopard | 2433 | 0 | 3 | 0.05 % | 1.75 | 3 → 0 | 1.69 | fill-margin 3 | 4 | 4 | 0.645 / 0.645 |
| rs-logo | 833 | 0 | 0 | 0.00 % | 1.42 | 0 → 0 | 1.42 | – | 0 | 0 | 0.796 / 0.796 |
| rs-parrot | 2542 | 0 | 10 | 0.15 % | 2.17 | 10 → 0 | 1.68 | check 1, eyes 2, rows 6, fill-margin 1 | 4 | 4 | 0.644 / 0.645 |
| rs-portrait | 3990 | 7 | 48 | 0.57 % | 3.14 | 55 → 0 | 1.70 | rows 16, fill-declined 6, fill-margin 32, edge 1 | 31 | 28 | 0.652 / 0.658 |
| rs-rose | 1846 | 0 | 0 | 0.00 % | 1.69 | 0 → 0 | 1.69 | – | 0 | 0 | 0.683 / 0.683 |
| rs-tulips | 2673 | 0 | 2 | 0.03 % | 1.97 | 2 → 0 | 1.70 | fill-declined 1, fill-margin 1 | 2 | 2 | 0.665 / 0.665 |
| rs-woman | 2613 | 3 | 11 | 0.24 % | 2.59 | 14 → 0 | 1.70 | eyes 8, rows 4, fill-margin 2 | 12 | 12 | 0.671 / 0.674 |

"fill_exact" and "fill-both": the holes left by the strass rules of section 4 alone (before any IS
fill). Coverage is the acceptance coverage of 7.5 on the production design and with the IS fill.

Totals: 235 holes on 21 designs (18 SS6, 217 SS4), at most 0.65 % of a subject's area; the largest
empty circle is 1.4–3.1 mm before and at most 1.70 mm after (an SS4 stone with its two gaps does not
fit in that). With the IS fill every design has **0 holes**, stays accepted (7.4), the IS gap check
finds 0 violations (smallest gap 0.100 mm), the natural size is unchanged on all 21 (the filled
holes are inside the old footprint), and the coverage rises by up to 0.006.

Pictures per design (`data/exp-holes/out/`): `NAME-views.jpg` plain before (holes ringed) | plain
after | tinted before | tinted after; `NAME-closeups.jpg` the three worst hole groups, AI image |
plain before | tinted before | tinted after. Worth a look: `rs-portrait` (hair), `giraffe-rule`
(spots), `rs-woman` and `dog-norule` (eyes).

## 3. Why the holes are there

Each hole is given the first cause that applies, in this order, from the IS cleanup's removed
stones and a trace of the service's stages (`holes_trace.py`, which reproduces the service's
layout stone for stone and records each stage's decisions):

| cause | meaning | holes | share |
| --- | --- | ---: | ---: |
| is-cleanup | the IS overlap cleanup (7.5) removed a stone there | 0 | 0 % |
| check | the service's last gap check in `post_process` removed a stone there | 4 | 2 % |
| eyes | the eye stage removed the AI's stones there (around a pupil) | 53 | 23 % |
| rows | the ordered layout dropped the AI's stone (as a painted gap dot 20, interstitial 14, tiny 12, shadow 8) or deleted it pushing the rows apart (4) | 58 | 25 % |
| fill-declined | the service's fill found the spot and declined it: cover below 0.7 on the closed alpha (11), no "room" near a detection (2) | 13 | 6 % |
| fill-margin | the service's fill keeps 0.15 mm (0.1 mm gap + 0.05 mm raster margin) from every stone; the spot has 0.1–0.175 mm | 106 | 45 % |
| edge | outside the service's strict subject mask | 1 | 0 % |
| not-detected | the AI drew a stone there that no detector found | 0 | 0 % |
| ai-empty | the AI drew no stone there | 0 | 0 % |

So **one stage, the service's fill after the eye stage, accounts for 51 %** (fill-margin and
fill-declined); the eye stage (people's pupils, where the iris rings were switched off in IS-05c,
and animals' eyes) and the ordered layout's filters make up the rest. Detection and the IS cleanup
cause none. The private portraits show the same picture, with the fill stage's share higher and
fill-declined (cover below 0.7 on the closed alpha) much larger on some B&W designs.

## 4. The fixes tried

**A. IS hole fill** (`src/pipeline/holes.js`, flag `IS_FILL_HOLES=1`). After the overlap cleanup,
the holes of section 1 are filled: SS6 first, then SS4, each with at least 0.1 mm to every stone
(exact check), only where the whole stone is inside the subject. Each new stone's colour is read
from the AI image as the service reads its own fill stones (`sample_delivered`): the mean CIE Lab of
the opaque pixels within the inner 60 % of its radius, snapped to the catalogue by the service's
`snap_colours` rules (palette `PLUS_REAL_SKIN`). The JavaScript port gives the same colour id as the
service's Python on 450 of 450 random spots (Lab within 0.0001). Then the normal IS gap check and
acceptance run. In B&W mode the new stones are mapped to Jet / Crystal with the others (7.6).
Cost: about 0.5 s per design.

**B. Service fill rules** (strass copy, `fill_exact` and `fill_cover_mask`, off in `DEFAULT`). The
fills after the eye stage keep 0.1 mm from every stone, checked exactly, instead of 0.15 mm on the
raster (`fill_exact`); and measure their 0.7 cover on the strict subject mask they fill instead of
the closed alpha (`fill_cover_mask`). "fill-both" is both.

| service rules | stones | holes left | SS6 holes left | largest empty, max mm | accepted |
| --- | ---: | ---: | ---: | ---: | --- |
| `DEFAULT` | 53 969 | 235 | 18 | 3.14 | 21 / 21 |
| `fill_exact` | 54 095 | 126 | 19 | 3.14 | 21 / 21 |
| fill-both | 54 109 | 114 | 18 | 2.84 | 21 / 21 |

B removes about half of the holes (all of the margin ones it can reach; the eye and rows holes are
not its stage) and changes nothing else on these designs: no gap violations, faces and pupils as
before. With the IS fill on top, B and `DEFAULT` both end at 0 holes.

## 5. Recommendation

Adopt **A, the IS hole fill**, by switching `IS_FILL_HOLES` on (or making it the default in
`cleanedLayout`'s caller), and keep the strass rules of B off.

- A is complete: 0 holes on every design, against half for B. Most holes come from three
  different service stages (fill, eyes, rows), and A covers all of them in one place.
- A is IS code, after the service, so the strass copy stays at RS rules for its layout and RS fixes
  still port by diff; B changes `geometry.fill`, which RS shares with its own pipeline.
- The risk is small and measured: SS4/SS6 stones only, only inside the subject, 0.1 mm gaps kept,
  natural size unchanged, acceptance unchanged on all 21 designs and on the private portraits.
- What A does not do: its stones skip the service's later colour stages (dark-dot and family
  clean-up, skin nearest, warm shadow). In the close-ups that is mostly invisible; at a few colour
  boundaries a mixed spot snaps to an in-between colour (an olive stone on the giraffe's mane line).
  If that matters, B (fill-both) plus A gives the same 0 holes with about half of the new stones
  coloured by the service's full colour stages.

Not changed by this experiment: the spec, `DEFAULT`, the production path. Adopting A changes spec
7.5 (a hole-fill step after the cleanup); that is Alex's decision.
