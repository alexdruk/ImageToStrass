# IS: new file, not from Rhinestone-Studio.
"""IS-05d diagnosis runs (skin shadow): lays out saved AI images with DEFAULT and the shadow rules
of IS-05d (Rules.warm_shadow, Rules.mixed_shadow). No provider call; nothing here is used by the
service, and DEFAULT is not changed.

    .venv/bin/python scripts/is05d_runs.py OUT_DIR VARIANTS NAME=PNG [NAME=PNG ...]

VARIANTS is a comma-separated list of names from VARIANTS below, or "shadow" for all of them.
Output files as scripts/is05c_runs.py writes them (NAME.VARIANT.json, NAME.VARIANT.stages.json,
NAME.det.npy).

  default            the service as shipped
  warm-1.5, warm-3   A: warm_shadow with warm_shadow_de 1.5 / 3
  mixed              B: mixed_shadow
  warm-1.5-mixed     C: A (1.5) and B together
  warm-3-mixed       C: A (3) and B together
"""
import dataclasses
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import is05c_runs  # noqa: E402
from strass_layout import DEFAULT  # noqa: E402

SHADOW = {
    "default": DEFAULT,
    "warm-1.5": dataclasses.replace(DEFAULT, warm_shadow=True, warm_shadow_de=1.5),
    "warm-3": dataclasses.replace(DEFAULT, warm_shadow=True, warm_shadow_de=3.0),
    "mixed": dataclasses.replace(DEFAULT, mixed_shadow=True),
    "warm-1.5-mixed": dataclasses.replace(DEFAULT, warm_shadow=True, warm_shadow_de=1.5, mixed_shadow=True),
    "warm-3-mixed": dataclasses.replace(DEFAULT, warm_shadow=True, warm_shadow_de=3.0, mixed_shadow=True),
}

if __name__ == "__main__":
    is05c_runs.VARIANTS.update({k: (r, ()) for k, r in SHADOW.items()})
    is05c_runs.GROUPS["shadow"] = list(SHADOW)
    is05c_runs.main(sys.argv[1], sys.argv[2].split(","), sys.argv[3:])
