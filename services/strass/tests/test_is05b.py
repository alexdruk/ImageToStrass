# IS: new file, not from Rhinestone-Studio.
"""IS-05b: plausible pupils (Rules.plausible_eyes), the pupil positions in the report and
soft_outlines off in DEFAULT."""
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

    def kept(self, cands):
        return _plausible_pupils(cands, self.MASK)

    def plausible(self, cands):
        return self.kept(cands) is not None

    def test_none_or_one_pupil_is_plausible(self):
        self.assertEqual(self.kept([]), [])
        one = [pupil(100, 100)]
        self.assertEqual(self.kept(one), one)

    def test_a_level_pair_of_equal_pupils_is_plausible(self):
        pair = [pupil(150, 100), pupil(250, 110)]
        self.assertEqual(self.kept(pair), pair)

    def test_very_different_sizes(self):
        self.assertTrue(self.plausible([pupil(150, 100, 1.0), pupil(250, 100, 1.55)]))
        self.assertFalse(self.plausible([pupil(150, 100, 1.0), pupil(250, 100, 1.6)]))

    def test_far_from_horizontal(self):
        self.assertTrue(self.plausible([pupil(150, 100), pupil(250, 150)]))
        self.assertFalse(self.plausible([pupil(150, 100), pupil(250, 151)]))
        self.assertFalse(self.plausible([pupil(150, 100), pupil(150, 160)]))

    def test_too_far_apart_for_the_subject(self):
        self.assertTrue(self.plausible([pupil(100, 100), pupil(280, 100)]))
        self.assertFalse(self.plausible([pupil(100, 100), pupil(281, 100)]))

    def test_of_more_than_two_the_one_plausible_pair_is_kept(self):
        # The IS-03b giraffe (its frame mm x 5 + 50, subject 80 mm wide): a large false pupil on an
        # ossicone above, one on the neck below, and the two eyes (sizes 1.18 apart, level).
        ossicone, neck = pupil(201, 78, 5.56), pupil(175, 316, 3.96)
        left, right = pupil(203, 216, 3.95), pupil(96, 211, 3.34)
        self.assertEqual(self.kept([ossicone, neck, left, right]), [left, right])

    def test_several_plausible_pairs_are_not_a_face(self):
        # Three level pupils: two pairs pass (the outer one is too far apart).
        self.assertIsNone(self.kept([pupil(100, 100), pupil(200, 100), pupil(300, 100)]))

    def test_more_than_two_with_no_plausible_pair_are_not_a_face(self):
        self.assertIsNone(self.kept([pupil(100, 50), pupil(100, 150), pupil(100, 250)]))

    def test_default_rules_check_the_pupils(self):
        self.assertTrue(DEFAULT.plausible_eyes)
        self.assertFalse(BUILD_I.plausible_eyes)

    def test_default_rules_have_no_soft_outlines(self):
        self.assertFalse(DEFAULT.soft_outlines)
        self.assertTrue(BUILD_I.soft_outlines)


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
