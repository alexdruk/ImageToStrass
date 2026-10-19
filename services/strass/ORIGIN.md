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
