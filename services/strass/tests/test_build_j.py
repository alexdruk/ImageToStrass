# From Rhinestone-Studio @38cd831 services/strass-layout/tests/test_build_j.py
"""IMG-026J: the DEFAULT rules (skin and fur stones take their nearest skin colour) against BUILD_I.

See docs/specifications/IMG-026-StrassLayoutService.md, "Skin and fur tones (build J)" and the
Build J acceptance figures.

IS (IS-05b): DEFAULT has soft_outlines off, so it is compared with BUILD_I with soft_outlines off.
IS (IS-05b): DEFAULT's sample_delivered recolours stones everywhere, so DefaultAgainstBuildI runs
DEFAULT with it off (test_is05b.SampleDelivered checks that it changes only colours).
IS (IS-05c): DEFAULT has human_iris off and skin_nearest_inner on; DefaultAgainstBuildI runs DEFAULT with
human_iris on and skin_nearest_inner off (tests/test_is05c.py checks both).
IS (IS-05d): DEFAULT has warm_shadow on; DefaultAgainstBuildI runs DEFAULT with it off (tests/test_is05d.py checks it).
"""
import dataclasses
import unittest

import numpy as np
from skimage.color import rgb2lab

from strass_layout import BUILD_I, DEFAULT
from strass_layout.colour import CAT_IDS, PLUS_REAL_SKIN, palette
from strass_layout.distinct import SKIN
from strass_layout.faces import skin_nearest
from tests import support

IMAGES = support.IMAGES + ["sunburst_flower"]
MIN_GAP_MM = 0.1 - 1e-6


def hex_lab(h):
    return rgb2lab(np.array([[[int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]]]))[0, 0]


class SkinNearest(unittest.TestCase):
    def test_skin_stones_take_the_nearest_skin_colour(self):
        lab = np.array([hex_lab("#c99a6c"), hex_lab("#b87333"), hex_lab("#ebb28d"), hex_lab("#b6741e")])
        out, n = skin_nearest(np.array([2.0, 2.0, 1.5, 2.0]), ["copper", "silk", "silk", "copper"], lab, PLUS_REAL_SKIN)
        self.assertEqual(out, ["golden-shadow", "copper", "silk", "copper"])
        self.assertEqual(n, 2)

    def test_other_stones_keep_their_colour(self):
        lab = np.array([hex_lab("#c99a6c")] * 3)
        out, n = skin_nearest(np.array([2.0, 4.0, 1.5]), ["jet", "copper", "sapphire"], lab, PLUS_REAL_SKIN)
        self.assertEqual((out, n), (["jet", "copper", "sapphire"], 0))

    def test_rules(self):
        self.assertFalse(BUILD_I.skin_nearest)
        self.assertTrue(DEFAULT.skin_nearest)
        self.assertIs(palette(DEFAULT), PLUS_REAL_SKIN)


class DefaultAgainstBuildI(unittest.TestCase):
    def test_images(self):
        changed = 0
        for name in IMAGES:
            with self.subTest(image=name):
                i = support.layout_result(name, dataclasses.replace(BUILD_I, soft_outlines=False))  # IS (IS-05b)
                j = support.layout_result(name, dataclasses.replace(DEFAULT, sample_delivered=False, human_iris=True,  # IS (IS-05b, IS-05c)
                                                                   skin_nearest_inner=False, warm_shadow=False))
                ri, rj = i["report"], j["report"]
                self.assertEqual(rj["violations"], 0)
                self.assertGreaterEqual(rj["minGapMm"], MIN_GAP_MM)
                self.assertEqual(rj["stones"], ri["stones"])
                self.assertEqual(rj["coverage"], ri["coverage"])
                self.assertEqual(rj["pupilsMm"], ri["pupilsMm"])
                self.assertEqual(rj["face"], ri["face"])
                self.assertTrue(set(rj["colours"]) <= set(CAT_IDS))
                si, sj = i["stones"], j["stones"]
                self.assertEqual([q[:3] for q in sj], [q[:3] for q in si])
                diff = [(a[3], b[3]) for a, b in zip(si, sj) if a[3] != b[3]]
                self.assertTrue(all(b in SKIN for _, b in diff))
                changed += bool(diff)
                print("ROW %s skin stones changed %d" % (name, len(diff)))
        self.assertGreaterEqual(changed, 8)


if __name__ == "__main__":
    unittest.main()
