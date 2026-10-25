# IS design concept (v1)

Status: concept, 25 Oct 2026. Revised 25 Oct 2026 (exp-engine build 3): check 4 counts holes of 1.4 mm
or more. Every IS design must follow these rules. The engine that places
stones (spec section 7) implements them; the checks in section 8 below measure them.

Why: until now IS copied the stones the AI drew and fixed faults one by one. The result has no
plan: a clean line is broken by one stone of another colour, features have no clear shape, and
holes appear where rows of stones meet. From now on the AI image (or, later, the photo) is only a
**map** of colours, lines and features. IS places the stones itself, by the rules below.

## 1. Stones and spacing

- Main stone SS6. SS4 for fine lines and small details. SS10 only inside large calm areas.
  Pupils SS6 to SS16 (SS20 allowed for pupils on real human faces).
- Gap between neighbours: at least 0.1 mm, normally 0.1–0.3 mm.
- **No visible holes:** inside the subject, no empty circle between stones larger than 1.0 mm in
  diameter (stones in tidy rows leave at most about 0.4–1.0 mm).

## 2. Lines

A line is an outline or a feature line (lid, brow, lip line, nose shadow, hair strand).

- A line is a **chain**: stones one after another along a smooth path.
- One colour and one size along the whole chain. Never a stone of another colour inside a line.
- Even spacing along the path. No breaks, except where the line really ends.
- Smooth: no zigzag. A chain is at least 3 stones long; shorter pieces are not lines.
- Fine lines use SS4, outlines SS6.

## 3. Areas

An area is a part of the picture with one meaning: skin, hair, a shirt, a background shape.

- At most 3 tones per area, taken from one colour ramp (skin, fur, greys...).
- Tones form calm patches with smooth borders. No single stones of another tone: a patch smaller
  than 4 stones joins its neighbour.
- Stones run in **rows parallel to the area's outline**, from the outline inwards, so they pack
  tightly. Where rows meet in the middle, small stones close the seam.

## 4. Subject outline

- The whole subject has one continuous outline chain, in the darkest colour of the ramp next to it
  (Jet where the subject is dark or black).

## 5. Faces (people)

Feature size and position come from face landmarks. Both eyes use a similar size, and the
catch-lights sit on the same side in both eyes.

**Eye**
- Almond-shaped outline.
- Upper lid: a chain of SS6 Jet stones, the heaviest line of the eye.
- Lower lid: a chain of SS4 or SS6 stones, a dark tone of the skin ramp (Jet in black & white).
- Eye white: Crystal, filling the space between the lids.
- Iris: a ring of SS4 stones in the iris colour around the pupil, only when there is room.
- Pupil: one Jet stone (SS6 to SS20), at most half the iris width.
- Catch-light: usually one Crystal SS4 stone touching the pupil on the side the light comes from.
- Lashes (optional): 2–5 SS4 Jet stones at the outer corner of the upper lid.

**Brow**
- A chain of 1–2 rows along the brow, thicker at the inner end, thinner at the outer end, in the
  hair colour.

**Nose**
- No full outline.
- Each nostril: one or a few dark stones.
- If needed, one shadow chain of SS4 stones along the darker side, from the bridge to the tip,
  one tone darker than the skin.

**Lips**
- Outline: a chain of SS4 or SS6 stones in a dark lip tone.
- Usually the upper lip is filled with a darker lip tone and the lower lip with a lighter one.
- Mouth line: a chain of SS4 dark stones between the lips, usually present.

**Teeth** (when the mouth is open)
- Crystal stones, in rows, between the mouth line above and below. No lines inside the teeth.

**Face contour**
- The jaw and cheek outline is part of the subject outline, or a shadow chain where the face
  continues into the neck.

## 6. Black & white

- Jet and Crystal only.
- **Stencil style:** every area is solid Jet or solid Crystal.
- **Halftone style:** areas may mix Jet and Crystal in a regular pattern to show grey.
- In both styles, lines and features never mix: they follow sections 2 and 5 in Jet and Crystal.

## 7. Priority

When rules meet: features, then lines, then the subject outline, then areas, then filling.
A stone of a higher rule is never removed for a lower one.

## 8. Checks (every design)

1. Gap check: 0 violations, smallest gap 0.1 mm.
2. Lines: every stone of a chain has the chain's colour and size; no chain is broken.
3. Areas: no patch smaller than 4 stones; at most 3 tones per area.
4. Holes: no hole of 1.4 mm or more inside the subject (an empty circle of that diameter between
   stones, or between stones and the subject's edge).
5. Faces: each eye has its outline, white and pupil, and usually a catch-light; lips have an
   outline and usually a mouth line.
