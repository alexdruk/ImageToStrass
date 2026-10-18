// SVG sanitising (spec section 6.1). An SVG is rejected, never repaired, when it holds:
// a script element, foreignObject, an event attribute (on...=), any href/src/url() that is not
// a data: URI or a #fragment, an entity declaration or internal DTD subset, or a stylesheet
// processing instruction. The checks run on the whole text, case-insensitively, and are
// deliberately broad: a false refusal costs a re-upload, a false pass could fetch or run code.

const RULES = [
  ["script", /<(?:[\w.-]+:)?script\b/i],
  ["foreignObject", /foreignobject/i],
  ["event attribute", /[\s"'/](?:[\w.-]+:)?on[a-z]+\s*=/i],
  ["entity", /<!ENTITY/i],
  ["internal DTD subset", /<!DOCTYPE[^>]*\[/i],
  ["stylesheet instruction", /<\?xml-stylesheet/i],
  ["CSS import", /@import/i]
];

// href="...", xlink:href='...', src=..., and CSS url(...).
const REFERENCES = [
  /(?:^|[\s"'/])(?:[\w.-]+:)?(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/gi,
  /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)/gi
];

function isLocal(value) {
  const v = value.trim();
  return v.startsWith("#") || /^data:/i.test(v);
}

// Returns null when the SVG is acceptable, otherwise a short reason (for the local log only).
export function svgProblem(text) {
  if (typeof text !== "string") {
    return "not text";
  }

  if (text.includes("\u0000")) {
    return "NUL byte";
  }

  for (const [reason, pattern] of RULES) {
    if (pattern.test(text)) {
      return reason;
    }
  }

  for (const pattern of REFERENCES) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? match[2] ?? match[3] ?? "";

      if (!isLocal(value)) {
        return "external reference";
      }
    }
  }

  return null;
}
