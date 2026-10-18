# IS: new file, not from Rhinestone-Studio.
"""Writes the /layout answer for each of the 12 RS test images (prototype/img/N2_*.png) to OUT_DIR.

These are the "12 RS test layouts" the IS-03 tier and black & white checks run on (tools/ in the
Node app). Same call as POST /layout (target pitch 2.1 mm); the colour id check is skipped.

    .venv/bin/python scripts/make_test_layouts.py ../../tools/fixtures/layouts
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from strass_layout import layout, load_models  # noqa: E402
from tests.support import IMAGES, png_bytes  # noqa: E402


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    models = load_models()
    for name in IMAGES:
        t0 = time.time()
        result = layout(png_bytes(name), None, 2.1, models)
        with open(os.path.join(out_dir, name + ".json"), "w") as f:
            json.dump(result, f, separators=(",", ":"))
            f.write("\n")
        r = result["report"]
        print("%s: %d stones, %.1f x %.1f mm, %s, violations %d, %.0f s" % (
            name, r["stones"], result["widthMm"], result["heightMm"], r["bySize"], r["violations"], time.time() - t0))


if __name__ == "__main__":
    main(sys.argv[1])
