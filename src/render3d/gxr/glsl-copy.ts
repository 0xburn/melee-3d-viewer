/* GX renderer: the other passes as fragment shaders: the EFB copy into texture memory (spec 12), the clear after a copy (12.5) and the
 * picture (the EFB as 8-bit colors). The EFB is a pair of integers per pixel: the color word of the pixel format and the depth. */
import { MEM_ROW } from "./glsl-pixel";

export const COPY_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uEfb;
uniform int uDest, uStride, uFmt, uBlocksX, uBlocksY, uKw, uKh, uBytes, uHalf, uX0, uY0, uPixFmt;
out uint o;

int w6(int v) { return (v << 2) | (v >> 4); }

ivec4 pixel(int p) {
  if (p < 0 || p >= 640 * 528) return ivec4(0);
  uint w = texelFetch(uEfb, ivec2(p % 640, p / 640), 0).r;
  if (uPixFmt == 1) return ivec4(w6(int((w >> 18) & 63u)), w6(int((w >> 12) & 63u)), w6(int((w >> 6) & 63u)), w6(int(w & 63u)));
  return ivec4(int((w >> 16) & 255u), int((w >> 8) & 255u), int(w & 255u), 255);
}

// texel (X, Y) of the output: r, g, b, a
ivec4 texel(int X, int Y) {
  int k = uHalf == 1 ? 2 : 1;
  int p = (uY0 + Y * k) * 640 + uX0 + X * k;
  if (uHalf == 0) return pixel(p);
  ivec4 s = pixel(p) + pixel(p + 1) + pixel(p + 640) + pixel(p + 641);
  if (uPixFmt == 1) return min(ivec4(255), s + (s >> 6));
  return s >> 2;
}

int lum(ivec4 c) { return (4096 + 66 * c.r + 129 * c.g + 25 * c.b) >> 8; }

// the byte of one texel for the 8-bit and the 16-bit (hi / lo) formats
int texByte(int fmt, ivec4 c, int part) {
  if (fmt == 1) return lum(c);
  if (fmt == 2) return 0xf0 | (lum(c) >> 4);
  if (fmt == 3) return part == 0 ? 255 : lum(c);
  if (fmt == 4) { int v = ((c.r << 8) & 0xf800) | ((c.g << 3) & 0x07e0) | ((c.b >> 3) & 0x001e); return part == 0 ? v >> 8 : v & 255; }
  if (fmt == 5) { int v = 0x8000 | ((c.r << 7) & 0x7c00) | ((c.g << 2) & 0x03e0) | ((c.b >> 3) & 0x001e); return part == 0 ? v >> 8 : v & 255; }
  if (fmt == 8) return 0xf0 | (c.r >> 4);
  if (fmt == 9) return part == 0 ? 255 : c.r;
  if (fmt == 10) return 255;
  if (fmt == 11) return c.r;
  if (fmt == 12) return c.g;
  if (fmt == 13) return c.b;
  if (fmt == 14) return part == 0 ? c.g : c.r;
  return part == 0 ? c.b : c.g;
}

void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  int a = fc.y * ${MEM_ROW} + fc.x;
  int rel = a - uDest;
  if (rel < 0) discard;
  int r = uStride > 0 ? rel / uStride : 0;
  int inRow = rel - r * uStride;
  if (r >= uBlocksY || inRow >= uBlocksX * uBytes) discard;
  int blk = inRow / uBytes;
  int off = inRow - blk * uBytes;
  int bw = 1 << uKw, bh = 1 << uKh;
  int fmt = uFmt;
  int res = 0;
  if (fmt == 6) {
    int q = (off & 31) >> 1;
    ivec4 c = texel(blk * bw + (q & 3), r * bh + (q >> 2));
    int hiPart = off >= 32 ? 1 : 0;
    int odd = off & 1;
    res = hiPart == 0 ? (odd == 0 ? c.a : c.r) : (odd == 0 ? c.g : c.b);
  } else if (fmt == 0 || fmt == 7) {
    int j = off >> 2, i = (off & 3) * 2;
    ivec4 ca = texel(blk * bw + i, r * bh + j), cb = texel(blk * bw + i + 1, r * bh + j);
    int ya = fmt == 0 ? lum(ca) : ca.r, yb = fmt == 0 ? lum(cb) : cb.r;
    res = (ya & 0xf0) | (yb >> 4);
  } else if (bw == 4) {
    int q = off >> 1;
    ivec4 c = texel(blk * bw + (q & 3), r * bh + (q >> 2));
    res = texByte(fmt, c, off & 1);
  } else {
    int j = off >> 3, i = off & 7;
    ivec4 c = texel(blk * bw + i, r * bh + j);
    res = texByte(fmt, c, 0);
  }
  o = uint(res & 255);
}
`;

export const CLEAR_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uEfb;
uniform ivec4 uRect;      // x0, y0, x1, y1 inclusive
uniform uint uColor;      // the color word to write if color update
uniform uint uAlpha6;     // 6-bit alpha (RGBA6)
uniform uint uDepth;
uniform int uColorUpd, uAlphaUpd, uZUpd, uPixFmt;
out uvec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uvec2 e = texelFetch(uEfb, p, 0).rg;
  if (p.x >= uRect.x && p.x <= uRect.z && p.y >= uRect.y && p.y <= uRect.w) {
    if (uColorUpd == 1) {
      if (uPixFmt == 1) e.x = (uAlphaUpd == 1 ? uAlpha6 : (e.x & 63u)) | (uColor & ~63u);
      else e.x = uColor;
    } else if (uAlphaUpd == 1 && uPixFmt == 1) e.x = (e.x & ~63u) | uAlpha6;
    if (uZUpd == 1) e.y = uDepth;
  }
  o = uvec4(e, 0u, 0u);
}
`;

export const PICTURE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uEfb;
uniform int uPixFmt;
out vec4 o;
int w6(int v) { return (v << 2) | (v >> 4); }
void main() {
  uint w = texelFetch(uEfb, ivec2(gl_FragCoord.xy), 0).r;
  ivec4 c;
  if (uPixFmt == 1) c = ivec4(w6(int((w >> 18) & 63u)), w6(int((w >> 12) & 63u)), w6(int((w >> 6) & 63u)), w6(int(w & 63u)));
  else c = ivec4(int((w >> 16) & 255u), int((w >> 8) & 255u), int(w & 255u), 255);
  o = vec4(c) / 255.0;
}
`;
