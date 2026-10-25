# exp-engine — a stone placement engine for the design concept

Status: experiment, branch `exp-engine`, four builds on 25 Oct 2026. Production is unchanged: the
engine runs only with `IS_ENGINE=concept` (spec 7.8); the default stays today's pipeline (spec 7.5,
7.6). The strass service is unchanged: it still gives the detections (`report.discsAtMm`), the pupils
and face, and the natural size (`mmPerPx`, `offsetMm`), so designs keep their size and frame.

No provider calls. Material: the saved AI images of the 9 CC0 fixtures (`tools/fixtures/is03b-ai/`),
the 12 RS images (`services/strass/prototype/img/`) and the private photos in three styles (colour,
B&W halftone, B&W stencil2), with the /layout answers saved in exp-faces (the three CC0 "norule"
images laid out once by the local service, `data/exp-engine/layouts/`). Private results only in
`data/private-portraits/engine.html`.

Build 2 (sections 1-6) answers Alex's review of build 1: holes everywhere, brows unfinished, faces not
as the concept says. Faces stay for build 3; build 2 fixes the engine underneath them. Build 1 is kept
below as history.

## Build 4: face features by size

Alex's review of build 3: on the family photos the built faces fail, because most eyes there are 6 to
10 mm wide (3 to 5 stones), too small for the concept's full eye. Build 4 designs each feature by its
size (concept section 5, revised; section 1's hole limit is now 1.4 mm too) and tries bigger faces
(head-and-shoulders crops of the private photos). Production is unchanged (spec 7.8: the pipeline
passes no landmarks). Builds 3, 2 and 1 follow as history.

### B4.1 What was built

1. **Designs by size** (`src/engine/faces.js` `eyeDesign`, `mouthDesign`). Eyes by their width
   (corner to corner): **full** from 10 mm (build 3's eye), **simple** from 6 mm, else **kept**. Both
   eyes of a face get the smaller eye's design, so they stay alike (a turned face's far eye decides).
   Lips by the mouth's width: **full** from 14 mm, **simple** from 7 mm, else **kept**; **line** (the
   mouth line only) for a full or simple mouth under hair.
2. **Simple eye** (`features.js buildSimpleEyes`): the upper lid a chain of SS4 Jet; the pupil one Jet
   stone, as the full eye's (half the iris at most, SS6 at least, both eyes the same), allowed up to
   1 mm below the iris centre since there is no lower lid; one Crystal white on each side of it along
   the eye (SS6, else SS4) where it fits inside the opening. No iris ring, lower lid, catch-light or
   lashes. Its region is the lid chain's path and the lower lid curve 0.4 mm further down.
3. **Kept eye and mouth** (`place.js`, `features.js cleanKept`): today's stones (the AI's) in an
   ellipse around the feature, cleaned: in an eye the pupil (the largest stone of L\* 35 or less within
   the iris) stays as it is; every other stone whose colour is not one of the feature's (eye: Jet,
   Crystal, the skin's tones and its lower-lid tone; mouth: those and the lip tones) takes the nearest
   of them (CIEDE2000). Black & white designs are Jet and Crystal already.
4. **Simple mouth**: the mouth line as the full mouth's (an open mouth: along both inner lips, with
   the teeth) and both lips packed in one lip tone (the most common colour of the AI's lip discs); no
   outline.
5. **No lips over a moustache or beard** (`map.js lipsUnderHair`): the hair's tones are the AI's brow
   colours (outside the skin ramp, whose dark end is as often skin shadow), the colours of its discs
   over the forehead, and the light greys (white hair); less the cheeks' tones. The lips are under hair
   when at least 40 % of the AI's non-ink discs on the upper lip (a moustache) or the lower lip (a
   beard) are hair tones, and at least 30 % between the nose and the upper lip or in a chin band below
   the lower lip are too (a lip drawn in a hair-like tone, as red hair and lip shading share Colorado
   Topaz, has skin around it). Black & white: Jet on 80 % of the lips and of the band above them.
   Then only the mouth line is built, in the darkest colour the AI drew along it, and its region is a
   band of 1.2 mm around the line, so the hair's area runs on over the lips.
6. **Check 5 by design** (`checks.js`): a full eye as before; a simple eye its upper lid (70 %), a white
   (one light stone; no catch-light is set apart) and its pupil; a kept eye its pupil (L\* 35 or less,
   SS4 or more). Full lips their outline; simple and line mouths their mouth line (a line mouth
   against the skin alone); a kept mouth nothing. The catch-light is now the light stone touching the
   pupil above its centre and closest to it (before, a white touching the pupil higher up could be
   taken for it).
7. **Bigger faces** (`tools/exp-faces-size.mjs hs`, private): for each private photo whose prepared
   photo has one face (9 of 12), the prepared photo made again as the app makes it, a
   head-and-shoulders crop (the face 45 % of the crop's width, the top half a face height above the
   forehead, 1.3 times as high as wide), and the crop through the production pipeline in colour: one
   provider call each, 9 calls in all, no retry, no automatic re-run. All 9 were accepted (0 stones
   removed, coverage 0.63–0.67).

### B4.2 Results

Public faces (the RS images; the private results are in `data/private-portraits/faces-size.html`):

| Set | Designs | Faces | Eyes: full · simple · kept | Mouths: full · simple · line · kept | Check 5 today | Check 5 engine |
| --- | ---: | ---: | --- | --- | ---: | ---: |
| photos | 3 | 3 | 4 · 2 · 0 | 1 · 1 · 1 · 0 | 0/3 | 3/3 |

Each face: the eyes' and the mouth's width, the design they got (the hair share over the lips), and
check 5 for today's design and the engine's:

| Design | Face | Eyes: width mm (design) | Mouth: width mm (design; hair over the lips) | Who | Check 5 | Eyes (left — right) | Lips |
| --- | ---: | --- | --- | --- | --- | --- | --- |
| rs-einstein | 1 | 13.8 · 10.1 (full) | 26.3 (line; 0.88) | today | fail | full: outline no (0.62/0.86) · white 1 · pupil 4.7 · catch-light yes → **fail** — full: outline no (0.29/0.95) · white 0 · pupil 4.7 · catch-light yes → **fail** | line: outline yes (0.84) · mouth line yes (0.79) → ok |
| | | | | engine | **pass** | full: outline yes (0.9/1) · white 5 · pupil 2 · catch-light yes → ok — full: outline yes (0.71/1) · white 2 · pupil 2 · catch-light yes → ok | line: outline yes (0.72) · mouth line yes (1) → ok |
| rs-portrait | 1 | 14.4 · 21.8 (full) | 29 (full; 0) | today | fail | full: outline no (0.62/0.33) · white 8 · pupil 2.8 · catch-light yes → **fail** — full: outline no (0.81/0.38) · white 10 · pupil 2.8 · catch-light yes → **fail** | full: outline yes (0.94) · mouth line no (0.66) → ok |
| | | | | engine | **pass** | full: outline yes (1/1) · white 6 · pupil 4 · catch-light yes → ok — full: outline yes (1/1) · white 6 · pupil 4 · catch-light yes → ok | full: outline yes (1) · mouth line yes (1) → ok |
| rs-woman | 1 | 11 · 6.5 (simple) | 12.8 (simple; 0) | today | fail | simple: outline no (0.57/0.14) · white 3 · pupil 4.7 → **fail** — simple: outline no (0.24/0) · white 0 · pupil 4.7 → **fail** | simple: outline no (0.63) · mouth line no (0.42) → **fail** |
| | | | | engine | **pass** | simple: outline yes (1/0.81) · white 2 · pupil 2 → ok — simple: outline yes (1/1) · white 1 · pupil 2 → ok | simple: outline no (0.26) · mouth line yes (1) → ok |

Checks 1-4:

| Design | Who | Stones | 1 Gaps: viol. / min | 2 Lines clean · other colour · breaks | 3 Patches <4 | 4 Holes ≥1.4 mm | Faces passing check 5 |
| --- | --- | ---: | --- | --- | ---: | ---: | --- |
| rs-einstein | today | 3594 | 0 / 0.1 | 37/71 · 22 · 0 | 462 | 58 | 0/1 |
|  | engine | 3433 | 0 / 0.1 | 64/71 · 1 · 0 | 1 | 21 | 1/1 |
| rs-portrait | today | 4045 | 0 / 0.1 | 7/35 · 2 · 4 | 674 | 223 | 0/1 |
|  | engine | 4031 | 0 / 0.1 | 34/35 · 0 · 0 | 3 | 34 | 1/1 |
| rs-woman | today | 2627 | 0 / 0.1 | 6/14 · 4 · 1 | 158 | 39 | 0/1 |
|  | engine | 2552 | 0 / 0.1 | 12/14 · 0 · 0 | 0 | 13 | 1/1 |

Private photos, in numbers only (colour; 12 photos with 16 faces, and their 9 head-and-shoulders
crops):

| Set | Faces | Eyes: full · simple · kept | Mouths: full · simple · line · kept | Check 5 today | Check 5 engine |
| --- | ---: | --- | --- | ---: | ---: |
| photos | 16 | 2 · 24 · 6 | 12 · 3 · 1 · 0 | 1/16 | 14/16 |
| head-and-shoulders crops | 9 | 14 · 4 · 0 | 9 · 0 · 0 · 0 | 0/9 | 6/9 |

What it shows:

- **Sizes.** On the photos as they are, 24 of 32 eyes are 6–10 mm (simple), 6 under 6 mm (kept), 2
  full; with simple eyes 14 of 16 faces pass check 5 (build 3's full eyes: most failed for want of
  room for the white). The two failures: a closed eye (0.9 mm high) has no pupil to keep, and a tiny
  face's kept eye whose pupil the AI drew off the landmark iris.
- **Crops.** The head-and-shoulders crop makes the face bigger in the design where the photo showed
  more than head and shoulders (eyes 6.4 → 11.7 mm, 7.3 → 11.6, 9.8 → 11.9), and hardly where it
  already was one (9.8 → 10.4): the AI draws about the same number of stones across whatever it is
  given, so the design's natural size stays about the same and the face takes more of it. 14 of 18
  eyes are full on the crops. 6 of 9 pass check 5; the failures are room, not design: a nearly closed
  eye (the smaller eye, 8.7 mm, makes both simple, and no white fits in it), a full eye with room for
  one white only, and an upper lid that covers 67 % of the lid (70 % asked) under glasses.
- **Beards.** Einstein's white moustache and a groom's red beard get only the mouth line. Without the
  second condition (hair beside the lips) a woman with red hair lost her lips; with it, no false
  find on the 28 faces.
- **Not met, or open.** The landmarks of a turned or small face can sit off the AI's drawing (rs-woman's
  lips, a smiling man's teeth): the features are built where the landmarks are, and the AI's teeth are
  then missed. Full lips read heavy (dark lip tones, lipstick-like) on children's faces. A simple eye
  has no catch-light, as asked; the eyes look flatter for it.

### B4.3 Pictures

Each face: the image | AI image | today | engine with faces by size; then the eyes and the mouth.

### rs-woman (simple eyes, simple mouth)

![rs-woman](exp-engine/b4/rs-woman.jpg)

### rs-portrait (full eyes, full lips)

![rs-portrait](exp-engine/b4/rs-portrait.jpg)

### rs-einstein (full eyes, mouth line under the moustache)

![rs-einstein](exp-engine/b4/rs-einstein.jpg)

## Build 3: faces, holes, lines leaving the subject

Build 3 (this section) adds the faces of concept section 5, check 5, the hole step and the new check 4
(holes of 1.4 mm or more), and keeps lines that leave the subject. Builds 2 and 1 follow as history.
Production is unchanged: the pipeline still runs the engine only with `IS_ENGINE=concept`, and it has
no landmark source, so in the pipeline faces keep today's eye and mouth stones (spec 7.8).

### B3.1 What was built

1. **Landmarks** (exp-faces setup, its files checked out singly, the branch not merged):
   `services/strass/scripts/face_landmarks.py` (MediaPipe Face Landmarker, Face Mesh V2, Apache 2.0,
   own venv `services/strass/.venv-faces`, model `services/strass/models/mediapipe/`, both
   git-ignored). `tools/exp-engine.mjs` finds the faces as exp-faces did: the AI image blurred by
   0.6 mm; with a prepared photo, the AI's faces matched to the photo's (iris centres within 0.6 eye
   distances; false finds dropped, a photo face with no AI face used as mapped); RS images without a
   photo at confidence 0.7. Each eye moves to the service's pupil where one lies within 1.5 iris radii
   (at least 1.5 mm) of the landmark iris. The cached landmarks of exp-faces are reused.
2. **Geometry and regions** (`src/engine/faces.js`): each eye's lids fitted as an almond (a cubic
   through both corners, least squares to the lid landmarks), its iris, the brows' upper and lower
   edges, the nose (bridge, tip, base, alae), the lips, the face oval. Polygon regions: each eye and
   the mouth (the path of their outer chains: areas, outline and lines stay out; map lines also 2.5 /
   1.5 mm around them) and the nose (lines only). An eye under 5 mm wide or 1.6 mm high keeps today's
   stones (a pupil region around it). Faces without landmarks (animals, Jesus) keep build 2's pupil
   regions.
3. **Features** (`src/engine/features.js`, by concept section 5): upper lid an SS6 Jet chain; lower lid
   an SS4 chain (SS6 on eyes 18 mm wide) in a tone 20 L\* darker than the skin (the skin area's own
   tone, else its ramp's); both half a stone radius outside the curves (a whole radius on eyes under
   6 mm high, so the white keeps room). Pupil one Jet stone, the largest of SS20, SS16, SS10, SS6 at
   most half the iris width that fits in both eyes (both the same size), at the iris centre or up to
   0.4 iris radii off, preferring a spot where the catch-light fits too. Catch-light one Crystal SS4
   touching the pupil, 45° up towards the light (turning to straight up or 30° below the horizontal
   if blocked, always on the light's side). Light side: the cheek band's mean L\* left against right
   in the AI image; 4 L\* or more decides, else upper right. Iris ring of SS4 in the iris colour (the
   photo's, else the AI's mid-tone iris discs) when it fits within 0.5 mm of the iris and a third of
   it (3 stones at least) shows between the lids, the rest of the iris SS4 in that colour. Eye white
   Crystal, packed (SS6 lattice along the eye, then SS6 and SS4 farthest-first). Lashes when the AI drew
   them (dark share above the outer half of the upper lid at least 0.35 and 0.15 above the inner
   half): a chain of 2–5 SS4 Jet from the outer corner, turned up. Brows from the landmarks (between
   the upper and lower brow edges, moved to the AI's dark discs beside them by up to 2.5 mm; one row,
   a second on the inner 55 % where thicker than 1.4 stones; the colour of those discs; no brow where
   the AI drew none). Nose: each nostril one dark stone (SS6 or SS4) at the darkest spot near it where
   the AI drew it 6 L\* darker than the cheeks; a shadow chain of SS4 from the bridge towards the tip on
   the darker side, a tone 8 L\* darker than the skin, only where the AI's side is 8 L\* darker than the
   cheeks and 3 darker than the other side. Lips: outline a closed chain (SS4, SS6 on mouths 35 mm
   wide) in a lip tone 10 L\* darker than the upper lip; mouth line SS4 a further 6 L\* darker (open
   mouth: one along each inner lip); upper lip packed in the darker tone (at least 6 L\* darker than
   the lower), lower lip in the lighter one; the tones from the AI's lip discs (L\* 35 or more, so not
   its dark outline) and their ramp. Teeth: Crystal on a lattice along the mouth where the AI is light
   (L\* 62 or more over 15 % of the opening), the rest of the opening the darkest lip tone. Black &
   white: lids, lashes, pupil, iris, nostrils, nose shadow, lip outline, mouth line and upper lip Jet;
   white, catch-light, lower lip and teeth Crystal. The face contour is not built in this build (the
   subject outline and the map's lines carry it).
4. **Check 5** (`checks.js checkFaces`), measured on any design against the landmarks: per eye the
   outline (the upper lid's middle 80 % within 1.3 mm of a stone 25 L\* darker than the cheeks' stones,
   at least 70 %; the lower lid's 8 L\* darker, at least 60 %), the white (two light stones, L\* 80 or
   more, in the opening besides the catch-light), the pupil (a stone of L\* 25 or less and SS6 or more
   at the iris centre), the catch-light (the highest of the smallest light stones touching the pupil)
   and its side; the lips' outline (10 L\* darker than the skin along 70 %) and mouth line (8 L\*
   darker than the lower lip and the skin along 70 % of its middle). In black & white dark means Jet. A
   face passes with every eye's outline, white and pupil and the lips' outline.
5. **Check 4 and the hole step.** Check 4 now counts holes of 1.4 mm or more (the concept's wording
   is updated). The hole step (`place.js closeHoles`), after the settle step and fill: every hole of
   1.4 mm or more, largest first; the area and seam stones within 2.6 mm of it move in small steps
   (each at most 0.6 mm), every pair closer than 0.1 mm pushed apart, a stone that would leave the
   subject or enter a face region held back, lines, outline, brows and features fixed: first *close*
   (the rim stones step towards the centre), else *open* (an SS4 at the centre, the stones pushed out;
   it takes its neighbours' colour). A try is kept only with every gap at least 0.1 mm, the hole gone
   and fewer holes of 1.4 mm or more within 4 mm than before; three passes.
6. **Lines that leave the subject** (`map.js`): the subject's thin, long parts (what an opening by
   1.6 mm removes, at least 4 mm long and at most 3.2 mm wide on average) are strands, not body. Their
   discs are line ink by their lightness, the edge discs joining them to the body are no edge, and the
   edge does not cut a line within 2.5 mm of a strand, so a whisker runs on from the face out along the
   strand as one chain (its stones may come to 0.4 of their radius of the edge). The subject outline
   follows the body, so it no longer runs round the whiskers' shapes and cuts them; where a whisker
   leaves, the outline stops at the whisker chain and goes on beyond it. No area row or honeycomb
   goes into a strand; the seam fill does where a stone still fits.
7. A tools fix: `tools/exp-holes.mjs tintedPng` cropped renders by an SS6 margin; where SS4 are the
   main stone (an eye) the crop was shifted. It uses the render's own canvas now.

### B3.2 Results (CC0 and RS)

"engine, no faces" is the engine with build 2's face handling (today's eye and mouth stones kept) and
build 3's other changes; "engine, faces" builds the faces (the same design where there is no landmark
face). All three designs are checked against the map with faces. "Before the hole step" is the
engine's histogram of empty circles just before step 5c.

| Set | Designs | Who | Gap pass | Clean lines | Other colour | Breaks | Missing | Patches <4 | Holes ≥1.4 mm (designs passing) | Holes 0.6 · 0.8 · 1.0 · 1.2 · 1.4+ mm | Before the hole step | Faces passing check 5 | Eyes: outline · white · pupil · catch-light (of) | Same side | Lips: outline · mouth line | ms mean / max |
| --- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- | ---: | --- | --- |
| CC0 | 9 | today | 9/9 | 71/176 | 81 | 8 | 8 | 2817 | 941 (0) | 16926 · 9984 · 5048 · 2131 · 951 |  | – | – | – | – | 529 / 711 |
|  |  | engine, no faces | 9/9 | 165/176 | 1 | 0 | 7 | 0 | 112 (0) | 17134 · 18697 · 3374 · 919 · 165 | 17105 · 18769 · 3250 · 801 · 370 | – | – | – | – | 4155 / 5635 |
|  |  | engine, faces | 9/9 | 165/176 | 1 | 0 | 7 | 0 | 112 (0) | 17134 · 18697 · 3374 · 919 · 165 | 17105 · 18769 · 3250 · 801 · 370 | – | – | – | – | 4155 / 5635 |
| RS | 12 | today | 12/12 | 228/486 | 71 | 24 | 30 | 3894 | 981 (1) | 24314 · 15275 · 6975 · 2441 · 1008 |  | 0/3 | 0 · 3 · 6 · 5 (6) | 2 | 2 · 0 | 577 / 842 |
|  |  | engine, no faces | 12/12 | 435/486 | 2 | 2 | 30 | 50 | 280 (0) | 25346 · 28388 · 5440 · 1501 · 315 | 25338 · 28514 · 5259 · 1310 · 562 | 0/3 | 0 · 3 · 6 · 5 (6) | 2 | 2 · 0 | 4718 / 7337 |
|  |  | engine, faces | 12/12 | 443/486 | 1 | 1 | 30 | 5 | 268 (0) | 25213 · 28717 · 5438 · 1474 · 306 | 25231 · 28818 · 5283 · 1311 · 545 | 2/3 | 6 · 5 · 6 · 6 (6) | 3 | 3 · 3 | 4677 / 7337 |

Check 5 per face:

| Design | Face | Who | Pass | Eyes (left · right): outline (upper/lower cover) · white · pupil (SS mm, share of iris width) · catch-light | Same side | Lips: outline · mouth line |
| --- | ---: | --- | --- | --- | --- | --- |
| rs-einstein | 1 | today | fail | no (0.62/0.86) · no · 4.7 (0.83) · yes — no (0.29/0.95) · no · 4.7 (0.91) · yes | yes | yes (0.84) · no (0.33) |
|  |  | engine, no faces | fail | no (0.62/0.86) · no · 4.7 (0.83) · yes — no (0.29/0.95) · no · 4.7 (0.91) · yes | yes | yes (0.76) · no (0.33) |
|  |  | engine, faces | **pass** | yes (0.9/1) · yes · 2 (0.35) · yes — yes (0.71/1) · yes · 2 (0.39) · yes | yes | yes (1) · yes (1) |
| rs-portrait | 1 | today | fail | no (0.62/0.33) · yes · 2.8 (0.34) · yes — no (0.81/0.38) · yes · 2.8 (0.32) · yes | yes | yes (0.94) · no (0.66) |
|  |  | engine, no faces | fail | no (0.62/0.33) · yes · 2.8 (0.34) · yes — no (0.81/0.38) · yes · 2.8 (0.32) · yes | yes | yes (0.93) · no (0.66) |
|  |  | engine, faces | **pass** | yes (1/1) · yes · 4 (0.49) · yes — yes (1/1) · yes · 4 (0.46) · yes | yes | yes (1) · yes (1) |
| rs-woman | 1 | today | fail | no (0.57/0.14) · yes · 4.7 (1.12) · yes — no (0.24/0) · no · 4.7 (1.41) · no | – | no (0.63) · no (0.42) |
|  |  | engine, no faces | fail | no (0.57/0.14) · yes · 4.7 (1.12) · yes — no (0.24/0) · no · 4.7 (1.41) · no | – | no (0.63) · no (0.42) |
|  |  | engine, faces | fail | yes (0.86/1) · yes · 2 (0.48) · yes — yes (0.76/1) · no · 2 (0.6) · yes | yes | yes (0.99) · yes (0.97) |

Features that could not be built, and why:

- **rs-cat**: no features built: no landmark face found in the AI image.
- **rs-dog**: no features built: no landmark face found in the AI image.
- **rs-einstein** (1 face): face 1 nose shadow: not drawn.
- **rs-jesus**: no features built: no landmark face found in the AI image.
- **rs-portrait** (1 face): face 1 left eye iris ring: ring does not fit (3 of 10).
- **rs-woman** (1 face): face 1 left eye iris ring: iris too small for a ring; face 1 right eye iris ring: iris too small for a ring; face 1 right eye white: room for 1 stone only (6.46 x 4.45 mm); face 1 right eye lashes: no room (outside the subject or against other stones).

What met the rules:

- **Check 1** on every design (0 violations, smallest gap 0.1 mm), faces and hole step included.
- **Check 5**: RS Einstein and the RS portrait pass with faces; today and the engine without faces
  pass none (the AI's eyes have no lower lid outline, and the SS20 pupils fill the eye). RS woman fails
  on the far eye of her turned face: 6.5 × 4.5 mm, room for one white stone beside the lids, pupil and
  catch-light. Pupils are SS6 (Einstein, woman) and SS16 (portrait): at most half the iris width, as
  the concept says, much smaller than the AI's and today's SS20. Catch-lights on the same side on all
  three faces; the light side came from the shading on the woman (left) and the portrait (right), and
  was unclear on Einstein (upper right).
- **Holes (new check 4)**: no design passes yet, but holes of 1.4 mm or more fall from today's 1922
  to 380 (check 4, CC0 and RS, engine with faces); by the histogram's 1.4 mm bin from 1959 to 471, 915
  just before the hole step. The step targeted 1596 holes,
  closed 291 and opened 108. Of the 397 holes left, 319 have only stones on their rim that may not
  move (lines, outline, brows, features, kept face stones): the step cannot reach them without moving
  line or feature stones, which this build does not do.
- **Lines leaving the subject**: strands on cc0-cat-norule and cc0-cat-rule (5 each; 4 and 5 with a
  whisker chain), rs-portrait, Einstein and Jesus (hair), rs-tulips, rs-logo (25 thin letter strokes,
  8 with a chain). The dogs and rs-cat have none: their AI images draw no whisker or strand over the
  background, so the fix changes nothing there.

Not met, or open:

- Faces only where landmarks exist: Jesus is a profile (the service calls it an animal with one
  pupil) and MediaPipe finds no face, so it keeps today's stones; animals keep build 2's handling.
- The pipeline has no landmark source; faces in production need one (the strass service, or the
  direct path), a decision of its own (exp-faces section 3).
- Look: the concept's eye has a small pupil (half the iris), lids on both sides and a white, where
  the AI draws a large dark pupil; on Einstein's deep-set eyes it reads busier than the AI's. Under a
  moustache (Einstein) the lips are built where the landmarks put them, over the moustache.
- The private photos (`data/private-portraits/engine.html`) show the same in all three styles; their
  faces are mostly small (eyes 6–10 mm wide, some under 5 mm, which keep today's stones), and there
  the eye white most often does not fit: a narrow eye's opening is little higher than an SS6 pupil.

Per design:

| Design | | Stones | ms | Size mm | 1 Gaps: viol. / min | 2 Lines: clean · other colour · other size · breaks · missing | 3 Areas: >3 tones (max) · patches <4 | 4 Holes ≥1.4 mm / largest | Holes 0.6 · 0.8 · 1.0 · 1.2 · 1.4+ mm | Before the hole step: 0.6 · … · 1.4+ |
| --- | --- | ---: | ---: | --- | --- | --- | --- | --- | --- | --- |
| cc0-car-rule | today | 3548 | 710 | 260 × 87.4 | 0 / 0.1 | 14/35 · 21 · 30 · 2 · 0 | 14 (10) · 315 | 210 / 1.7 | 2044 · 1732 · 1176 · 568 · 220 |  |
|  | engine, no faces | 3709 | 5635 | 259 × 86.7 | 0 / 0.1 | 33/35 · 0 · 0 · 0 · 1 | 0 (3) · 0 | 10 / 1.69 | 2865 · 3093 · 499 · 115 · 23 | 2878 · 3092 · 471 · 99 · 51 |
| cc0-cat-norule | today | 3148 | 578 | 158.4 × 120.8 | 0 / 0.101 | 13/33 · 7 · 34 · 2 · 0 | 32 (10) · 701 | 95 / 1.7 | 2463 · 1800 · 787 · 264 · 95 |  |
|  | engine, no faces | 3168 | 5108 | 157.6 × 120 | 0 / 0.1 | 31/33 · 0 · 0 · 0 · 2 | 0 (3) · 0 | 21 / 1.64 | 2401 · 2713 · 541 · 138 · 23 | 2397 · 2721 · 528 · 119 · 56 |
| cc0-cat-rule | today | 3579 | 711 | 167.8 × 125.7 | 0 / 0.101 | 5/29 · 20 · 81 · 1 · 2 | 37 (10) · 574 | 80 / 1.68 | 3482 · 1286 · 391 · 144 · 78 |  |
|  | engine, no faces | 3531 | 5336 | 167.1 × 125.2 | 0 / 0.1 | 25/29 · 0 · 1 · 0 · 3 | 0 (3) · 0 | 17 / 1.65 | 2628 · 3210 · 560 · 134 · 25 | 2604 · 3235 · 542 · 130 · 54 |
| cc0-dachshund-rule | today | 1633 | 370 | 159.2 × 106.4 | 0 / 0.102 | 5/13 · 1 · 13 · 0 · 0 | 11 (7) · 110 | 15 / 1.65 | 1299 · 710 · 229 · 58 · 16 |  |
|  | engine, no faces | 1549 | 2819 | 157.4 × 105.8 | 0 / 0.1 | 13/13 · 0 · 0 · 0 · 0 | 0 (3) · 0 | 8 / 1.65 | 1247 · 1328 · 250 · 73 · 14 | 1242 · 1322 · 250 · 70 · 22 |
| cc0-dog-norule | today | 2084 | 484 | 87 × 203.1 | 0 / 0.1 | 6/12 · 0 · 2 · 0 · 2 | 22 (13) · 238 | 94 / 1.66 | 1284 · 1072 · 714 · 225 · 76 |  |
|  | engine, no faces | 2120 | 3862 | 86.2 × 202.3 | 0 / 0.1 | 12/12 · 0 · 0 · 0 · 0 | 0 (3) · 0 | 11 / 1.61 | 1696 · 1934 · 371 · 93 · 9 | 1694 · 1943 · 364 · 79 · 24 |
| cc0-dog-rule | today | 2050 | 495 | 83.8 × 200.8 | 0 / 0.101 | 3/8 · 3 · 7 · 0 · 0 | 22 (8) · 247 | 65 / 1.72 | 1295 · 1122 · 664 · 176 · 73 |  |
|  | engine, no faces | 2074 | 3531 | 83.2 × 200 | 0 / 0.1 | 7/8 · 0 · 0 · 0 · 0 | 0 (3) · 0 | 13 / 1.66 | 1709 · 1754 · 329 · 99 · 17 | 1715 · 1759 · 318 · 89 · 33 |
| cc0-giraffe-rule | today | 2327 | 556 | 79.8 × 307.5 | 0 / 0.101 | 21/32 · 6 · 7 · 3 · 0 | 15 (12) · 497 | 377 / 1.71 | 1423 · 1167 · 911 · 656 · 388 |  |
|  | engine, no faces | 2395 | 4334 | 78.4 × 307.1 | 0 / 0.1 | 31/32 · 0 · 0 · 0 · 1 | 0 (3) · 0 | 24 / 1.63 | 1996 · 2072 · 359 · 127 · 38 | 1995 · 2088 · 339 · 109 · 58 |
| cc0-mug-norule | today | 2224 | 448 | 146.5 × 109.6 | 0 / 0.102 | 4/14 · 23 · 16 · 0 · 4 | 5 (5) · 99 | 4 / 1.63 | 2199 · 697 · 108 · 27 · 4 |  |
|  | engine, no faces | 2105 | 3429 | 145.9 × 109.1 | 0 / 0.1 | 13/14 · 1 · 0 · 0 · 0 | 0 (1) · 0 | 3 / 1.67 | 1660 · 1719 · 232 · 54 · 10 | 1662 · 1722 · 228 · 45 · 21 |
| cc0-mug-rule | today | 1751 | 410 | 130.4 × 96 | 0 / 0.103 | 0/0 · 0 · 0 · 0 · 0 | 2 (5) · 36 | 1 / 1.41 | 1437 · 398 · 68 · 13 · 1 |  |
|  | engine, no faces | 1737 | 3338 | 130.3 × 96.4 | 0 / 0.1 | 0/0 · 0 · 0 · 0 · 0 | 0 (2) · 0 | 5 / 1.52 | 932 · 874 · 233 · 86 · 6 | 918 · 887 · 210 · 61 · 51 |
| rs-cat | today | 2162 | 444 | 103 × 130.8 | 0 / 0.1 | 11/35 · 5 · 32 · 3 · 0 | 40 (9) · 367 | 81 / 1.7 | 1690 · 1093 · 485 · 192 · 80 |  |
|  | engine, no faces | 2159 | 3531 | 102.4 × 130.4 | 0 / 0.1 | 27/35 · 0 · 0 · 1 · 6 | 0 (3) · 1 | 20 / 1.59 | 1744 · 1701 · 340 · 113 · 21 | 1755 · 1709 · 324 · 99 · 42 |
| rs-dog | today | 1683 | 417 | 96.6 × 160.6 | 0 / 0.102 | 4/7 · 0 · 4 · 0 · 0 | 7 (10) · 152 | 48 / 1.65 | 1281 · 1117 · 564 · 160 · 44 |  |
|  | engine, no faces | 1742 | 2983 | 95.6 × 159.9 | 0 / 0.1 | 7/7 · 0 · 0 · 0 · 0 | 0 (2) · 0 | 8 / 1.65 | 1341 · 1347 · 329 · 72 · 9 | 1343 · 1349 · 321 · 63 · 32 |
| rs-einstein | today | 3594 | 806 | 150.2 × 143.2 | 0 / 0.1 | 37/70 · 22 · 29 · 0 · 6 | 43 (11) · 458 | 58 / 1.68 | 2868 · 1680 · 544 · 148 · 66 |  |
|  | engine, no faces | 3434 | 5764 | 149.8 × 142.5 | 0 / 0.1 | 58/70 · 2 · 13 · 1 · 3 | 3 (4) · 30 | 31 / 1.67 | 2871 · 3202 · 641 · 188 · 36 | 2871 · 3215 · 621 · 160 · 63 |
|  | engine, faces | 3442 | 5983 | 149.8 × 142.5 | 0 / 0.1 | 63/70 · 1 · 3 · 0 · 3 | 0 (3) · 1 | 29 / 1.67 | 2826 · 3421 · 627 · 136 · 29 | 2831 · 3425 · 613 · 131 · 48 |
| rs-jesus | today | 3307 | 689 | 145.8 × 163.9 | 0 / 0.1 | 20/52 · 11 · 44 · 4 · 1 | 31 (8) · 344 | 165 / 1.7 | 2560 · 1783 · 1060 · 518 · 158 |  |
|  | engine, no faces | 3335 | 5873 | 145.4 × 162.7 | 0 / 0.1 | 49/52 · 0 · 3 · 0 · 2 | 0 (3) · 0 | 18 / 1.64 | 2725 · 3378 · 535 · 145 · 19 | 2725 · 3393 · 515 · 121 · 38 |
| rs-lake | today | 4100 | 842 | 154.7 × 152.1 | 0 / 0.1 | 46/84 · 13 · 19 · 2 · 2 | 50 (11) · 580 | 88 / 1.7 | 3053 · 2030 · 853 · 240 · 83 |  |
|  | engine, no faces | 4009 | 7337 | 153.7 × 151.3 | 0 / 0.1 | 76/84 · 0 · 0 · 0 · 7 | 0 (3) · 0 | 29 / 1.66 | 3480 · 4026 · 630 · 168 · 36 | 3470 · 4049 · 606 · 143 · 66 |
| rs-leopard | today | 2436 | 546 | 117.3 × 153.7 | 0 / 0.101 | 22/65 · 5 · 17 · 6 · 9 | 51 (9) · 596 | 94 / 1.68 | 1868 · 1229 · 679 · 230 · 100 |  |
|  | engine, no faces | 2405 | 4408 | 116.4 × 152.7 | 0 / 0.1 | 58/65 · 0 · 0 · 0 · 7 | 0 (3) · 0 | 26 / 1.68 | 2066 · 2384 · 497 · 122 · 23 | 2070 · 2388 · 487 · 114 · 37 |
| rs-logo | today | 833 | 267 | 144.9 × 79.1 | 0 / 0.102 | 8/8 · 0 · 0 · 0 · 0 | 0 (1) · 0 | 0 / 1.37 | 118 · 167 · 84 · 6 · 0 |  |
|  | engine, no faces | 766 | 1678 | 144.2 × 78.5 | 0 / 0.1 | 5/8 · 0 · 3 · 0 · 0 | 0 (1) · 0 | 33 / 1.6 | 520 · 345 · 72 · 48 · 41 | 518 · 345 · 72 · 47 · 44 |
| rs-parrot | today | 2552 | 591 | 168.3 × 151.6 | 0 / 0.101 | 13/40 · 6 · 4 · 1 · 8 | 42 (9) · 368 | 114 / 1.67 | 1685 · 1392 · 780 · 274 · 121 |  |
|  | engine, no faces | 2514 | 4844 | 167.6 × 150.1 | 0 / 0.1 | 38/40 · 0 · 0 · 0 · 2 | 0 (3) · 0 | 23 / 1.62 | 2132 · 2464 · 513 · 128 · 29 | 2144 · 2462 · 509 · 118 · 45 |
| rs-portrait | today | 4045 | 749 | 149.5 × 166 | 0 / 0.1 | 7/35 · 2 · 35 · 4 · 4 | 25 (11) · 674 | 223 / 1.72 | 3375 · 1509 · 782 · 348 · 241 |  |
|  | engine, no faces | 3999 | 7194 | 149 × 165.4 | 0 / 0.1 | 33/35 · 0 · 0 · 0 · 1 | 2 (4) · 15 | 36 / 1.66 | 3020 · 3434 · 754 · 227 · 42 | 3011 · 3451 · 735 · 194 · 83 |
|  | engine, faces | 4031 | 7019 | 149 × 165.4 | 0 / 0.1 | 34/35 · 0 · 0 · 0 · 1 | 0 (3) · 3 | 34 / 1.65 | 2997 · 3612 · 749 · 257 · 43 | 3002 · 3625 · 726 · 224 · 88 |
| rs-rose | today | 1846 | 404 | 121 × 130.5 | 0 / 0.101 | 24/34 · 0 · 15 · 2 · 0 | 3 (5) · 65 | 21 / 1.65 | 1587 · 782 · 226 · 53 · 25 |  |
|  | engine, no faces | 1722 | 2938 | 120.1 × 130 | 0 / 0.1 | 33/34 · 0 · 0 · 0 · 0 | 0 (2) · 0 | 4 / 1.49 | 1449 · 1668 · 318 · 60 · 6 | 1447 · 1685 · 308 · 52 · 14 |
| rs-tulips | today | 2675 | 558 | 140.3 × 141.7 | 0 / 0.101 | 30/42 · 3 · 12 · 1 · 0 | 9 (7) · 133 | 50 / 1.66 | 2002 · 1286 · 552 · 187 · 48 |  |
|  | engine, no faces | 2596 | 4995 | 139.9 × 141 | 0 / 0.1 | 40/42 · 0 · 2 · 0 · 1 | 0 (2) · 0 | 26 / 1.66 | 2173 · 2369 · 402 · 108 · 29 | 2169 · 2377 · 387 · 98 · 44 |
| rs-woman | today | 2627 | 607 | 143.9 × 146.7 | 0 / 0.1 | 6/14 · 4 · 5 · 1 · 0 | 13 (6) · 157 | 39 / 1.65 | 2227 · 1207 · 366 · 85 · 42 |  |
|  | engine, no faces | 2536 | 5070 | 143.1 × 145.9 | 0 / 0.1 | 11/14 · 0 · 6 · 0 · 1 | 1 (4) · 4 | 26 / 1.69 | 1825 · 2070 · 409 · 122 · 24 | 1815 · 2091 · 374 · 101 · 54 |
|  | engine, faces | 2549 | 4536 | 143.1 × 145.9 | 0 / 0.1 | 13/14 · 0 · 0 · 0 · 1 | 0 (2) · 0 | 18 / 1.63 | 1760 · 2002 · 426 · 117 · 21 | 1757 · 2011 · 415 · 101 · 47 |

### B3.3 Pictures

Each design: original | AI image | today | engine without faces | engine with faces (whole); then
per face the eyes, nose and mouth; for designs with a strand, the strand; for animals, the face around
the service's pupils (the cats' whiskers).

### rs-woman

![rs-woman](exp-engine/b3/rs-woman.jpg)

### rs-portrait

![rs-portrait](exp-engine/b3/rs-portrait.jpg)

### rs-einstein

![rs-einstein](exp-engine/b3/rs-einstein.jpg)

### rs-jesus

![rs-jesus](exp-engine/b3/rs-jesus.jpg)

### cc0-cat-norule

![cc0-cat-norule](exp-engine/b3/cc0-cat-norule.jpg)

### cc0-cat-rule

![cc0-cat-rule](exp-engine/b3/cc0-cat-rule.jpg)

### cc0-dachshund-rule

![cc0-dachshund-rule](exp-engine/b3/cc0-dachshund-rule.jpg)

### cc0-dog-norule

![cc0-dog-norule](exp-engine/b3/cc0-dog-norule.jpg)

### cc0-dog-rule

![cc0-dog-rule](exp-engine/b3/cc0-dog-rule.jpg)

### rs-cat

![rs-cat](exp-engine/b3/rs-cat.jpg)

### rs-dog

![rs-dog](exp-engine/b3/rs-dog.jpg)

## 1. Build 2: what changed

1. **Packing** (concept sections 1 and 3). Build 1 laid rows parallel to the outline all the way in.
   Now each piece is packed as a **band** of rows parallel to its outline and to every chain in it,
   then a **honeycomb** (hexagonal lattice, pitch SS6 + 0.15 mm) inside the band, its rows along the
   piece's main direction (the principal axis of its cells), at the best of 9 lattice phases. SS6 and
   then SS4 stones close the seam where band and honeycomb meet (the hole fill of spec 7.5), then a
   settle step (row stones move into empty circles over 0.96 mm, up to 14 rounds) and the fill again.
   Tried: bands of 1 and 2 rows; packing each area on its own (as specified) and packing the areas
   that touch without a chain between them as one piece ("shared", colours still per area); and the
   honeycomb placed before the band. Empty circles over 1.0 mm on the trial design cc0-cat-rule:
   build 1 1064; per area, 1 row 1222, 2 rows 1080; shared, 2 rows 811; then 14 settle rounds instead
   of 6: 657 (24 rounds: 627, a second slower). A private photo tried alongside showed the same order
   (its numbers are on the private page); honeycomb first was no better there. Over all designs the
   1-row band is measured beside the chosen one (section 2). **Chosen: shared, 2 rows, band first, 14 settle rounds.** Packing each area separately leaves a
   seam at every colour border, also where no line runs; that is where most of its extra holes were.
2. **rs-woman bugs.**
   - *Neck outline dark red.* Cause: the outline took the darkest catalogue colour within 25° of hue
     of the area's darkest tone; light skin (light peach, hue 47°) reached Indian Siam (27°, L\* 19), a
     lip red. Fix: explicit colour ramps (skin, gold, grey, red, pink, blue, green; `map.js RAMPS`);
     an area's ramp is the one holding most of its tones and its outline is that ramp's darkest colour
     (skin: Smoked Topaz), Jet for dark or grey areas. The neck is now Smoked Topaz.
   - *Second eye's region beside the eye.* The service's pupils are right. Cause: the region was
     centred on the pupil; with a sideways gaze the pupil sits at one end of the eye, and the far eye
     of a turned face is foreshortened, so its 0.42 IPD-wide region reached past the face's edge. Fix:
     each eye region is centred between the pupil and its eye-white discs, and as wide as the eye
     whites reach plus 1.5 mm (0.30–0.42 IPD). rs-woman's far eye: centre 2 mm towards the eye, half
     width 8.4 → 6.8 mm.
3. **Brows** (concept section 5). Above each eye (0.2–0.85 IPD above its centre, ±0.5 IPD across, on
   the pupils' axis) the largest connected group of dark discs is the brow; a quadratic through them is
   its centre line. One SS6 row along all of it, and where the drawn brow is thicker than 1.4 stones a
   second row along the inner 55 %, so it is thicker at the inner end; the hair colour of its discs
   (Jet in B&W). Brow discs are neither area nor line. People only. Found on 5 public faces (RS
   Einstein, Jesus, portrait, woman), and on the private photos.
4. **Light lines.** Discs clearly lighter than the ones around them (L\* above 55 and 18 above the
   median two steps around; Crystal in B&W, in halftone only where Crystal is at most half the
   neighbourhood) are traced like the dark ones and placed as chains in their light colour: 272 light
   lines on the public designs (whiskers, highlights, light strands).
5. **Missing lines.** Chains now pass crossings with longer lines (a skipped spot holding another
   chain's stone does not break the chain; check 2 does not count a crossing's stone against the
   line), and lines may run to 1.2 mm from the edge (was 1.8). Measured against the same (new) map,
   lines with no stone of their colour: build 1 88, build 2 37 of 619 on the public designs (CC0 7,
   RS 30). Build 1's "22 lost" were against its own, smaller map. Still lost: lines that run into a
   face region, or lie along most of a longer line, or are shorter than 3 stones once the face region
   and the subject's edge are taken off.
6. **Halftone**: every halftone area is a regular ordered dither (4 × 4) of the honeycomb's lattice at
   the area's share; band stones take the index of their nearest lattice point.
7. **Render worker**: in the pipeline the engine runs in the render worker (`engineOffThread`,
   `src/render/offthread.js`), as the renders do.

The hole histogram counts every gap (a local maximum of the clearance to stones and the subject's
edge) by its diameter: 0.6–0.8, 0.8–1.0, 1.0–1.2, 1.2–1.4, 1.4 mm and more. Check 4 keeps build 1's
count (connected pieces over 1.0 mm), so the two are not the same number. "Engine before" is build 1's
engine (its stones, saved before build 2); all three designs are checked against the build 2 map.

## 2. Build 2: results (CC0 and RS)

Time: the engine takes 3.7 s per design on average (map 1.1 s, placement 2.5 s; at most 5.7 s; the
private photos up to 15 s) against today's 0.6 s. Stones: 53 473 against today's 54 204 over the 21
designs. Natural size within 1.8 mm of today's. By role: band rows 21 401, honeycomb 6 712, seam fill
13 230, outline 6 182, lines 3 831, brows 61, kept face stones 2 056.

| Set | Designs | Who | Gap pass | Clean lines | Other colour on lines | Breaks | Missing lines | Areas >3 tones | Patches <4 | Holes >1 mm | Holes 0.6 · 0.8 · 1.0 · 1.2 · 1.4+ mm | Largest hole | Stones | ms (mean / max) |
| --- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| CC0 | 9 | today | 9/9 | 70/168 | 70 | 8 | 8 | 163 | 2823 | 7193 | 16926 · 9984 · 5048 · 2131 · 951 | 1.72 | 22344 | 597 / 1018 |
|  |  | before | 9/9 | 103/168 | 5 | 27 | 26 | 13 | 151 | 6023 | 18189 · 20936 · 5210 · 1120 · 304 | 1.71 | 21706 | 2231 / 3182 |
|  |  | now, 1-row band | | | | | | | 5076 | 15083 · 19166 · 4200 · 1114 · 416 | | | |
|  |  | now | 9/9 | 158/168 | 1 | 0 | 7 | 0 | 0 | 4013 | 17161 · 18831 · 3278 · 826 · 353 | 1.71 | 22351 | 3585 / 5705 |
| RS | 12 | today | 12/12 | 205/451 | 69 | 19 | 30 | 302 | 3782 | 9094 | 24314 · 15275 · 6975 · 2441 · 1008 | 1.72 | 31860 | 603 / 871 |
|  |  | before | 12/12 | 262/451 | 14 | 52 | 62 | 50 | 544 | 10770 | 24298 · 29961 · 9381 · 2076 · 676 | 1.69 | 30289 | 2469 / 3573 |
|  |  | now, 1-row band | | | | | | | 8206 | 23045 · 29005 · 6925 · 1589 · 719 | | | |
|  |  | now | 12/12 | 412/451 | 2 | 1 | 30 | 0 | 4 | 6291 | 25465 · 28614 · 5373 · 1272 · 592 | 1.69 | 31122 | 3756 / 5327 |

Per design (columns: stones, ms, natural size; the four checks; the hole histogram; the 1-row band's
holes beside it):

| Design | | Stones | ms | Size mm | 1 Gaps: viol. / min | 2 Lines: clean · other colour · other size · breaks · missing | 3 Areas: >3 tones (max) · patches <4 | 4 Holes >1 mm / largest | Holes 0.6 · 0.8 · 1.0 · 1.2 · 1.4+ mm |
| --- | --- | ---: | ---: | --- | --- | --- | --- | --- | --- |
| cc0-car-rule | today | 3548 | 672 | 260 × 87.4 | 0 / 0.1 | 14/35 · 21 · 30 · 2 · 0 | 14 (10) · 315 | 1851 / 1.7 | 2044 · 1732 · 1176 · 568 · 220 |
|  | before | 3579 | 3182 | 259.1 × 86.7 | 0 / 0.1 | 27/35 · 3 · 12 · 3 · 2 | 4 (5) · 48 | 1016 / 1.71 | 3037 · 3632 · 849 · 201 · 43 |
|  | now | 3702 | 4674 | 259 × 86.7 | 0 / 0.1 | 33/35 · 0 · 0 · 0 · 1 | 0 (3) · 0 | 571 / 1.71 | 2878 · 3092 · 471 · 99 · 51 |
|  | now, 1-row band | 3720 | 6379 | | 0 | | | 722 / 1.71 | 2375 · 2875 · 574 · 190 · 73 |
| cc0-cat-norule | today | 3148 | 1018 | 158.4 × 120.8 | 0 / 0.101 | 12/30 · 5 · 32 · 2 · 0 | 33 (10) · 704 | 979 / 1.7 | 2463 · 1800 · 787 · 264 · 95 |
|  | before | 3014 | 2558 | 157.6 × 120 | 0 / 0.1 | 16/30 · 0 · 28 · 7 · 6 | 2 (4) · 27 | 1040 / 1.66 | 2400 · 3041 · 925 · 199 · 56 |
|  | now | 3175 | 5705 | 157.6 × 120 | 0 / 0.1 | 28/30 · 0 · 0 · 0 · 2 | 0 (3) · 0 | 618 / 1.67 | 2404 · 2739 · 542 · 122 · 45 |
|  | now, 1-row band | 3139 | 5053 | | 0 | | | 733 / 1.64 | 2198 · 2926 · 639 · 173 · 66 |
| cc0-cat-rule | today | 3579 | 735 | 167.8 × 125.7 | 0 / 0.101 | 5/24 · 11 · 81 · 1 · 2 | 39 (10) · 577 | 541 / 1.68 | 3482 · 1286 · 391 · 144 · 78 |
|  | before | 3362 | 2892 | 167.1 × 125.2 | 0 / 0.1 | 12/24 · 0 · 56 · 12 · 4 | 5 (5) · 35 | 1060 / 1.66 | 2749 · 3716 · 940 · 200 · 56 |
|  | now | 3523 | 4497 | 167.1 × 125.2 | 0 / 0.1 | 21/24 · 0 · 0 · 0 · 3 | 0 (3) · 0 | 657 / 1.65 | 2653 · 3279 · 556 · 152 · 48 |
|  | now, 1-row band | 3556 | 4631 | | 0 | | | 802 / 1.69 | 2256 · 3041 · 683 · 156 · 61 |
| cc0-dachshund-rule | today | 1633 | 394 | 159.2 × 106.4 | 0 / 0.102 | 5/13 · 1 · 13 · 0 · 0 | 11 (7) · 110 | 292 / 1.65 | 1299 · 710 · 229 · 58 · 16 |
|  | before | 1520 | 1691 | 157.9 × 105.8 | 0 / 0.1 | 5/13 · 0 · 6 · 0 · 4 | 0 (3) · 12 | 397 / 1.65 | 1338 · 1427 · 362 · 56 · 22 |
|  | now | 1548 | 2317 | 157.4 × 105.8 | 0 / 0.1 | 13/13 · 0 · 0 · 0 · 0 | 0 (3) · 0 | 315 / 1.65 | 1242 · 1322 · 250 · 70 · 22 |
|  | now, 1-row band | 1529 | 2397 | | 0 | | | 437 / 1.67 | 1046 · 1331 · 353 · 78 · 33 |
| cc0-dog-norule | today | 2084 | 468 | 87 × 203.1 | 0 / 0.1 | 6/12 · 0 · 2 · 0 · 2 | 22 (13) · 238 | 958 / 1.66 | 1284 · 1072 · 714 · 225 · 76 |
|  | before | 2077 | 2021 | 86.2 × 202.3 | 0 / 0.1 | 8/12 · 0 · 2 · 0 · 2 | 1 (4) · 7 | 581 / 1.62 | 1667 · 2004 · 496 · 124 · 23 |
|  | now | 2116 | 2886 | 86.2 × 202.3 | 0 / 0.1 | 12/12 · 0 · 0 · 0 · 0 | 0 (3) · 0 | 410 / 1.64 | 1694 · 1943 · 364 · 79 · 24 |
|  | now, 1-row band | 2105 | 2872 | | 0 | | | 546 / 1.61 | 1535 · 2012 · 447 · 124 · 30 |
| cc0-dog-rule | today | 2050 | 583 | 83.8 × 200.8 | 0 / 0.101 | 3/8 · 3 · 7 · 0 · 0 | 22 (8) · 247 | 914 / 1.72 | 1295 · 1122 · 664 · 176 · 73 |
|  | before | 2022 | 1881 | 83.2 × 200 | 0 / 0.1 | 4/8 · 0 · 7 · 1 · 1 | 0 (3) · 5 | 609 / 1.66 | 1674 · 1901 · 502 · 118 · 38 |
|  | now | 2072 | 3173 | 83.2 × 200 | 0 / 0.1 | 7/8 · 0 · 0 · 0 · 0 | 0 (3) · 0 | 375 / 1.66 | 1715 · 1759 · 318 · 89 · 33 |
|  | now, 1-row band | 2055 | 2991 | | 0 | | | 489 / 1.66 | 1570 · 1984 · 423 · 99 · 40 |
| cc0-giraffe-rule | today | 2327 | 589 | 79.8 × 307.5 | 0 / 0.101 | 21/32 · 6 · 7 · 3 · 0 | 15 (12) · 497 | 1460 / 1.71 | 1423 · 1167 · 911 · 656 · 388 |
|  | before | 2333 | 2364 | 78.4 × 307.1 | 0 / 0.1 | 19/32 · 1 · 3 · 4 · 7 | 1 (7) · 17 | 647 / 1.63 | 1949 · 2275 · 545 · 117 · 35 |
|  | now | 2392 | 3559 | 78.4 × 307.1 | 0 / 0.1 | 31/32 · 0 · 0 · 0 · 1 | 0 (3) · 0 | 458 / 1.63 | 1995 · 2088 · 339 · 109 · 58 |
|  | now, 1-row band | 2385 | 3444 | | 0 | | | 543 / 1.66 | 1803 · 2214 · 428 · 117 · 51 |
| cc0-mug-norule | today | 2224 | 523 | 146.5 × 109.6 | 0 / 0.102 | 4/14 · 23 · 16 · 0 · 4 | 5 (5) · 99 | 119 / 1.63 | 2199 · 697 · 108 · 27 · 4 |
|  | before | 2130 | 1974 | 145.9 × 109.2 | 0 / 0.1 | 12/14 · 1 · 1 · 0 · 0 | 0 (2) · 0 | 315 / 1.51 | 1894 · 1507 · 276 · 50 · 10 |
|  | now | 2102 | 3121 | 145.9 × 109.1 | 0 / 0.1 | 13/14 · 1 · 0 · 0 · 0 | 0 (1) · 0 | 299 / 1.67 | 1662 · 1722 · 228 · 45 · 21 |
|  | now, 1-row band | 2092 | 3343 | | 0 | | | 436 / 1.67 | 1470 · 1834 · 356 · 56 · 23 |
| cc0-mug-rule | today | 1751 | 395 | 130.4 × 96 | 0 / 0.103 | 0/0 · 0 · 0 · 0 · 0 | 2 (5) · 36 | 79 / 1.41 | 1437 · 398 · 68 · 13 · 1 |
|  | before | 1669 | 1512 | 130.3 × 96.4 | 0 / 0.1 | 0/0 · 0 · 0 · 0 · 0 | 0 (2) · 0 | 358 / 1.67 | 1481 · 1433 · 315 · 55 · 21 |
|  | now | 1721 | 2337 | 130.3 × 96.4 | 0 / 0.1 | 0/0 · 0 · 0 · 0 · 0 | 0 (2) · 0 | 310 / 1.62 | 918 · 887 · 210 · 61 · 51 |
|  | now, 1-row band | 1698 | 2210 | | 0 | | | 368 / 1.67 | 830 · 949 · 297 · 121 · 39 |
| rs-cat | today | 2162 | 423 | 103 × 130.8 | 0 / 0.1 | 11/35 · 5 · 32 · 3 · 0 | 40 (9) · 367 | 649 / 1.7 | 1690 · 1093 · 485 · 192 · 80 |
|  | before | 2043 | 1848 | 102 × 130.4 | 0 / 0.1 | 15/35 · 0 · 14 · 3 · 9 | 4 (5) · 45 | 809 / 1.68 | 1703 · 2035 · 718 · 153 · 49 |
|  | now | 2149 | 2819 | 102.4 × 130.4 | 0 / 0.1 | 27/35 · 0 · 0 · 1 · 6 | 0 (3) · 1 | 375 / 1.65 | 1811 · 1864 · 353 · 75 · 42 |
|  | now, 1-row band | 2127 | 2775 | | 0 | | | 559 / 1.65 | 1605 · 1852 · 473 · 117 · 56 |
| rs-dog | today | 1683 | 444 | 96.6 × 160.6 | 0 / 0.102 | 4/7 · 0 · 4 · 0 · 0 | 7 (10) · 152 | 728 / 1.65 | 1281 · 1117 · 564 · 160 · 44 |
|  | before | 1700 | 1759 | 95.7 × 159.9 | 0 / 0.1 | 6/7 · 0 · 0 · 0 · 0 | 4 (6) · 26 | 488 / 1.68 | 1379 · 1648 · 444 · 66 · 14 |
|  | now | 1735 | 2647 | 95.6 × 159.9 | 0 / 0.1 | 7/7 · 0 · 0 · 0 · 0 | 0 (2) · 0 | 375 / 1.66 | 1343 · 1349 · 321 · 63 · 32 |
|  | now, 1-row band | 1702 | 2829 | | 0 | | | 505 / 1.65 | 1135 · 1541 · 441 · 74 · 35 |
| rs-einstein | today | 3594 | 821 | 150.2 × 143.2 | 0 / 0.1 | 33/64 · 23 · 28 · 0 · 7 | 40 (11) · 415 | 648 / 1.68 | 2868 · 1680 · 544 · 148 · 66 |
|  | before | 3376 | 3298 | 149.8 × 142.4 | 0 / 0.1 | 42/64 · 12 · 9 · 7 · 8 | 7 (6) · 74 | 1164 / 1.67 | 2613 · 3145 · 947 · 260 · 91 |
|  | now | 3423 | 5056 | 149.8 × 142.4 | 0 / 0.1 | 58/64 · 2 · 3 · 0 · 2 | 0 (3) · 1 | 788 / 1.67 | 2778 · 3209 · 625 · 166 · 69 |
|  | now, 1-row band | 3367 | 4617 | | 0 | | | 1060 / 1.67 | 2644 · 3383 · 877 · 205 · 82 |
| rs-jesus | today | 3307 | 693 | 145.8 × 163.9 | 0 / 0.1 | 17/46 · 9 · 43 · 3 · 1 | 30 (8) · 341 | 1466 / 1.7 | 2560 · 1783 · 1060 · 518 · 158 |
|  | before | 3179 | 3102 | 145.4 × 162.7 | 0 / 0.1 | 13/46 · 1 · 35 · 20 · 5 | 4 (4) · 90 | 1442 / 1.68 | 2456 · 3634 · 1204 · 240 · 67 |
|  | now | 3315 | 4971 | 145.4 × 162.7 | 0 / 0.1 | 43/46 · 0 · 0 · 0 · 3 | 0 (3) · 0 | 647 / 1.64 | 2796 · 3316 · 555 · 130 · 48 |
|  | now, 1-row band | 3302 | 4960 | | 0 | | | 882 / 1.64 | 2452 · 3268 · 730 · 140 · 66 |
| rs-lake | today | 4100 | 871 | 154.7 × 152.1 | 0 / 0.1 | 45/83 · 13 · 19 · 2 · 2 | 50 (11) · 581 | 1142 / 1.7 | 3053 · 2030 · 853 · 240 · 83 |
|  | before | 3857 | 3573 | 153.3 × 151.3 | 0 / 0.1 | 44/83 · 1 · 19 · 6 · 16 | 10 (6) · 78 | 1564 / 1.62 | 3214 · 4121 · 1366 · 301 · 75 |
|  | now | 4002 | 5327 | 153.7 × 151.3 | 0 / 0.1 | 75/83 · 0 · 0 · 0 · 7 | 0 (3) · 0 | 728 / 1.66 | 3479 · 4084 · 616 · 141 · 58 |
|  | now, 1-row band | 3959 | 5176 | | 0 | | | 1046 / 1.7 | 3190 · 4020 · 889 · 207 · 76 |
| rs-leopard | today | 2436 | 569 | 117.3 × 153.7 | 0 / 0.101 | 22/65 · 5 · 17 · 6 · 9 | 51 (9) · 596 | 892 / 1.68 | 1868 · 1229 · 679 · 230 · 100 |
|  | before | 2338 | 2323 | 116.3 × 152.7 | 0 / 0.1 | 41/65 · 0 · 7 · 1 · 12 | 13 (5) · 83 | 987 / 1.68 | 1871 · 2397 · 899 · 183 · 50 |
|  | now | 2403 | 3706 | 116.4 × 152.7 | 0 / 0.1 | 58/65 · 0 · 0 · 0 · 7 | 0 (3) · 0 | 549 / 1.68 | 2070 · 2388 · 487 · 114 · 37 |
|  | now, 1-row band | 2393 | 3782 | | 0 | | | 570 / 1.68 | 1897 · 2486 · 500 · 117 · 43 |
| rs-logo | today | 833 | 294 | 144.9 × 79.1 | 0 / 0.102 | 0/0 · 0 · 0 · 0 · 0 | 0 (1) · 0 | 88 / 1.37 | 118 · 167 · 84 · 6 · 0 |
|  | before | 773 | 1022 | 144.2 × 78.3 | 0 / 0.1 | 0/0 · 0 · 0 · 0 · 0 | 0 (1) · 0 | 75 / 1.6 | 550 · 352 · 59 · 34 · 46 |
|  | now | 773 | 1367 | 144.2 × 78.3 | 0 / 0.1 | 0/0 · 0 · 0 · 0 · 0 | 0 (1) · 0 | 78 / 1.6 | 553 · 359 · 63 · 36 · 42 |
|  | now, 1-row band | 773 | 1284 | | 0 | | | 78 / 1.6 | 553 · 359 · 63 · 36 · 42 |
| rs-parrot | today | 2552 | 616 | 168.3 × 151.6 | 0 / 0.101 | 13/40 · 6 · 4 · 1 · 8 | 42 (9) · 367 | 1017 / 1.67 | 1685 · 1392 · 780 · 274 · 121 |
|  | before | 2407 | 2688 | 167.8 × 150.5 | 0 / 0.1 | 17/40 · 0 · 21 · 6 · 4 | 3 (6) · 86 | 1134 / 1.69 | 1759 · 2448 · 1004 · 227 · 67 |
|  | now | 2528 | 3946 | 167.6 × 150.2 | 0 / 0.1 | 38/40 · 0 · 0 · 0 · 2 | 0 (3) · 0 | 524 / 1.66 | 2124 · 2298 · 446 · 114 · 40 |
|  | now, 1-row band | 2510 | 3989 | | 0 | | | 522 / 1.64 | 2131 · 2415 · 456 · 83 · 43 |
| rs-portrait | today | 4045 | 799 | 149.5 × 166 | 0 / 0.1 | 4/26 · 1 · 33 · 1 · 3 | 21 (10) · 630 | 1064 / 1.72 | 3375 · 1509 · 782 · 348 · 241 |
|  | before | 3912 | 3252 | 149.4 × 165.4 | 0 / 0.1 | 18/26 · 0 · 4 · 1 · 4 | 4 (5) · 27 | 1245 / 1.68 | 3119 · 3529 · 1067 · 264 · 84 |
|  | now | 3946 | 5325 | 149.4 × 165.4 | 0 / 0.1 | 25/26 · 0 · 0 · 0 · 1 | 0 (3) · 1 | 927 / 1.66 | 3115 · 3615 · 804 · 173 · 100 |
|  | now, 1-row band | 3913 | 5345 | | 0 | | | 1214 / 1.66 | 2723 · 3502 · 1050 · 260 · 106 |
| rs-rose | today | 1846 | 481 | 121 × 130.5 | 0 / 0.101 | 24/34 · 0 · 15 · 2 · 0 | 3 (5) · 65 | 255 / 1.65 | 1587 · 782 · 226 · 53 · 25 |
|  | before | 1673 | 1819 | 120.1 × 130 | 0 / 0.1 | 28/34 · 0 · 6 · 3 · 1 | 0 (2) · 0 | 526 / 1.69 | 1306 · 1800 · 474 · 94 · 32 |
|  | now | 1720 | 2424 | 120.1 × 130 | 0 / 0.1 | 33/34 · 0 · 0 · 0 · 0 | 0 (2) · 0 | 332 / 1.59 | 1441 · 1676 · 304 · 56 · 17 |
|  | now, 1-row band | 1706 | 2543 | | 0 | | | 448 / 1.58 | 1213 · 1651 · 387 · 71 · 20 |
| rs-tulips | today | 2675 | 625 | 140.3 × 141.7 | 0 / 0.101 | 27/38 · 3 · 12 · 0 · 0 | 9 (7) · 133 | 698 / 1.66 | 2002 · 1286 · 552 · 187 · 48 |
|  | before | 2537 | 2603 | 139.9 × 141.1 | 0 / 0.1 | 30/38 · 0 · 7 · 4 · 1 | 1 (5) · 13 | 720 / 1.67 | 2130 · 2521 · 648 · 145 · 63 |
|  | now | 2599 | 4079 | 139.9 × 141.1 | 0 / 0.1 | 37/38 · 0 · 0 · 0 · 1 | 0 (2) · 0 | 496 / 1.66 | 2140 · 2365 · 425 · 103 · 53 |
|  | now, 1-row band | 2565 | 4095 | | 0 | | | 626 / 1.66 | 1944 · 2519 · 535 · 109 · 64 |
| rs-woman | today | 2627 | 598 | 143.9 × 146.7 | 0 / 0.1 | 5/13 · 4 · 5 · 1 · 0 | 9 (5) · 135 | 447 / 1.65 | 2227 · 1207 · 366 · 85 · 42 |
|  | before | 2494 | 2343 | 143.1 × 145.9 | 0 / 0.1 | 8/13 · 0 · 1 · 1 · 2 | 0 (3) · 22 | 616 / 1.69 | 2198 · 2331 · 551 · 109 · 38 |
|  | now | 2529 | 3407 | 143.1 × 145.9 | 0 / 0.1 | 11/13 · 0 · 1 · 0 · 1 | 0 (3) · 1 | 472 / 1.69 | 1815 · 2091 · 374 · 101 · 54 |
|  | now, 1-row band | 2515 | 3429 | | 0 | | | 696 / 1.69 | 1558 · 2009 · 524 · 170 · 86 |

## 3. Build 2: what met the rules, and what did not

Met on every design: **check 1** (0 violations; build 1's saved stones too, at full precision),
every chain one colour and size and at least 3 stones, at most 3 tones per area, Jet and Crystal only
in B&W. **Check 2**: clean lines 570 of 619 (today 275, build 1 365); stones of another colour on a
line 3 (today 139); breaks 1 (today 27, build 1 79). **Check 3**: 4 small patches over 21 designs
(today 6 605, build 1 695), 0 areas over 3 tones.

**Check 4 (no empty circle over 1.0 mm) is still met by no design**, but the engine now has clearly
fewer than today: 10 304 against 16 287 (build 1 16 793); gaps of 1.0 mm and more by the histogram
11 694 against today's 18 554, and those of 1.4 mm and more 945 against 1 959. The engine still has
more than today on 7 of the 21 designs (cc0-cat-rule, the dachshund, both mugs, Einstein, the rose,
rs-woman): designs with many small areas and lines, where the band covers almost everything and the
honeycomb is small. The worst-seam close-ups (plain view) show where they sit: where the band meets
the honeycomb, and between kept face stones and the engine's. The cause is unchanged: an SS4 needs
1.7 mm with its gaps, so a 1.0–1.7 mm gap can only be avoided by the packing, and a lattice never
meets a curved band exactly. The largest gap is 1.7 mm everywhere (the fill takes anything bigger).

Other limits:

- Light lines need contrast (18 L\*): grey seams on a black suit, or lace drawn faintly on white, are
  still areas.
- Brows: only with a human face and two pupils; a brow drawn into the hair (no gap between) is cut at
  the box; the far brow of a turned face often lies in the edge band and is not found.
- The 1-row band leaves more holes than the 2-row band on every set (13 282 against 10 304).
- The engine is 6 times slower than today's pipeline; the halftone private photos take up to 15 s in
  the worker.

## 4. What build 3 needs

1. Faces (concept section 5) from landmarks: the MediaPipe Face Landmarker of exp-faces, all faces,
   check 5; brows then from the landmarks instead of the box above the pupils.
2. Holes: a decision on check 4's limit, or packing that fits the honeycomb to the band (a lattice
   bent along the band, or an optimisation of the stones after placement), and the seam between kept
   face stones and the engine's.
3. Light lines at lower contrast where a line is long and straight.
4. Speed: the settle step and the 9-phase lattice search are most of the placement time.

## 5. Files

- `src/engine/`: `map.js` (map, ramps, light lines, brows), `place.js` (band, honeycomb, chains),
  `checks.js` (checks 1–4, hole histogram), `faces.js`, `grid.js`, `index.js`, RS copies
  (`ContourRingSampler.js`, `LineDesignSampler.js`).
- `src/render/offthread.js`, `offthread-worker.js`: the engine job; `src/pipeline/design.js`,
  `src/server/config.js`: `IS_ENGINE=concept`.
- `tools/exp-engine.mjs` (`public`, `private`, `tables`, `page`), `tools/test-engine.mjs`.
- Build 3: `src/engine/features.js`, landmark geometry in `faces.js`, `services/strass/scripts/face_landmarks.py`,
  `tools/fixtures/face-landmarks.json` (the RS portrait's landmarks, for the tests), pictures in `docs/exp-engine/b3/`.
- `docs/exp-engine/`: pictures and `results.json`; maps in `data/exp-engine/maps/`, build 1's
  stones in `data/exp-engine/before/`.

## 6. Pictures

Each design: original | AI image | today | engine before (build 1) | engine now | map now; then
close-ups (AI | today | before | now) at the longest line, the longest area border, the densest seam
fill and the face, and the plain view (flat stones in their colour, gaps over 1.0 mm ringed red) at
the engine's two worst seams.

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

## Build 1 (history)

### B1.1 What the engine did

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


### B1.2 What met the rules, and what did not (build 1)

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

### B1.3 What build 2 needed (build 1)

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
