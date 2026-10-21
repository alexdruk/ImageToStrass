# IS: new file, not from Rhinestone-Studio.
"""IS-05c: human_iris off in DEFAULT, and skin_nearest reading the inner 60 % of each stone
(Rules.skin_nearest_inner)."""
import dataclasses
import unittest

from strass_layout import DEFAULT, PROTOTYPE
from strass_layout.distinct import SKIN
from strass_layout.rules import BUILD_E, BUILD_F, BUILD_G, BUILD_H, BUILD_I
from tests import support
from tests.test_build_f import iris_stones

BUILDS = (PROTOTYPE, BUILD_E, BUILD_F, BUILD_G, BUILD_H, BUILD_I)


class Defaults(unittest.TestCase):
    def test_default_has_no_human_iris(self):
        self.assertFalse(DEFAULT.human_iris)
        self.assertTrue(BUILD_I.human_iris)

    def test_only_default_reads_the_inner_part_for_skin_nearest(self):
        self.assertTrue(DEFAULT.skin_nearest_inner)
        for rules in BUILDS:
            self.assertFalse(rules.skin_nearest_inner)


class HumanIris(unittest.TestCase):
    def test_people_lose_the_iris_rings(self):
        for name in ("woman", "portrait"):
            with self.subTest(image=name):
                on = iris_stones(support.frame_result(name, dataclasses.replace(DEFAULT, human_iris=True)))
                off = iris_stones(support.frame_result(name, DEFAULT))
                print("IRIS %s %d->%d" % (name, on, off))
                self.assertLess(off, on)

    def test_animals_are_unchanged(self):
        # An animal's iris rings do not depend on the rule.
        for name in ("cat", "dog"):
            with self.subTest(image=name):
                on = support.layout_result(name, dataclasses.replace(DEFAULT, human_iris=True))
                off = support.layout_result(name, DEFAULT)
                self.assertEqual(on["report"]["face"], "animal")
                self.assertEqual(on["stones"], off["stones"])


class SkinNearestInner(unittest.TestCase):
    def test_only_skin_colours_change(self):
        for name in ("woman", "dog"):
            with self.subTest(image=name):
                on = support.layout_result(name, DEFAULT)
                off = support.layout_result(name, dataclasses.replace(DEFAULT, skin_nearest_inner=False))
                self.assertEqual([s[:3] for s in on["stones"]], [s[:3] for s in off["stones"]])
                for key in ("face", "pupilsMm", "pupilsAtMm", "bySize", "violations", "coverage"):
                    self.assertEqual(on["report"][key], off["report"][key], key)
                diff = [(a[3], b[3]) for a, b in zip(off["stones"], on["stones"]) if a[3] != b[3]]
                self.assertGreater(len(diff), 0)
                self.assertTrue(all(a in SKIN and b in SKIN for a, b in diff))

    def test_the_woman_has_less_smoked_topaz(self):
        # The whole disc reaches into the AI's dark gaps (docs/IS-05c-results.md section 2).
        count = lambda r: sum(s[3] == "smoked-topaz" for s in r["stones"])
        on = count(support.layout_result("woman", DEFAULT))
        off = count(support.layout_result("woman", dataclasses.replace(DEFAULT, skin_nearest_inner=False)))
        print("SMOKED TOPAZ woman %d->%d" % (off, on))
        self.assertLess(on, off)


if __name__ == "__main__":
    unittest.main()
