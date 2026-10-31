# From Rhinestone-Studio @38cd831 services/strass-layout/strass_layout/faces.py
"""IMG-026I and J: finishing passes for faces, run after tone separation.

skin_nearest (IMG-026J) gives every SS4 or SS6 skin and fur stone the skin colour nearest its own
mean colour, undoing the tone-separation moves inside the skin ramp.

soften_outlines turns a person's black outline stones that sit on skin into Smoked Topaz, away
from the eyes. calm_skin gives a lone skin stone the shade most of its neighbours share, when
that shade is a close neighbour on the skin ramp.

IS (IS-05d, experiment): Rules.warm_shadow lets skin_nearest prefer Colorado Topaz to a near-tie
Smoked Topaz; Rules.mixed_shadow (mixed_shadow, after calm_skin) alternates the two along the rows
where the sampled colour lies between them.

IS (PN-04h): Rules.lone_white_skin (lone_white_skin, after calm_skin) gives a lone white stone in
skin, which reads as a hole, its skin neighbours' colour.
"""
import numpy as np
from scipy.spatial import cKDTree
from skimage.color import deltaE_ciede2000, rgb2lab

from .distinct import SKIN

BLACK = {"jet", "hematite", "black-diamond", "jet-hematite"}
REACH = 0.6


def _neighbours(P, D):
    t = cKDTree(P)
    out = []
    for i, p in enumerate(P):
        nb = [j for j in t.query_ball_point(p, D[i] / 2 + D.max() / 2 + REACH) if j != i]
        out.append([j for j in nb if np.hypot(*(P[j] - p)) <= (D[i] + D[j]) / 2 + REACH])
    return out


def _near_eye(p, eyes, k):
    return any(np.hypot(p[0] - x, p[1] - y) < k * r for x, y, r in eyes)


def soften_outlines(P, D, C, eyes, nb=None):
    """Recolour jet stones with at least 40 % of their neighbours in skin colours and at most two
    black neighbours, outside 2.2 eye-zone radii, to smoked-topaz. Returns (colours, count)."""
    nb = nb if nb is not None else _neighbours(P, D)
    out = list(C)
    n = 0
    for i, c in enumerate(C):
        if c != "jet" or not nb[i] or _near_eye(P[i], eyes, 2.2):
            continue
        cs = [C[j] for j in nb[i]]
        skin = sum(x in SKIN for x in cs)
        black = sum(x in BLACK for x in cs)
        if skin >= 0.4 * len(cs) and black <= 2:
            out[i] = "smoked-topaz"
            n += 1
    return out, n


def calm_skin(P, D, C, pal, eyes, nb=None, max_de=15.0):
    """Recolour a skin stone that shares its colour with no neighbour, has at least four
    neighbours, and has at least 60 % of them in one other skin colour within max_de ΔE2000 of
    its own, to that colour. Stones inside 1.5 eye-zone radii keep their colour."""
    nb = nb if nb is not None else _neighbours(P, D)
    out = list(C)
    n = 0
    for i, c in enumerate(C):
        if c not in SKIN or len(nb[i]) < 4 or _near_eye(P[i], eyes, 1.5):
            continue
        cs = [C[j] for j in nb[i]]
        if c in cs:
            continue
        vals, cnt = np.unique(cs, return_counts=True)
        k = int(np.argmax(cnt))
        x = vals[k]
        if x not in SKIN or cnt[k] < 0.6 * len(cs):
            continue
        a, b = pal.lab[pal.ids.index(c)], pal.lab[pal.ids.index(x)]
        if deltaE_ciede2000(a[None], b[None])[0] <= max_de:
            out[i] = str(x)
            n += 1
    return out, n


def skin_nearest(D, C, lab, pal, warm_de=None):
    """Recolour each SS4 or SS6 stone whose colour is in distinct.SKIN to the SKIN colour (Topaz
    excepted) nearest its Lab colour in ΔE2000. Returns (colours, count).

    IS (IS-05d): with warm_de (Rules.warm_shadow), a stone whose nearest is Smoked Topaz takes
    Colorado Topaz when that is at most warm_de further away."""
    ids = [k for k in pal.ids if k in SKIN and k != "topaz"]
    cat = pal.lab[[pal.ids.index(k) for k in ids]]
    out = list(C)
    n = 0
    for i, c in enumerate(C):
        if c not in SKIN or D[i] not in (1.5, 2.0):
            continue
        de = deltaE_ciede2000(np.repeat(lab[i][None], len(ids), 0), cat)
        new = ids[int(np.argmin(de))]
        if warm_de is not None and new == SMOKED and de[ids.index(COLORADO)] - de.min() <= warm_de:
            new = COLORADO
        if new != c:
            out[i] = new
            n += 1
    return out, n


# IS (PN-04h): the near-white stones lone_white_skin recolours.
WHITE = {"crystal-clear", "crystal", "silver"}


def lone_white_skin(P, D, C, pal, eyes, nb=None):
    """IS (PN-04h): an SS4 or SS6 WHITE stone with at least four neighbours, all of them in skin
    colours, outside 1.5 eye-zone radii (so a pupil's catch-light stays), takes the colour most of
    its neighbours have (on a tie the lighter one). The AI paints such a stone as a highlight on
    skin; in stones it reads as a hole. Returns (colours, count)."""
    nb = nb if nb is not None else _neighbours(P, D)
    out = list(C)
    n = 0
    for i, c in enumerate(C):
        if c not in WHITE or D[i] not in (1.5, 2.0) or len(nb[i]) < 4 or _near_eye(P[i], eyes, 1.5):
            continue
        cs = [C[j] for j in nb[i]]
        if not all(x in SKIN for x in cs):
            continue
        vals, cnt = np.unique(cs, return_counts=True)
        best = [str(v) for v, k in zip(vals, cnt) if k == cnt.max()]
        out[i] = max(best, key=lambda k: pal.lab[pal.ids.index(k)][0])
        n += 1
    return out, n


# IS (IS-05d): the two stones the AI's shadow skin lies between, and the patterns mixed_shadow
# lays: the share of Colorado Topaz and one period of the pattern along a row (1 = Colorado Topaz).
SMOKED, COLORADO = "smoked-topaz", "colorado-topaz"
MIX_PATTERNS = {1 / 3: (1, 0, 0), 1 / 2: (1, 0), 2 / 3: (1, 1, 0)}
ROW_SLOPE = 0.5


def _linear(hexes):
    v = np.array([[int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)] for h in hexes])
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def _mix_lab(lin, shares):
    """Lab of the light mix of two linear-RGB colours lin[0], lin[1] at each share of lin[1]."""
    m = np.array([(1 - q) * lin[0] + q * lin[1] for q in shares])
    v = np.where(m <= 0.0031308, 12.92 * m, 1.055 * m ** (1 / 2.4) - 0.055)
    return rgb2lab(np.clip(v, 0, 1)[None])[0]


def _rows(P, D):
    """IS (IS-05d): a row index and a column index per stone. Each stone is linked to its nearest
    neighbour to the right (within ROW_SLOPE of horizontal, touching within REACH), closest pairs
    first, one link each way; a row is a chain of links. The column is the chain position plus
    the chain start's x in link lengths, the row the chain start's y in 0.87 link lengths, so
    neighbouring rows are numbered apart and a pattern indexed by row + column staggers."""
    t = cKDTree(P)
    pairs = []
    for i, p in enumerate(P):
        for j in t.query_ball_point(p, D[i] / 2 + D.max() / 2 + REACH):
            dx, dy = P[j] - p
            dist = np.hypot(dx, dy)
            if dx > 0 and abs(dy) <= ROW_SLOPE * dx and dist <= (D[i] + D[j]) / 2 + REACH:
                pairs.append((dist, i, j))
    right = -np.ones(len(P), int)
    left = -np.ones(len(P), int)
    links = []
    for dist, i, j in sorted(pairs):
        if right[i] < 0 and left[j] < 0:
            right[i], left[j] = j, i
            links.append(dist)
    step = float(np.median(links)) if links else float(np.median(D))
    row = np.zeros(len(P), int)
    col = np.zeros(len(P), int)
    for i in np.nonzero(left < 0)[0]:
        r, c, j = int(round(P[i, 1] / (0.87 * step))), int(round(P[i, 0] / step)), i
        while j >= 0:
            row[j], col[j] = r, c
            c += 1
            j = right[j]
    return row, col


def mixed_shadow(P, D, C, lab, pal, eyes, nb=None):
    """IS (IS-05d): on SS4/SS6 Smoked Topaz and Colorado Topaz stones outside 1.5 eye-zone radii,
    the local colour is the mean Lab of the stone and its skin-coloured neighbours; when the light
    mix of the two stones nearest it (ΔE2000) is one of MIX_PATTERNS rather than either stone
    alone, the stone takes its place in that pattern along its row. Returns (colours, count)."""
    nb = nb if nb is not None else _neighbours(P, D)
    lin = _linear([pal.fills[pal.ids.index(SMOKED)], pal.fills[pal.ids.index(COLORADO)]])
    shares = [0.0] + list(MIX_PATTERNS) + [1.0]
    mix = _mix_lab(lin, shares)
    row, col = _rows(P, D)
    out = list(C)
    n = 0
    for i, c in enumerate(C):
        if c not in (SMOKED, COLORADO) or D[i] not in (1.5, 2.0) or _near_eye(P[i], eyes, 1.5):
            continue
        local = lab[[i] + [j for j in nb[i] if C[j] in SKIN]].mean(0)
        q = shares[int(np.argmin(deltaE_ciede2000(np.repeat(local[None], len(mix), 0), mix)))]
        if q in MIX_PATTERNS:
            pattern = MIX_PATTERNS[q]
            new = COLORADO if pattern[(row[i] + col[i]) % len(pattern)] else SMOKED
            if new != c:
                out[i] = new
                n += 1
    return out, n


def finish_faces(P, D, C, pal, face, eyes, rules, lab=None):
    nb = None
    if rules.skin_nearest:
        C, _ = skin_nearest(D, C, lab, pal, rules.warm_shadow_de if rules.warm_shadow else None)
    if rules.soft_outlines and face == "human":
        nb = _neighbours(P, D)
        C, _ = soften_outlines(P, D, C, eyes, nb)
    if rules.calm_skin:
        nb = nb if nb is not None else _neighbours(P, D)
        C, _ = calm_skin(P, D, C, pal, eyes, nb)
    if rules.mixed_shadow:
        nb = nb if nb is not None else _neighbours(P, D)
        C, _ = mixed_shadow(P, D, C, lab, pal, eyes, nb)
    if rules.lone_white_skin:
        nb = nb if nb is not None else _neighbours(P, D)
        C, _ = lone_white_skin(P, D, C, pal, eyes, nb)
    return C
