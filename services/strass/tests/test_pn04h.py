# IS: new file, not from Rhinestone-Studio.
"""PN-04h: Rules.lone_white_skin (on in DEFAULT only)."""
import dataclasses
import unittest

import numpy as np

from strass_layout import DEFAULT, PROTOTYPE
from strass_layout.colour import PLUS_REAL_SKIN
from strass_layout.distinct import SKIN
from strass_layout.faces import WHITE, lone_white_skin
from strass_layout.rules import BUILD_E, BUILD_F, BUILD_G, BUILD_H, BUILD_I
from tests import support

ALL = (PROTOTYPE, BUILD_E, BUILD_F, BUILD_G, BUILD_H, BUILD_I, DEFAULT)
PAL = PLUS_REAL_SKIN


def _hex_grid(rows, cols, pitch=2.1):
    return np.array([[c * pitch + (r % 2) * pitch / 2, r * pitch * 0.87] for r in range(rows) for c in range(cols)])


class Defaults(unittest.TestCase):
    def test_only_default_has_it(self):
        for rules in ALL:
            self.assertEqual(rules.lone_white_skin, rules is DEFAULT)


class LoneWhite(unittest.TestCase):
    def setUp(self):
        self.P = _hex_grid(5, 5)
        self.D = np.full(len(self.P), 2.0)
        self.mid = 12  # row 2, column 2: six neighbours

    def colours(self, centre, around="silk"):
        C = [around] * len(self.P)
        C[self.mid] = centre
        return C

    def test_a_white_stone_in_skin_takes_the_skin_colour(self):
        for white in sorted(WHITE):
            out, n = lone_white_skin(self.P, self.D, self.colours(white), PAL, [])
            self.assertEqual((out[self.mid], n), ("silk", 1), white)

    def test_the_most_common_neighbour_colour_and_on_a_tie_the_lighter(self):
        C = self.colours("crystal-clear")
        nb = [i for i in range(len(self.P)) if i != self.mid and np.hypot(*(self.P[i] - self.P[self.mid])) < 2.7]
        self.assertEqual(len(nb), 6)
        for k, i in enumerate(nb):
            C[i] = "rose-gold" if k < 4 else "light-peach"
        self.assertEqual(lone_white_skin(self.P, self.D, C, PAL, [])[0][self.mid], "rose-gold")
        for k, i in enumerate(nb):
            C[i] = "copper" if k < 3 else "light-peach"
        self.assertEqual(lone_white_skin(self.P, self.D, C, PAL, [])[0][self.mid], "light-peach")

    def test_kept_near_an_eye_next_to_anything_not_skin_and_when_not_white(self):
        x, y = self.P[self.mid]
        self.assertEqual(lone_white_skin(self.P, self.D, self.colours("crystal-clear"), PAL, [(x + 2, y, 3.0)])[1], 0)
        C = self.colours("crystal-clear")
        C[self.mid + 1] = "jet"
        self.assertEqual(lone_white_skin(self.P, self.D, C, PAL, [])[1], 0)
        self.assertEqual(lone_white_skin(self.P, self.D, self.colours("grey"), PAL, [])[1], 0)
        # Larger than SS6 (a pupil or a cap-sized stone) is left alone.
        D = self.D.copy()
        D[self.mid] = 4.7
        self.assertEqual(lone_white_skin(self.P, D, self.colours("crystal-clear"), PAL, [])[1], 0)
        # Only skin around it counts: white among white stays.
        self.assertEqual(lone_white_skin(self.P, self.D, self.colours("crystal-clear", "crystal-clear"), PAL, [])[1], 0)

    def test_on_a_layout_only_white_stones_become_skin(self):
        on = support.layout_result("woman", DEFAULT)
        off = support.layout_result("woman", dataclasses.replace(DEFAULT, lone_white_skin=False))
        self.assertEqual([s[:3] for s in on["stones"]], [s[:3] for s in off["stones"]])
        for a, b in zip(off["stones"], on["stones"]):
            if a[3] != b[3]:
                self.assertIn(a[3], WHITE)
                self.assertIn(b[3], SKIN)


if __name__ == "__main__":
    unittest.main()
