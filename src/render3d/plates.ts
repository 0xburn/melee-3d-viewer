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
import { glyphAlpha, layoutSis, parseSisCommon, sisBody, sisWrap, type SisCommon, type SisFont } from "./sistext";
import { VaList, vsprintf, type MemoryReader } from "./msl";
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

// ---------------------------------------------------------------- what the string routine is given

// Slippi's playback sets a plate's text with the game's own routine (HSD_SisLib_803A6B98), handing it the display name
// as a printf format and nothing else: the arguments a conversion in the name reads are what the caller left in the
// registers and on its stack, and the buffer the formatted text goes to is a frame of the routine's own that still
// holds what earlier calls left in it. Everything below is the game's, as the code computes it and as the plates
// drawn for names with up to twelve conversions, with lead bytes at the end and with odd percent signs showed it.

/** the text heap (HSD_SisLib_Alloc and its free): 12 byte headers, best fit, the head block carved from its front, a
 *  freed block next to the head given back to it and any other put at the list's end. A plate's text takes 4 blocks
 *  (the text's own 0xA0 bytes, 0x10, the ops buffer's 0x80, 0x10) and grows its ops buffer in steps of 0x80. */
class TextHeap {
  private free: { hdr: number; data: number; size: number }[];
  private used: { hdr: number; data: number; size: number }[] = [];
  constructor(data: number, size = 0x100000) { this.free = [{ hdr: data - 12, data, size }]; }
  alloc(n: number): number {
    n = (n + 3) & ~3;
    let best = -1;
    for (let i = 0; i < this.free.length; i++) {
      const b = this.free[i];
      if (b.size === n) { best = i; break; }
      if (b.size > n && (best < 0 || b.size < this.free[best].size)) best = i;
    }
    if (best < 0) throw new Error("text heap exhausted");
    let blk: { hdr: number; data: number; size: number };
    if (best === 0) {
      const h = this.free[0], hdr = h.data + n;
      blk = { hdr: h.hdr, data: h.data, size: n };
      this.free[0] = { hdr, data: hdr + 12, size: h.size - n - 12 };
    } else blk = this.free.splice(best, 1)[0];
    this.used.push(blk);
    return blk.data;
  }
  release(data: number) {
    const i = this.used.findIndex((b) => b.data === data);
    if (i < 0) return;
    const [node] = this.used.splice(i, 1);
    const head = this.free[0];
    if (head.hdr === node.data + node.size) this.free[0] = { hdr: node.hdr, data: node.data, size: head.size + node.size + 12 };
    else this.free.push(node);
  }
}

/** where the first plate's text lands in the text heap, and how far each stage moves it (a Pokemon Stadium game has
 *  the stage's own text allocated first: 0x254 bytes), and a plate takes 0x170 */
const TEXT_HEAP_START = 0x80bd91d0;
const TEXT_HEAP_STAGE: Record<number, number> = { 3: 0x254 };
/** the first slot of the caller's stack past the registers, per stage (a double-conversion constant, 0x43300000, on
 *  all but Corneria's stage (7), where it is 0) */
const STACK_SLOT0: Record<number, number> = { 7: 0 };

/** the caller's stack from its first slot (slot 0 is per stage, see above): a double's conversion constant, and
 *  stack and code addresses and small numbers the earlier calls left */
const STACK_SLOTS = [0x43300000, 0, 0x804eeaf8, 0x802f9ebc, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 0xffffffff, 0, 0, 0, 0,
                     0x804eeaf8, 0x802f617c, 0x804eeaf8, 0x802f6494, 0x804eead0, 0x8037acc0];
/** the saved float registers f1 to f8 (the text's x and y, a few viewport numbers) */
const FLOAT_REGS = [0, 0, 0, 640, 480, -0.4807128906250, 1, 0];

/** the game's low memory, which a string argument that is a small number reads (the disc header's id first) */
const LOW_MEMORY = hexBytes("47414c45303100020000000000000000000000000000000000000000c2339f3d0d15ea5e0000000101830d401000000600000000818298008182980000007529");
/** the first bytes of other memory the arguments point at: [address, bytes] */
const MEMORY_AT: [number, Uint8Array][] = [
  [0x804ce380, hexBytes("3f3f1800")],
  [0x804d0000, hexBytes("00")],
  [0x804eeaf8, hexBytes("804eeb18802f652c00")],
  [0x802f9ebc, hexBytes("4800007400")],
];
function hexBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let k = 0; k < out.length; k++) out[k] = parseInt(h.slice(k * 2, k * 2 + 2), 16);
  return out;
}

/** heap pointers the earlier calls left in the buffer's stale bytes; they depend on the game's whole memory history and
 *  cannot be known from the replay (they are only read when a name ends on a lead byte or the text runs on past its
 *  end), so these stand in: the first plate's are the game's in every game measured */
export interface StaleWords { x4: number; x16: number; x25: number; x38: number }
export const STALE_DEFAULT: StaleWords = { x4: 0x80ef9280, x16: 0x80ef9280, x25: 0x80ef9280, x38: 0x80ef9280 };

/** the 42 words below the formatted string's start: the stack the routine's frame stands on holds what earlier calls
 *  wrote there. Constant words are code and stack addresses; the rest are the text's own addresses by plate order. */
function staleImage(k: number, t0: number, T: number[], x: StaleWords): Uint8Array {
  const first = k === 0;
  const prev = first ? t0 - 0x1a8 : T[k - 1];
  const ws = [
    0x804ce38c, 0x804ee998, 0x8037acc0, 0x804ee9a0, first ? 0x8035e084 : x.x4,
    first ? 0x804ee9b8 : 0x804ee9a8, 2, 0x804ee9c8, 0x80390014, 0x804ee9d0,
    first ? 0x80382044 : 0x8036c198, 0x804ee9d0, first ? 0x80000000 : 0x8035e0e0, 0x80bdfee0,
    first ? 0x803dda84 : 0x60, 0x80bdfee0, x.x16, t0 - 0x1c, prev, T[k], 2, 0x804eea38, 0x803a5be8,
    first ? 0x804eea00 : 0, first ? 0x8037aa3c : 0, first ? x.x25 : 0x3fe3d70a,
    first ? 8 : 0x40000000, first ? 0x80 : 0x3fe8cccc, first ? 0x803dda78 : 0xc0000000, 0x804eea20,
    first ? 9 : 0, first ? 12 : 0x40840000, 0x803dda78, 0x8065fa60, first ? 0x803dda84 : 0x60,
    0x80bdfee0, 0x803dda78, 0x8065fa60, first ? x.x38 : prev, first ? t0 : T[k], first ? t0 : T[k], 0x804eea38,
  ];
  const out = new Uint8Array(ws.length * 4), v = new DataView(out.buffer);
  ws.forEach((w, i) => v.setUint32(i * 4, w >>> 0));
  return out;
}

/** The ops buffer's walk after the text is written (the width loop of HSD_SisLib_803A6B98 starts 15 bytes in): where it
 *  ends, which is the pointer the next plate's call finds in r10. */
function opsWalk(ops: ArrayLike<number>): number {
  let i = 15;
  while (i < ops.length) {
    const b = ops[i];
    if (b === 0x0f) return i;
    i += b === 0x20 || b === 0x40 ? 2 : 1;
  }
  return i;
}

/** one plate's text as the string routine makes it: the formatted bytes and the ops they become */
export interface PlateRun { printed: Uint8Array; body: number[] }

/**
 * The plates Slippi sets, in the order it sets them (the players' ports, low to high): for each, what the name becomes
 * through the game's printf (the registers and stack its caller leaves) and the string routine (the buffer's stale
 * bytes). Each plate's call depends on the earlier ones through the text heap (its addresses are the first
 * conversions' values) and the ops buffer's end, so they are run in order.
 * `names` are the display names' bytes and `ports` the ports they belong to (the text's position, which a string
 * conversion of the text's address reads, is by port).
 */
export function runPlates(common: SisCommon, names: Uint8Array[], ports: number[], stage: number,
                          stale: (Partial<StaleWords> | undefined)[] = []): PlateRun[] {
  const t0 = TEXT_HEAP_START + (TEXT_HEAP_STAGE[stage] ?? 0);
  const slot0 = STACK_SLOT0[stage] ?? STACK_SLOTS[0];
  const heap = new TextHeap(t0);
  const out: PlateRun[] = [];
  const T: number[] = [];
  const bufs: [number, number[]][] = [];
  const f32 = Math.fround;
  // (the text's own bytes: its x and y by port, then zero)
  const textBytes = (port: number) => {
    const v = new DataView(new ArrayBuffer(24));
    v.setFloat32(0, f32(-20.2 + 14 * port)); v.setFloat32(4, f32(20.64)); v.setFloat32(12, 150); v.setFloat32(16, 150);
    return new Uint8Array(v.buffer);
  };
  let prevEnd = 0;
  names.forEach((name, k) => {
    const text = heap.alloc(0xa0); heap.alloc(0x10); let buf = heap.alloc(0x80); heap.alloc(0x10);
    T.push(text);
    const regs = [0, 0, 0x10, text, 0x804ce380, 0x804d0000, k === 0 ? 0x50 : 1, k === 0 ? 8 : prevEnd];
    const stack = [slot0, ...STACK_SLOTS.slice(1)];
    const mem: MemoryReader = (a) => {
      if (a >= 0 && a < LOW_MEMORY.length) return LOW_MEMORY[a];
      for (let j = 0; j < T.length; j++) if (a >= T[j] && a < T[j] + 0xa0) { const b = textBytes(ports[j] ?? j); return a - T[j] < b.length ? b[a - T[j]] : 0; }
      for (const [at, bytes] of bufs) if (a >= at && a < at + bytes.length) return bytes[a - at];
      for (const [at, bytes] of MEMORY_AT) if (a >= at && a < at + bytes.length) return bytes[a - at];
      return 0;
    };
    const printed = vsprintf(name, new VaList(regs, FLOAT_REGS, stack), mem);
    const image = staleImage(k, t0, T, { ...STALE_DEFAULT, ...stale[k] });
    const buffer = new Uint8Array(Math.max(printed.length + 1, image.length));
    buffer.set(image);
    buffer.set(printed);
    buffer[printed.length] = 0;
    // (the formatted string, its zero, then what the frame held past that)
    const body = sisBody(buffer, common);
    const ops = [...new Array(14).fill(0), ...body, 0x0f, 0x0d, 0];
    const need = 0x11 + body.length;
    if (need > 0x80) {
      const grown = 0x80 + ((((need - 0x80) >> 7) + 1) << 7);
      const next = heap.alloc(grown);
      heap.release(buf);
      buf = next;
    }
    prevEnd = buf + opsWalk(ops);
    bufs.push([buf, ops]);
    out.push({ printed, body });
  });
  return out;
}

// ---------------------------------------------------------------- the glyph atlas

const CELL = GLYPH_PX + 2, COLS = 17;
const atlases = new WeakMap<SisFont, Map<string, GlyphAtlas>>();

/** the glyphs of a font in one picture (made once per font and name): `key` names the picture, so the draw log
 *  can tell what a batch is lettering */
export function glyphAtlasOf(f: SisFont, key: string): GlyphAtlas {
  let byKey = atlases.get(f);
  if (!byKey) atlases.set(f, (byKey = new Map()));
  const had = byKey.get(key);
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
  byKey.set(key, atlas);
  return atlas;
}

/** the executable's glyph atlas (made once per font) */
export function glyphAtlas(font: PlateFont): GlyphAtlas {
  return (font.atlas ??= glyphAtlasOf(font.common.font, "plate-font"));
}

// ---------------------------------------------------------------- a name's quads

const texts = new WeakMap<PlateFont, Map<string, PlateText[]>>();

/** One plate of a game: the player's port, the name the page shows and the bytes the replay holds for it (rawBytes),
 *  while the text is still what the replay says: the game was given those, not the text. */
export interface PlateName { port: number; name: string; raw?: Uint8Array | null }

/** The quads and plate widths of a game's plates, in the order given (the players' ports, low to high: the game's
 *  plates depend on the ones before them, see runPlates), made once per game. `stage` is the stage's id. */
export function plateTexts(font: PlateFont, plates: PlateName[], stage: number, stale?: (Partial<StaleWords> | undefined)[]): PlateText[] {
  let m = texts.get(font);
  if (!m) texts.set(font, (m = new Map()));
  const bytes = plates.map((p) => p.raw ?? nameBytes(p.name));
  const key = `${stage}|${stale ? JSON.stringify(stale) : ""}|${plates.map((p, k) => `${p.port}:${p.raw ? "r" : "s"}${Array.from(bytes[k]).join(",")}`).join("|")}`;
  const had = m.get(key);
  if (had) return had;
  const c = font.common;
  const runs = runPlates(c, bytes, plates.map((p) => p.port), stage, stale);
  const atlas = glyphAtlas(font);
  const result = runs.map((run) => {
    // the name's ops, laid out as the plate's text is: at the text's own scale, kerned, dynamic, centered on its
    // middle and squeezed to the box when it runs wider
    const ops = Uint8Array.from(sisWrap(run.body, 0, 0, [255, 255, 255], null));
    const glyphs = layoutSis(ops, { align: 1, boxW: TEXT_BOX, fit: true, kern: true, dynamic: true, scale: [TEXT_SCALE, TEXT_SCALE] },
                             null, c.font);
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
    return { quads, count: glyphs.length, width: clamped * SUM_SLOPE } as PlateText;
  });
  m.set(key, result);
  return result;
}

/** One name's plate on its own (the first plate of a game on a stage with no text of its own): a convenience for
 *  the checks and the demo; a game's plates come from plateTexts. */
export function plateText(font: PlateFont, name: string, raw?: Uint8Array | null, stage = 0): PlateText {
  return plateTexts(font, [{ port: 0, name, raw }], stage)[0];
}

/** the plate model's x scale at the sum's cap */
export const PLATE_FULL = SUM_MAX * SUM_SLOPE;
