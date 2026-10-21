// The texture decoder as it was before the faster one (hsd.ts decodeImage), kept to check the new one against.
import type { Archive, Image, Tlut } from "../src/render3d/hsd.ts";

/** Decode a GX texture to RGBA8. A color-indexed image needs its palette;
 * an index past the palette's end reads as transparent black. */
export function decodeImageReference(a: Archive, img: Image, tlut: Tlut | null): Uint8Array {
  const { width: w, height: h, format: f } = img;
  const d = a.data;
  const out = new Uint8Array(w * h * 4);
  const put = (x: number, y: number, r: number, g: number, b: number, al: number) => {
    if (x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = al;
  };
  const pal: number[][] = [];
  if (tlut) {
    for (let i = 0; i < tlut.count; i++) pal.push(paletteColor(d.getUint16(tlut.dataOff + i * 2), tlut.format));
  }
  const none = [0, 0, 0, 0];
  const bw = [8, 8, 8, 4, 4, 4, 4, 0, 8, 8, 4, 0, 0, 0, 8][f];
  const bh = [8, 4, 4, 4, 4, 4, 4, 0, 8, 4, 4, 0, 0, 0, 8][f];
  if (!bw) throw new Error(`texture format ${f} is not a GX format`);
  let o = img.dataOff;
  const limit = d.byteLength;
  for (let by = 0; by < h; by += bh) {
    for (let bx = 0; bx < w; bx += bw) {
      if (o >= limit) return out;
      if (f === 14) {
        // CMPR: 2x2 DXT1 sub-blocks
        for (let s = 0; s < 4; s++) {
          const sx = bx + (s & 1) * 4, sy = by + (s >> 1) * 4;
          const c0 = d.getUint16(o), c1 = d.getUint16(o + 2);
          const cs = [rgb565(c0), rgb565(c1)];
          if (c0 > c1) {
            cs.push(cs[0].map((v, i) => (2 * v + cs[1][i]) / 3 | 0));
            cs.push(cs[0].map((v, i) => (v + 2 * cs[1][i]) / 3 | 0));
          } else {
            cs.push(cs[0].map((v, i) => (v + cs[1][i]) / 2 | 0));
            cs.push([0, 0, 0, 0]);
          }
          for (let y = 0; y < 4; y++) {
            const row = d.getUint8(o + 4 + y);
            for (let x = 0; x < 4; x++) {
              const c = cs[(row >> (6 - x * 2)) & 3];
              put(sx + x, sy + y, c[0], c[1], c[2], c.length > 3 ? c[3] : 255);
            }
          }
          o += 8;
        }
        continue;
      }
      if (f === 6) {
        // RGBA8: AR plane then GB plane
        for (let i = 0; i < 16; i++) {
          const x = bx + (i & 3), y = by + (i >> 2);
          put(x, y, d.getUint8(o + i * 2 + 1), d.getUint8(o + 32 + i * 2), d.getUint8(o + 32 + i * 2 + 1), d.getUint8(o + i * 2));
        }
        o += 64;
        continue;
      }
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const X = bx + x, Y = by + y;
          switch (f) {
            case 0: { // I4
              const b = d.getUint8(o + ((y * bw + x) >> 1));
              const v = ((x & 1) ? b & 15 : b >> 4) * 17;
              put(X, Y, v, v, v, v);
              break;
            }
            case 1: { const v = d.getUint8(o + y * bw + x); put(X, Y, v, v, v, v); break; }
            case 2: { // IA4
              const b = d.getUint8(o + y * bw + x);
              const i4 = (b & 15) * 17;
              put(X, Y, i4, i4, i4, (b >> 4) * 17);
              break;
            }
            case 3: { // IA8
              const at = o + (y * bw + x) * 2;
              const i8 = d.getUint8(at + 1);
              put(X, Y, i8, i8, i8, d.getUint8(at));
              break;
            }
            case 4: { const c = rgb565(d.getUint16(o + (y * bw + x) * 2)); put(X, Y, c[0], c[1], c[2], 255); break; }
            case 5: { const c = rgb5a3(d.getUint16(o + (y * bw + x) * 2)); put(X, Y, c[0], c[1], c[2], c[3]); break; }
            case 8: { // CI4
              const b = d.getUint8(o + ((y * bw + x) >> 1));
              const c = pal[(x & 1) ? b & 15 : b >> 4] ?? none;
              put(X, Y, c[0], c[1], c[2], c[3]);
              break;
            }
            case 9: { const c = pal[d.getUint8(o + y * bw + x)] ?? none; put(X, Y, c[0], c[1], c[2], c[3]); break; }
            case 10: { const c = pal[d.getUint16(o + (y * bw + x) * 2) & 0x3fff] ?? none; put(X, Y, c[0], c[1], c[2], c[3]); break; }
          }
        }
      }
      o += 32;
    }
  }
  return out;
}

function rgb565(v: number): number[] {
  return [((v >> 11) & 31) * 255 / 31 | 0, ((v >> 5) & 63) * 255 / 63 | 0, (v & 31) * 255 / 31 | 0, 255];
}

function rgb5a3(v: number): number[] {
  if (v & 0x8000) return [((v >> 10) & 31) * 255 / 31 | 0, ((v >> 5) & 31) * 255 / 31 | 0, (v & 31) * 255 / 31 | 0, 255];
  return [((v >> 8) & 15) * 17, ((v >> 4) & 15) * 17, (v & 15) * 17, ((v >> 12) & 7) * 255 / 7 | 0];
}

function paletteColor(v: number, format: number): number[] {
  if (format === 0) return [v & 0xff, v & 0xff, v & 0xff, v >> 8]; // IA8
  if (format === 1) return rgb565(v);
  return rgb5a3(v);
}

