"""IS-07a: the service finds faces with MediaPipe and never imports dlib or loads its model (the dlib
68-point model's iBUG 300-W training data excludes commercial use)."""
import os
import re
import subprocess
import sys
import unittest

import numpy as np

from strass_layout.imageio import decode_png
from strass_layout.models import MP_EYES, load_models
from tests import support

PRODUCTION = ["app.py", "strass_layout"]


class NoDlibInProduction(unittest.TestCase):
    def test_no_dlib_in_the_service_code(self):
        found = []
        for root in PRODUCTION:
            path = os.path.join(support.SERVICE_DIR, root)
            files = [path] if os.path.isfile(path) else [os.path.join(d, f) for d, _, fs in os.walk(path) for f in fs if f.endswith(".py")]
            for f in files:
                with open(f) as fh:
                    text = fh.read()
                if re.search(r"^\s*(import|from)\s+dlib\b", text, re.M) or "shape_predictor_68" in text:
                    found.append(os.path.relpath(f, support.SERVICE_DIR))
        self.assertEqual(found, [])

    def test_loading_the_service_does_not_import_dlib(self):
        code = "import sys; import app; from strass_layout import load_models; load_models(); print('dlib' in sys.modules)"
        out = subprocess.run([sys.executable, "-c", code], cwd=support.SERVICE_DIR, capture_output=True, text=True, timeout=600)
        self.assertEqual(out.returncode, 0, out.stderr[-2000:])
        self.assertEqual(out.stdout.strip().splitlines()[-1], "False")

    def test_requirements_have_no_dlib(self):
        with open(os.path.join(support.SERVICE_DIR, "requirements.txt")) as f:
            pins = [line for line in f if line.strip() and not line.startswith("#")]
        self.assertFalse(any("dlib" in p for p in pins))


class EyeContours(unittest.TestCase):
    def contours(self, name):
        return load_models().eye_contours(decode_png(support.png_bytes(name)).onwhite)

    def test_a_person_has_two_eyes_in_dlib_order(self):
        eyes = self.contours("woman")
        self.assertIsNotNone(eyes)
        self.assertEqual([e.shape for e in eyes], [(6, 2), (6, 2)])
        left, right = eyes
        # Image-left eye first; points 0 and 3 are its corners (dlib 36 and 39, 42 and 45).
        self.assertLess(left[:, 0].mean(), right[:, 0].mean())
        self.assertEqual(int(np.argmin(left[:, 0])), 0)
        self.assertEqual(int(np.argmax(right[:, 0])), 3)
        self.assertEqual(len(MP_EYES), 2)

    def test_an_animal_has_no_face(self):
        self.assertIsNone(self.contours("cat"))


if __name__ == "__main__":
    unittest.main()
