/* 3D replay viewer: the game's own text (HSD_SisLib), for
 * Pokemon Stadium's big screen.
 *
 * The game writes text as a list of ops and two-byte glyph codes. A code
 * below 0x4000 is a glyph of the common font (the game's executable: 287
 * pictures of 32 by 32 at 4 bits, a left and a right trim each), one from
 * 0x4000 a glyph of the file's own font (a stage's SIS table: entry 0 its
 * pictures, entry 1 its trims; the pages from entry 3 on). Strings the code
 * writes in (HSD_SisLib_803A6B98) become ops and common-font codes through
 * the executable's Shift-JIS table (HSD_SisLib_803A67EC).
 *
 * The layout is the game's drawing function's (HSD_SisLib_803A84BC) and its
 * line measure's (HSD_SisLib_803A8134), read from their machine code (the
 * decompilation has neither): a glyph is 32 by 32 times the scale, a space
 * 16 wide; with kerning a glyph is drawn its left trim less one further left
 * and advances its two trims less two less; a line is placed when its first
 * glyph or space comes, by its width (centered, right or left in the box, or
 * about an op 07's x), squeezed to the box when fitting is on and it is
 * wider; a new line moves down by the line's height (its tallest glyph, or
 * 32 times the scale with none) and the line spacing; each glyph sits on the
 * bottom of its line.
 */

/** a font: its glyph pictures (I4, 32 by 32, 512 bytes each) and each glyph's left and right trim */
export interface SisFont { images: Uint8Array; kern: Uint8Array }

/** the executable's part: the common font and the tables a string goes through, and the characters' names */
export interface SisCommon {
  font: SisFont;
  /** the Shift-JIS pairs the font has, two bytes each (lbl_8040C8C0) */
  sjis: Uint8Array;
  /** each pair's code (HSD_SisLib_8040C680) */
  codes: Uint8Array;
  /** the players' colors (gm_80160968's table: a human's by port, 4 a computer's) */
  colors: [number, number, number][];
  /** the characters' names (Shift-JIS), by external character id */
  names: Uint8Array[];
}

/** what Pokemon Stadium's screen writes with: its file's text, and the executable's when it could be read */
export interface Lettering { file: SisFile; common: SisCommon | null }

/** a stage's text: its font and its pages (each page's bytes, from its start) */
export interface SisFile { font: SisFont; pages: (Uint8Array | null)[] }

/** the executable's text font as dol.ts reads it (textFontFromDol) */
export function parseSisCommon(buf: ArrayBuffer): SisCommon | null {
  const u = new Uint8Array(buf);
  if (u.length < 4 + 0x6c0 + 0x23e00 + 0x24 || String.fromCharCode(...u.subarray(0, 4)) !== "SIS1") return null;
  let at = 4;
  const take = (n: number) => { const s = u.subarray(at, at + n); at += n; return s; };
  const sjis = take(0x240), codes = take(0x240), kern = take(0x240), images = take(0x23e00), col = take(0x24);
  const colors: [number, number, number][] = [];
  for (let k = 0; k < 9; k++) colors.push([col[k * 4], col[k * 4 + 1], col[k * 4 + 2]]);
  const names: Uint8Array[] = [];
  while (at < u.length) { const n = u[at++]; names.push(u.subarray(at, at + n)); at += n; }
  return { font: { images, kern }, sjis, codes, colors, names };
}

/** one HSD_Text: where it is, its box, its defaults; `dynamic` for one the code writes strings into
 *  (alloc_data: its spacing ops count only without kerning) */
export interface SisTextOpts {
  x?: number; y?: number; boxW?: number; boxH?: number;
  scale?: [number, number]; spacing?: [number, number]; color?: [number, number, number];
  align?: number; kern?: boolean; fit?: boolean; dynamic?: boolean;
}

/** a glyph to draw: its font and index, its color, and its quad in the text's units */
export interface SisGlyph { font: SisFont; index: number; color: [number, number, number]; x: number; y: number; w: number; h: number }

interface State { sx: number; sy: number; spx: number; spy: number; color: [number, number, number]; align: number; kern: boolean; fit: boolean }

const s16 = (b: Uint8Array, i: number) => ((b[i] << 8) | b[i + 1]) << 16 >> 16;
const u16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const f32 = Math.fround;

/** The glyphs a text's ops lay out (HSD_SisLib_803A84BC), in its own units
 *  (the stage's screen: 250 by 160 from its top left). */
export function layoutSis(bytes: Uint8Array, o: SisTextOpts, file: SisFont | null, common: SisFont | null): SisGlyph[] {
  const px = o.x ?? 0, py = o.y ?? 0, boxW = o.boxW ?? 640, fsx = 1, fsy = 1;
  const dflt = (): State => ({ sx: o.scale?.[0] ?? 1, sy: o.scale?.[1] ?? 1, spx: o.spacing?.[0] ?? 0, spy: o.spacing?.[1] ?? 0,
                               color: o.color ?? [255, 255, 255], align: o.align ?? 0, kern: !!o.kern, fit: !!o.fit });
  let st = dflt();
  // the pushes ops make, each put back by its own kind (HSD_SisLib_803A7684 / 803A7F0C)
  const stacks: Record<string, unknown[]> = { sp: [], color: [], scale: [], align: [] };
  const push = (k: string, v: unknown) => stacks[k].push(v);
  const pop = <T>(k: string, d: T): T => (stacks[k].length ? stacks[k].pop() as T : d);
  const spacingCounts = (kern: boolean) => !o.dynamic || !kern;
  const fontOf = (code: number) => (code < 0x4000 ? { f: common, i: code - 0x2000 } : { f: file, i: code - 0x4000 });
  const trims = (code: number): [number, number] => {
    const { f, i } = fontOf(code);
    return f && i >= 0 && i * 2 + 1 < f.kern.length ? [f.kern[i * 2], f.kern[i * 2 + 1]] : [1, 1];
  };

  /** the line from `i`: its width and height (HSD_SisLib_803A8134) */
  const measure = (i: number): [number, number] => {
    let sx = st.sx, sy = st.sy, spx = st.spx, kern = st.kern;
    const sps: number[] = [], scs: [number, number][] = [];
    let w = 0, h = f32(32 * sy);
    while (i < bytes.length) {
      const b = bytes[i];
      if (b === 0 || b === 1 || b === 2 || b === 3 || b === 7) break;
      if (b === 5) i += 2;
      else if (b === 6 || b === 8 || b === 9) i += 4;
      else if (b === 0x0a) { if (spacingCounts(kern)) { sps.push(spx); spx = s16(bytes, i + 1) / 256; } i += 4; }
      else if (b === 0x0b) { if (spacingCounts(kern)) spx = sps.length ? sps.pop()! : (o.spacing?.[0] ?? 0); }
      else if (b === 0x0c) i += 3;
      else if (b === 0x0e) { scs.push([sx, sy]); sx = u16(bytes, i + 1) / 256; sy = u16(bytes, i + 3) / 256; i += 4; }
      else if (b === 0x0f) { [sx, sy] = scs.length ? scs.pop()! : [st.sx, st.sy]; }
      else if (b === 0x16) kern = true;
      else if (b === 0x17) kern = false;
      else if (b === 0x1a) { w = f32(w + f32(sx * f32(16 + spx))); h = Math.max(h, f32(32 * sy)); }
      else if (b >= 0x20) {
        const code = u16(bytes, i);
        w = f32(w + f32(sx * f32(32 + spx)));
        if (kern) { const [l, r] = trims(code); w = f32(w - f32(sx * (l + r - 2))); }
        h = Math.max(h, f32(32 * sy));
        i++;
      }
      i++;
    }
    return [f32(w - spx), h];
  };

  const out: SisGlyph[] = [];
  let penX = 0, penY = 0, fit = 1, lineH = f32(32 * st.sy), started = false;
  const startLine = (i: number) => {
    const [w, h] = measure(i);
    started = true; lineH = h;
    if (st.fit && boxW < w) { penX = 0; fit = f32(boxW / w); }
    else { fit = 1; penX = st.align === 2 ? f32(boxW - w) : st.align === 1 ? f32(0.5 * f32(boxW - w)) : 0; }
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) break;
    switch (b) {
      case 0x01: st = dflt(); for (const k in stacks) stacks[k].length = 0; continue;
      case 0x02: penY = 0; started = false; continue;
      case 0x03: {
        if (!started) lineH = f32(32 * st.sy);
        penY = f32(penY + fsy * f32(f32(st.sy * st.spy) + lineH));
        started = false;
        continue;
      }
      case 0x04: continue;
      case 0x05: i += 2; continue;
      case 0x06: case 0x08: case 0x09: i += 4; continue;
      case 0x07: {
        const x = s16(bytes, i + 1), y = s16(bytes, i + 3);
        const [w, h] = measure(i + 5);
        started = true; lineH = h;
        fit = st.fit && boxW < w ? f32(boxW / w) : 1;
        penX = st.align === 2 ? f32(x - f32(w * fit)) : st.align === 1 ? f32(x - f32(0.5 * f32(w * fit))) : x;
        penY = f32(y * fsy);
        i += 4;
        continue;
      }
      case 0x0a:
        if (spacingCounts(st.kern)) { push("sp", [st.spx, st.spy]); st.spx = s16(bytes, i + 1) / 256; st.spy = s16(bytes, i + 3) / 256; }
        i += 4; continue;
      case 0x0b:
        if (spacingCounts(st.kern)) [st.spx, st.spy] = pop("sp", [o.spacing?.[0] ?? 0, o.spacing?.[1] ?? 0]);
        continue;
      case 0x0c: push("color", st.color); st.color = [bytes[i + 1], bytes[i + 2], bytes[i + 3]]; i += 3; continue;
      case 0x0d: st.color = pop("color", o.color ?? [255, 255, 255]); continue;
      case 0x0e: push("scale", [st.sx, st.sy]); st.sx = u16(bytes, i + 1) / 256; st.sy = u16(bytes, i + 3) / 256; i += 4; continue;
      case 0x0f: [st.sx, st.sy] = pop("scale", [o.scale?.[0] ?? 1, o.scale?.[1] ?? 1]); continue;
      case 0x10: case 0x12: case 0x14: push("align", st.align); st.align = b === 0x10 ? 1 : b === 0x12 ? 0 : 2; continue;
      case 0x11: case 0x13: case 0x15: st.align = pop("align", o.align ?? 0); continue;
      case 0x16: st.kern = true; continue;
      case 0x17: st.kern = false; continue;
      case 0x18: st.fit = true; continue;
      case 0x19: st.fit = false; continue;
      case 0x1a:
        if (!started) startLine(i);
        penX = f32(penX + f32(fit * f32(st.sx * f32(16 + st.spx))));
        continue;
    }
    if (b < 0x20) continue;
    const code = u16(bytes, i);
    i++;
    if (!started) startLine(i - 1);
    const { f, i: index } = fontOf(code);
    const [l, r] = trims(code);
    let x0 = f32(f32(penX * fsx) + px);
    if (st.kern) x0 = f32(x0 - f32(fsx * f32(st.sx * (l - 1))));
    const gw = f32(f32(32 * st.sx) * fsx), gh = f32(32 * st.sy);
    const y0 = f32(f32(py + penY) + f32(fsy * f32(lineH - gh)));
    if (f && index >= 0 && (index + 1) * 512 <= f.images.length) {
      out.push({ font: f, index, color: st.color, x: x0, y: y0, w: f32(fit * gw), h: f32(gh * fsy) });
    }
    penX = f32(penX + f32(fit * f32(st.sx * f32(32 + st.spx))));
    if (st.kern) penX = f32(penX - f32(fit * f32(st.sx * (l + r - 2))));
  }
  return out;
}

/** A string the code writes in (HSD_SisLib_803A6B98): at (x, y), in the
 *  text's color and scale, its characters as the common font's codes
 *  (HSD_SisLib_803A67EC): ASCII is turned to full-width Shift-JIS, a space,
 *  a period or a colon pulls the letters 12 closer until a letter, quote,
 *  apostrophe, comma or hyphen puts the spacing back; anything else is taken
 *  as a Shift-JIS pair. */
export function sisString(s: Uint8Array, x: number, y: number, color: [number, number, number], scale: [number, number], c: SisCommon): number[] {
  const out: number[] = [7, ...be16(Math.trunc(x)), ...be16(Math.trunc(y)), 0x0c, ...color];
  const fix = (v: number) => [Math.trunc(v) & 0xff, Math.trunc(v * 256) & 0xff];
  out.push(0x0e, ...fix(scale[0]), ...fix(scale[1]));
  let narrow = 0;
  for (let k = 0; k < s.length && k < 128; k++) {
    const ch = s[k];
    if (ch === 0) break;
    let hi: number, lo: number;
    const tight = () => { if (!narrow) { out.push(0x0a, 0xf4, 0, 0, 0); narrow++; } };
    const back = () => { out.push(0x0b); narrow = 0; };
    if (ch === 0x20) { tight(); hi = 0x81; lo = 0x40; }
    else if (ch === 0x22) { back(); hi = 0x81; lo = 0x68; }
    else if (ch === 0x27) { back(); hi = 0x81; lo = 0x66; }
    else if (ch === 0x2c) { back(); hi = 0x81; lo = 0x43; }
    else if (ch === 0x2d) { back(); hi = 0x81; lo = 0x7c; }
    else if (ch === 0x2e) { tight(); hi = 0x81; lo = 0x44; }
    else if (ch >= 0x30 && ch <= 0x39) { hi = 0x82; lo = ch + 31; }
    else if (ch === 0x3a) { tight(); hi = 0x81; lo = 0x46; }
    else if (ch >= 0x41 && ch <= 0x5a) { back(); hi = 0x82; lo = ch + 31; }
    else if (ch >= 0x61 && ch <= 0x7a) { back(); hi = 0x82; lo = ch + 32; }
    else { back(); hi = ch; lo = s[++k] ?? 0; }
    for (let j = 0; j < 287; j++) {
      if (c.sjis[j * 2] === hi && c.sjis[j * 2 + 1] === lo) { out.push(c.codes[j * 2], c.codes[j * 2 + 1]); break; }
    }
  }
  if (narrow) out.push(0x0b);
  out.push(0x0f, 0x0d);
  return out;
}

function be16(v: number): [number, number] { return [(v >> 8) & 0xff, v & 0xff]; }

/** ASCII bytes of a string (the code's formats: digits, letters, ':' and spaces) */
export function ascii(s: string): Uint8Array { return Uint8Array.from([...s].map((ch) => ch.charCodeAt(0) & 0xff)); }

/** one glyph's picture as alpha (GX I4: 8 by 8 tiles, two pixels a byte, high first), 32 by 32 */
export function glyphAlpha(f: SisFont, index: number): Uint8Array {
  const src = f.images.subarray(index * 512, index * 512 + 512), out = new Uint8Array(32 * 32);
  let p = 0;
  for (let ty = 0; ty < 32; ty += 8) for (let tx = 0; tx < 32; tx += 8) {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 2) {
      const b = src[p++];
      out[(ty + y) * 32 + tx + x] = (b >> 4) * 17;
      out[(ty + y) * 32 + tx + x + 1] = (b & 15) * 17;
    }
  }
  return out;
}

/** the stage file's SIS table (its public `SIS_GrPStadiumData`): entry 0 the font's pictures, 1 its trims, pages from 3 on */
export function parseSisFile(u8: Uint8Array, table: number, ptr: (at: number) => number | null): SisFile | null {
  const entries: (number | null)[] = [];
  for (let k = 0; k < 64; k++) { const p = ptr(table + k * 4); if (p === null && k > 2) break; entries.push(p); }
  if (entries.length < 4 || entries[0] === null || entries[1] === null) return null;
  // (the pictures run to the file's end at most; the trims are 2 bytes a glyph)
  const images = u8.subarray(entries[0]!, Math.min(u8.length, entries[0]! + 512 * 512));
  const kern = u8.subarray(entries[1]!, entries[1]! + 2 * 512);
  return { font: { images, kern }, pages: entries.map((p) => (p === null ? null : u8.subarray(p))) };
}
