# IS: new file, not from Rhinestone-Studio.
"""exp-holes: Rules.fill_exact and Rules.fill_cover_mask (experiment, off everywhere including DEFAULT)."""
import dataclasses
import unittest

import numpy as np

from strass_layout import DEFAULT, PROTOTYPE
from strass_layout.colour import stone_colours
from strass_layout.eyes import find_pupils
from strass_layout.imageio import Pixels
from strass_layout.geometry import GAP, _exact_keep, mask_cover, violations
from strass_layout.ordered import delivered_lab
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


class StoneBeyondTheEdge(unittest.TestCase):
    """The DM crash (colour.py: IndexError on an empty quantile): a delivered stone past the image's
    last row, as the fill and legalise place it when the subject touches the border, has no pixel
    within its sampling radius."""

    def test_delivered_colour_of_a_stone_past_the_last_row(self):
        h, w, s = 20, 30, 0.2
        rgb = np.zeros((h, w, 3), np.float32)
        rgb[..., 0] = 1.0  # red
        a = np.ones((h, w), np.float32)
        # An SS4 stone 2.1 px below the last row's centre: its mean disc (2.25 px) holds fewer than
        # 3 pixels and its core (R = 2 px) none, so the median rule had nothing to take a quantile of.
        P = np.array([[10 * s, (h - 1 + 2.1) * s]])
        lab = delivered_lab(rgb, a, s, P, np.array([1.5]), True)
        self.assertAlmostEqual(lab[0][0], 53.2, delta=0.5)  # L* of pure red
        self.assertGreater(lab[0][1], 70)
        # The median rule too, with the whole disc far outside the image.
        out = stone_colours(rgb, a, np.array([[h + 50.0, -40.0, 1.0, 0.0]]))
        self.assertAlmostEqual(out[0][0], 53.2, delta=0.5)


class DarkDiscAtTheEdge(unittest.TestCase):
    """The second crash of the same design (eyes.py, _find_inscribed: IndexError past the last row):
    a dark region cut by the image's border, with a highlight, has its distance peak near the edge,
    and the window around it reached past the image."""

    def test_find_pupils_with_a_dark_disc_cut_by_the_bottom_edge(self):
        h, w = 60, 80
        rgba = np.zeros((h, w, 4), np.uint8)
        rgba[..., 3] = 255
        rgba[..., :3] = 200  # light grey
        yy, xx = np.mgrid[0:h, 0:w]
        rgba[np.hypot(yy - (h - 1), xx - 40) <= 22, :3] = 10  # a dark disc centred on the last row
        rgba[np.hypot(yy - (h - 9), xx - 42) <= 2.5, :3] = 250  # its highlight
        cands = find_pupils(Pixels(rgba), 0.15, 12.0, core_only=True, inscribed=True)
        self.assertIsInstance(cands, list)


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
