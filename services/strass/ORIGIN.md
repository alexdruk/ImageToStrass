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

- `scripts/start_layout.sh` renamed to `scripts/start.sh`.
- `app.py`: `POST /remove-background`, sharing the `/layout` lock.
- `strass_layout/background.py`, `tests/test_background.py`: new.
- `requirements.txt`, `scripts/setup_mac.sh`, `scripts/start.sh`, `README.md`: rembg and its
  model.
