# IS: new file, not from Rhinestone-Studio.
"""exp-holes diagnosis: lays out saved AI images and records, stage by stage, which stones were
dropped, deleted or never placed, so tools/exp-holes.mjs can tell why a hole is empty. No provider
call; nothing here is used by the service.

    .venv/bin/python scripts/holes_trace.py OUT_DIR VARIANT NAME=PNG [NAME=PNG ...]

VARIANT is a name from VARIANTS below: "default" (DEFAULT), "fill-exact", "fill-cover-mask" and
"fill-both" (DEFAULT with Rules.fill_exact, Rules.fill_cover_mask or both). For each image it writes

  NAME.VARIANT.layout.json   the /layout answer (layout() with those rules, as the service returns it)
  NAME.VARIANT.trace.json    the stage record below
  NAME.strict.png            the service's strict subject mask (frame pixels, 255 = subject)

The trace holds plain lists, every position in the layout's own (cropped) mm, like its stones:

  detections     [x, y, d, why]: why is the ordered layout's verdict on the detection: "kept",
                 "tiled" (a big stone laid as tiles), "tiny", "inside-big", "shadow", "gap-dot",
                 "interstitial", "outside-mask", "duplicate", "rows-deleted" (removed by the first
                 resolve_idx, which pushes the rows apart to the gap rule)
  rowsDeleted    [x, y, d] stones the second resolve_idx (after the first fill) deleted
  fill           [x, y, d, stage, cover, room, ok]: every candidate a fill call found (stage "rows"
                 for the ordered layout's fill, "post" for the three fills after the eyes); ok is
                 cover >= 0.7 and room (geometry.fill)
  eyeDropped     [x, y, d] stones of the ordered layout the eye stage removed
  eyeAdded       [x, y, d] eye stones
  checkRemoved   [x, y, d] stones the last gap check of post_process removed
"""
import dataclasses
import json
import os
import sys

import cv2
import numpy as np
from scipy.spatial import cKDTree
from skimage.color import deltaE_ciede2000, rgb2lab

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from strass_layout import DEFAULT, load_models  # noqa: E402
from strass_layout import geometry, ordered, pipeline, post  # noqa: E402
from strass_layout.chains import chain_mask  # noqa: E402
from strass_layout.colour import stone_colours  # noqa: E402
from strass_layout.geometry import SS4, SS6, subject_mask  # noqa: E402
from strass_layout.imageio import decode_png  # noqa: E402
from strass_layout.ordered import scale_from  # noqa: E402

PITCH = 2.1

VARIANTS = {
    "default": DEFAULT,
    "fill-exact": dataclasses.replace(DEFAULT, fill_exact=True),
    "fill-cover-mask": dataclasses.replace(DEFAULT, fill_cover_mask=True),
    "fill-both": dataclasses.replace(DEFAULT, fill_exact=True, fill_cover_mask=True),
}


def ordered_verdicts(px, det, rules):
    """The ordered layout's keep-or-drop decision per detection, by the same steps as
    ordered.ordered_layout (copied here, diagnosis only). Returns (why, stones), stones being the
    list handed to the first resolve_idx: (x, y, d, detection index or -1 for a tile)."""
    rgb, a = px.rgb, px.a
    s = scale_from(PITCH, det)
    pitch_px = PITCH / s
    mask = subject_mask(a, det, pitch_px)
    col = stone_colours(rgb, a, det)
    d_mm = 2 * det[:, 2] * s
    tiny = d_mm < 1.1
    big = d_mm > 2.9
    minor_det = (d_mm >= 1.1) & (d_mm < 1.6)
    inside_big = np.zeros(len(det), bool)
    if big.any():
        tb = cKDTree(det[:, :2])
        for i in np.nonzero(big)[0]:
            for j in tb.query_ball_point(det[i, :2], det[i, 2]):
                if j != i:
                    inside_big[j] = True
    shadow = np.zeros(len(det), bool)
    tdet = cKDTree(det[:, :2])
    mainm = d_mm >= 1.6
    for i in np.nonzero(minor_det & (col[:, 0] < 30))[0]:
        nb = [j for j in tdet.query_ball_point(det[i, :2], 2.2 * det[i, 2] + 6) if j != i and mainm[j]]
        if nb and np.mean(col[nb, 0] < 30) < 0.5:
            shadow[i] = True
    gapdrop = np.zeros(len(det), bool)
    disc = np.zeros(a.shape, np.uint8)
    for y_, x_, r_, *_ in det:
        cv2.circle(disc, (int(round(x_)), int(round(y_))), int(round(r_)), 1, -1)
    subj = cv2.morphologyEx((a > 0.5).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8)).astype(bool)
    gpx = subj & (disc == 0)
    gap_alpha_mean = float(a[gpx].mean()) if gpx.any() else 0.0
    if gap_alpha_mean > 0.5:
        glab = np.median(rgb2lab(rgb)[gpx & (a > 0.5)], 0)
        dg = deltaE_ciede2000(col, np.repeat(glab[None], len(col), 0))
        gapdrop = (d_mm < 1.6) & (dg < 12)
    inter = np.zeros(len(det), bool)
    if mainm.sum() > 10:
        tm = cKDTree(det[mainm][:, :2])
        rmain = det[mainm][:, 2]
        main_d = np.median(2 * rmain)
        kq = min(6, int(mainm.sum()))
        for i in np.nonzero(~mainm)[0]:
            dd_, jj = tm.query(det[i, :2], kq)
            if 2 * np.min(dd_ - rmain[jj]) < 0.6 * main_d:
                inter[i] = True
    chain = chain_mask(det, col, s, rules)
    shadow &= ~chain
    inter &= ~chain
    why = np.array(["kept"] * len(det), dtype=object)
    for name, m in (("interstitial", inter), ("gap-dot", gapdrop), ("shadow", shadow), ("inside-big", inside_big), ("tiny", tiny)):
        why[m] = name
    use = ~tiny & ~inside_big & ~shadow & ~gapdrop & ~inter
    stones, S, Mn = [], [], []
    sq3 = np.sqrt(3)
    pitch = PITCH
    for i in np.nonzero(use)[0]:
        y, x = det[i, 0] * s, det[i, 1] * s
        if big[i]:
            why[i] = "tiled"
            R = d_mm[i] / 2
            dd, pt = (SS6, pitch) if R - SS6 / 2 + 0.25 >= pitch else (SS4, SS4 + geometry.GAP + 0.04)
            for q in range(-5, 6):
                for rr_ in range(-5, 6):
                    px_, py_ = (q + rr_ / 2) * pt, rr_ * pt * sq3 / 2
                    if np.hypot(px_, py_) <= max(0.0, R - dd / 2 + 0.25):
                        stones.append((x + px_, y + py_, dd, -1))
                        S.append(9.0)
                        Mn.append(False)
        else:
            stones.append((x, y, SS4 if minor_det[i] else SS6, i))
            S.append(det[i, 3])
            Mn.append(bool(minor_det[i]))
    P = np.array([[q[0], q[1]] for q in stones])
    src = np.array([q[3] for q in stones])
    D = np.array([q[2] for q in stones])
    S, Mn = np.array(S), np.array(Mn)
    my = np.clip((P[:, 1] / s).astype(int), 0, a.shape[0] - 1)
    mx = np.clip((P[:, 0] / s).astype(int), 0, a.shape[1] - 1)
    inm = mask[my, mx]
    why[src[~inm & (src >= 0)]] = "outside-mask"
    P, D, S, Mn, src = P[inm], D[inm], S[inm], Mn[inm], src[inm]
    order = np.lexsort((-S, Mn))
    P, D, S, Mn, src = P[order], D[order], S[order], Mn[order], src[order]
    t = cKDTree(P)
    dup = np.zeros(len(P), bool)
    for i in range(len(P)):
        if dup[i]:
            continue
        for j in t.query_ball_point(P[i], 0.5 * D[i] + 0.3):
            if j > i:
                dup[j] = True
    why[src[dup & (src >= 0)]] = "duplicate"
    return why, P[~dup], D[~dup], src[~dup], s


class Recorder:
    """Wraps the stage functions the ordered layout and post_process call, and records what they
    were given and what they returned. The stage results are unchanged."""

    def __init__(self):
        self.det = None
        self.resolve = []
        self.fill = []
        self._in_fill = None
        self._orig = {
            "pipeline.detect_stones": pipeline.detect_stones,
            "ordered.resolve_idx": ordered.resolve_idx,
            "ordered.fill": ordered.fill,
            "post.fill": post.fill,
            "geometry.cover_frac": geometry.cover_frac,
            "geometry.openai_room": geometry.openai_room,
        }

    def install(self):
        o = self._orig

        def detect(px, models):
            self.det = o["pipeline.detect_stones"](px, models)
            return self.det

        def resolve_idx(P, D, A, score, minor):
            given = (P.copy(), D.copy())  # resolve_idx shrinks D in place
            out = o["ordered.resolve_idx"](P, D, A, score, minor)
            self.resolve.append((*given, out))
            return out

        def make_fill(stage, fn):
            def fill_(state, P, D, mask, s, *args, **kw):
                self._in_fill = {"stage": stage, "P": P.copy(), "D": D.copy()}
                out = fn(state, P, D, mask, s, *args, **kw)
                self._in_fill["out"] = out
                self.fill.append(self._in_fill)
                self._in_fill = None
                return out
            return fill_

        def cover_frac(state, P, d, s, thr=0.5):
            out = o["geometry.cover_frac"](state, P, d, s, thr)
            if self._in_fill is not None:
                self._in_fill["cand"] = (np.asarray(P).copy(), np.broadcast_to(d, (len(P),)).copy())
                self._in_fill["cover"] = out.copy()
            return out

        def openai_room(state, P, s, edge_mm=3.0, frac=0.72):
            out = o["geometry.openai_room"](state, P, s, edge_mm, frac)
            if self._in_fill is not None:
                self._in_fill["room"] = np.asarray(out).copy()
            return out

        pipeline.detect_stones = detect
        ordered.resolve_idx = resolve_idx
        ordered.fill = make_fill("rows", o["ordered.fill"])
        post.fill = make_fill("post", o["post.fill"])
        geometry.cover_frac = cover_frac
        geometry.openai_room = openai_room

    def uninstall(self):
        pipeline.detect_stones = self._orig["pipeline.detect_stones"]
        ordered.resolve_idx = self._orig["ordered.resolve_idx"]
        ordered.fill = self._orig["ordered.fill"]
        post.fill = self._orig["post.fill"]
        geometry.cover_frac = self._orig["geometry.cover_frac"]
        geometry.openai_room = self._orig["geometry.openai_room"]


def key(x, y):
    return (round(float(x), 3), round(float(y), 3))


def run(png, rules, models):
    px = decode_png(png)
    rec = Recorder()
    rec.install()
    try:
        result = pipeline.layout_frame(png, PITCH, models, rules)
    finally:
        rec.uninstall()
    layout = pipeline.finish_layout(result)
    det = rec.det
    ox, oy = layout["report"]["offsetMm"]
    why, P1, D1, src, s = ordered_verdicts(px, det, rules)
    # The copy of the ordered layout's filters must hand resolve_idx exactly what the service did.
    P0, D0, (P1r, D1r, A1r, idx1) = rec.resolve[0]
    if len(P0) != len(P1) or not np.allclose(P0, P1) or not np.allclose(D0, D1):
        raise RuntimeError("ordered_verdicts does not reproduce the ordered layout: %d vs %d stones, first P %s vs %s" % (len(P0), len(P1), P0[:2].tolist(), P1[:2].tolist()))
    gone = np.ones(len(P1), bool)
    gone[idx1] = False
    why[src[gone & (src >= 0)]] = "rows-deleted"
    detections = [[round(float(x * s - ox), 3), round(float(y * s - oy), 3), round(float(2 * r * s), 3), str(w)]
                  for (y, x, r), w in zip(det[:, :3], why)]
    # Second resolve_idx: rows plus the first fill's stones.
    P2, D2, (P2r, D2r, A2r, idx2) = rec.resolve[1]
    gone2 = np.ones(len(P2), bool)
    gone2[idx2] = False
    rows_deleted = [[round(float(x - ox), 3), round(float(y - oy), 3), float(d)] for (x, y), d in zip(P2[gone2], D2[gone2])]
    fills = []
    for f in rec.fill:
        if "cand" not in f:
            continue
        cP, cD = f["cand"]
        ok = (f["cover"] >= 0.7) & f["room"]
        for (x, y), d, c, r, k in zip(cP, cD, f["cover"], f["room"], ok):
            fills.append([round(float(x - ox), 3), round(float(y - oy), 3), float(d), f["stage"], round(float(c), 3), bool(r), bool(k)])
    # Eye stage: the ordered layout's stones (first P) against the first post fill's input.
    post_fills = [f for f in rec.fill if f["stage"] == "post"]
    first_P, first_D = rec.resolve[1][2][0], rec.resolve[1][2][1]
    before_eyes = {key(x, y): d for (x, y), d in zip(np.round(first_P, 3), first_D)}
    after_eyes = {key(x, y): d for (x, y), d in zip(post_fills[0]["P"], post_fills[0]["D"])}
    eye_dropped = [[round(k[0] - ox, 3), round(k[1] - oy, 3), float(d)] for k, d in before_eyes.items() if k not in after_eyes]
    eye_added = [[round(k[0] - ox, 3), round(k[1] - oy, 3), float(d)] for k, d in after_eyes.items() if k not in before_eyes]
    last = post_fills[-1]
    pre_P = np.concatenate([last["P"], last["out"][0]]) if len(last["out"][0]) else last["P"]
    pre_D = np.concatenate([last["D"], last["out"][1]]) if len(last["out"][0]) else last["D"]
    final = {key(q["x"], q["y"]) for q in result["stones"]}
    check_removed = [[round(float(x) - ox, 3), round(float(y) - oy, 3), float(d)] for (x, y), d in zip(pre_P, pre_D) if key(x, y) not in final]
    trace = {
        "mmPerPx": s, "offsetMm": [ox, oy],
        "detections": detections, "rowsDeleted": rows_deleted, "fill": fills,
        "eyeDropped": eye_dropped, "eyeAdded": eye_added, "checkRemoved": check_removed,
        "face": layout["report"]["face"],
    }
    return layout, trace, result["frame"]["mask"]


def main(out_dir, variant, pairs):
    os.makedirs(out_dir, exist_ok=True)
    rules = VARIANTS[variant]
    models = load_models()
    for pair in pairs:
        name, path = pair.split("=", 1)
        with open(path, "rb") as f:
            png = f.read()
        try:
            layout, trace, mask = run(png, rules, models)
        except Exception as exc:  # a layout the service refuses too (it answers an error)
            with open(os.path.join(out_dir, "%s.%s.layout.json" % (name, variant)), "w") as f:
                json.dump({"error": {"code": "layout-failed", "message": "%s: %s" % (type(exc).__name__, exc)}}, f)
            print(name, variant, "failed:", type(exc).__name__, exc, flush=True)
            continue
        with open(os.path.join(out_dir, "%s.%s.layout.json" % (name, variant)), "w") as f:
            json.dump(layout, f)
        with open(os.path.join(out_dir, "%s.%s.trace.json" % (name, variant)), "w") as f:
            json.dump(trace, f)
        cv2.imwrite(os.path.join(out_dir, "%s.strict.png" % name), mask.astype(np.uint8) * 255)
        print(name, variant, len(layout["stones"]), "stones", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3:])
