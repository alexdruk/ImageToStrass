// From Rhinestone-Studio @38cd831 src/text/VectorPath.js
// IS: only Point2D, BoundingBox and their two helpers, moved into their own file (spec section 16).

export class Point2D {
  constructor(xMm, yMm) {
    assertFiniteNumber(xMm, 'xMm');
    assertFiniteNumber(yMm, 'yMm');
    this.xMm = xMm;
    this.yMm = yMm;
  }

  clone() {
    return new Point2D(this.xMm, this.yMm);
  }

  translate(dxMm, dyMm) {
    return new Point2D(this.xMm + dxMm, this.yMm + dyMm);
  }

  scale(scaleX, scaleY = scaleX) {
    assertFiniteNumber(scaleX, 'scaleX');
    assertFiniteNumber(scaleY, 'scaleY');
    return new Point2D(this.xMm * scaleX, this.yMm * scaleY);
  }

  distanceTo(other) {
    return Math.hypot(this.xMm - other.xMm, this.yMm - other.yMm);
  }

  toJSON() {
    return { xMm: roundForJson(this.xMm), yMm: roundForJson(this.yMm) };
  }

  static fromJSON(value) {
    if (!value || typeof value !== 'object') {
      throw new TypeError('Point2D.fromJSON expects an object.');
    }
    return new Point2D(value.xMm, value.yMm);
  }
}

export class BoundingBox {
  constructor(minXmm, minYmm, maxXmm, maxYmm) {
    assertFiniteNumber(minXmm, 'minXmm');
    assertFiniteNumber(minYmm, 'minYmm');
    assertFiniteNumber(maxXmm, 'maxXmm');
    assertFiniteNumber(maxYmm, 'maxYmm');

    if (maxXmm < minXmm || maxYmm < minYmm) {
      throw new RangeError('BoundingBox max values must be greater than or equal to min values.');
    }

    this.minXmm = minXmm;
    this.minYmm = minYmm;
    this.maxXmm = maxXmm;
    this.maxYmm = maxYmm;
  }

  get widthMm() {
    return this.maxXmm - this.minXmm;
  }

  get heightMm() {
    return this.maxYmm - this.minYmm;
  }

  get center() {
    return new Point2D(
      this.minXmm + this.widthMm / 2,
      this.minYmm + this.heightMm / 2
    );
  }

  expandToIncludePoint(point) {
    return new BoundingBox(
      Math.min(this.minXmm, point.xMm),
      Math.min(this.minYmm, point.yMm),
      Math.max(this.maxXmm, point.xMm),
      Math.max(this.maxYmm, point.yMm)
    );
  }

  union(other) {
    return new BoundingBox(
      Math.min(this.minXmm, other.minXmm),
      Math.min(this.minYmm, other.minYmm),
      Math.max(this.maxXmm, other.maxXmm),
      Math.max(this.maxYmm, other.maxYmm)
    );
  }

  toJSON() {
    return {
      minXmm: roundForJson(this.minXmm),
      minYmm: roundForJson(this.minYmm),
      maxXmm: roundForJson(this.maxXmm),
      maxYmm: roundForJson(this.maxYmm),
      widthMm: roundForJson(this.widthMm),
      heightMm: roundForJson(this.heightMm)
    };
  }

  static empty() {
    return null;
  }

  static fromPoints(points) {
    if (!Array.isArray(points) || points.length === 0) {
      return BoundingBox.empty();
    }

    let minXmm = Infinity;
    let minYmm = Infinity;
    let maxXmm = -Infinity;
    let maxYmm = -Infinity;

    for (const point of points) {
      minXmm = Math.min(minXmm, point.xMm);
      minYmm = Math.min(minYmm, point.yMm);
      maxXmm = Math.max(maxXmm, point.xMm);
      maxYmm = Math.max(maxYmm, point.yMm);
    }

    return new BoundingBox(minXmm, minYmm, maxXmm, maxYmm);
  }
}

function assertFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
}

function roundForJson(value) {
  return Number(value.toFixed(6));
}
