# IS: new file, not from Rhinestone-Studio.
"""IS-05b: plausible pupils (Rules.plausible_eyes) and the pupil positions in the report."""
import unittest

import numpy as np

from strass_layout import DEFAULT
from strass_layout.post import _plausible_pupils
from strass_layout.rules import BUILD_I
from tests import support


def pupil(x, y, d=1.0):
    return {"x": float(x), "y": float(y), "diam_mm": d}


class PlausiblePupils(unittest.TestCase):
    # Subject mask 400 px wide: a pair may be at most 180 px apart.
    MASK = np.zeros((300, 500), bool)
    MASK[50:250, 50:450] = True

    def test_none_or_one_pupil_is_plausible(self):
        self.assertTrue(_plausible_pupils([], self.MASK))
        self.assertTrue(_plausible_pupils([pupil(100, 100)], self.MASK))

    def test_a_level_pair_of_equal_pupils_is_plausible(self):
        self.assertTrue(_plausible_pupils([pupil(150, 100), pupil(250, 110)], self.MASK))

    def test_more_than_two_pupils_are_not_a_face(self):
        self.assertFalse(_plausible_pupils([pupil(100, 100), pupil(200, 100), pupil(300, 100)], self.MASK))

    def test_very_different_sizes(self):
        self.assertTrue(_plausible_pupils([pupil(150, 100, 1.0), pupil(250, 100, 1.55)], self.MASK))
        self.assertFalse(_plausible_pupils([pupil(150, 100, 1.0), pupil(250, 100, 1.6)], self.MASK))

    def test_far_from_horizontal(self):
        self.assertTrue(_plausible_pupils([pupil(150, 100), pupil(250, 150)], self.MASK))
        self.assertFalse(_plausible_pupils([pupil(150, 100), pupil(250, 151)], self.MASK))
        self.assertFalse(_plausible_pupils([pupil(150, 100), pupil(150, 160)], self.MASK))

    def test_too_far_apart_for_the_subject(self):
        self.assertTrue(_plausible_pupils([pupil(100, 100), pupil(280, 100)], self.MASK))
        self.assertFalse(_plausible_pupils([pupil(100, 100), pupil(281, 100)], self.MASK))

    def test_default_rules_check_the_pupils(self):
        self.assertTrue(DEFAULT.plausible_eyes)
        self.assertFalse(BUILD_I.plausible_eyes)


class PupilPositions(unittest.TestCase):
    def test_each_reported_pupil_is_a_stone_centre(self):
        for name in ("cat", "woman"):
            with self.subTest(image=name):
                result = support.layout_result(name, DEFAULT)
                report = result["report"]
                self.assertEqual(len(report["pupilsAtMm"]), len(report["pupilsMm"]))
                self.assertEqual(len(report["pupilsAtMm"]), 2)
                self.assertIsNotNone(report["face"])
                centres = {(s[0], s[1]): s[2] for s in result["stones"]}
                for (x, y) in report["pupilsAtMm"]:
                    self.assertIn((x, y), centres)
                    self.assertIn(centres[(x, y)], ("ss20", "ss30"))


if __name__ == "__main__":
    unittest.main()
