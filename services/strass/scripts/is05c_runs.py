# IS: new file, not from Rhinestone-Studio.
"""IS-05c diagnosis runs (eyes and skin): lays out saved AI images with DEFAULT and variants of it
that switch one eye or skin rule off. No provider call; nothing here is used by the service, and
DEFAULT is not changed.

    .venv/bin/python scripts/is05c_runs.py OUT_DIR VARIANTS NAME=PNG [NAME=PNG ...]

VARIANTS is a comma-separated list of names from VARIANTS below, or "eyes", "skin" for the groups.
For each NAME and variant it writes OUT_DIR/NAME.VARIANT.json (the /layout answer) and
OUT_DIR/NAME.VARIANT.stages.json (per stone of the answer, the colour id after each colour step,
as scripts/is05b_runs.py records them; "start" is the first pick plus the eye and fill stones).
Detections are cached in OUT_DIR/NAME.det.npy.

Eye variants (relative to DEFAULT):
  default                     the service as shipped
  eye-no-<rule>               one eye rule off (EYE_RULES)
  eye-rules-off               all EYE_RULES off together
  eye-no-lashes               the jet SS4 lash stones in a person's eye boxes not added (no rule)
  eye-skip                    no eye stage at all, as for a non-face (post._plausible_pupils -> None)
Skin variants:
  skin-no-<rule>              one skin rule off (SKIN_RULES)
  skin-soft-outlines-on       soft_outlines on (DEFAULT has it off)
  skin-no-family-fix          colsmooth.family_fix skipped (red among brown, no rule)
  skin-no-distinct            tone separation (distinct_tones) skipped (no rule)
  skin-no-darkdots            darkdots.clean skipped (isolated dark stones, no rule)
  skin-rules-off              SKIN_RULES off and the three unflagged steps skipped
  skin-nearest-inner          skin_nearest reads each stone's inner 60 % (ordered.SAMPLE_SHARE) instead
                              of its whole disc, which on most AI images takes in the dark gaps
  skin-nearest-inner-kl2      as skin-nearest-inner, and its ΔE2000 weighs lightness half (kL = 2)
"""
import dataclasses
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from strass_layout import DEFAULT, faces, load_models, ordered, pipeline, post  # noqa: E402
from strass_layout.pipeline import finish_layout, layout_frame  # noqa: E402
from is05b_runs import STAGES, Recorder, _key  # noqa: E402

EYE_RULES = ["pupil_core_only", "pupil_inscribed", "human_iris", "eye_keep", "lively_eyes", "plausible_eyes"]
SKIN_RULES = ["skin_nearest", "calm_skin", "skin_no_wine"]
STEPS = ["family_fix", "distinct", "darkdots"]


def _off(**kw):
    return dataclasses.replace(DEFAULT, **kw)


# name -> (rules, patches); patches name the unflagged steps to skip or replace (see _patched).
VARIANTS = {"default": (DEFAULT, ())}
VARIANTS.update({"eye-no-" + r.replace("_", "-"): (_off(**{r: False}), ()) for r in EYE_RULES})
VARIANTS["eye-rules-off"] = (_off(**{r: False for r in EYE_RULES}), ())
VARIANTS["eye-no-lashes"] = (DEFAULT, ("lashes",))
VARIANTS["eye-skip"] = (DEFAULT, ("skip_eyes",))
VARIANTS.update({"skin-no-" + r.replace("_", "-"): (_off(**{r: False}), ()) for r in SKIN_RULES})
VARIANTS["skin-soft-outlines-on"] = (_off(soft_outlines=True), ())
VARIANTS.update({"skin-no-" + p.replace("_", "-"): (DEFAULT, (p,)) for p in STEPS})
VARIANTS["skin-rules-off"] = (_off(**{r: False for r in SKIN_RULES}), tuple(STEPS))
VARIANTS["skin-nearest-inner"] = (DEFAULT, ("nearest_inner",))
VARIANTS["skin-nearest-inner-kl2"] = (DEFAULT, ("nearest_inner", "nearest_kl2"))
GROUPS = {"eyes": ["default"] + [k for k in VARIANTS if k.startswith("eye-")],
          "skin": ["default"] + [k for k in VARIANTS if k.startswith("skin-")]}


class _Patched:
    """Skips or replaces unflagged steps for one run and puts them back afterwards."""

    def __init__(self, patches):
        self.patches = patches

    def __enter__(self):
        self.saved = {"plaus": post._plausible_pupils, "ss4": post.SS4, "family": post.family_fix,
                      "distinct": pipeline.distinct_tones, "clean": post.darkdots.clean,
                      "colours": pipeline.stone_colours, "de": faces.deltaE_ciede2000}
        p = self.patches
        if "skip_eyes" in p:
            # the non-face path of post_process: no pupil, no eye box, no eye stone, face None
            post._plausible_pupils = lambda cands, mask: None
        if "lashes" in p:
            # post.SS4 is read only by the lash loop (eyes.py has its own); a huge lash never fits
            post.SS4 = 1e6
        if "family_fix" in p:
            post.family_fix = lambda P, D, C, *a, **k: (list(C), 0)
        if "distinct" in p:
            pipeline.distinct_tones = lambda rgb, a, s, P, D, C, *args, **kw: list(C)
        if "darkdots" in p:
            post.darkdots.clean = lambda P, D, C, *a, **k: (list(C), 0)
        if "nearest_inner" in p:
            # pipeline.py calls stone_colours once, for skin_nearest's Lab (radius 0.5 D, whole disc)
            orig = self.saved["colours"]
            pipeline.stone_colours = lambda rgb, a, det, mean=False: orig(rgb, a, det * np.array([1, 1, ordered.SAMPLE_SHARE, 1]), mean)
        if "nearest_kl2" in p:
            # faces.py calls deltaE_ciede2000 in skin_nearest and calm_skin; only skin_nearest passes arrays
            de = self.saved["de"]
            faces.deltaE_ciede2000 = lambda x, y, **k: de(x, y, kL=2) if len(x) > 1 else de(x, y, **k)
        return self

    def __exit__(self, *exc):
        post._plausible_pupils = self.saved["plaus"]
        post.SS4 = self.saved["ss4"]
        post.family_fix = self.saved["family"]
        pipeline.distinct_tones = self.saved["distinct"]
        post.darkdots.clean = self.saved["clean"]
        pipeline.stone_colours = self.saved["colours"]
        faces.deltaE_ciede2000 = self.saved["de"]


def main(out_dir, variants, pairs):
    os.makedirs(out_dir, exist_ok=True)
    models = load_models()
    real_detect = pipeline.detect_stones
    names = []
    for v in variants:
        names += GROUPS.get(v, [v])
    names = list(dict.fromkeys(names))
    for pair in pairs:
        name, png = pair.split("=", 1)
        with open(png, "rb") as f:
            data = f.read()
        det_file = os.path.join(out_dir, name + ".det.npy")
        det = np.load(det_file) if os.path.exists(det_file) else None
        for v in names:
            out_file = os.path.join(out_dir, "%s.%s.json" % (name, v))
            if os.path.exists(out_file):
                continue
            t0 = time.time()
            rules, patches = VARIANTS[v]

            def detect(px, m):
                nonlocal det
                if det is None:
                    det = real_detect(px, m)
                    np.save(det_file, det)
                return det.copy()
            pipeline.detect_stones = detect
            rec = Recorder()
            try:
                with _Patched(patches):
                    # the recorder wraps the patched steps, so a skipped step still records
                    rec.install()
                    try:
                        frame = layout_frame(data, 2.1, models, rules)
                    finally:
                        rec.uninstall()
            finally:
                pipeline.detect_stones = real_detect
            result = finish_layout(frame)
            with open(out_file, "w") as f:
                json.dump(result, f, separators=(",", ":"))
            rows = [[rec.maps.get(st, {}).get(_key(q["x"], q["y"])) for st in STAGES] for q in frame["stones"]]
            fill = [_key(q["x"], q["y"]) in rec.fill for q in frame["stones"]]
            with open(os.path.join(out_dir, "%s.%s.stages.json" % (name, v)), "w") as f:
                json.dump({"stages": STAGES, "colours": rows, "fill": fill}, f, separators=(",", ":"))
            r = result["report"]
            print("%s %s: %d stones, face %s, pupils %s, %.0f s" % (name, v, r["stones"], r["face"], r["pupilsMm"], time.time() - t0),
                  flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2].split(","), sys.argv[3:])
