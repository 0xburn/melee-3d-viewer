/* 3D replay viewer: the HUD's words, as pictures to draw with it.
 *
 * Two kinds: the player names under the percentages (Slippi's plates, as its
 * playback shows a netplay game's display names) and the nametags over the
 * fighters (a console game's tags, as the game draws them). The words
 * themselves come from the page (Hud3D.tsx keeps them as its own hidden text,
 * so the page's demo mode swaps them like every other name); they are drawn
 * here into a small picture, once per word and size, and the HUD draws that
 * picture as a quad over the match, into the same picture as everything else
 * (so the 480p look softens them as it does the rest).
 *
 * The plates are lettered with the game's own font out of its executable
 * (plates.ts); the picture here is their fallback when no executable can be
 * read, a bold sans. The nametags are set in a narrow sans in the game's cell
 * spacing (12 pixels a letter at 480 lines, capitals 14 tall), as the font
 * is not in the files the nametags' draw reads.
 */
import type { Batch } from "./fx/draw";

export type TextKind = "plate" | "tag";

export interface TextPicture {
  sprite: NonNullable<Batch["sprite"]>;
  /** its size in the units it is drawn in (the HUD's, or 480-line pixels for a tag) */
  w: number;
  h: number;
  /** from its top down to the baseline (plates) or the capitals' top (tags), same units */
  ref: number;
}

// the plates: a 1.13-unit bold sans with a little tracking (the HUD camera's units)
export const PLATE_FONT = 1.13, PLATE_TRACKING = 0.04;
// the tags: the game's cells (0.4 x 32 wide), capitals 13.9 tall, in 480-line pixels
export const TAG_PITCH = 12.2, TAG_CAPS = 13.9;

// what it uses of a canvas, by shape (the checks run outside a browser)
interface Ctx2D {
  font: string; letterSpacing: string; fillStyle: string; textBaseline: string; textAlign: string;
  measureText(t: string): { width: number };
  fillText(t: string, x: number, y: number): void;
  save(): void; restore(): void; translate(x: number, y: number): void; scale(x: number, y: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}
interface Canvas { width: number; height: number; getContext(k: "2d"): Ctx2D | null }

const cache = new Map<string, TextPicture>();

/** a word as a picture, at `ppu` pixels a unit (null outside a browser, or for no word) */
export function textPicture(text: string, kind: TextKind, ppu: number): TextPicture | null {
  const doc = (globalThis as { document?: { createElement(t: "canvas"): Canvas } }).document;
  if (!text || !doc) return null;
  // (sizes in steps, so a canvas being resized does not make a picture a frame)
  const scale = Math.max(1, Math.round(ppu * 4) / 4);
  const key = `hudtext|${kind}|${scale}|${text}`;
  const had = cache.get(key);
  if (had) return had;
  const cv = doc.createElement("canvas");
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  let pic: TextPicture;
  if (kind === "plate") {
    const px = PLATE_FONT * scale;
    const font = `700 ${px}px "Segoe UI", system-ui, sans-serif`;
    ctx.font = font;
    ctx.letterSpacing = `${PLATE_TRACKING * scale}px`;
    const w = Math.ceil(ctx.measureText(text).width + 2), h = Math.ceil(px * 1.6);
    cv.width = w; cv.height = h;
    ctx.font = font;
    ctx.letterSpacing = `${PLATE_TRACKING * scale}px`;
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, 1, px * 1.2);
    pic = { sprite: sprite(key, ctx, w, h), w: w / scale, h: h / scale, ref: 1.2 * PLATE_FONT };
  } else {
    // one letter a cell, narrowed, capitals TAG_CAPS tall
    const chars = [...text];
    const px = (TAG_CAPS / 0.7) * scale, cell = TAG_PITCH * scale;
    const font = `500 ${px}px "Segoe UI", system-ui, sans-serif`;
    const w = Math.ceil(cell * chars.length + 2), h = Math.ceil(px * 1.3);
    cv.width = w; cv.height = h;
    ctx.font = font;
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "center";
    const base = px * 1.0;
    chars.forEach((c, i) => {
      ctx.save();
      ctx.translate(1 + cell * (i + 0.5), base);
      ctx.scale(0.74, 1);
      ctx.fillText(c, 0, 0);
      ctx.restore();
    });
    pic = { sprite: sprite(key, ctx, w, h), w: w / scale, h: h / scale, ref: (base - 0.7 * px) / scale };
  }
  cache.set(key, pic);
  return pic;
}

function sprite(key: string, ctx: Ctx2D, w: number, h: number): TextPicture["sprite"] {
  const data = ctx.getImageData(0, 0, w, h).data;
  // (the picture's rows bottom first: a quad's texture runs up the screen)
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) rgba.set(data.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  return { key, w, h, rgba };
}

/** A console game's nametag as the game shows it: its full-width letters
 *  (the replay's Shift-JIS) in the ordinary ones the game's font draws them as. */
export function tagText(nametag: string): string {
  return (nametag ?? "").normalize("NFKC").trim();
}

// ---------------------------------------------------------------- quads

const FLOATS = 17;

/** A quad for the renderer's particle pass (fx/draw.ts's layout): corners
 *  (x0, y0) bottom left to (x1, y1) top right at depth z; untextured in
 *  `color`, or the picture in white at `alpha` */
export function quad(out: number[], x0: number, y0: number, x1: number, y1: number, z: number,
                     color: [number, number, number, number] | null, alpha = 1) {
  const prim = color ?? [1, 1, 1, alpha];
  const env = color ?? [1, 1, 1, 0];
  const tex = color ? 0 : 1;
  // the alpha compare always passes (GX_ALWAYS both, AND)
  const cmp = [63, 0, 0];
  const v = (x: number, y: number, u: number, t: number) => out.push(x, y, z, u, t, ...prim, ...env, ...cmp, tex);
  v(x0, y0, 0, 0); v(x0, y1, 0, 1); v(x1, y1, 1, 1); v(x1, y0, 1, 0);
}
export const QUAD_FLOATS = FLOATS * 4;

/** A textured quad over the rectangle (x0, y0) bottom left to (x1, y1) top right at depth z: white at `alpha`,
 *  the picture's rectangle (u0, vTop) to (u1, vBottom) - the picture's rows run top down, as a glyph atlas keeps
 *  them - drawn with the same layout as `quad`. */
export function texQuad(out: number[], x0: number, y0: number, x1: number, y1: number, z: number,
                        u0: number, vTop: number, u1: number, vBottom: number) {
  // (position 3, texture 2, primary color 4, env color 4, the alpha compare always passing 3, textured 1)
  out.push(x0, y0, z, u0, vBottom, 1, 1, 1, 1, 1, 1, 1, 0, 63, 0, 0, 1);
  out.push(x0, y1, z, u0, vTop, 1, 1, 1, 1, 1, 1, 1, 0, 63, 0, 0, 1);
  out.push(x1, y1, z, u1, vTop, 1, 1, 1, 1, 1, 1, 1, 0, 63, 0, 0, 1);
  out.push(x1, y0, z, u1, vBottom, 1, 1, 1, 1, 1, 1, 1, 0, 63, 0, 0, 1);
}
