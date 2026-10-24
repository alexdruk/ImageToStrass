// From Rhinestone-Studio @38cd831 server/redraw/prompt.mjs
// IMG-022: the prompt the redraw server sends with every image. The palette line is generated from
// the stone catalogue, so a colour added there reaches the prompt with no edit here.
// IS (spec section 7.2): the stones prompt only (the flat style is not copied). Section 6 uses the
// whole image instead of a square one, and rule 1 has no "about 60 stones across" sentence (prompt
// version 3, IS-03b decision); for Black & white, section 4 and the final check are replaced
// by the spec's Appendix A (BW_STYLE halftone, the default) or by the stencil variant (BW_STYLE
// stencil, exp-bw-stencil). There is no size line: every design has its natural size (7.5). The prompt is built
// server-side only; it is never logged, stored under public/ or sent to the browser.
import { STONE_COLORS } from '../stones/StoneColors.js';

// IS: version of the IS prompt (v6 of RS plus the IS additions). A wording change bumps it.
export const IS_PROMPT_VERSION = 3;
// IS (exp-bw-stencil): the Black & white stencil variant has its own version (5: the eye rule).
export const IS_STENCIL_PROMPT_VERSION = 5;
// IS (exp-bw-stencil): the Black & white styles (the BW_STYLE setting); the first is the default.
export const BW_STYLES = Object.freeze(['halftone', 'stencil']);

// IMG-026 (S10, S11, build H): version 6 is the placement-chart prompt of the spec's Appendix D, with
// the generated palette line inside rule 4.
const V6_HEAD = [
  'Turn the uploaded image into a rhinestone design drawn as a flat technical placement chart. Software will measure every stone in your image (position, size and colour) and rebuild it as a real rhinestone layout, so clean geometry matters more than a realistic look.',
  '',
  '1. STONES',
  '- Every stone is a perfect circle seen straight from above, filled with ONE flat colour.',
  '- No highlights, facets, sparkle, glints, gradients, rims, shadows, reflections or white dots on the stones.',
  '- Use one main stone size for the whole design.',
  '- Only two exceptions:',
  '  a) a smaller stone, 3/4 of the main diameter, only for very fine details (eyes, eyelids, nostrils, thin lines);',
  '  b) one large stone, twice the main diameter, for each pupil.',
  '- No other sizes: no tiny filler dots, no half stones, no ovals.',
  '',
  '2. GAPS',
  '- Every stone is separated from its neighbours by a small, clearly visible gap of about 1/8 of the stone diameter.',
  '- Stones never touch and never overlap.',
  '- Keep the gaps even and small. Pack the stones tightly, with neighbouring rows shifted so that stones sit in the notches of the next row. Avoid wide empty spaces inside the subject.',
  '- The gaps show the background only. Never draw anything in the gaps: no dark shading, no glow, no colour, no dots, no texture.',
  '',
  '3. BACKGROUND AND EDGES',
  '- Background fully transparent. If transparency is not available, use solid pure magenta #FF00FF with no variation, and never use magenta inside the subject.',
  '- Every stone is fully opaque with a crisp edge. No soft or semi-transparent edges.',
  '- No frame, border, text, watermark, drop shadow or decoration.',
  ''
].join('\n');

// IS: section 4 of v6 (colour mode), unchanged.
const V6_COLOURS_INTRO = [
  '4. COLOURS',
  'Use only the colours below, with exactly these hex values, as flat fills:'
].join('\n');

const V6_COLOURS_RULES = [
  '- Every stone gets exactly one of these colours. Do not invent, mix, tint or shade colours.',
  '- Pick the closest of these colours for each area, and keep neighbouring areas clearly distinguishable so the design reads well from a distance.',
  '- Use these ramps, from light to dark, and stay inside the ramp of each kind of area:',
  '  skin: Silk, Light Peach, Rose Gold, Light Colorado Topaz, Golden Shadow, Copper, Colorado Topaz, Smoked Topaz, with Rose Peach and Vintage Rose for cheeks and Crystal only for the brightest highlights;',
  '  tan or brown fur, wood, earth: Silk, Light Peach, Golden Shadow, Light Colorado Topaz, Light Smoked Topaz, Copper, Colorado Topaz, Smoked Topaz;',
  '  white, grey and black hair, fur, metal, stone: Crystal, Silver, Greige, Grey, Black Diamond, Graphite, Jet Hematite, Hematite, Jet;',
  '  greens: Chrysolite, Citrus Green, Peridot, Emerald, Fern Green, Erinite, Olivine, Khaki; blues: Light Sapphire, Aquamarine, Sapphire, Capri Blue; reds and pinks: Rose, Rose Peach, Vintage Rose, Padparadscha, Light Siam, Scarlet, Siam, Indian Siam, Fuchsia; yellows and oranges: Citrine, Light Topaz, Metallic Sunshine, Gold, Topaz, Hyacinth.',
  '- Never use Topaz or Hyacinth on skin.',
  '- Inside one area use at most three neighbouring shades of its ramp, in clear patches; never alternate shades stone by stone.',
  '- When a colour of the image lies between two listed colours, choose one of them for the whole patch; do not paint an in-between shade.'
].join('\n');

// IS: spec Appendix A, section 4 for Black & white.
function bwColoursSection(colors) {
  return [
    '4. COLOURS',
    'Use only these two colours, with exactly these hex values, as flat fills:',
    `Jet ${colors.jet.previewColor}, Crystal ${colors['crystal-clear'].previewColor}.`,
    '- Every stone is either Jet or Crystal. No greys, no other colours, no tints.',
    '- Dark areas, outlines, pupils and shadows are Jet; light areas, highlights and the catch-light are Crystal.',
    '- Show mid-tones only by mixing the two colours in clear patterns (rows or patches), never by inventing a grey.',
    '- Keep the subject clearly readable from a distance: strong Jet outlines around the main shapes.'
  ].join('\n');
}

// IS (exp-bw-stencil): section 4 for Black & white in stencil style: solid areas, no mixing.
function bwStencilColoursSection(colors) {
  return [
    '4. COLOURS',
    'Use only these two colours, with exactly these hex values, as flat fills:',
    `Jet ${colors.jet.previewColor}, Crystal ${colors['crystal-clear'].previewColor}.`,
    '- Every stone is either Jet or Crystal. No greys, no other colours, no tints.',
    '- Stencil style: every area is solid. Decide for each area whether it is dark or light, and fill all of it with that one colour.',
    '- Never alternate or mix the two colours to suggest grey: no checkerboards, no dotted, speckled or halftone areas.',
    '- Faces: light skin in Crystal. The shadows that shape the face (eye sockets, under the nose, under the lower lip, the jaw and neck shadow) and the hair in solid Jet, as clean shapes.',
    '- Eyes are never part of a dark area. In each eye the white is Crystal, the iris and the pupil are Jet, with one Crystal catch-light stone, and at least one row of Crystal stones separates the eye from any dark shadow or eyebrow around it.',
    '- Keep the subject clearly readable from a distance: strong Jet outlines around the main shapes.'
  ].join('\n');
}

const V6_DESIGN = [
  '',
  '5. DESIGN',
  '- Lay the stones in rows that follow the shapes: along feathers, hair strands, fur direction, wrinkles, petals and outlines.',
  '- Outline important shapes with one row of stones in a darker colour of the same colour family (plain black only where the area itself is black or very dark).',
  '- Outline stones are ordinary stones: the main size or the 3/4 size, on the same rows as their neighbours, with the same gap. Never squeeze extra stones between rows and never let outline stones touch.',
  '- Busy textures (rocks, grass, foliage, fur, water) are simplified into patches of one or two shades. Every stone there is still a separate flat circle with a gap; never draw broken, angular or overlapping stones.',
  '- Eyes: a dark outline ring, the iris in 1 or 2 rings of stones, one large dark pupil stone, and one Crystal #f5f5f5 stone touching the pupil at its upper right as the catch-light.',
  '- Keep the subject, pose, proportions and recognisable features of the uploaded image. Simplify only where stones cannot show the detail.',
  '',
  '6. COMPOSITION',
  '- Use the whole image at the highest resolution available, in the same shape (width to height) as the uploaded image.',
  '- The whole subject fits inside the image with a margin of about 3 stones on every side; nothing is cut off at the edges.',
  '- One scale for the whole image, no perspective.'
].join('\n');

const CHECK_HEAD = 'Before finishing, check that: every stone is a separate flat circle; no two stones touch, outline stones included; nothing is drawn in the gaps; only the three allowed sizes are used; ';
const CHECK_TAIL = '; the background is transparent or pure magenta.';
const V6_CHECK = ['', `${CHECK_HEAD}only the listed colours are used, skin and fur only from their ramps${CHECK_TAIL}`].join('\n');
// IS: spec Appendix A, the final check for Black & white (no ramps to refer to).
const BW_CHECK = ['', `${CHECK_HEAD}every stone is Jet or Crystal${CHECK_TAIL}`].join('\n');
// IS (exp-bw-stencil): the final check of the stencil variant.
const BW_STENCIL_CHECK = ['', `${CHECK_HEAD}every stone is Jet or Crystal; no area is mixed or speckled${CHECK_TAIL}`].join('\n');

// "Name #hex" pairs in catalogue order; the hex is previewColor. IMG-026F: the aiOnly colours are
// listed only with includeAiOnly, which the stones prompt passes.
export function buildPaletteLine(colors = STONE_COLORS, includeAiOnly = false) {
  return Object.values(colors).filter((c) => includeAiOnly || !c.aiOnly).map((c) => `${c.name} ${c.previewColor}`).join(', ');
}

function checkOptions(mode, bwStyle) {
  if (mode !== 'colour' && mode !== 'bw') throw new RangeError('mode must be colour or bw.');
  if (!BW_STYLES.includes(bwStyle)) throw new RangeError('bwStyle must be halftone or stencil.');
}

// IS: the version of the prompt buildPrompt makes for these options.
export function promptVersion({ mode, bwStyle = BW_STYLES[0] }) {
  checkOptions(mode, bwStyle);
  return mode === 'bw' && bwStyle === 'stencil' ? IS_STENCIL_PROMPT_VERSION : IS_PROMPT_VERSION;
}

// IS: { mode: 'colour' | 'bw', bwStyle: 'halftone' | 'stencil' (Black & white only) } -> the prompt text.
export function buildPrompt({ mode, bwStyle = BW_STYLES[0] }, colors = STONE_COLORS) {
  checkOptions(mode, bwStyle);
  if (mode === 'bw' && bwStyle === 'stencil') return [V6_HEAD, bwStencilColoursSection(colors), V6_DESIGN, BW_STENCIL_CHECK].join('\n');
  if (mode === 'bw') return [V6_HEAD, bwColoursSection(colors), V6_DESIGN, BW_CHECK].join('\n');
  const colours = [V6_COLOURS_INTRO, buildPaletteLine(colors, true), V6_COLOURS_RULES].join('\n');
  return [V6_HEAD, colours, V6_DESIGN, V6_CHECK].join('\n');
}
