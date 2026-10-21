/* 3D replay viewer: Slippi's name plates, lettered as its playback letters them.
 *
 * A plate's name is set in the game's own text font (the executable's: 287
 * glyphs of 32 by 32 at 4 bits, see dol.ts) by the game's own text rules
 * (sistext.ts): the display name's Shift-JIS bytes go through the formatter
 * and the string routine's table (HSD_SisLib_803A6B98 / 803A67EC), and the
 * line is laid out with kerning, a width the string routine's spacing ops do
 * not change, centered on the plate and squeezed to 9 units when it runs
 * wider (the text's own scale is 1.035, so a name of 288 text pixels or more
 * has 1.000 by 1.035 quads). Each glyph is a quad in the HUD camera's space,
 * white, its alpha the glyph's texel, drawn over the plate with the
 * source-alpha blend, depth tested (lequal) without writing.
 *
 * Everything here is made once: the font from the executable, the glyph
 * atlas (one picture for all of them) and each name's quads. A frame only
 * copies a name's quads to where its plate is.
 */
import { glyphAlpha, layoutSis, parseSisCommon, sisString, type SisCommon, type SisFont } from "./sistext";
import { textFontFromDol } from "./dol";

/** a glyph is 32 pixels of text, and a pixel of text is 1/32 of a unit in the HUD camera's space */
const GLYPH_PX = 32;
/** the plate text's own scale (both ways: a quad 1.035 units tall), and the width it is fitted to when it
 *  runs wider, in pixels of text (9 units) */
const TEXT_SCALE = 1.035, TEXT_BOX = 288;

// The plate's width follows the name: the sum of (20 - left trim) over its
// glyphs, held to 60..144, times 0.0146, is the plate model's x scale. Fitted
// to the game's own draws of names with sums from 16 to 163: a sum under 60
// draws at 60 (0.876), from there the scale is the sum times 0.0146 to the
// last digit the draws give (62 -> 0.9052, 93 -> 1.3578, 144 -> 2.1024), and
// over 144 it stays at 2.1024.
const SUM_MIN = 60, SUM_MAX = 144, SUM_SLOPE = 0.0146, SUM_BASE = 20;

/** the font: the executable's tables and the glyph atlas */
export interface PlateFont {
  common: SisCommon;
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
  /** the plate model's x scale for this name (the cap, PLATE_FULL, is the plate at its widest) */
  width: number;
}

const memo = new WeakMap<ArrayBuffer, PlateFont | null>();

/** The font out of the game's executable (null when it is not NTSC 1.02's), made once per file. */
export function plateFontFromDol(buf: ArrayBuffer): PlateFont | null {
  if (memo.has(buf)) return memo.get(buf)!;
  let font: PlateFont | null = null;
  try { font = plateFontFromText(textFontFromDol(buf)); } catch { /* not the version the addresses are for: the canvas letters */ }
  memo.set(buf, font);
  return font;
}

/** The font from the executable's text tables as textFontFromDol made them (files.ts keeps those in the
 *  browser, so the executable is not read again), made once per buffer; null when they are no font. */
export function plateFontFromText(text: ArrayBuffer): PlateFont | null {
  if (memo.has(text)) return memo.get(text)!;
  let font: PlateFont | null = null;
  try {
    const common = parseSisCommon(text);
    if (common) font = { common, atlas: null };
  } catch { /* the canvas letters */ }
  memo.set(text, font);
  return font;
}

// ---------------------------------------------------------------- the name's bytes

/** Unicode -> Shift-JIS bytes, for the names that reach the plate as text (a page's demo mode rewrites them; the
 *  replay's own bytes are kept beside the text, see plateText). The decoder is the browser's own, run over
 *  every pair once. */
let encoder: Map<number, number[]> | null = null;
function sjisBytes(cp: number): number[] | null {
  if (!encoder) {
    const table = new Map<number, number[]>();
    encoder = table;
    let dec: TextDecoder | null = null;
    try { dec = new TextDecoder("shift_jis"); } catch { /* no table: only ASCII */ }
    if (dec) {
      const put = (s: string, bytes: number[]) => {
        const c = s.codePointAt(0);
        // (one character a pair; a pair the decoder cannot read comes back as U+FFFD or as two characters)
        if (c !== undefined && c !== 0xfffd && s.length === (c > 0xffff ? 2 : 1) && !table.has(c)) table.set(c, bytes);
      };
      const one = new Uint8Array(1), two = new Uint8Array(2);
      for (let b = 0xa1; b <= 0xdf; b++) { one[0] = b; put(dec.decode(one), [b]); }
      for (let hi = 0x81; hi <= 0xfc; hi++) {
        if (hi > 0x9f && hi < 0xe0) continue;
        for (let lo = 0x40; lo <= 0xfc; lo++) {
          if (lo === 0x7f) continue;
          two[0] = hi; two[1] = lo;
          put(dec.decode(two), [hi, lo]);
        }
      }
    }
  }
  return encoder.get(cp) ?? null;
}

/** A name as the Shift-JIS bytes the string routine takes: ASCII as it is, anything else as its pair (or the one
 *  byte of a half-width kana). A character Shift-JIS has no code for is left out. */
export function nameBytes(name: string): Uint8Array {
  const out: number[] = [];
  for (const ch of name) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) { if (cp >= 0x20) out.push(cp); continue; }
    const b = sjisBytes(cp);
    if (b) out.push(...b);
  }
  return Uint8Array.from(out);
}

/** The bytes the replay holds for a name (its "binary string": a character a byte), up to the first zero. */
export function rawBytes(raw: string): Uint8Array {
  const out: number[] = [];
  for (let k = 0; k < raw.length && k < 31; k++) {
    const b = raw.charCodeAt(k) & 0xff;
    if (b === 0) break;
    out.push(b);
  }
  return Uint8Array.from(out);
}

/** The formatter the name goes through (the string is a printf format: HSD_SisLib_803A6B98 hands it to vsprintf
 *  with the registers the caller left as its arguments). The first argument is 16 in every plate measured
 *  ("%d" draws 16, "%x" 10, "%5d" "   16", "%-4d" "16  ", "%04d" 0016), a "%s" of it is empty, "%c" is the
 *  control byte 16; a percent sign that goes with nothing it knows stays as it is, "%%" is one. The arguments
 *  after the first are whatever was in the registers and not modeled: they draw nothing. */
export function formatName(b: Uint8Array): Uint8Array {
  const out: number[] = [];
  let arg = 0;
  const digit = (c: number | undefined) => c !== undefined && c >= 0x30 && c <= 0x39;
  for (let i = 0; i < b.length; i++) {
    const ch = b[i];
    if (ch === 0) break;
    if (ch !== 0x25) { out.push(ch); continue; }
    let j = i + 1;
    if (b[j] === 0x25) { out.push(0x25); i = j; continue; }
    let left = false, zero = false, plus = false, space = false, alt = false;
    for (; j < b.length; j++) {
      const f = b[j];
      if (f === 0x2d) left = true; else if (f === 0x30) zero = true; else if (f === 0x2b) plus = true;
      else if (f === 0x20) space = true; else if (f === 0x23) alt = true; else break;
    }
    let width = 0, prec = -1;
    while (digit(b[j])) width = width * 10 + b[j++] - 0x30;
    if (b[j] === 0x2e) { j++; prec = 0; while (digit(b[j])) prec = prec * 10 + b[j++] - 0x30; }
    while (b[j] === 0x68 || b[j] === 0x6c || b[j] === 0x4c) j++;
    const conv = b[j] ?? 0;
    if (conv === 0 || !"diuxXocsp".includes(String.fromCharCode(conv))) {
      // (not a conversion it knows, or the string ended on the percent sign: kept as written)
      for (let k = i; k <= Math.min(j, b.length - 1); k++) if (b[k] !== 0) out.push(b[k]);
      i = j;
      continue;
    }
    i = j;
    const v = arg++ === 0 ? 16 : null;
    let text: number[] = [];
    if (v !== null) {
      const c = String.fromCharCode(conv);
      if (c === "c") text = [v];
      else if (c === "s") text = [];
      else {
        let digits = c === "x" ? v.toString(16) : c === "X" ? v.toString(16).toUpperCase() : c === "o" ? v.toString(8) : String(v);
        if (prec >= 0) digits = digits.padStart(prec, "0");
        const sign = c === "d" || c === "i" ? (plus ? "+" : space ? " " : "") : "";
        const prefix = alt ? (c === "x" ? "0x" : c === "X" ? "0X" : c === "o" ? "0" : "") : "";
        const pad = width - sign.length - prefix.length - digits.length;
        let s: string;
        if (pad <= 0) s = sign + prefix + digits;
        else if (left) s = sign + prefix + digits + " ".repeat(pad);
        else if (zero && prec < 0) s = sign + prefix + "0".repeat(pad) + digits;
        else s = " ".repeat(pad) + sign + prefix + digits;
        text = [...s].map((x) => x.charCodeAt(0));
      }
      if ((c === "c" || c === "s") && width > text.length) {
        const fill = Array(width - text.length).fill(0x20);
        text = left ? [...text, ...fill] : [...fill, ...text];
      }
    }
    out.push(...text);
  }
  return Uint8Array.from(out);
}

/** What the string routine reads when a name finishes on a byte it takes for a lead byte (a lone '!' or '?', a
 *  half-width kana): the second byte is the terminator, and it goes on into what the buffer held before. Those
 *  bytes, by their place in the buffer (the name's first byte is 0), as the game's plates showed them for names
 *  of 1 to 30 bytes ending in '?' on two stages: an N at 3, 5, 11, 13, 19, 21, 27 and 29, a 7 at 7 and 9, a 9 at
 *  31, and at 15 and 17 a 5 on the first player's plate, an N on the others'; nothing at the places between. */
export function pastTheEnd(first: boolean): Uint8Array {
  const t = new Uint8Array(40);
  const put = (at: number[], ch: string) => at.forEach((i) => { t[i] = ch.charCodeAt(0); });
  put([3, 5, 11, 13, 19, 21, 27, 29], "N");
  put([7, 9], "7");
  put([15, 17], first ? "5" : "N");
  put([31], "9");
  return t;
}

// ---------------------------------------------------------------- the glyph atlas

const CELL = GLYPH_PX + 2, COLS = 17;
const atlases = new WeakMap<SisFont, GlyphAtlas>();

/** the glyphs of a font in one picture (made once per font): `key` names the picture */
export function glyphAtlasOf(f: SisFont, key: string): GlyphAtlas {
  const had = atlases.get(f);
  if (had) return had;
  const n = Math.floor(f.images.length / 512);
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
  const atlas = { sprite: { key, w, h, rgba }, uv };
  atlases.set(f, atlas);
  return atlas;
}

/** the executable's glyph atlas (made once per font) */
export function glyphAtlas(font: PlateFont): GlyphAtlas {
  return (font.atlas ??= glyphAtlasOf(font.common.font, "plate-font"));
}

// ---------------------------------------------------------------- a name's quads

const texts = new WeakMap<PlateFont, Map<string, PlateText>>();

/** A name's quads and plate width (made once per name). `raw` is the replay's own bytes for it (rawBytes), when the
 *  text is still what the replay says: the game was given those, not the text. `first`: the first player's
 *  plate (what lies past the end of a name differs a little, see pastTheEnd). */
export function plateText(font: PlateFont, name: string, raw?: Uint8Array | null, first = false): PlateText {
  let m = texts.get(font);
  if (!m) texts.set(font, (m = new Map()));
  const key = `${first ? 1 : 0}${raw ? "r" + Array.from(raw).join(",") : "s" + name}`;
  const had = m.get(key);
  if (had) return had;
  const c = font.common;
  // the name's bytes, through the formatter and the string routine's ops, laid out as the plate's text is: at the
  // text's own scale, kerned, dynamic, centered on its middle and squeezed to the box when it runs wider
  const bytes = formatName(raw ?? nameBytes(name));
  const ops = Uint8Array.from(sisString(bytes, 0, 0, [255, 255, 255], null, c, pastTheEnd(first)));
  const glyphs = layoutSis(ops, { align: 1, boxW: TEXT_BOX, fit: true, kern: true, dynamic: true, scale: [TEXT_SCALE, TEXT_SCALE] },
                           null, c.font);
  const atlas = glyphAtlas(font);
  const quads = new Float32Array(glyphs.length * 8);
  let sum = 0;
  glyphs.forEach((g, k) => {
    sum += SUM_BASE - c.font.kern[g.index * 2];
    const o = k * 8;
    quads[o] = g.x / GLYPH_PX;
    quads[o + 1] = -g.y / GLYPH_PX;
    quads[o + 2] = (g.x + g.w) / GLYPH_PX;
    quads[o + 3] = -(g.y + g.h) / GLYPH_PX;
    quads.set(atlas.uv.subarray(g.index * 4, g.index * 4 + 4), o + 4);
  });
  const clamped = Math.min(SUM_MAX, Math.max(SUM_MIN, sum));
  const t: PlateText = { quads, count: glyphs.length, width: clamped * SUM_SLOPE };
  m.set(key, t);
  return t;
}

/** the plate model's x scale at the sum's cap */
export const PLATE_FULL = SUM_MAX * SUM_SLOPE;
