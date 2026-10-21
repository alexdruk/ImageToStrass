# IS: new file, not from Rhinestone-Studio.
"""IS-05d (experiment): Rules.warm_shadow and Rules.mixed_shadow, off everywhere including DEFAULT."""
import dataclasses
import unittest

import numpy as np

from strass_layout import DEFAULT, PROTOTYPE
from strass_layout.colour import PLUS_REAL_SKIN
from strass_layout.faces import COLORADO, MIX_PATTERNS, SMOKED, _linear, _mix_lab, _rows, mixed_shadow, skin_nearest
from strass_layout.rules import BUILD_E, BUILD_F, BUILD_G, BUILD_H, BUILD_I
from tests import support

ALL = (PROTOTYPE, BUILD_E, BUILD_F, BUILD_G, BUILD_H, BUILD_I, DEFAULT)
PAL = PLUS_REAL_SKIN


def _hex_grid(rows, cols, pitch=2.1):
    return np.array([[c * pitch + (r % 2) * pitch / 2, r * pitch * 0.87] for r in range(rows) for c in range(cols)])


def _mix(share):
    lin = _linear([PAL.fills[PAL.ids.index(SMOKED)], PAL.fills[PAL.ids.index(COLORADO)]])
    return _mix_lab(lin, [share])[0]


class Defaults(unittest.TestCase):
    def test_the_rules_are_off_everywhere(self):
        for rules in ALL:
            self.assertFalse(rules.warm_shadow)
            self.assertFalse(rules.mixed_shadow)


class WarmShadow(unittest.TestCase):
    def test_a_near_tie_takes_colorado_topaz(self):
        # The woman's mean shadow colour (docs/IS-05c-results.md 2.2): Smoked Topaz 11.9, Colorado 12.9.
        lab = np.array([[33.4, 25.7, 34.1]])
        D, C = np.array([2.0]), [SMOKED]
        self.assertEqual(skin_nearest(D, C, lab, PAL)[0], [SMOKED])
        self.assertEqual(skin_nearest(D, C, lab, PAL, warm_de=3.0)[0], [COLORADO])
        # A clear Smoked Topaz stays.
        self.assertEqual(skin_nearest(D, C, PAL.lab[PAL.ids.index(SMOKED)][None], PAL, warm_de=3.0)[0], [SMOKED])

    def test_only_smoked_topaz_becomes_colorado_topaz(self):
        on = support.layout_result("woman", dataclasses.replace(DEFAULT, warm_shadow=True, warm_shadow_de=3.0))
        off = support.layout_result("woman", DEFAULT)
        self.assertEqual([s[:3] for s in on["stones"]], [s[:3] for s in off["stones"]])
        diff = {(a[3], b[3]) for a, b in zip(off["stones"], on["stones"]) if a[3] != b[3]}
        self.assertEqual(diff, {(SMOKED, COLORADO)})


class MixedShadow(unittest.TestCase):
    def test_rows_follow_the_grid(self):
        P = _hex_grid(4, 6)
        row, col = _rows(P, np.full(len(P), 2.0))
        for r in range(4):
            cols = col[r * 6:(r + 1) * 6]
            self.assertEqual(list(cols), list(range(cols[0], cols[0] + 6)))
            self.assertEqual(len(set(row[r * 6:(r + 1) * 6])), 1)
        self.assertEqual(len(set(row)), 4)

    def test_each_mix_is_laid_in_its_proportion(self):
        P = _hex_grid(8, 12)
        D = np.full(len(P), 2.0)
        for share, pattern in MIX_PATTERNS.items():
            with self.subTest(share=share):
                lab = np.repeat(_mix(share)[None], len(P), 0)
                out, _ = mixed_shadow(P, D, [SMOKED] * len(P), lab, PAL, [])
                got = sum(c == COLORADO for c in out) / len(out)
                self.assertAlmostEqual(got, sum(pattern) / len(pattern), delta=0.05)
                # along a row the pattern repeats
                row = out[2 * 12:3 * 12]
                self.assertTrue(all(row[k] == row[k + len(pattern)] for k in range(12 - len(pattern))))

    def test_a_pure_colour_and_the_eyes_are_left_alone(self):
        P = _hex_grid(6, 6)
        D = np.full(len(P), 2.0)
        lab = np.repeat(PAL.lab[PAL.ids.index(SMOKED)][None], len(P), 0)
        self.assertEqual(mixed_shadow(P, D, [SMOKED] * len(P), lab, PAL, [])[1], 0)
        lab = np.repeat(_mix(0.5)[None], len(P), 0)
        self.assertEqual(mixed_shadow(P, D, [SMOKED] * len(P), lab, PAL, [(5.0, 5.0, 100.0)])[1], 0)

    def test_only_the_two_topazes_change_on_the_woman(self):
        on = support.layout_result("woman", dataclasses.replace(DEFAULT, mixed_shadow=True))
        off = support.layout_result("woman", DEFAULT)
        self.assertEqual([s[:3] for s in on["stones"]], [s[:3] for s in off["stones"]])
        for key in ("face", "pupilsMm", "pupilsAtMm", "bySize", "violations", "coverage"):
            self.assertEqual(on["report"][key], off["report"][key], key)
        diff = {(a[3], b[3]) for a, b in zip(off["stones"], on["stones"]) if a[3] != b[3]}
        self.assertTrue(diff)
        self.assertTrue(diff <= {(SMOKED, COLORADO), (COLORADO, SMOKED)})


if __name__ == "__main__":
    unittest.main()
