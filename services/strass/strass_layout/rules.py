# From Rhinestone-Studio @38cd831 services/strass-layout/strass_layout/rules.py
"""Which IMG-026E to J rules the pipeline applies on top of the prototype.

PROTOTYPE reproduces the prototype exactly (the equivalence and golden tests run with it);
BUILD_E to BUILD_I are what builds E to I shipped; DEFAULT is what the service ships.
See docs/specifications/IMG-026-StrassLayoutService.md, "Layout quality (build E)",
"Colour and eyes (build F)", "Pupils and stone colours (build G)",
"More catalogue colours (build H)", "Faces and eyes (build I)" and "Skin and fur tones (build J)".

IS (IS-05b, not in RS): plausible_eyes treats a design whose pupils are not one plausible pair
(two of very different sizes, far from level or too far apart for the subject; of more than two,
none or several passing pairs) as having no face: the eye stage is skipped and report.face is
null. Of more than two pupils with exactly one plausible pair, that pair is kept and the others
are ordinary stones. See post._plausible_pupils.

IS (IS-05b, not in RS): DEFAULT has soft_outlines off (RS 38cd831 ships it on). It turned the
AI's black outline stones on skin into smoked topaz and raised the colour error where it acted
(docs/IS-05b-results.md in the IS repository).

IS (IS-05b, not in RS): sample_delivered reads each stone's colour at its delivered position and
size, after the ordered layout has moved it, instead of at the detection it came from; the stones
the layout adds to fill holes read their own pixels too, instead of taking the nearest detection's
or their neighbours' colour. The catch-light of a tiled big stone keeps its colour. DEFAULT has it
on; PROTOTYPE and the BUILD_* rules have it off, so the equivalence and golden tests are unchanged.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class Rules:
    pupil_core_only: bool
    keep_chains: bool
    chain_dark_l: float = 30.0
    chain_min_len: int = 3
    chain_link: float = 1.35
    extra_colours: bool = False
    mean_colour: bool = False
    human_iris: bool = False
    eye_keep: bool = False
    pupil_inscribed: bool = False
    real_colours: bool = False
    more_colours: bool = False
    lively_eyes: bool = False
    skin_no_wine: bool = False
    soft_outlines: bool = False
    calm_skin: bool = False
    skin_nearest: bool = False
    plausible_eyes: bool = False
    sample_delivered: bool = False


PROTOTYPE = Rules(pupil_core_only=False, keep_chains=False)
BUILD_E = Rules(pupil_core_only=True, keep_chains=True)
BUILD_F = Rules(pupil_core_only=True, keep_chains=True, extra_colours=True, mean_colour=True, human_iris=True, eye_keep=True)
BUILD_G = Rules(pupil_core_only=True, keep_chains=True, extra_colours=True, mean_colour=True, human_iris=True, eye_keep=True,
                pupil_inscribed=True, real_colours=True)
BUILD_H = Rules(pupil_core_only=True, keep_chains=True, extra_colours=True, mean_colour=True, human_iris=True, eye_keep=True,
                pupil_inscribed=True, real_colours=True, more_colours=True)
BUILD_I = Rules(pupil_core_only=True, keep_chains=True, extra_colours=True, mean_colour=True, human_iris=True, eye_keep=True,
                pupil_inscribed=True, real_colours=True, more_colours=True, lively_eyes=True, skin_no_wine=True,
                soft_outlines=True, calm_skin=True)
DEFAULT = Rules(pupil_core_only=True, keep_chains=True, extra_colours=True, mean_colour=True, human_iris=True, eye_keep=True,
                pupil_inscribed=True, real_colours=True, more_colours=True, lively_eyes=True, skin_no_wine=True,
                soft_outlines=False, calm_skin=True, skin_nearest=True, plausible_eyes=True,
                sample_delivered=True)  # IS (IS-05b): soft_outlines off, sample_delivered on
