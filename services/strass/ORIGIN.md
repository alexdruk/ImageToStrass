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
