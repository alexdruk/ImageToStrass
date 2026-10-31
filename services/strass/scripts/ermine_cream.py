# IS: new file, not from Rhinestone-Studio.
"""PN-04i: the listing photo of Lady with an Ermine with only the ermine (the animal) warmed to cream.

    .venv/bin/python -I scripts/ermine_cream.py <8-ermine.jpg> <out.png> [--da=1.5] [--db=5]

Listing photos only (docs/listing/README.md), never a buyer's image. The ermine's mask is a hand-drawn
polygon (POLY, in a 660 px wide preview's coordinates) less every pixel that is not fur (her hand and
skin have a* >= 4, the dress more, the sleeve b* < 3), cleaned and feathered. Inside it a* + da and
b* + db (CIELAB), lightness kept; every pixel outside the mask is unchanged. Written as PNG so nothing
else is re-encoded. Try 2 of PN-04i used da 1.5, db 5 (try 1, 4 and 11, came out golden).
"""
import argparse

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from skimage.color import lab2rgb, rgb2lab

POLY = [(312, 520), (322, 497), (345, 486), (372, 488), (392, 480), (400, 500), (418, 545), (432, 578),
        (415, 590), (402, 600), (420, 618), (442, 632), (440, 655), (422, 662), (405, 690), (392, 725),
        (388, 770), (400, 795), (380, 810), (355, 800), (340, 808), (290, 810), (220, 805), (160, 790),
        (128, 760), (132, 725), (170, 700), (230, 700), (270, 690), (300, 640), (305, 600), (305, 560)]


def ermine_mask(lab, size):
    k = size[0] / 660
    pm = Image.new("L", size, 0)
    ImageDraw.Draw(pm).polygon([(x * k, y * k) for x, y in POLY], fill=255)
    fur = (lab[..., 0] > 8) & (lab[..., 1] < 4) & (lab[..., 2] > 3)
    m = (np.asarray(pm) > 0) & fur
    mi = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(9)).filter(ImageFilter.GaussianBlur(6))
    return np.asarray(mi) / 255.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--da", type=float, default=1.5)
    ap.add_argument("--db", type=float, default=5.0)
    a = ap.parse_args()
    im = Image.open(a.src).convert("RGB")
    lab = rgb2lab(np.asarray(im) / 255.0)
    m = ermine_mask(lab, im.size)
    lab[..., 1] += a.da * m
    lab[..., 2] += a.db * m
    out = (np.clip(lab2rgb(lab), 0, 1) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(out).save(a.out)


if __name__ == "__main__":
    main()
