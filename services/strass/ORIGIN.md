# Origin

Copied from `alexdruk/Rhinestone-Studio` at commit `38cd831`, folder `services/strass-layout/`
(IS-001 spec section 16). Every text file starts with a `From Rhinestone-Studio @38cd831 <path>`
comment (line 2 after a shebang). The files below cannot carry a comment; they are unchanged
copies of the same path under `services/strass-layout/`:

- `models/stardist/2D_versatile_fluo/config.json`
- `models/stardist/2D_versatile_fluo/thresholds.json`
- `models/stardist/2D_versatile_fluo/weights_best.h5`
- `prototype/catalogue.json`
- `prototype/catalogue_v4.json`
- `prototype/expected/N2_cat_final_rs.json`
- `prototype/expected/N2_dog_final_rs.json`
- `prototype/expected/N2_einstein_final_rs.json`
- `prototype/expected/N2_jesus_final_rs.json`
- `prototype/expected/N2_lake_final_rs.json`
- `prototype/expected/N2_leopard_final_rs.json`
- `prototype/expected/N2_logo_final_rs.json`
- `prototype/expected/N2_parrot_final_rs.json`
- `prototype/expected/N2_portrait_final_rs.json`
- `prototype/expected/N2_rose_final_rs.json`
- `prototype/expected/N2_tulips_final_rs.json`
- `prototype/expected/N2_woman_final_rs.json`
- `prototype/img/N2_cat.png`
- `prototype/img/N2_dog.png`
- `prototype/img/N2_einstein.png`
- `prototype/img/N2_jesus.png`
- `prototype/img/N2_lake.png`
- `prototype/img/N2_leopard.png`
- `prototype/img/N2_logo.png`
- `prototype/img/N2_parrot.png`
- `prototype/img/N2_portrait.png`
- `prototype/img/N2_rose.png`
- `prototype/img/N2_tulips.png`
- `prototype/img/N2_woman.png`
- `prototype/looks.json`
- `strass_layout/catalogue.json`
- `tests/fixtures/sunburst_flower.png`

Changes made for IS:

- `scripts/start_layout.sh` renamed to `scripts/start.sh`; it binds `STRASS_PORT` (default 8000).
- `app.py`: `POST /remove-background` under the `/layout` lock; the background model loads at
  startup.
- `requirements.txt`: `onnxruntime==1.23.2`, `rembg==2.0.69`.
- `scripts/setup_mac.sh`: downloads the background model into `models/rembg/`.
- `README.md`: an IS note at the top and the new endpoint.
- New files (not from RS): `strass_layout/background.py`, `tests/test_background.py`,
  `tests/fixtures/photos/` (CC0 photos, see `SOURCES.md` there), this file.
- IS-07a (face landmarks, see the section below): `requirements.txt` drops `dlib-bin`;
  `scripts/setup_mac.sh` installs MediaPipe and downloads the dlib model only with
  `--with-dlib-tests`; `Dockerfile` installs MediaPipe and copies its model instead of fetching
  the dlib model; `README.md`: an IS-07a note and the setup, test and Docker text. New files:
  `requirements-nodeps.txt`, `requirements-dlib-tests.txt`, `tests/dlib_faces.py`,
  `scripts/is07a_landmarks.py`, and `models/mediapipe/face_landmarker.task` (MediaPipe Face
  Landmarker, float16 version 1, Apache 2.0, from
  `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
  SHA-256 `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`; it cannot carry a
  comment).

**The dlib 68-point model must never be shipped or used in production.** It was trained on the
iBUG 300-W dataset, whose licence excludes commercial use. Since IS-07a the service does not import
dlib or load the model; it stays only as a test-only dependency of the equivalence test against the
prototype (`prototype/landmarks.py` uses it), skipped when the model is absent.

## Divergences from RS 38cd831 in the layout code (to port back)

Changes to RS code under `strass_layout/`, `tests/` and the README, as opposed to the IS-only
additions above. Each is marked `IS (IS-05b)` in the code.

### IS-05b (19 Oct 2026): plausible pupils and pupil positions

- `strass_layout/rules.py`: new rule `plausible_eyes` (default `False`, so `PROTOTYPE` and
  `BUILD_E` … `BUILD_I` are unchanged); `DEFAULT` sets it `True`. Docstring note.
- `strass_layout/post.py`:
  - new `_plausible_pupils(cands, mask)` and constants `PAIR_MAX_RATIO = 1.6`,
    `PAIR_MAX_SLOPE = 0.5`, `PAIR_MAX_SPAN = 0.45`: no pupil or one pupil is plausible; more than
    two never are; two are a plausible pair when their diameters (before they are equalised) are
    within a factor 1.6, the vertical offset is at most half the horizontal one and the centres
    are at most 0.45 of the subject mask's width apart;
  - in `post_process`, right after the pupil candidates are final (after the human fallback,
    before the two diameters are equalised): with `rules.plausible_eyes` and implausible pupils,
    the candidates and the eye boxes are dropped, so the eye stage places no pupil, catch-light,
    iris or lash stone, `soften_outlines` does not run (it needs `face == "human"`), and
    `info["face"]` is `None`;
  - `info["pupilsAtMm"]`: each placed pupil's centre in frame mm, rounded as the stones are.
- `strass_layout/pipeline.py`: `layout_frame` passes `pupilsAtMm` in the frame; `finish_layout`
  adds `report.pupilsAtMm` (`[x, y]` per pupil, in the cropped stone coordinates, same order as
  `pupilsMm`). `report.face` can now be `null`.
- `tests/test_contract.py`: `pupilsAtMm` added to `REPORT_KEYS`.
- `README.md`: the new report key and `face: null`.
- New test `tests/test_is05b.py`; new script `scripts/is05b_runs.py` (diagnosis runs, not used
  by the service).

Effect (docs/IS-05b-results.md): the IS-03b car (19 "pupils" on its wheels) and giraffe (4) lose
their eye stage; the 12 RS test layouts and every other IS-03b design are unchanged stone for
stone, apart from the new report key.

### IS-05b follow-up (19 Oct 2026): soft outlines off, one plausible pair of more than two pupils

- `strass_layout/rules.py`: `DEFAULT` has `soft_outlines=False` (RS ships it on; `BUILD_I` keeps it
  on). On the RS woman it turned 94 black outline stones on the skin into smoked topaz, which the
  AI drew black; switched off, the colour error falls where it acted (woman 7.73 → 7.02, portrait
  8.23 → 8.06, dog 7.76 → 7.66 mean ΔE2000) and nothing else changes. Docstring note.
- `strass_layout/post.py`: `_plausible_pupils(cands, mask)` now returns the pupils to keep, or
  `None` for no face (it returned a bool); the pair test is `_plausible_pair(a, b, width)`. Of more
  than two pupils, the pair is kept when exactly one pair passes the test, and the others are laid
  out as ordinary stones; none or several passing pairs are still no face. The IS-03b giraffe (4
  pupils, only its eyes pass) keeps its eyes; the IS-03b car (19 pupils, 31 passing pairs) still
  has no face. Every other test design is unchanged stone for stone apart from `soft_outlines`.
- `tests/test_build_j.py`: `DefaultAgainstBuildI` compares `DEFAULT` with `BUILD_I` with
  `soft_outlines` off.
- `tests/test_is05b.py`: tests for the kept pair, several pairs, and `soft_outlines` off.
- `scripts/is05b_runs.py` (IS diagnosis only): "rs" keeps `soft_outlines` on, so it stays the RS
  38cd831 rules; first-pick experiments "rs-pick-nearest", "rs-pick-sample", "rs-pick-both".

The service's first colour pick was checked against the prompt (IS-05b follow-up, item 3): the
service matches against `fill` (`DEFAULT` → `PLUS_REAL_SKIN`, real colours), and every one of the
47 `fill` values equals the hex the prompt gives the AI (`previewColor`). Nothing was changed.

### IS-05b second follow-up (20 Oct 2026): colours read at the delivered stones

- `strass_layout/rules.py`: new rule `sample_delivered` (default `False`, so `PROTOTYPE` and
  `BUILD_E` … `BUILD_I` are unchanged and the equivalence test against the prototype still holds);
  `DEFAULT` sets it `True`. Docstring note.
- `strass_layout/ordered.py`: new `SAMPLE_SHARE = 0.6`, `delivered_lab(rgb, a, s, P, D, mean)` and
  `_delivered_colours(rgb, a, s, P, D, C, mean)`. With `rules.sample_delivered`, after the last
  `resolve_idx` (the stones' final positions, fill stones included) each stone's Lab colour is read
  again by `stone_colours` at its delivered position (rounded to 0.001 mm as returned), from the
  inner 60 % of its radius, by the same rule the detections are read with (`mean_colour`); a tiled
  big stone's catch-light keeps `CATCH_LAB`. RS reads every colour at the detection and gives fill
  stones the nearest detection's colour. The keep-or-drop decisions still read the detections
  (`col`), so no stone moves. Why 60 %: the whole disc of a stone that moved, or is larger than the
  stone the AI drew, reaches into the AI's gaps, which most AI images paint dark; on the IS-03b mug
  that took the mean ΔE from 3.3 to 7.1, the inner 60 % gives 3.2.
- `strass_layout/post.py`: with `rules.sample_delivered`, a stone added by the second fill takes
  the catalogue colour of its own pixels (`ordered.delivered_lab`) instead of its neighbours' most
  common colour.
- `tests/test_build_j.py`: `DefaultAgainstBuildI` runs `DEFAULT` with `sample_delivered` off
  (it checks that build J changes only skin colours relative to build I).
- `tests/test_is05b.py`: `SampleDelivered` (the rule's defaults, `_delivered_colours` on a
  two-colour image, and on cat and woman: stones, sizes, face, pupils, coverage identical, only
  colours change).
- `scripts/is05b_runs.py` (IS diagnosis only): variant "default-no-sample"; "rs" has the rule off.

Effect on the 21 test designs (docs/IS-05b-results.md section 7): stone positions, sizes, faces and
pupils identical on all 21; only colours change.

### IS-05c (21 Oct 2026): no human iris rings, skin_nearest reads the inner part of each stone

- `strass_layout/rules.py`: `DEFAULT` has `human_iris=False` (RS 38cd831 ships it on; `BUILD_F` …
  `BUILD_I` keep it on). Its SS4 rings around a person's pupil, coloured from the AI's eye white,
  snapped to Grey and Silver and made the eyes look like goggles; off, the AI's own stones stay
  around the pupil. Animals keep their iris rings (`build_eye_copy` gives them rings whatever the
  rule says). Docstring note.
- `strass_layout/rules.py`: new rule `skin_nearest_inner` (default `False`, so `PROTOTYPE` and
  `BUILD_E` … `BUILD_I` are unchanged and the equivalence test against the prototype still holds);
  `DEFAULT` sets it `True`. Docstring note.
- `strass_layout/pipeline.py`: with `rules.skin_nearest_inner`, the Lab colours `skin_nearest`
  reads are taken from the inner `ordered.SAMPLE_SHARE` (60 %) of each stone's radius instead of its
  whole disc (radius 0.5 D). The whole disc reaches into the AI's gaps, which most AI images paint
  dark: on the RS woman `skin_nearest` turned 90 warm shadow stones into Smoked Topaz. Only skin
  colours change; stones, sizes, faces and pupils do not. Docstring note.
- `tests/test_build_j.py`: `DefaultAgainstBuildI` runs `DEFAULT` with `human_iris` on and
  `skin_nearest_inner` off as well (it checks that build J changes only skin colours relative to
  build I).
- New test `tests/test_is05c.py` (the rules' defaults; people lose the iris rings, cat and dog are
  unchanged; `skin_nearest_inner` changes only skin colours on woman and dog, and gives the woman
  less Smoked Topaz).
- `scripts/is05c_runs.py` (IS diagnosis only): variants "before" (the IS-05b `DEFAULT`) and
  `IS05C_BASE=before`; "skin-nearest-inner" uses the rule.

Effect (docs/IS-05c-results.md section 5): the people's eyes lose the iris rings; on the designs
with skin or fur colours some SS4/SS6 stones change between skin colours; stone positions and
sizes are unchanged on every design without a person's face.

### IS-05d (21 Oct 2026, experiment): warm and mixed shadow rules, off everywhere

- `strass_layout/rules.py`: new rules `warm_shadow` (default `False`), `warm_shadow_de` (default
  1.5) and `mixed_shadow` (default `False`). They are off in `PROTOTYPE`, `BUILD_E` … `BUILD_I`
  **and `DEFAULT`**, so the service, the equivalence test and every other test are unchanged.
  Docstring note.
- `strass_layout/faces.py`:
  - `skin_nearest(D, C, lab, pal, warm_de=None)`: with `warm_de` (`rules.warm_shadow`), a stone
    whose nearest skin colour is Smoked Topaz takes Colorado Topaz when that is at most `warm_de`
    ΔE2000 further from its sampled colour;
  - new `mixed_shadow(P, D, C, lab, pal, eyes, nb)`, `_rows(P, D)`, `_linear`, `_mix_lab` and
    constants `SMOKED`, `COLORADO`, `MIX_PATTERNS`, `ROW_SLOPE = 0.5`: on SS4/SS6 Smoked and
    Colorado Topaz stones outside 1.5 eye-zone radii, the share of Colorado Topaz (0, 1/3, 1/2, 2/3,
    1; the two fills mixed in linear light) nearest the mean Lab of the stone and its skin-coloured
    neighbours; for 1/3, 1/2, 2/3 the stone takes its place in the pattern `C S S`, `C S`, `C C S`
    along its row (a chain of nearest right-hand neighbours within ROW_SLOPE of horizontal),
    staggered from row to row;
  - `finish_faces`: passes `warm_de`; runs `mixed_shadow` after `calm_skin` with
    `rules.mixed_shadow`.
- `strass_layout/pipeline.py`: the stone colours `skin_nearest` reads are also read when only
  `rules.mixed_shadow` is on.
- New test `tests/test_is05d.py` (the rules are off everywhere; the warm tie-break; rows on a grid;
  each mix laid in its proportion; pure colours and eyes untouched; on the woman only the two
  topazes change and stones, sizes, face and pupils are identical).
- `scripts/is05d_runs.py` (IS diagnosis only): variants "warm-1.5", "warm-3", "mixed",
  "warm-1.5-mixed", "warm-3-mixed".

Effect (docs/IS-05d-results.md): only Smoked/Colorado Topaz colours change; stones, sizes, faces and
pupils are identical on the six test designs. Recommended there: `warm_shadow` with
`warm_shadow_de=3`; not applied.

### IS-05d decision (21 Oct 2026): warm_shadow on in DEFAULT, 3 ΔE

Alex's decision on docs/IS-05d-results.md (variant A, "warm-3"):

- `strass_layout/rules.py`: `DEFAULT` has `warm_shadow=True`, `warm_shadow_de=3.0`. `PROTOTYPE` and
  `BUILD_E` … `BUILD_I` keep it off, so the equivalence test against the prototype still holds.
  `mixed_shadow` (variant B) stays off everywhere. Docstring note.
- `tests/test_is05d.py`: the defaults test checks `warm_shadow` is on only in `DEFAULT` (3 ΔE) and
  `mixed_shadow` off everywhere; the woman test compares `DEFAULT` with `warm_shadow` off.
- `tests/test_build_j.py`: `DefaultAgainstBuildI` runs `DEFAULT` with `warm_shadow` off as well.
- `scripts/is05d_runs.py`: "default" is now `DEFAULT` with `warm_shadow` off (the experiment's
  baseline), "final" is `DEFAULT`; "mixed" keeps `warm_shadow` off.

Effect on the 21 test designs (docs/IS-05d-results.md section 9): stones, sizes, coverage, faces and
pupils identical; 11 designs change colour, almost all Smoked Topaz → Colorado Topaz (woman 75,
giraffe-rule 97, dachshund-rule 65, leopard 33, einstein 17).

### exp-holes (23 Oct 2026, experiment): exact and mask-cover fills, off everywhere

The exp-holes diagnosis (docs/exp-holes.md) found that most holes (a spot in the subject where an
SS6 or SS4 stone fits with 0.1 mm to every stone) are spots the fills after the eye stage do not
place: they keep 0.15 mm from every stone (GAP + 0.05 mm raster margin), and they decline spots
whose disc is less than 70 % covered by the closed alpha.

- `strass_layout/rules.py`: new rules `fill_exact` and `fill_cover_mask` (default `False`). They
  are off in `PROTOTYPE`, `BUILD_E` … `BUILD_I` **and `DEFAULT`**, so the service, the equivalence
  test and every other test are unchanged. Docstring note.
- `strass_layout/geometry.py`:
  - `fill(..., extra=0.05, exact=False, cover_mask=False)`: `extra` is the margin beyond `GAP` the
    raster keeps (RS: 0.05 mm, the defaults are RS 38cd831's fill); with `exact`, only the new
    stones whose exact rim gap to every stone, and to the new stones kept before them, is at least
    `GAP` are returned; with `cover_mask`, the 0.7 cover is measured on the `mask` the fill fills
    instead of the closed alpha (`cover_frac`);
  - new `mask_cover(mask, P, d, s)` and `_exact_keep(P, D, newP, newD)`.
- `strass_layout/post.py`: the three fills after the eye stage pass `extra=0` and `exact` with
  `rules.fill_exact`, and `cover_mask` with `rules.fill_cover_mask`. The ordered layout's own fill
  (`ordered.py`) is unchanged: its stones go through `resolve_idx`, which keeps 0.12 mm anyway.
- New test `tests/test_exp_holes.py` (the rules are off everywhere; `_exact_keep`, `mask_cover`; on
  the woman the fills only add stones and no gap is below 0.1 mm).
- New script `scripts/holes_trace.py` (IS diagnosis only): lays out saved AI images and records
  which stage dropped, deleted or declined a stone; variants "default", "fill-exact",
  "fill-cover-mask", "fill-both".

### exp-holes follow-up (24 Oct 2026): no crash on a stone beyond the image's edge

An AI image whose subject touches the image's edge crashed the layout with `IndexError: index -1 is
out of bounds for axis 0 with size 0 (at colour.py:96)`. The fill (`geometry.fill`) places stones on
a grid that reaches half a pixel past the last pixel centre, and `legalise` can push them further,
so delivered stones can lie past the image's last row. With
`sample_delivered` (`ordered.delivered_lab`, IS-05b) their colours are read by `stone_colours`, whose
median rule then had no pixel within its radius and took the quantile of an empty array. (RS
38cd831 reads colours at the detections only, which lie inside the image, so this path is IS's.)

- `strass_layout/colour.py`: `stone_colours` reads the nearest pixel of the image for a stone with
  no pixel within its radius, and for a stone whose whole window lies outside the image (where the
  window itself was empty). A stone with pixels is read as before, so the equivalence test and
  every layout that did not crash are unchanged. Docstring note.
- `strass_layout/eyes.py` (RS bug): with the colour stage fixed, the same image crashed next in
  `_find_inscribed` (`pupil_inscribed`, build G): `IndexError: index … is out of bounds for axis 0`.
  A dark region cut by the image's border has its distance-transform peak near the edge, and the
  window around it was clamped at 0 but not at the image's size. The window now ends at the image's
  edge; a window inside the image is unchanged, so no layout that did not crash changes. Docstring
  note.
- `tests/test_exp_holes.py`: `StoneBeyondTheEdge` reproduces the colour crash with a 20 x 30 px
  synthetic image (an SS4 stone 2.1 px past the last row, and a disc wholly outside the image);
  `DarkDiscAtTheEdge` reproduces the pupil crash with an 80 x 60 px image (a dark disc with a
  highlight, centred on the last row).

### exp-holes dark spots (24 Oct 2026): report.fillAtMm

IS gives the stones the service's fills placed their neighbours' colour when
`IS_SERVICE_FILL_NEIGHBOURS=1` (IS spec 7.5; the rule is IS code, `src/pipeline/cleanup.js`). The
`/layout` answer did not say which stones those are, so the report gains a key; no stone, size or
colour changes.

- `strass_layout/ordered.py`: the result's `"fill"` marks the stones the ordered layout's fill placed
  (the second `resolve_idx`'s survivors past the rows).
- `strass_layout/post.py`: `info["fillAtMm"]`, the centres (frame mm) of the delivered stones that
  the ordered layout's fill or the fills after the eyes placed.
- `strass_layout/pipeline.py`: `layout_frame` passes `fillAtMm` in the frame; `finish_layout` adds
  `report.fillAtMm` (`[x, y]` per stone, cropped mm like the stones).
- `tests/test_contract.py`: `fillAtMm` added to `REPORT_KEYS`; `README.md`: the new key.
- `scripts/holes_trace.py` records the same stones independently (`serviceFill`); they agree.

### exp-holes B&W (24 Oct 2026): report.discsAtMm

IS can read a black & white stone's colour from the AI stone disc it overlaps most instead of the
pixels under its delivered position (IS spec 7.6, `IS_BW_FROM_DISCS=1`, off; the rule is IS code,
`src/pipeline/bw.js`). The `/layout` answer did not hold the detections, so the report gains a key;
no stone, size or colour changes.

- `strass_layout/ordered.py`: the result's `"discs"`, `[x, y, d]` (frame mm) of every detection but
  the tiny ones, shadows, painted gap dots and interstitial dots (one inside a big stone counts).
- `strass_layout/pipeline.py`: `layout_frame` passes `discsAtMm` in the frame; `finish_layout` adds
  `report.discsAtMm` (cropped mm like the stones).
- `tests/test_contract.py`: `discsAtMm` added to `REPORT_KEYS`; `README.md`: the new key.
- `scripts/holes_trace.py` records the same detections with their verdicts; the discs are the
  verdicts kept, tiled, rows-deleted, duplicate, inside-big and outside-mask.

### IS-07a (26 Oct 2026): MediaPipe face landmarks instead of dlib

RS finds the face (and so a person as opposed to an animal) and the eye boxes with dlib's frontal
face detector and 68-point shape predictor. That model's training data (iBUG 300-W) excludes
commercial use, so the IS service replaces it with MediaPipe Face Landmarker (Apache 2.0).

- `strass_layout/models.py`: `Models` loads the MediaPipe landmarker
  (`models/mediapipe/face_landmarker.task`) instead of dlib; `landmarks()` (68 points) becomes
  `eye_contours()`: the largest face's two eye contours in dlib's order (points 36-41, then 42-47),
  from the Face Mesh points `MP_EYES`, or `None`. The search is RS's: the median 5 px blur, then
  Gaussian blurs of 3 and 6 px; in each, the face with the largest box is taken, and the first
  one wider than 0.12 of the image wins (the box is the mesh's bounding box; dlib's was its
  detection box). dlib's 2x upsampling has no MediaPipe equivalent and is dropped. Two additions
  keep the answers close to dlib's: faces need a detection and presence confidence of 0.6
  (MediaPipe's default 0.5 fitted a face to the RS dog at the 6 px blur), and a mesh whose iris
  centres are closer than 0.25 of its ear-to-ear width (a face seen from the side or a false find,
  which dlib's frontal detector does not report) is not a face. Docstring note.
- `strass_layout/post.py`: `_eye_boxes` reads `models.eye_contours`; the eye boxes are computed
  from the contours as before (centre, width, at least 20 px). Nothing else changes: `face` is
  still "human" with eye boxes, "animal" without, `None` for implausible pupils.
- `tests/dlib_faces.py` (test only): RS's dlib `landmarks()` and the same `eye_contours()` on top
  of the service's `Models`; `available()` is false without dlib or its model.
- `tests/support.py`: `frame_result(name, rules, dlib=False)`; `tests/test_equivalence.py` runs the
  package with `dlib=True` (the prototype uses dlib) and skips without it.
- `scripts/is07a_landmarks.py` (IS diagnosis only): lays out AI images with both and records what
  differs (docs/is-07a-landmarks.md).

### PN-04h (31 Oct 2026): lone white stones in skin

The AI paints small pale highlights on skin (L* about 95, just outside the snapping rules' warm hue
range); they snap to Crystal Clear and read as holes in the design.

- `strass_layout/rules.py`: new rule `lone_white_skin` (default `False`, so `PROTOTYPE` and the
  `BUILD_*` rules keep RS's behaviour); `DEFAULT` has it on. Docstring note.
- `strass_layout/faces.py`: `WHITE` and `lone_white_skin(P, D, C, pal, eyes, nb=None)`: an SS4 or SS6
  Crystal Clear, Crystal or Silver stone with at least four neighbours, all in `distinct.SKIN`,
  outside 1.5 eye-zone radii, takes its neighbours' most common colour (on a tie the lighter).
  `finish_faces` runs it last, after `calm_skin` (and `mixed_shadow`). Docstring note.
- `tests/test_pn04h.py` (new): the rule on a stone grid and on a layout (only white stones become
  skin colours; positions and sizes unchanged).
