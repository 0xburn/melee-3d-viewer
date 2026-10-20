/* 3D replay viewer: Slippi's name plates, lettered as its playback letters them.
 *
 * A plate's name is set in the game's own text font (the executable's: 287
 * glyphs of 32 by 32 at 4 bits, see dol.ts) by the game's own text rules
 * (sistext.ts): the display name's Shift-JIS goes through the string
 * routine's table (HSD_SisLib_803A6B98 / 803A67EC), and the line is laid out
 * with kerning, a width the string routine's spacing ops do not change, and
 * centered on the plate. Each glyph is a quad of 1.000 by 1.035 units in the
 * HUD camera's space, white, its alpha the glyph's texel, drawn over the
 * plate with the source-alpha blend, depth tested (lequal) without writing.
 *
 * Everything here is made once: the font from the executable, the glyph
 * atlas (one picture for all of them) and each name's quads. A frame only
 * copies a name's quads to where its plate is.
 */
import { glyphAlpha, layoutSis, parseSisCommon, sisString, type SisCommon } from "./sistext";
import { textFontFromDol } from "./dol";

/** a glyph quad's size in the HUD camera's units, and the pixels of text it is made of */
const GLYPH_W = 1.0, GLYPH_H = 1.035, GLYPH_PX = 32;

// The plate's width follows the name: the sum of (20 - left trim) over its
// glyphs, held to 60..144, times 0.0146 (the plate model's x scale).
// Measured from Slippi's display; short-name fit pending: no capture has a name
// short enough to show where the minimum and the slope really sit.
const SUM_MIN = 60, SUM_MAX = 144, SUM_SLOPE = 0.0146, SUM_BASE = 20;

/** the font: the executable's tables, the Unicode of each Shift-JIS pair it has, and the glyph atlas */
export interface PlateFont {
  common: SisCommon;
  /** Unicode code point -> the Shift-JIS pair's bytes (hi << 8 | lo), for the pairs the font has */
  pairs: Map<number, number>;
  atlas: GlyphAtlas | null;
}

/** the glyphs in one picture: a cell (glyph and one texel of edge each side, the edge repeated as a clamped
 *  texture would) a glyph, so a linear sample at a quad's edge reads what the game's does */
export interface GlyphAtlas {
  sprite: { key: string; w: number; h: number; rgba: Uint8Array };
  /** each glyph's texture rectangle: u0, v0 (its top), u1, v1 (its bottom) */
  uv: Float32Array;
}

/** one name: its quads relative to the plate's middle, and what sizes its plate */
export interface PlateText {
  /** per glyph: left, top, right, bottom (HUD units, y up, from the plate's middle), then u0, v0, u1, v1 */
  quads: Float32Array;
  count: number;
  /** the plate's width for this name, in HUD units (the cap is the measured plate) */
  width: number;
}

const memo = new WeakMap<ArrayBuffer, PlateFont | null>();

/** The font out of the game's executable (null when it is not NTSC 1.02's), made once per file. */
export function plateFontFromDol(buf: ArrayBuffer): PlateFont | null {
  if (memo.has(buf)) return memo.get(buf)!;
  let font: PlateFont | null = null;
  try {
    const common = parseSisCommon(textFontFromDol(buf));
    if (common) font = { common, pairs: pairTable(common), atlas: null };
  } catch { /* not the version the addresses are for: the canvas letters */ }
  memo.set(buf, font);
  return font;
}

/** Unicode for each Shift-JIS pair the font has (the decoder is the browser's own) */
function pairTable(c: SisCommon): Map<number, number> {
  const out = new Map<number, number>();
  let dec: TextDecoder;
  try { dec = new TextDecoder("shift_jis"); } catch { return out; }
  const two = new Uint8Array(2);
  for (let j = 0; j < 287; j++) {
    two[0] = c.sjis[j * 2]; two[1] = c.sjis[j * 2 + 1];
    const s = dec.decode(two);
    const cp = s.codePointAt(0);
    // (one character per pair; a pair the decoder cannot read comes back as U+FFFD or two characters)
    if (cp !== undefined && cp !== 0xfffd && s.length === (cp > 0xffff ? 2 : 1) && !out.has(cp)) out.set(cp, (two[0] << 8) | two[1]);
  }
  return out;
}

/** A name as the Shift-JIS bytes the string routine takes: ASCII as it is, anything else as its pair (what the
 *  font has none of is left out). */
export function nameBytes(name: string, font: PlateFont): Uint8Array {
  const out: number[] = [];
  for (const ch of name) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) { if (cp >= 0x20) out.push(cp); continue; }
    const pair = font.pairs.get(cp);
    if (pair !== undefined) out.push(pair >> 8, pair & 0xff);
  }
  return Uint8Array.from(out);
}

const CELL = GLYPH_PX + 2, COLS = 17;

/** the glyph atlas (made once per font) */
export function glyphAtlas(font: PlateFont): GlyphAtlas {
  if (font.atlas) return font.atlas;
  const f = font.common.font, n = Math.floor(f.images.length / 512);
  const rows = Math.ceil(n / COLS), w = COLS * CELL, h = rows * CELL;
  const rgba = new Uint8Array(w * h * 4);
  const uv = new Float32Array(n * 4);
  for (let g = 0; g < n; g++) {
    const a = glyphAlpha(f, g), cx = (g % COLS) * CELL, cy = Math.floor(g / COLS) * CELL;
    for (let y = 0; y < CELL; y++) {
      const sy = Math.min(GLYPH_PX - 1, Math.max(0, y - 1));
      for (let x = 0; x < CELL; x++) {
        const sx = Math.min(GLYPH_PX - 1, Math.max(0, x - 1));
        const o = ((cy + y) * w + cx + x) * 4;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = 255;
        rgba[o + 3] = a[sy * GLYPH_PX + sx];
      }
    }
    uv[g * 4] = (cx + 1) / w; uv[g * 4 + 1] = (cy + 1) / h;
    uv[g * 4 + 2] = (cx + 1 + GLYPH_PX) / w; uv[g * 4 + 3] = (cy + 1 + GLYPH_PX) / h;
  }
  return (font.atlas = { sprite: { key: "plate-font", w, h, rgba }, uv });
}

const texts = new WeakMap<PlateFont, Map<string, PlateText>>();

/** A name's quads and plate width (made once per name). */
export function plateText(font: PlateFont, name: string): PlateText {
  let m = texts.get(font);
  if (!m) texts.set(font, (m = new Map()));
  const had = m.get(name);
  if (had) return had;
  const c = font.common;
  // the string routine's ops, laid out as the plate's text is: kerned, dynamic, centered on its middle
  const ops = Uint8Array.from(sisString(nameBytes(name, font), 0, 0, [255, 255, 255], [1, 1], c));
  const glyphs = layoutSis(ops, { align: 1, boxW: 0, kern: true, dynamic: true, scale: [1, 1] }, null, c.font);
  const atlas = glyphAtlas(font);
  const quads = new Float32Array(glyphs.length * 8);
  let sum = 0;
  glyphs.forEach((g, k) => {
    sum += SUM_BASE - c.font.kern[g.index * 2];
    const o = k * 8;
    // (measured: the glyph's left is its pen's place less the trim's step times the quad's height factor,
    // where layoutSis steps by the width factor, 1; the pen itself advances by the width factor)
    const left = g.x + (c.font.kern[g.index * 2] - 1) * (1 - GLYPH_H / GLYPH_W);
    quads[o] = left / GLYPH_PX * GLYPH_W;
    quads[o + 1] = -g.y / GLYPH_PX * GLYPH_H;
    quads[o + 2] = (left + g.w) / GLYPH_PX * GLYPH_W;
    quads[o + 3] = -(g.y + g.h) / GLYPH_PX * GLYPH_H;
    quads.set(atlas.uv.subarray(g.index * 4, g.index * 4 + 4), o + 4);
  });
  const clamped = Math.min(SUM_MAX, Math.max(SUM_MIN, sum));
  const t: PlateText = { quads, count: glyphs.length, width: clamped * SUM_SLOPE };
  m.set(name, t);
  return t;
}

/** the plate model's width at the sum's cap, in x-scale units */
export const PLATE_FULL = SUM_MAX * SUM_SLOPE;
