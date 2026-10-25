import { squaredEdt } from "../pipeline/holes.js";

// The engine's raster (experiment exp-engine, docs/exp-engine.md): a grid of square cells in the
// layout service's own mm (the /layout answer's stones; AI pixel = (mm + report.offsetMm) /
// report.mmPerPx). Cell (i, j) has its centre at (x0 + (i + 0.5) / ppmm, y0 + (j + 0.5) / ppmm).

export class Grid {
  constructor({ x0, y0, w, h, ppmm }) {
    Object.assign(this, { x0, y0, w, h, ppmm, n: w * h });
  }

  // The cell index at layout mm (x, y), or -1 outside the grid.
  at(x, y) {
    const i = Math.floor((x - this.x0) * this.ppmm), j = Math.floor((y - this.y0) * this.ppmm);
    return i < 0 || j < 0 || i >= this.w || j >= this.h ? -1 : j * this.w + i;
  }

  cx(k) { return this.x0 + ((k % this.w) + 0.5) / this.ppmm; }
  cy(k) { return this.y0 + (Math.floor(k / this.w) + 0.5) / this.ppmm; }

  // Cell index ranges { i0, i1, j0, j1 } (inclusive, clamped) covering a disc.
  span(x, y, r) {
    return {
      i0: Math.max(0, Math.floor((x - r - this.x0) * this.ppmm)), i1: Math.min(this.w - 1, Math.ceil((x + r - this.x0) * this.ppmm)),
      j0: Math.max(0, Math.floor((y - r - this.y0) * this.ppmm)), j1: Math.min(this.h - 1, Math.ceil((y + r - this.y0) * this.ppmm))
    };
  }

  // Distance (mm) from every cell centre to the nearest cell with feature[k] set (Infinity if none).
  distanceTo(feature) {
    const d2 = squaredEdt(feature, this.w, this.h);
    const out = new Float32Array(this.n);
    for (let k = 0; k < this.n; k++) out[k] = Math.sqrt(d2[k]) / this.ppmm;
    return out;
  }

  // Smoother label borders: every allowed cell takes the label whose share of the cells around it
  // (a box blur of radius mm, applied twice) is largest. label: Int32Array, -1 for none; changed in
  // place.
  smoothLabels(label, allowed, radiusMm) {
    const { w, h, n } = this;
    const R = Math.max(1, Math.round(radiusMm * this.ppmm));
    const boxes = new Map();
    for (let k = 0; k < n; k++) {
      const l = label[k];
      if (l < 0 || !allowed[k]) continue;
      const i = k % w, j = (k - i) / w;
      let b = boxes.get(l);
      if (!b) boxes.set(l, (b = { i0: i, i1: i, j0: j, j1: j }));
      if (i < b.i0) b.i0 = i;
      if (i > b.i1) b.i1 = i;
      if (j < b.j0) b.j0 = j;
      if (j > b.j1) b.j1 = j;
    }
    const best = new Float32Array(n).fill(-1);
    const out = Int32Array.from(label);
    const blur = (src, cw, ch) => {
      // Horizontal then vertical running sums, twice.
      let a = src, b = new Float32Array(cw * ch);
      for (let pass = 0; pass < 2; pass++) {
        for (let y = 0; y < ch; y++) {
          let s = 0;
          const row = y * cw;
          for (let x = -R; x < cw; x++) {
            if (x + R < cw) s += a[row + x + R];
            if (x - R - 1 >= 0) s -= a[row + x - R - 1];
            if (x >= 0) b[row + x] = s;
          }
        }
        [a, b] = [b, a];
        for (let x = 0; x < cw; x++) {
          let s = 0;
          for (let y = -R; y < ch; y++) {
            if (y + R < ch) s += a[(y + R) * cw + x];
            if (y - R - 1 >= 0) s -= a[(y - R - 1) * cw + x];
            if (y >= 0) b[y * cw + x] = s;
          }
        }
        [a, b] = [b, a];
      }
      return a;
    };
    for (const [l, b] of boxes) {
      const i0 = Math.max(0, b.i0 - 2 * R), i1 = Math.min(w - 1, b.i1 + 2 * R), j0 = Math.max(0, b.j0 - 2 * R), j1 = Math.min(h - 1, b.j1 + 2 * R);
      const cw = i1 - i0 + 1, ch = j1 - j0 + 1;
      const ind = new Float32Array(cw * ch);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) ind[y * cw + x] = label[(y + j0) * w + x + i0] === l ? 1 : 0;
      const score = blur(ind, cw, ch);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const k = (y + j0) * w + x + i0;
          if (!allowed[k]) continue;
          const v = score[y * cw + x];
          if (v > best[k] + 1e-6) { best[k] = v; out[k] = l; }
        }
      }
    }
    label.set(out);
    return label;
  }

  // Multi-source breadth-first fill: every cell with allowed[k] and label[k] < 0 takes the label of
  // the nearest labelled cell (4-connected steps). Changes label in place.
  spread(label, allowed) {
    const { w, h, n } = this;
    let front = [];
    for (let k = 0; k < n; k++) if (allowed[k] && label[k] >= 0) front.push(k);
    while (front.length) {
      const next = [];
      for (const k of front) {
        const i = k % w, j = (k - i) / w;
        const nb = [i > 0 ? k - 1 : -1, i < w - 1 ? k + 1 : -1, j > 0 ? k - w : -1, j < h - 1 ? k + w : -1];
        for (const m of nb) {
          if (m < 0 || !allowed[m] || label[m] >= 0) continue;
          label[m] = label[k];
          next.push(m);
        }
      }
      front = next;
    }
    return label;
  }
}
