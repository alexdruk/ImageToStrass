"""IS (PN-09, diagnosis only; not used by the service): where does a portrait's skin colour change?

    .venv/bin/python scripts/skin_check.py JOBS.json OUT.json [CHECK_DIR]
    .venv/bin/python scripts/skin_check.py --sheet OUT.json SHEET.png

JOBS.json: [{"id": "...", "attempt": "an attempt folder of a listing run (prepared.png, ai.png,
layout.json, stones.json)", "patches": [Face Mesh points, optional]}, ...]. For each design the face's
skin area is found in prepared.png with the service's MediaPipe Face Landmarker (the committed
model): discs around the cheek and chin landmarks (PATCHES, or the job's own "patches" where the
default ones fall on a beard; radius PATCH_SHARE of the face's width), inside the convex hull of the face mesh
and the cut-out (alpha >= 128). The same face area in the AI image: the AI's own face landmarks
mapped onto the photo's by a similarity transform (cv2.estimateAffinePartial2D on the 468 mesh
points), as the AI redraws the face a little moved; without a face in the AI image, the model-input
crop of spec 7.1 (the cut-out's box plus 3 % of its longest side, scaled to the AI image).
aiLandmarkShiftRadii says how far the AI's landmarks are from the crop mapping's (mean, in patch
radii). The final stones are those whose centre (stones.json mm -> AI px: (mm + offsetMm) / mmPerPx,
the layout report) lies in the AI area.

Per design OUT.json holds the median CIE Lab of the area in the photo and in the AI image, the
stones' colours and counts and the median Lab of their catalogue fills, and per stone: the AI
colour the service reads (mean Lab of the inner 60 % of the stone, as sample_delivered and
skin_nearest_inner), the plain catalogue snap of that colour (colour.snap_colours, the DEFAULT
palette) and its nearest SKIN colour (faces.skin_nearest's choice), and the photo's colour under
the stone with its plain snap and nearest SKIN colour (what the stones would be if the AI had kept
the photo's colour), and restPhoto / restAi: the median Lab of everything outside the face mesh's
hull (hair, clothes, objects) in the photo and the AI image, and hullPhoto / hullAi: the median Lab
of the whole face (the hull itself). --sheet draws OUT.json as one row per
design: the skin's median colour in the photo, in the AI image and in the stones' fills, each with
its L* a* b*, then the stones in proportion, and the stones the photo's own colour snaps to.
CHECK_DIR: an image per design with the area drawn on the photo and the AI image.
"""
import hashlib
import json
import os
import sys
from collections import Counter

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import FaceLandmarker, FaceLandmarkerOptions
from PIL import Image, ImageDraw
from PIL import ImageFont
from skimage.color import deltaE_ciede2000, lab2rgb, rgb2lab

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from strass_layout import DEFAULT  # noqa: E402
from strass_layout.colour import palette, snap_colours  # noqa: E402
from strass_layout.distinct import SKIN  # noqa: E402

MODEL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "mediapipe", "face_landmarker.task")
# Face Mesh points: both cheeks (below the eyes, beside the nose) and the chin above its edge.
PATCHES = (50, 280, 205, 425, 199)
SIDES = (234, 454)
PATCH_SHARE = 0.06
SUBJECT_ALPHA, SUBJECT_MARGIN = 128, 0.03
SAMPLE_SHARE = 0.6
PAL = palette(DEFAULT)
SKIN_IDS = [k for k in PAL.ids if k in SKIN and k != "topaz"]


def landmarks(det, rgb):
    for prep in (lambda x: x, lambda x: cv2.medianBlur(x, 5), lambda x: cv2.GaussianBlur(x, (0, 0), 3)):
        found = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(prep(rgb)))).face_landmarks
        if found:
            h, w = rgb.shape[:2]
            best = max(found, key=lambda f: np.ptp([p.x for p in f]))
            return np.array([[p.x * w, p.y * h] for p in best])
    return None


def on_white(rgba):
    a = rgba[..., 3:4] / 255.0
    return (rgba[..., :3] * a + 255 * (1 - a)).astype(np.uint8)


def area(shape, lm, alpha, patches=PATCHES):
    h, w = shape
    r = PATCH_SHARE * float(np.hypot(*(lm[SIDES[0]] - lm[SIDES[1]])))
    m = np.zeros((h, w), np.uint8)
    for k in patches:
        cv2.circle(m, tuple(int(round(v)) for v in lm[k]), int(round(r)), 1, -1)
    return (m > 0) & hull_mask((h, w), lm) & (alpha >= SUBJECT_ALPHA), r


def hull_mask(shape, lm):
    m = np.zeros(shape, np.uint8)
    cv2.fillConvexPoly(m, cv2.convexHull(lm[:468].astype(np.int32)), 1)
    return m > 0


def crop_box(alpha):
    ys, xs = np.nonzero(alpha >= SUBJECT_ALPHA)
    left, top, bw, bh = xs.min(), ys.min(), xs.max() - xs.min() + 1, ys.max() - ys.min() + 1
    m = round(SUBJECT_MARGIN * max(bw, bh))
    return left - m, top - m, left + bw + m, top + bh + m


def lab_of(rgb):
    return rgb2lab(rgb.reshape(-1, 1, 3) / 255.0).reshape(-1, 3)


def fill_lab(ids):
    return np.array([PAL.lab[PAL.ids.index(k)] for k in ids])


def nearest_skin(lab):
    cat = fill_lab(SKIN_IDS)
    return [SKIN_IDS[int(np.argmin(deltaE_ciede2000(np.repeat(c[None], len(cat), 0), cat)))] for c in lab]


def disc_mean(lab_img, alpha, x, y, r):
    h, w = alpha.shape
    R = max(2.0, r)
    y0, y1, x0, x1 = int(max(0, y - R)), int(min(h, y + R + 1)), int(max(0, x - R)), int(min(w, x + R + 1))
    yy, xx = np.mgrid[y0:y1, x0:x1]
    m = (np.hypot(yy - y, xx - x) <= R) & (alpha[y0:y1, x0:x1] >= SUBJECT_ALPHA)
    return lab_img[y0:y1, x0:x1][m].mean(0) if m.sum() else None


def stats(lab):
    med = np.median(lab, 0)
    return {"n": int(len(lab)), "L": round(float(med[0]), 1), "a": round(float(med[1]), 1), "b": round(float(med[2]), 1)}


def run(job, det, check_dir):
    d = job["attempt"]
    photo = np.array(Image.open(os.path.join(d, "prepared.png")).convert("RGBA"))
    ai = np.array(Image.open(os.path.join(d, "ai.png")).convert("RGBA"))
    layout = json.load(open(os.path.join(d, "layout.json")))
    stones = json.load(open(os.path.join(d, "stones.json")))["stones"]
    rep = layout["report"]

    lm = landmarks(det, on_white(photo))
    if lm is None:
        raise RuntimeError(f"{job['id']}: no face in prepared.png")
    patches = job.get("patches", PATCHES)
    mask, r = area(photo.shape[:2], lm, photo[..., 3], patches)
    left, top, right, bottom = crop_box(photo[..., 3])
    sx, sy = ai.shape[1] / (right - left), ai.shape[0] / (bottom - top)
    to_ai = lambda p: np.stack([(p[..., 0] - left) * sx, (p[..., 1] - top) * sy], -1)  # noqa: E731
    to_photo = lambda q: np.stack([q[..., 0] / sx + left, q[..., 1] / sy + top], -1)  # noqa: E731
    lm_ai = landmarks(det, on_white(ai))
    shift = None if lm_ai is None else round(float(np.mean(np.hypot(*(lm_ai[:468] - to_ai(lm[:468])).T))) / (r * sx), 2)
    if lm_ai is not None:
        M, _ = cv2.estimateAffinePartial2D(lm_ai[:468].astype(np.float32), lm[:468].astype(np.float32))
        to_photo = lambda q: q @ M[:, :2].T + M[:, 2]  # noqa: E731

    # The same area in the AI image: every AI pixel whose centre maps into the photo's area.
    yy, xx = np.mgrid[0:ai.shape[0], 0:ai.shape[1]]
    back = np.rint(to_photo(np.stack([xx + 0.5, yy + 0.5], -1))).astype(int)
    inside = (back[..., 0] >= 0) & (back[..., 0] < photo.shape[1]) & (back[..., 1] >= 0) & (back[..., 1] < photo.shape[0])
    ai_mask = np.zeros(ai.shape[:2], bool)
    ai_mask[inside] = mask[back[..., 1][inside], back[..., 0][inside]]
    ai_mask &= ai[..., 3] >= SUBJECT_ALPHA


    photo_lab, ai_lab = rgb2lab(photo[..., :3] / 255.0), rgb2lab(ai[..., :3] / 255.0)
    out = {"id": job["id"], "attempt": d, "patches": list(patches), "patchRadiusPx": round(r, 1), "aiLandmarkShiftRadii": shift,
           "aiArea": "ai landmarks" if lm_ai is not None else "model-input crop",
           "photo": stats(photo_lab[mask]), "ai": stats(ai_lab[ai_mask])}
    # Everything but the face (hair, clothes, objects): does the AI lighten the whole picture?
    out["restPhoto"] = stats(photo_lab[(photo[..., 3] >= SUBJECT_ALPHA) & ~hull_mask(photo.shape[:2], lm)])
    if lm_ai is not None:
        out["restAi"] = stats(ai_lab[(ai[..., 3] >= SUBJECT_ALPHA) & ~hull_mask(ai.shape[:2], lm_ai)])
    # PN-10: the whole face (the face mesh's hull, eyes, brows and lips included), a second view next
    # to the cheek and chin area, which holds the face's lightest skin.
    out["hullPhoto"] = stats(photo_lab[(photo[..., 3] >= SUBJECT_ALPHA) & hull_mask(photo.shape[:2], lm)])
    if lm_ai is not None:
        out["hullAi"] = stats(ai_lab[(ai[..., 3] >= SUBJECT_ALPHA) & hull_mask(ai.shape[:2], lm_ai)])

    off, mpp = rep["offsetMm"], rep["mmPerPx"]
    picked = []
    for s in stones:
        x, y = (s["xMm"] + off[0]) / mpp, (s["yMm"] + off[1]) / mpp
        xi, yi = int(x), int(y)
        if 0 <= yi < ai.shape[0] and 0 <= xi < ai.shape[1] and ai_mask[yi, xi]:
            rr = SAMPLE_SHARE * 0.5 * s["sizeMm"] / mpp
            px, py = to_photo(np.array([x, y]))
            scale = float(np.hypot(*(to_photo(np.array([1.0, 0.0])) - to_photo(np.array([0.0, 0.0])))))
            picked.append({"color": s["color"], "sizeMm": s["sizeMm"], "ai": disc_mean(ai_lab, ai[..., 3], x, y, rr),
                           "photo": disc_mean(photo_lab, photo[..., 3], px, py, rr * scale)})
    picked = [p for p in picked if p["ai"] is not None and p["photo"] is not None]
    ids = [p["color"] for p in picked]
    out["stones"] = {"n": len(ids), "colours": dict(Counter(ids).most_common()), "fill": stats(fill_lab(ids))}
    ai_s, ph_s = np.array([p["ai"] for p in picked]), np.array([p["photo"] for p in picked])
    out["aiUnderStones"] = stats(ai_s)
    out["aiSnap"] = dict(Counter(snap_colours(ai_s, PAL)[0]).most_common())
    out["aiNearestSkin"] = dict(Counter(nearest_skin(ai_s)).most_common())
    out["photoUnderStones"] = stats(ph_s)
    out["photoSnap"] = dict(Counter(snap_colours(ph_s, PAL)[0]).most_common())
    out["photoNearestSkin"] = dict(Counter(nearest_skin(ph_s)).most_common())
    med = np.median(photo_lab[mask], 0)
    de = deltaE_ciede2000(np.repeat(med[None], len(PAL.ids), 0), PAL.lab)
    out["photoNearestCatalogue"] = [{"id": PAL.ids[i], "dE": round(float(de[i]), 1), "skin": PAL.ids[i] in SKIN}
                                    for i in np.argsort(de)[:5]]

    if check_dir:
        a = Image.fromarray(on_white(photo)).convert("RGB")
        b = Image.fromarray(on_white(ai)).convert("RGB")
        for img, m, pts in ((a, mask, lm), (b, ai_mask, to_ai(lm) if lm_ai is None else lm_ai)):  # noqa: B023
            over = np.array(img)
            over[m] = (0.5 * over[m] + [0, 127, 127]).astype(np.uint8)
            img.paste(Image.fromarray(over))
            dr = ImageDraw.Draw(img)
            for k in patches:
                dr.ellipse([pts[k][0] - 4, pts[k][1] - 4, pts[k][0] + 4, pts[k][1] + 4], fill=(255, 0, 255))
        h = 900
        a, b = (im.resize((round(im.width * h / im.height), h)) for im in (a, b))
        sheet = Image.new("RGB", (a.width + b.width + 20, h), "white")
        sheet.paste(a, (0, 0))
        sheet.paste(b, (a.width + 20, 0))
        sheet.save(os.path.join(check_dir, f"{job['id']}-area.jpg"), quality=85)
    return out


FONT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "tools", "fonts", "Inter-{}.ttf")


def rgb_of(L, a, b):
    return tuple(int(round(255 * v)) for v in np.clip(lab2rgb(np.array([[[L, a, b]]], float))[0, 0], 0, 1))


def sheet(results, out_file):
    font = lambda w, px: ImageFont.truetype(FONT.format(w), px)  # noqa: E731
    SW, SH, GAP, LEFT, ROW, TOP = 220, 150, 24, 300, 250, 110
    heads = ["Photo", "AI image", "Stones", "Stones, by count", "If the photo's colour reached the stones"]
    W = LEFT + 3 * (SW + GAP) + 2 * (2 * SW + GAP) + GAP
    img = Image.new("RGB", (W, TOP + ROW * len(results)), "white")
    dr = ImageDraw.Draw(img)
    x = LEFT
    for i, h in enumerate(heads):
        dr.text((x, 50), h, fill="#0e1730", font=font("SemiBold", 24))
        x += (SW if i < 3 else 2 * SW) + GAP
    for k, r in enumerate(results):
        y = TOP + k * ROW
        dr.text((24, y + 50), r["id"], fill="#0e1730", font=font("SemiBold", 26))
        dr.text((24, y + 88), f"{r['stones']['n']} stones in the area", fill="#5a6680", font=font("Regular", 20))
        x = LEFT
        for st in (r["photo"], r["ai"], r["stones"]["fill"]):
            dr.rectangle([x, y, x + SW, y + SH], fill=rgb_of(st["L"], st["a"], st["b"]))
            dr.text((x, y + SH + 10), f"L* {st['L']}  a* {st['a']}  b* {st['b']}", fill="#0e1730", font=font("Regular", 19))
            x += SW + GAP
        for counts in (r["stones"]["colours"], r["photoSnap"]):
            n, x0 = sum(counts.values()), x
            for cid, c in counts.items():
                w = round(2 * SW * c / n) if cid != list(counts)[-1] else x + 2 * SW - x0
                dr.rectangle([x0, y, x0 + w, y + SH], fill=PAL.fills[PAL.ids.index(cid)])
                x0 += w
            top = ", ".join(f"{cid} {c}" for cid, c in list(counts.items())[:3])
            dr.text((x, y + SH + 10), top, fill="#0e1730", font=font("Regular", 19))
            x += 2 * SW + GAP
    img.save(out_file, optimize=True)


def main():
    if sys.argv[1] == "--sheet":
        return sheet(json.load(open(sys.argv[2])), sys.argv[3])
    jobs, out_file = json.load(open(sys.argv[1])), sys.argv[2]
    check_dir = sys.argv[3] if len(sys.argv) > 3 else None
    det = FaceLandmarker.create_from_options(FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=MODEL), num_faces=4))
    results = [run(j, det, check_dir) for j in jobs]
    for j, r in zip(jobs, results):
        r["tintedSha256"] = hashlib.sha256(open(os.path.join(j["attempt"], "tinted.png"), "rb").read()).hexdigest()
    json.dump(results, open(out_file, "w"), indent=1)
    print(json.dumps([{k: r[k] for k in ("id", "aiLandmarkShiftRadii", "photo", "ai", "stones")} for r in results], indent=1))


if __name__ == "__main__":
    main()
