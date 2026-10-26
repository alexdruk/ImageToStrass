"""IS (IS-07a, diagnosis only; not used by the service): lays out AI images with the service's
MediaPipe face landmarks and with RS's dlib ones (tests/dlib_faces.py, test only), DEFAULT rules,
all colours, and records what differs.

    .venv/bin/python scripts/is07a_landmarks.py JOBS.json OUT_DIR

JOBS.json: [{"id": "...", "path": "AI image PNG"}, ...]. Writes OUT_DIR/ID-mediapipe.json and
OUT_DIR/ID-dlib.json (the /layout answers) and OUT_DIR/results.json: per image, for each model,
the eye contours found (image px), report.face, pupilsMm, pupilsAtMm (frame mm), the stone count,
violations and minGapMm; and the pupil distances (mm, each dlib pupil to the nearest MediaPipe one)
and the stones only one of the two layouts has.
"""
import copy
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from strass_layout import DEFAULT, layout_frame, load_models  # noqa: E402
from strass_layout.imageio import decode_png  # noqa: E402
from strass_layout.pipeline import finish_layout  # noqa: E402
from tests import dlib_faces  # noqa: E402


def stone_keys(layout):
    return {tuple(s) for s in layout["stones"]}


def run(models, data):
    t = time.time()
    frame = layout_frame(data, 2.1, models, DEFAULT)
    pupils_at = frame["frame"]["pupilsAtMm"]
    out = finish_layout(copy.deepcopy(frame))
    return out, pupils_at, round(time.time() - t, 1)


def main(jobs_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    if not dlib_faces.available():
        sys.exit("dlib or its model is absent: run scripts/setup_mac.sh --with-dlib-tests")
    mp_models = load_models()
    dl_models = dlib_faces.dlib_models()
    results = {}
    for job in json.load(open(jobs_path)):
        with open(job["path"], "rb") as f:
            data = f.read()
        onwhite = decode_png(data).onwhite
        row = {}
        layouts = {}
        for key, models in (("mediapipe", mp_models), ("dlib", dl_models)):
            eyes = models.eye_contours(onwhite)
            layout, pupils_at, sec = run(models, data)
            layouts[key] = layout
            with open(os.path.join(out_dir, "%s-%s.json" % (job["id"], key)), "w") as f:
                json.dump(layout, f)
            r = layout["report"]
            row[key] = {
                "eyes": None if eyes is None else [np.round(e, 1).tolist() for e in eyes],
                "face": r["face"], "pupilsMm": r["pupilsMm"], "pupilsAtMm": pupils_at,
                "stones": r["stones"], "violations": r["violations"], "minGapMm": r["minGapMm"], "s": sec,
            }
        a, b = row["mediapipe"]["pupilsAtMm"], row["dlib"]["pupilsAtMm"]
        row["pupilDistMm"] = [round(min(float(np.hypot(p[0] - q[0], p[1] - q[1])) for q in a), 3) if a else None for p in b]
        ka, kb = stone_keys(layouts["mediapipe"]), stone_keys(layouts["dlib"])
        row["onlyMediapipe"] = len(ka - kb)
        row["onlyDlib"] = len(kb - ka)
        results[job["id"]] = row
        print(job["id"], row["dlib"]["face"], "->", row["mediapipe"]["face"], "pupils", len(b), "->", len(a),
              "dist", row["pupilDistMm"], "stones +%d -%d" % (row["onlyMediapipe"], row["onlyDlib"]),
              "viol", row["dlib"]["violations"], row["mediapipe"]["violations"], flush=True)
        with open(os.path.join(out_dir, "results.json"), "w") as f:
            json.dump(results, f, indent=1)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
