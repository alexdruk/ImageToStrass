# IS-05d — skin shadow (experiment)

21 Oct 2026, branch `is-05d-skin`, run on Alex's laptop (Apple Silicon). `DEFAULT` is **unchanged**;
the new rules are off in every rule set. No provider call: everything is laid out from saved AI
images (`services/strass/prototype/img/` and `tools/fixtures/is03b-ai/cat-rule-output.png`).

Designs: rs-woman, rs-portrait, rs-einstein, rs-jesus (faces), rs-dog and cat-rule (controls).

Strass service restarted on this laptop with today's `DEFAULT` (`caffeinate -i scripts/start.sh`);
`GET /health` → `{"ok":true,"modelsLoaded":true,"version":"1.2.0","busy":false}`.

How to reproduce:

```
# layouts (services/strass)
.venv/bin/python scripts/is05d_runs.py <runs> shadow woman=prototype/img/N2_woman.png \
  portrait=prototype/img/N2_portrait.png einstein=prototype/img/N2_einstein.png \
  jesus=prototype/img/N2_jesus.png dog=prototype/img/N2_dog.png cat=../../tools/fixtures/is03b-ai/cat-rule-output.png
# images and numbers (docs/IS-05d-results/)
node tools/is05d-results.mjs <runs>
```

## Summary

| Question | Answer |
| --- | --- |
| Does any variant remove the woman's dark patch? | **No.** A moves 38 (1.5) or 75 (3) stones from Smoked to Colorado Topaz, 26 / 54 of them in the 521-stone jaw and neck shadow: the patch shrinks a little at its edges. B breaks the patch's hard edges into a texture, but it makes the shadow *darker*, not warmer (193 Colorado → Smoked against 144 the other way). C is B within a few stones: wherever B acts it overrides A. |
| Why does B go darker? | It matches the mix to the colour the service samples, the AI image's RGB (L\* 33.4, chroma 43). In linear light a 1:1 mix of the two stones is L\* ≈ 39, so for most of the shadow 2 Smoked : 1 Colorado matches best. |
| Then why does Alex see "warm mid-brown" in the AI image? | The AI woman is **semi-transparent**: in the middle of the image 36 % of the pixels are transparent and 60 % partly so (einstein 31 / 66 %, jesus 24 / 71 %, dog 23 / 25 %, portrait 0 %). The service reads RGB and ignores alpha. Seen on white, the shadow stones themselves are L\* 36.4, chroma 40, nearer Colorado Topaz than Smoked Topaz for 310 of the 521 stones, and the gaps between them show white, which the tinted preview fills instead. So the target that the eye compares against is lighter and warmer than the one the layout matches. |
| Recommendation | **A with 3 ΔE** (`warm_shadow`, `warm_shadow_de=3`). It acts only on the near ties, always towards the warmer stone, which is the one closer to what the AI image looks like; it costs 0.04 per-stone ΔE on the woman and nothing measurable elsewhere; the controls change by 1 stone (dog) and 0 (cat). It does **not** make the patch go away, and it should not be expected to (see "Open" at the end). |

## 1. The variants

New rules in IS's strass copy (`strass_layout/rules.py`, all default `False`; recorded in
`services/strass/ORIGIN.md`):

| Variant | Rules | What it does |
| --- | --- | --- |
| A 1.5, A 3 | `warm_shadow`, `warm_shadow_de` 1.5 / 3 | In `skin_nearest` (every SS4/SS6 stone in a skin colour): when the nearest skin colour is Smoked Topaz and Colorado Topaz is at most `warm_shadow_de` ΔE2000 further from the sampled colour, the stone takes Colorado Topaz. |
| B | `mixed_shadow` | New step after `calm_skin` (`faces.mixed_shadow`), so `calm_skin` cannot undo the pattern: on SS4/SS6 Smoked and Colorado Topaz stones outside 1.5 eye-zone radii, the local colour is the mean Lab of the stone and its skin-coloured neighbours. Of the shares of Colorado Topaz 0, 1/3, 1/2, 2/3 and 1, mixed in linear light from the two catalogue fills, the one nearest the local colour (ΔE2000) is chosen; for 1/3, 1/2 or 2/3 the stone takes its place in the pattern `C S S`, `C S` or `C C S` along its row. |
| C 1.5, C 3 | A and B | Both. |

Rows: the stones are the AI's own positions pushed apart, not a grid (nearest-neighbour directions
cluster near 0°, 60° and 120°, but rows drift: y modulo the pitch is flat). So `faces._rows` links
each stone to its nearest neighbour to the right (within 27° of horizontal and touching within
0.6 mm), closest pairs first, one link each way; a row is a chain of links. The pattern index is
the chain position plus the chain start's x in link lengths, plus the row number (the chain start's
y in 0.87 link lengths), so neighbouring rows are staggered.

## 2. rs-woman face and neck

Each row: AI image, tinted default, tinted variant, per-stone ΔE map of the skin stones (green < 5,
yellow < 10, orange < 15, red < 20, dark red ≥ 20). Rows: default, A 1.5, A 3, B, C 1.5, C 3.

![rs-woman face and neck per variant](IS-05d-results/woman-face.jpg)

The jaw and neck shadow: skin stones of the face window (77 × 123 mm) whose AI colour has L\* 25–40
(521 stones, mean AI colour L\* 33.4, chroma 43). Columns:

- **ΔE stone**: per stone, AI colour (inner 60 %, RGB as the service reads it) vs the stone's fill;
- **ΔE 3 mm**: per stone, the light mix of the fills of the skin stones within 3 mm vs the light mix
  of the AI colours under them (what a mix of stones should be judged on);
- **ΔE rendered 3 mm**: the tinted preview against the AI image *as seen on white*, each averaged
  in linear light over a 3 mm disc (gaps and highlights in both); dL is render − AI.

| Variant | Changed | Smoked / Colorado | ΔE stone | ΔE 3 mm | ΔE rendered 3 mm | dL rendered |
| --- | --- | --- | --- | --- | --- | --- |
| default | – | 257 / 263 | 10.10 | 7.68 | 23.47 | −23.5 |
| A 1.5 | 38 | 231 / 289 | 10.12 | 7.77 | 22.95 | −22.9 |
| A 3 | 75 | 203 / 317 | 10.24 | 8.00 | 22.36 | −22.2 |
| B | 337 | 277 / 243 | 11.80 | 6.84 | 24.00 | −23.9 |
| C 1.5 | 337 | 277 / 243 | 11.80 | 6.84 | 24.00 | −23.9 |
| C 3 | 338 | 276 / 244 | 11.80 | 6.84 | 23.99 | −23.9 |

Face window, all 1252 skin stones:

| Variant | ΔE stone | ΔE 3 mm | ΔE rendered 3 mm | Skin stones per colour |
| --- | --- | --- | --- | --- |
| default | 7.40 | 5.58 | 15.17 | colorado-topaz 505, silk 307, smoked-topaz 258, rose-gold 140, copper 39, others 3 |
| A 1.5 | 7.41 | 5.62 | 14.93 | colorado-topaz 531, silk 307, smoked-topaz 232, rose-gold 140, copper 39, others 3 |
| A 3 | 7.46 | 5.71 | 14.66 | colorado-topaz 559, silk 307, smoked-topaz 204, rose-gold 140, copper 39, others 3 |
| B | 8.35 | 5.11 | 15.63 | colorado-topaz 454, smoked-topaz 309, silk 307, rose-gold 140, copper 39, others 3 |
| C 1.5 | 8.35 | 5.11 | 15.63 | as B |
| C 3 | 8.35 | 5.10 | 15.62 | colorado-topaz 455, smoked-topaz 308, (rest as B) |

The measures disagree, and the reason is the target colour:

| Shadow stones, mean L\* | AI inner 60 % | AI stone disc | AI 3 mm | fill | render inner 60 % | render disc | render 3 mm |
| --- | --- | --- | --- | --- | --- | --- | --- |
| default | 33.4 | 32.4 | 32.4 | 38.1 | 42.1 | 36.3 | 36.2 |
| A 3 | 33.4 | 32.4 | 32.4 | 39.9 | 44.0 | 38.1 | 37.7 |
| B | 33.4 | 32.4 | 32.4 | 37.4 | 41.4 | 35.6 | 35.3 |

(Lab means over opaque pixels only, as the service reads them.) Against the AI's RGB the stones are
already 4–6 L\* *too light*, so every measure built on the service's sampling rewards B, which adds
Smoked Topaz. Seen on white, as Alex sees the AI image, the shadow stones are L\* 36.4, chroma 40
(alpha 0.95 inside the stones), Colorado Topaz is the nearer stone (ΔE 10.75 against 12.56 for Smoked
Topaz) for 310 of 521 stones, and the transparent gaps show white: the rendered 3 mm comparison puts
the tinted preview 23 L\* below the AI image. Most of that gap is the gaps (white in the AI image,
filled in the preview, spec section 8), which no stone colour can close; what the stone colour can do
is move towards the lighter, warmer side, and only A does.

## 3. Eye and cheek close-ups

Eye window (both pupils of the default plus 7 mm) and cheek window (as wide, from 2 mm below the
lower pupil, 1.2 times as high), 30 px per mm. Columns: AI image, default, A 1.5, A 3, B, C 1.5, C 3.

#### rs-woman

![rs-woman eye and cheek](IS-05d-results/closeup-rs-woman.jpg)

#### rs-portrait

![rs-portrait eye and cheek](IS-05d-results/closeup-rs-portrait.jpg)

#### rs-einstein

![rs-einstein eye and cheek](IS-05d-results/closeup-rs-einstein.jpg)

#### rs-jesus

dlib finds no face on jesus, so the service lays it out as an animal with one pupil; the eye window is
around that one pupil.

![rs-jesus eye and cheek](IS-05d-results/closeup-rs-jesus.jpg)

No variant changes a pupil, catch-light or lash stone. A changes a few stones around the eyes and on
the cheeks. B skips only stones within 1.5 eye-zone radii: on einstein the AI's brown rings around
both eyes (Smoked and Colorado Topaz) lie outside that and become a speckled Smoked/Colorado
texture, which makes the eye sockets read busier than the AI's smooth brown; on the cheeks B gives
the shadow the same texture.

## 4. Every design: per-stone ΔE, skin ΔE, what changed

Stone positions, sizes, face and pupils are **identical to the default on all six designs for every
variant**; only colours change. Skin: every stone whose AI colour is warm (hue 30–78°, chroma 12–60,
L\* ≥ 25), as in IS-05c. ΔE per stone over the whole design (fill vs AI inner 60 %), then skin ΔE
(same, skin stones), skin ΔE 3 mm and skin ΔE rendered 3 mm (section 2).

| Design | Variant | Changed | ΔE per stone | ΔE rendered | Skin ΔE | Skin ΔE 3 mm | Skin ΔE rendered 3 mm |
| --- | --- | --- | --- | --- | --- | --- | --- |
| rs-woman | default | – | 6.48 | 9.81 | 7.30 | 5.52 | 15.34 |
| | A 1.5 | 38 | 6.49 | 9.84 | 7.31 | 5.56 | 15.07 |
| | A 3 | 75 | 6.52 | 9.87 | 7.36 | 5.65 | 14.82 |
| | B | 337 | 7.24 | 10.35 | 8.29 | 5.12 | 15.78 |
| | C 1.5 / C 3 | 337 / 338 | 7.24 | 10.35 / 10.36 | 8.29 / 8.30 | 5.12 | 15.78 |
| rs-portrait | all | 0 | 6.42 | 5.78 | 7.27 | 6.46 | 3.60 |
| rs-einstein | default | – | 6.87 | 9.74 | 7.57 | 5.65 | 15.66 |
| | A 1.5 | 9 | 6.87 | 9.74 | 7.57 | 5.67 | 15.60 |
| | A 3 | 17 | 6.88 | 9.74 | 7.59 | 5.68 | 15.54 |
| | B | 133 | 7.19 | 9.99 | 8.12 | 5.68 | 15.86 |
| | C 1.5 / C 3 | 135 / 138 | 7.19 | 9.99 | 8.12 / 8.13 | 5.67 | 15.84 / 15.82 |
| rs-jesus | default | – | 5.47 | 7.25 | 6.54 | 4.97 | 11.08 |
| | A 1.5 / A 3 | 1 / 2 | 5.48 | 7.25 | 6.54 | 4.98 / 4.97 | 11.07 / 11.06 |
| | B | 134 | 5.94 | 7.62 | 7.19 | 5.21 | 10.48 |
| | C 1.5 / C 3 | 134 / 135 | 5.94 | 7.62 | 7.19 / 7.20 | 5.21 / 5.20 | 10.48 / 10.47 |
| rs-dog (control) | default | – | 4.17 | 4.95 | 8.32 | 7.90 | 6.63 |
| | A 1.5 / A 3 | 1 | 4.17 | 4.95 | 8.32 | 7.90 | 6.59 |
| | B | 26 | 4.32 | 5.08 | 8.44 | 8.02 | 6.57 |
| | C 1.5 / C 3 | 27 | 4.32 | 5.08 | 8.44 | 8.02 | 6.53 |
| cat-rule (control) | default | – | 6.27 | 5.85 | 6.54 | 5.00 | 4.69 |
| | A 1.5 / A 3 | 0 | 6.27 | 5.85 | 6.54 | 5.00 | 4.69 |
| | B, C 1.5, C 3 | 6 | 6.29 | 5.86 | 6.75 | 5.08 | 4.79 |

Colour changes against the default (all are between the two topazes):

| Design | A 1.5 | A 3 | B | C 3 |
| --- | --- | --- | --- | --- |
| rs-woman | S→C 38 | S→C 75 | C→S 193, S→C 144 | C→S 193, S→C 145 |
| rs-portrait | none | none | none | none |
| rs-einstein | S→C 9 | S→C 17 | C→S 70, S→C 63 | C→S 70, S→C 68 |
| rs-jesus | S→C 1 | S→C 2 | S→C 130, C→S 4 | S→C 131, C→S 4 |
| rs-dog | S→C 1 | S→C 1 | S→C 25, C→S 1 | S→C 26, C→S 1 |
| cat-rule | none | none | S→C 6 | S→C 6 |

(S = Smoked Topaz, C = Colorado Topaz.) Skin-area stones per colour for every design and variant are
in `IS-05d-results/numbers.json` (`<design>.rows[].skinByColour`).

**Controls.** A: cat-rule unchanged; rs-dog one stone Smoked → Colorado Topaz (in its skin area).
B and C: rs-dog 26–27 stones, 24 of them outside the skin area (stones laid as Smoked or Colorado
Topaz whose AI colour is not counted as skin, e.g. darker than L\* 25; B acts on the stone colour,
not the AI colour), cat-rule 6 stones. rs-portrait has no
topaz and is unchanged by every variant.

## 5. Findings

- **A** does what it says and nothing else: it acts only on the closest ties (woman 38 / 75 stones,
  einstein 9 / 17, jesus 1 / 2, dog 1, cat 0), always towards Colorado Topaz. Per-stone ΔE moves by
  at most 0.04, the rendered comparison improves on every design that has topaz (woman shadow
  23.47 → 22.36 at 3 ΔE). Visually the patch is a little smaller at its edges and still there: with
  3 ΔE, 203 of the 521 shadow stones are still Smoked Topaz, because for them Smoked Topaz is
  clearly nearer the colour the service samples.
- **B** turns the hard patch edges into a texture, which is the visible effect Alex asked for, but
  the texture leans dark (2:1 Smoked on most of the woman's shadow), extends Smoked Topaz into areas
  that were Colorado Topaz (left cheek), and costs 0.3–0.8 per-stone ΔE on the faces. Its own
  target measure (ΔE 3 mm) improves (woman shadow 7.68 → 6.84) because it matches the RGB colour; the
  rendered comparison gets worse on woman and einstein and better only on jesus (where B adds
  Colorado Topaz). It also reaches the dog's dark fur. At 2.1 mm pitch a 1:2 or 1:1 pattern of
  stones of L\* 29 and 47 reads as speckle at the preview's size, not as a mid-brown.
- **C** is B within one to four stones: B overrides A wherever B acts, and A's near-ties are
  almost always stones B mixes.
- The patch is not a rule problem. The service matches the AI image's RGB, ignoring that the AI drew
  the woman semi-transparent; on white it looks lighter and warmer than the colour that is matched.

## 6. Recommendation

**A with `warm_shadow_de = 3`** (variant "warm-3"), if one variant is to be shipped. It is the only
variant that moves the woman towards what the AI image looks like, it is near-neutral on per-stone
ΔE, and it leaves the controls alone (dog one stone, cat none). Not applied: `DEFAULT` is unchanged.

Open, for Alex (not tried here):

1. **Composite the AI image on white before sampling colours** (or on the garment colour, if that
   is what the buyer will see). This would change every colour read in the service (detections,
   delivered stones, skin_nearest), not only the shadow, so it is a separate experiment; the woman,
   einstein and jesus AI images are semi-transparent, the portrait is not.
2. B's mix target could be the composited colour of item 1; with it, B would lean towards Colorado
   Topaz instead of Smoked Topaz. Without item 1, B is not recommended.
3. A catalogue stone between the two topazes (IS-05c section 2.4) remains the only way to a flat
   mid-brown.

## 7. Tests

- Strass service (`python -m unittest -v`, equivalence test included, `caffeinate -i`): **109 tests,
  OK, none skipped**, 4336 s. The equivalence test finds the package and the prototype identical on
  all 12 images.
- `npm test`: 143 tests, all pass (the provider-leak test included).

## 8. Files

- `services/strass/strass_layout/rules.py`: `warm_shadow`, `warm_shadow_de`, `mixed_shadow` (off
  everywhere).
- `services/strass/strass_layout/faces.py`: `skin_nearest(..., warm_de)`, `mixed_shadow`, `_rows`,
  `MIX_PATTERNS`; `finish_faces` runs `mixed_shadow` after `calm_skin`.
- `services/strass/strass_layout/pipeline.py`: reads the stone colours for `mixed_shadow` too.
- `services/strass/tests/test_is05d.py` (new); `services/strass/scripts/is05d_runs.py` (new,
  diagnosis only); `tools/is05d-results.mjs` (new); `docs/IS-05d-results/`.
