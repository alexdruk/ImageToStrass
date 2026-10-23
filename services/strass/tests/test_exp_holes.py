# IS: new file, not from Rhinestone-Studio.
"""exp-holes: Rules.fill_exact and Rules.fill_cover_mask (experiment, off everywhere including DEFAULT)."""
import dataclasses
import unittest

import numpy as np

from strass_layout import DEFAULT, PROTOTYPE
from strass_layout.geometry import GAP, _exact_keep, mask_cover, violations
from strass_layout.rules import BUILD_E, BUILD_F, BUILD_G, BUILD_H, BUILD_I
from tests import support

ALL = (PROTOTYPE, BUILD_E, BUILD_F, BUILD_G, BUILD_H, BUILD_I, DEFAULT)


class Defaults(unittest.TestCase):
    def test_off_everywhere(self):
        for rules in ALL:
            self.assertFalse(rules.fill_exact)
            self.assertFalse(rules.fill_cover_mask)


class Helpers(unittest.TestCase):
    def test_exact_keep_drops_stones_closer_than_the_gap(self):
        P = np.array([[0.0, 0.0]])
        D = np.array([2.0])
        # 2.1 apart: gap 0.1, kept; 2.05: gap 0.05, dropped; the third is 2.1 from the first new one.
        newP = np.array([[2.1, 0.0], [0.0, 2.05], [4.2, 0.0]])
        newD = np.array([2.0, 2.0, 2.0])
        self.assertEqual(list(_exact_keep(P, D, newP, newD)), [True, False, True])
        self.assertEqual(list(_exact_keep(P, D, np.array([[2.1, 0.0], [2.2, 0.0]]), newD[:2])), [True, False])

    def test_mask_cover(self):
        mask = np.zeros((100, 100), bool)
        mask[:, :50] = True
        cover = mask_cover(mask, np.array([[2.5, 5.0], [5.0, 5.0], [7.5, 5.0]]), 2.0, 0.1)
        self.assertEqual(cover[0], 1.0)
        self.assertAlmostEqual(cover[1], 0.5, delta=0.1)
        self.assertEqual(cover[2], 0.0)


class OnWoman(unittest.TestCase):
    def test_only_stones_are_added_and_the_gaps_hold(self):
        base = support.layout_result("woman", DEFAULT)
        for rules in (dataclasses.replace(DEFAULT, fill_exact=True), dataclasses.replace(DEFAULT, fill_exact=True, fill_cover_mask=True)):
            out = support.layout_result("woman", rules)
            self.assertGreaterEqual(len(out["stones"]), len(base["stones"]))
            # The fill adds stones; the stones before it stay where they were (the crop may move).
            ox = out["report"]["offsetMm"][0] - base["report"]["offsetMm"][0]
            oy = out["report"]["offsetMm"][1] - base["report"]["offsetMm"][1]
            have = {(round(s[0] + ox, 3), round(s[1] + oy, 3), s[2]) for s in out["stones"]}
            missing = [s for s in base["stones"] if (round(s[0], 3), round(s[1], 3), s[2]) not in have]
            self.assertLessEqual(len(missing), 0.01 * len(base["stones"]))
            self.assertEqual(out["report"]["face"], base["report"]["face"])
            P = np.array([s[:2] for s in out["stones"]])
            D = np.array([{"ss4": 1.5, "ss6": 2.0, "ss10": 2.8, "ss16": 4.0, "ss20": 4.7, "ss30": 6.4}[s[2]] for s in out["stones"]])
            cnt, gmin = violations(P, D)
            self.assertEqual(int(cnt.sum()), 0)
            self.assertGreaterEqual(gmin, GAP - 1e-6)


if __name__ == "__main__":
    unittest.main()
