# IS: new file, not from Rhinestone-Studio.
"""IS-05b diagnosis runs: lays out saved AI images with rule variants, and records each stone's
colour after every colour step of the default run. No provider call; nothing here is used by the
service.

    .venv/bin/python scripts/is05b_runs.py OUT_DIR VARIANTS NAME=PNG [NAME=PNG ...]

VARIANTS is a comma-separated list of names from VARIANTS below: "default" (the service's rules),
"rs" (the rules of RS 38cd831, i.e. DEFAULT without the IS plausible_eyes rule), "rs-no-<rule>"
(rs with one colour rule off) and "rs-no-colour-rules". For each NAME and variant it writes
OUT_DIR/NAME.VARIANT.json (the /layout answer, colour id check skipped) and, for the "rs" variant,
OUT_DIR/NAME.stages.json: per stone of the answer, in its order, the colour
id after each colour step (STAGES). Detections are computed once per image and cached in
OUT_DIR/NAME.det.npy; rules never change them.
"""
import dataclasses
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from strass_layout import DEFAULT, faces, load_models, pipeline, post  # noqa: E402
from strass_layout.pipeline import finish_layout, layout_frame  # noqa: E402

COLOUR_RULES = ["extra_colours", "mean_colour", "real_colours", "more_colours", "skin_no_wine", "soft_outlines",
                "calm_skin", "skin_nearest"]
RS = dataclasses.replace(DEFAULT, plausible_eyes=False)
VARIANTS = {"default": DEFAULT, "rs": RS}
VARIANTS.update({"rs-no-" + r.replace("_", "-"): dataclasses.replace(RS, **{r: False}) for r in COLOUR_RULES})
VARIANTS["rs-no-colour-rules"] = dataclasses.replace(RS, **{r: False for r in COLOUR_RULES})
for name in os.environ.get("IS05B_EXTRA", "").split(";"):
    # NAME:rule=0,rule=1 relative to RS, e.g. "rs-pick:skin_nearest=0,calm_skin=0"
    if name.strip():
        key, spec = name.split(":")
        VARIANTS[key] = dataclasses.replace(RS, **{k: v == "1" for k, v in (kv.split("=") for kv in spec.split(","))})

STAGES = ["start", "darkdots", "family_fix", "gap_check", "distinct", "skin_nearest", "soft_outlines", "calm_skin"]


def _key(x, y):
    return (round(float(x), 3), round(float(y), 3))


class Recorder:
    """Wraps the colour steps of post.py, pipeline.py and faces.py and keeps {stage: {(x, y): id}}."""

    def __init__(self):
        self.maps = {}
        self.fill = set()

    def put(self, stage, P, C):
        self.maps[stage] = {_key(x, y): c for (x, y), c in zip(P, C)}

    def install(self):
        rec = self
        orig = {"clean": post.darkdots.clean, "family_fix": post.family_fix, "fill": post.fill,
                "distinct": pipeline.distinct_tones, "skin": faces.skin_nearest, "soft": faces.soften_outlines,
                "calm": faces.calm_skin}
        self.orig = orig
        state = {}

        def fill(st, P, D, mask, s, *a, **k):
            fP, fD = orig["fill"](st, P, D, mask, s, *a, **k)
            rec.fill.update(_key(x, y) for x, y in fP)
            return fP, fD

        def clean(P, D, C, *a, **k):
            rec.put("start", P, C)
            out = orig["clean"](P, D, C, *a, **k)
            rec.put("darkdots", P, out[0])
            state["P"] = P
            return out

        def family_fix(P, D, C, *a, **k):
            out = orig["family_fix"](P, D, C, *a, **k)
            rec.put("family_fix", P, out[0])
            return out

        def distinct(rgb, a, s, P, D, C, *args, **kw):
            rec.put("gap_check", P, C)
            out = orig["distinct"](rgb, a, s, P, D, C, *args, **kw)
            rec.put("distinct", P, out)
            state["P"] = P
            for st in ("skin_nearest", "soft_outlines", "calm_skin"):
                rec.put(st, P, out)
            return out

        def wrap(stage, fn):
            def inner(*a, **k):
                out = fn(*a, **k)
                P = state["P"]
                rec.put(stage, P, out[0])
                for later in STAGES[STAGES.index(stage) + 1:]:
                    rec.put(later, P, out[0])
                return out
            return inner

        post.fill = fill
        post.darkdots.clean = clean
        post.family_fix = family_fix
        pipeline.distinct_tones = distinct
        faces.skin_nearest = wrap("skin_nearest", orig["skin"])
        faces.soften_outlines = wrap("soft_outlines", orig["soft"])
        faces.calm_skin = wrap("calm_skin", orig["calm"])

    def uninstall(self):
        post.fill = self.orig["fill"]
        post.darkdots.clean = self.orig["clean"]
        post.family_fix = self.orig["family_fix"]
        pipeline.distinct_tones = self.orig["distinct"]
        faces.skin_nearest = self.orig["skin"]
        faces.soften_outlines = self.orig["soft"]
        faces.calm_skin = self.orig["calm"]


def main(out_dir, variants, pairs):
    os.makedirs(out_dir, exist_ok=True)
    models = load_models()
    real_detect = pipeline.detect_stones
    for pair in pairs:
        name, png = pair.split("=", 1)
        with open(png, "rb") as f:
            data = f.read()
        det_file = os.path.join(out_dir, name + ".det.npy")
        if os.path.exists(det_file):
            det = np.load(det_file)
        else:
            det = None
        for v in variants:
            t0 = time.time()

            def detect(px, m):
                nonlocal det
                if det is None:
                    det = real_detect(px, m)
                    np.save(det_file, det)
                return det.copy()
            pipeline.detect_stones = detect
            rec = Recorder() if v == "rs" else None
            if rec:
                rec.install()
            try:
                frame = layout_frame(data, 2.1, models, VARIANTS[v])
            finally:
                if rec:
                    rec.uninstall()
                pipeline.detect_stones = real_detect
            result = finish_layout(frame)
            with open(os.path.join(out_dir, "%s.%s.json" % (name, v)), "w") as f:
                json.dump(result, f, separators=(",", ":"))
            if rec:
                rows = [[rec.maps.get(st, {}).get(_key(q["x"], q["y"])) for st in STAGES] for q in frame["stones"]]
                fill = [_key(q["x"], q["y"]) in rec.fill for q in frame["stones"]]
                with open(os.path.join(out_dir, name + ".stages.json"), "w") as f:
                    json.dump({"stages": STAGES, "colours": rows, "fill": fill}, f, separators=(",", ":"))
            r = result["report"]
            print("%s %s: %d stones, face %s, pupils %s, %.0f s" % (name, v, r["stones"], r["face"], r["pupilsMm"], time.time() - t0),
                  flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2].split(","), sys.argv[3:])
