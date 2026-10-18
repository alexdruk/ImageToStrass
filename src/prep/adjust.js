// Image adjustments (spec section 6.3). The only implementation: the browser imports this file
// (served as /adjust.js) for the live preview, the server runs it on the full image. Pure
// functions on RGBA images { data, width, height } with no Node or DOM imports; only + - * /,
// comparisons and Math.round, so every engine gives the same bytes for the same input.
//
// Order: rotate → crop → auto enhance → brightness → contrast → saturation. Alpha is kept.

export const DEFAULT_SETTINGS = Object.freeze({
  rotate: 0,          // clockwise degrees: 0, 90, 180, 270
  crop: null,         // { x, y, w, h } as fractions (0..1) of the rotated image, or null
  brightness: 0,      // -100 ... +100
  contrast: 0,        // -100 ... +100
  saturation: 0,      // -100 ... +100
  autoEnhance: false  // stretch levels to the 0.5 % / 99.5 % luminance percentiles
});

const ROTATIONS = [0, 90, 180, 270];
const LOW_PERCENTILE = 5;    // per mille
const HIGH_PERCENTILE = 995; // per mille

function slider(value, name) {
  if (value === undefined) {
    return 0;
  }

  if (!Number.isInteger(value) || value < -100 || value > 100) {
    throw new RangeError(`${name} must be an integer from -100 to 100.`);
  }

  return value;
}

function cropRect(crop) {
  if (crop === undefined || crop === null) {
    return null;
  }

  const { x, y, w, h } = crop;
  const fractions = [x, y, w, h];

  if (fractions.some((f) => typeof f !== "number" || !Number.isFinite(f) || f < 0 || f > 1) ||
      w <= 0 || h <= 0 || x + w > 1 + 1e-9 || y + h > 1 + 1e-9) {
    throw new RangeError("crop must be { x, y, w, h } fractions inside the image.");
  }

  return { x, y, w, h };
}

// Validates settings from the browser or the database; unknown keys are dropped.
export function normalizeSettings(input = {}) {
  if (input === null || typeof input !== "object") {
    throw new RangeError("settings must be an object.");
  }

  const rotate = input.rotate ?? 0;

  if (!ROTATIONS.includes(rotate)) {
    throw new RangeError("rotate must be 0, 90, 180 or 270.");
  }

  return {
    rotate,
    crop: cropRect(input.crop),
    brightness: slider(input.brightness, "brightness"),
    contrast: slider(input.contrast, "contrast"),
    saturation: slider(input.saturation, "saturation"),
    autoEnhance: input.autoEnhance === true
  };
}

function blank(width, height) {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

// Clockwise quarter turns.
export function rotate(image, degrees) {
  const { data, width, height } = image;
  const turns = degrees / 90;

  if (turns === 0) {
    return { data: new Uint8ClampedArray(data), width, height };
  }

  const out = turns === 2 ? blank(width, height) : blank(height, width);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let tx;
      let ty;

      if (turns === 1) {
        tx = height - 1 - y;
        ty = x;
      } else if (turns === 2) {
        tx = width - 1 - x;
        ty = height - 1 - y;
      } else {
        tx = y;
        ty = width - 1 - x;
      }

      const from = (y * width + x) * 4;
      const to = (ty * out.width + tx) * 4;
      out.data[to] = data[from];
      out.data[to + 1] = data[from + 1];
      out.data[to + 2] = data[from + 2];
      out.data[to + 3] = data[from + 3];
    }
  }

  return out;
}

// The crop rectangle in whole pixels of an image of this size (at least 1 × 1).
export function cropPixels(rect, width, height) {
  const x0 = Math.min(width - 1, Math.round(rect.x * width));
  const y0 = Math.min(height - 1, Math.round(rect.y * height));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.round((rect.x + rect.w) * width)));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.round((rect.y + rect.h) * height)));

  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
}

export function crop(image, rect) {
  if (!rect) {
    return image;
  }

  const { left, top, width, height } = cropPixels(rect, image.width, image.height);
  const out = blank(width, height);

  for (let y = 0; y < height; y += 1) {
    const from = ((top + y) * image.width + left) * 4;
    out.data.set(image.data.subarray(from, from + width * 4), y * width * 4);
  }

  return out;
}

function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// 0.5 % and 99.5 % luminance percentiles of the visible pixels (alpha >= 128), or of all
// pixels when none is visible.
export function levels(image) {
  const { data } = image;
  const histogram = new Array(256).fill(0);
  let count = 0;

  for (const visibleOnly of [true, false]) {
    for (let i = 0; i < data.length; i += 4) {
      if (!visibleOnly || data[i + 3] >= 128) {
        histogram[Math.round(luma(data[i], data[i + 1], data[i + 2]))] += 1;
        count += 1;
      }
    }

    if (count > 0) {
      break;
    }
  }

  let lo = 0;
  let hi = 255;
  let seen = 0;
  let foundLo = false;

  for (let v = 0; v < 256; v += 1) {
    seen += histogram[v];

    if (!foundLo && seen * 1000 > count * LOW_PERCENTILE) {
      lo = v;
      foundLo = true;
    }

    if (seen * 1000 >= count * HIGH_PERCENTILE) {
      hi = v;
      break;
    }
  }

  return { lo, hi };
}

function clamp(x) {
  return x < 0 ? 0 : x > 255 ? 255 : Math.round(x);
}

// One lookup table for levels, brightness and contrast (the same for R, G and B).
function toneTable(settings, range) {
  const table = new Uint8ClampedArray(256);
  const stretch = range && range.hi > range.lo;
  const b = (settings.brightness * 255) / 200;
  const c = settings.contrast;
  const factor = c >= 0 ? 1 + c / 50 : 1 + c / 100;

  for (let v = 0; v < 256; v += 1) {
    let x = stretch ? ((v - range.lo) * 255) / (range.hi - range.lo) : v;
    x += b;
    x = (x - 127.5) * factor + 127.5;
    table[v] = clamp(x);
  }

  return table;
}

// Brightness, contrast, saturation and auto enhance, on a copy.
export function tone(image, settings) {
  const { data, width, height } = image;
  const out = { data: new Uint8ClampedArray(data.length), width, height };
  const table = toneTable(settings, settings.autoEnhance ? levels(image) : null);
  const k = 1 + settings.saturation / 100;

  for (let i = 0; i < data.length; i += 4) {
    const r = table[data[i]];
    const g = table[data[i + 1]];
    const bl = table[data[i + 2]];

    if (k === 1) {
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = bl;
    } else {
      const grey = luma(r, g, bl);
      out.data[i] = clamp(grey + (r - grey) * k);
      out.data[i + 1] = clamp(grey + (g - grey) * k);
      out.data[i + 2] = clamp(grey + (bl - grey) * k);
    }

    out.data[i + 3] = data[i + 3];
  }

  return out;
}

// The whole adjustment: image → new image. settings go through normalizeSettings.
export function applyAdjustments(image, settings) {
  const s = normalizeSettings(settings);
  return tone(crop(rotate(image, s.rotate), s.crop), s);
}
