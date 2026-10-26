/* GX renderer: the pixel stage as a fragment shader (GLSL ES 3.00).
 *
 * One pass draws a run of triangles into the EFB. Every EFB pixel is one fragment: it reads its own color and depth, then walks the
 * triangles that cover its 16 x 16 tile in draw order, and for each one that covers it runs the pixel pipeline of the raster spec
 * (sections 7.3 to 11): coverage, the planes, depth, texture unit, TEV, alpha test, fog, depth test, blend. Because a pixel walks its
 * triangles in order, blending and depth tests see exactly what the hardware order gives, and no read-modify-write between draws is
 * needed. The float parts use the integer float of glsl-float.ts.
 *
 * Data (all unsigned integer textures read with texelFetch):
 *  - uMem: bytes of main memory (4096 per row), then TMEM and the palettes (see MEM_*);
 *  - uData: words; a triangle is HEADER_WORDS words then its planes (3 words each: f0, dfdx, dfdy);
 *  - uTiles: (first, count) into uList for every tile; uList: word offsets of triangles in uData;
 *  - uStates: STATE_WORDS words per state: BP registers 0..255, the constant colors K0..K3 (words 256..263), the palette address of
 *    each of the 8 texture maps (264..271), the texgen projection flags (272), the viewport half width as float bits (273);
 *  - uEfb: (color word, depth) per pixel of the previous pass.
 */
import { SOFT_FLOAT_GLSL } from "./glsl-float";

export const MEM_TMEM = 0x1800000;
export const MEM_PAL = 0x1900000;
export const MEM_PAL_SIZE = 0x40000;
export const MEM_BYTES = MEM_PAL + MEM_PAL_SIZE;
export const MEM_ROW = 4096;
export const HEADER_WORDS = 20;
export const STATE_WORDS = 280;
export const TILE = 16;

/** the pixel shader; `indirect` adds the indirect texture unit (spec 10.5), compiled only for draws that use it */
export function pixelShader(opts: { indirect?: boolean } = {}): string {
  return /* glsl */ `#version 300 es
${opts.indirect ? "#define INDIRECT 1" : ""}
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D uMem;
uniform usampler2D uData;
uniform usampler2D uTiles;
uniform usampler2D uList;
uniform usampler2D uStates;
uniform usampler2D uEfb;
uniform int uTilesX;
out uvec4 o;

#define TMEM_BASE ${MEM_TMEM}u
#define HEADER_WORDS ${HEADER_WORDS}u
#define STATE_WORDS ${STATE_WORDS}u
#define NO_PAL 0xffffffffu

${SOFT_FLOAT_GLSL}

uint wd(usampler2D t, uint i) { return texelFetch(t, ivec2(int(i & 4095u), int(i >> 12)), 0).r; }
uint mbyte(uint a) { return texelFetch(uMem, ivec2(int(a & 4095u), int(a >> 12)), 0).r; }
uint bf(uint v, int s, int n) { return (v >> uint(s)) & ((1u << uint(n)) - 1u); }
int bfi(uint v, int s, int n) { return int(bf(v, s, n)); }
int sx11(uint v) { return int(v << 21) >> 21; }
int idiv(int a, int b) { int q = abs(a) / b; return a < 0 ? -q : q; }

uint sbase;
uint S(uint k) { return wd(uStates, sbase + k); }

// ---------------------------------------------------------------------------------------------------------------------
// texture unit (spec 9)

struct MapI {
  uint fmt; int W; int H; int ws; int wt; uint pf; bool tmem; uint base; uint l1; uint l2; uint pal; uint mode0; uint mode1;
};

MapI loadMap(uint m) {
  bool hi = m >= 4u;
  uint k = m & 3u;
  uint img0 = S((hi ? 0xa8u : 0x88u) + k), img1 = S((hi ? 0xacu : 0x8cu) + k), img2 = S((hi ? 0xb0u : 0x90u) + k);
  uint img3 = S((hi ? 0xb4u : 0x94u) + k), tl = S((hi ? 0xb8u : 0x98u) + k);
  MapI mp;
  mp.fmt = bf(img0, 20, 4);
  mp.W = bfi(img0, 0, 10);
  mp.H = bfi(img0, 10, 10);
  uint m0 = S((hi ? 0xa0u : 0x80u) + k);
  mp.mode0 = m0;
  mp.mode1 = S((hi ? 0xa4u : 0x84u) + k);
  mp.ws = bfi(m0, 0, 2);
  mp.wt = bfi(m0, 2, 2);
  mp.pf = bf(tl, 10, 2);
  mp.tmem = bf(img1, 21, 1) == 1u;
  mp.base = (img3 & 0xffffffu) * 32u;
  mp.l1 = bf(img1, 0, 15) * 32u;
  mp.l2 = bf(img2, 0, 15) * 32u;
  mp.pal = S(264u + m);
  return mp;
}

// address in uMem of byte i of the image (TMEM images live in the TMEM area; an RGBA8 image keeps its green/blue halves in the other bank)
uint tAddr(MapI mp, uint i) {
  if (mp.tmem) {
    if (mp.fmt == 6u) {
      uint blk = i >> 6, r = i & 63u;
      return TMEM_BASE + ((r < 32u ? mp.l1 + blk * 32u + r : mp.l2 + blk * 32u + r - 32u) & 0xfffffu);
    }
    return TMEM_BASE + ((mp.l1 + i) & 0xfffffu);
  }
  return (mp.base + i) & 0x1ffffffu;
}
uint tb(MapI mp, uint i) { return mbyte(tAddr(mp, i)); }

int w3(int v) { return (v << 5) | (v << 2) | (v >> 1); }
int w4(int v) { return v * 17; }
int w5(int v) { return (v << 3) | (v >> 2); }
int w6(int v) { return (v << 2) | (v >> 4); }

ivec4 rgb5a3(uint v) {
  if ((v & 0x8000u) != 0u) return ivec4(w5(bfi(v, 10, 5)), w5(bfi(v, 5, 5)), w5(bfi(v, 0, 5)), 255);
  return ivec4(w4(bfi(v, 8, 4)), w4(bfi(v, 4, 4)), w4(bfi(v, 0, 4)), w3(bfi(v, 12, 3)));
}

ivec4 palColor(uint v, uint pf) {
  if (pf == 0u) { int i = int(v & 255u); return ivec4(i, i, i, int(v >> 8)); }
  if (pf == 1u) return ivec4(w5(bfi(v, 11, 5)), w6(bfi(v, 5, 6)), w5(bfi(v, 0, 5)), 255);
  return rgb5a3(v);
}

void finfo(uint fmt, out int kw, out int kh, out uint bytes) {
  bytes = 32u;
  if (fmt == 0u || fmt == 8u || fmt == 14u) { kw = 3; kh = 3; }
  else if (fmt == 1u || fmt == 2u || fmt == 9u) { kw = 3; kh = 2; }
  else if (fmt == 6u) { kw = 2; kh = 2; bytes = 64u; }
  else { kw = 2; kh = 2; }
}

// half bytes per texel, for the mip offsets (spec 9.3)
int nibblesOf(uint fmt) {
  if (fmt == 0u || fmt == 8u || fmt == 14u) return 1;
  if (fmt == 1u || fmt == 2u || fmt == 9u) return 2;
  if (fmt == 6u) return 8;
  return 4;
}

// one texel of a level (wrapped coordinates s, t), spec 9.2. Every format reads at most five bytes through the same five reads.
ivec4 fetchTexel(MapI mp, uint off, int W, int s, int t) {
  int kw, kh; uint bytes;
  finfo(mp.fmt, kw, kh, bytes);
  int bpr = (W >> kw) + 1;
  int blk = (t >> kh) * bpr + (s >> kw);
  uint base = off + uint(blk) * bytes;
  int tx = s & ((1 << kw) - 1), ty = t & ((1 << kh) - 1);
  uint fmt = mp.fmt;
  uint a0 = base, d2 = 2u, a4 = 0u;
  if (fmt == 0u || fmt == 8u) a0 = base + uint((ty * 8 + tx) >> 1);
  else if (fmt == 1u || fmt == 9u || fmt == 2u) a0 = base + uint(ty * 8 + tx);
  else if (fmt == 6u) { a0 = base + uint((ty * 4 + tx) * 2); d2 = 32u; }
  else if (fmt == 14u) { a0 = base + uint(((ty >> 2) << 1) + (tx >> 2)) * 8u; a4 = a0 + 4u + uint(ty & 3); }
  else a0 = base + uint((ty * 4 + tx) * 2);
  uint b0 = tb(mp, a0), b1 = tb(mp, a0 + 1u), b2 = 0u, b3 = 0u, b4 = 0u;
  if (fmt == 6u || fmt == 14u) { b2 = tb(mp, a0 + d2); b3 = tb(mp, a0 + d2 + 1u); }
  if (fmt == 14u) b4 = tb(mp, a4);
  uint v16 = (b0 << 8) | b1;
  uint pidx = 0u;
  bool indexed = false;
  ivec4 r = ivec4(0);
  if (fmt == 0u) { int v = w4((tx & 1) == 1 ? int(b0 & 15u) : int(b0 >> 4)); r = ivec4(v); }
  else if (fmt == 8u) { pidx = (tx & 1) == 1 ? (b0 & 15u) : (b0 >> 4); indexed = true; }
  else if (fmt == 1u) r = ivec4(int(b0));
  else if (fmt == 9u) { pidx = b0; indexed = true; }
  else if (fmt == 2u) { int i = w4(int(b0 & 15u)); r = ivec4(i, i, i, w4(int(b0 >> 4))); }
  else if (fmt == 3u) { int i = int(b1); r = ivec4(i, i, i, int(b0)); }
  else if (fmt == 4u) r = ivec4(w5(bfi(v16, 11, 5)), w6(bfi(v16, 5, 6)), w5(bfi(v16, 0, 5)), 255);
  else if (fmt == 5u) r = rgb5a3(v16);
  else if (fmt == 10u) { pidx = v16 & 0x3fffu; indexed = true; }
  else if (fmt == 6u) r = ivec4(int(b1), int(b2), int(b3), int(b0));
  else if (fmt == 14u) {
    uint c1 = v16, c2 = (b2 << 8) | b3;
    int sel = int((b4 >> uint(6 - 2 * (tx & 3))) & 3u);
    ivec3 a = ivec3(w5(bfi(c1, 11, 5)), w6(bfi(c1, 5, 6)), w5(bfi(c1, 0, 5)));
    ivec3 b = ivec3(w5(bfi(c2, 11, 5)), w6(bfi(c2, 5, 6)), w5(bfi(c2, 0, 5)));
    if (sel == 0) r = ivec4(a, 255);
    else if (sel == 1) r = ivec4(b, 255);
    else if (c1 > c2) {
      ivec3 d = b - a;
      ivec3 th = ivec3(0);
      for (int c = 0; c < 3; c++) { uint du = uint(d[c]); th[c] = int((du >> 1) - (du >> 3)); }
      r = sel == 2 ? ivec4((a + th) & 255, 255) : ivec4((b - th) & 255, 255);
    } else r = ivec4((a + b + 1) >> 1, sel == 2 ? 255 : 0);
  }
  if (indexed) {
    uint pe = 0u;
    if (mp.pal != NO_PAL) pe = (mbyte(mp.pal + pidx * 2u) << 8) | mbyte(mp.pal + pidx * 2u + 1u);
    r = palColor(pe, mp.pf);
  }
  return r;
}

int wrapC(int c, int Sz, int mode) {
  if (mode == 0) return min(max(c, 0), Sz);
  int n = Sz + 1;
  if (mode == 1) { int q = idiv(c, n); int r = c - q * n; return r < 0 ? Sz + r : r; }
  int q = idiv(c, n);
  int r = abs(c - q * n);
  return (q & 1) != 0 ? Sz - r : r;
}

uint levelOffset(uint fmt, int W, int H, int L) {
  int kw, kh; uint bytes;
  finfo(fmt, kw, kh, bytes);
  int bw = 1 << kw, bh = 1 << kh;
  int nib = nibblesOf(fmt);
  uint off = 0u;
  int w = W + 1, h = H + 1;
  for (int l = 1; l <= L; l++) {
    off += uint((max(w, bw) * max(h, bh) * nib) >> 1);
    w >>= 1; h >>= 1;
  }
  return off;
}

// the unit's sample (spec 9.3). Loops over the mip levels and the filter taps have run-time bounds so that the compiler keeps one
// copy of the texel fetch.
ivec4 sampleMap(MapI mp, int s, int t, int lod, bool linear) {
  uint mf = bf(mp.mode0, 5, 3);
  int fract = lod & 15;
  int mip = 0;
  bool mixl = false;
  if (lod > 0 && (mf & 3u) != 0u) {
    mip = lod >> 4;
    mixl = fract != 0 && (mf & 2u) != 0u;
    mip += (fract >> 3) & int(mf & 1u);
  }
  int nlev = mixl ? 2 : 1;
  int ntaps = linear ? 4 : 1;
  ivec4 acc0 = ivec4(0), acc1 = ivec4(0);
  for (int li = 0; li < uK.w; li++) {
    if (li >= nlev) break;
    int L = mip + li;
    uint off = L > 0 ? levelOffset(mp.fmt, mp.W, mp.H, L) : 0u;
    int W = mp.W >> L, H = mp.H >> L;
    int sl = s >> L, tl = t >> L;
    int s0 = linear ? (sl - 64) >> 7 : sl >> 7, t0 = linear ? (tl - 64) >> 7 : tl >> 7;
    int fs = (sl - 64) & 127, ft = (tl - 64) & 127;
    ivec4 sum = ivec4(0);
    for (int k = 0; k < uK.x; k++) {
      if (k >= ntaps) break;
      int dx = k & 1, dy = k >> 1;
      int wgt = linear ? ((dx == 1 ? fs : 128 - fs) * (dy == 1 ? ft : 128 - ft)) : 1;
      sum += fetchTexel(mp, off, W, wrapC(s0 + dx, W, mp.ws), wrapC(t0 + dy, H, mp.wt)) * wgt;
    }
    if (linear) sum = sum >> 14;
    if (li == 0) acc0 = sum; else acc1 = sum;
  }
  return mixl ? (acc0 * (16 - fract) + acc1 * fract) >> 4 : acc0;
}

// ---------------------------------------------------------------------------------------------------------------------
// planes and texture coordinates (spec 7.4, 8.3, 8.4)

uint gTri;      // word offset of the current triangle in uData
uint gOx, gOy;  // float bits
int gXi, gYi;

uint planeAt(uint k, uint dx, uint dy) {
  uint b = gTri + HEADER_WORDS + k * 3u;
  return f_add(f_add(wd(uData, b), f_mul(wd(uData, b + 1u), dx)), f_mul(wd(uData, b + 2u), dy));
}

// s and t of generator n at pixel (px, py)
void genST(uint n, int px, int py, out uint s, out uint t) {
  uint dx = f_add(gOx, f_from_int(px - gXi)), dy = f_add(gOy, f_from_int(py - gYi));
  uint iw = f_div(F_ONE, planeAt(0u, dx, dy));
  uint proj = iw;
  if (((S(272u) >> n) & 1u) == 1u) {
    uint q = f_mul(planeAt(10u + n * 3u + 2u, dx, dy), iw);
    proj = f_iszero(q) ? iw : f_div(iw, q);
  }
  s = f_mul(planeAt(10u + n * 3u, dx, dy), proj);
  t = f_mul(planeAt(10u + n * 3u + 1u, dx, dy), proj);
}

uint f_max(uint a, uint b) { return f_lt(a, b) ? b : a; }

int log2fix(uint d) { return int(((d & 0x7f800000u) >> 19) + ((d & 0x007fffffu) >> 19)) - 2032; }

// the texture stage's coordinates: the pixel's s and t of generator n (7 fractional bits) and the level of detail map mp gives (8.3, 8.4)
void stageCoords(MapI mp, uint n, int x, int y, out int S24, out int T24, out int lod, out bool linear) {
  int bx = x & ~1, by = y & ~1;
  uint sv[4], tv[4];
  for (int j = 0; j < uK.x; j++) genST(n, bx + (j & 1), by + (j >> 1), sv[j], tv[j]);
  uint ds, dt;
  if (bf(mp.mode0, 8, 1) == 1u) {
    ds = f_abs(f_sub(sv[0], sv[3])); dt = f_abs(f_sub(tv[0], tv[3]));
  } else {
    ds = f_max(f_abs(f_sub(sv[0], sv[1])), f_abs(f_sub(sv[0], sv[2])));
    dt = f_max(f_abs(f_sub(tv[0], tv[1])), f_abs(f_sub(tv[0], tv[2])));
  }
  uint d = f_max(ds, dt);
  int bias = int(bf(mp.mode0, 9, 8) << 24) >> 24;
  lod = log2fix(d) + (bias >> 1);
  uint mf = bf(mp.mode0, 5, 3);
  linear = (lod > 0 && (mf & 4u) != 0u) || (lod <= 0 && bf(mp.mode0, 4, 1) == 1u);
  int maxl = bfi(mp.mode1, 8, 8), minl = bfi(mp.mode1, 0, 8);
  if (lod > maxl) lod = maxl; else if (lod < minl) lod = minl;
  int me = (x & 1) + ((y & 1) << 1);
  S24 = (f_trunc(f_mul(sv[me], 0x43000000u)) << 8) >> 8;
  T24 = (f_trunc(f_mul(tv[me], 0x43000000u)) << 8) >> 8;
}

#ifdef INDIRECT
// the indirect unit for one TEV stage (spec 10.5): the stage's coordinates (S, T) become (oS, oT); bump is its alpha bump
void indirectStage(uint ind, int x, int y, int S, int T, int prevS, int prevT, out int oS, out int oT, out int bump) {
  int bt = bfi(ind, 0, 2), fmt = bfi(ind, 2, 2), biasBits = bfi(ind, 4, 3), bs = bfi(ind, 7, 2), mid = bfi(ind, 9, 4);
  int sw = bfi(ind, 13, 3), tw = bfi(ind, 16, 3);
  uint iref = S(0x27u);
  int imap = bfi(iref, 6 * bt, 3), icoord = bfi(iref, 6 * bt + 3, 3);
  uint ssw = S(0x25u + uint(bt >> 1));
  int ss = bfi(ssw, (bt & 1) * 8, 4), ts = bfi(ssw, (bt & 1) * 8 + 4, 4);
  int dS, dT, lod, IS, IT, dl;
  bool linear, dlin;
  // the level of detail uses the low two bits of the map and coordinate numbers (a quirk of the reference)
  stageCoords(loadMap(uint(imap & 3)), uint(icoord & 3), x, y, dS, dT, lod, linear);
  MapI im = loadMap(uint(imap));
  stageCoords(im, uint(icoord), x, y, IS, IT, dl, dlin);
  ivec4 tx = sampleMap(im, IS >> ss, IT >> ts, lod, linear);
  ivec3 i = ivec3(tx.a, tx.b, tx.g);
  int mask = fmt == 1 ? 0xe0 : (fmt == 2 ? 0xf0 : 0xf8);
  bump = bs == 0 ? 0 : (i[bs - 1] & mask);
  int vmask = fmt == 0 ? 0xff : (fmt == 1 ? 0x1f : (fmt == 2 ? 0x0f : 0x07));
  ivec3 v = i & vmask;
  for (int k = 0; k < 3; k++) if (((biasBits >> k) & 1) == 1) v[k] += fmt == 0 ? -128 : 1;
  int o0 = 0, o1 = 0;
  int m = mid & 3;
  if (m != 0) {
    uint A = S(0x06u + 3u * uint(m - 1)), B = S(0x07u + 3u * uint(m - 1)), C = S(0x08u + 3u * uint(m - 1));
    int ma = sx11(A & 0x7ffu), mb = sx11((A >> 11) & 0x7ffu), mc = sx11(B & 0x7ffu), md = sx11((B >> 11) & 0x7ffu), me = sx11(C & 0x7ffu), mf = sx11((C >> 11) & 0x7ffu);
    int ex = bfi(A, 22, 2) | (bfi(B, 22, 2) << 2) | (bfi(C, 22, 2) << 4);
    int shift = 17 - ex;
    int type = mid & 12;
    if (type == 0) { o0 = (ma * v.x + mc * v.y + me * v.z) >> 3; o1 = (mb * v.x + md * v.y + mf * v.z) >> 3; }
    else if (type == 4) { o0 = idiv(S * v.x, 256); o1 = idiv(T * v.x, 256); }
    else if (type == 8) { o0 = idiv(S * v.y, 256); o1 = idiv(T * v.y, 256); }
    if (shift >= 0) { o0 >>= shift; o1 >>= shift; } else { o0 <<= -shift; o1 <<= -shift; }
  }
  int ws = sw == 0 ? S : (sw >= 6 ? 0 : (S & (((256 >> (sw - 1)) << 7) - 1)));
  int wt = tw == 0 ? T : (tw >= 6 ? 0 : (T & (((256 >> (tw - 1)) << 7) - 1)));
  int rs = ws + o0, rt = wt + o1;
  if (bf(ind, 20, 1) == 1u) { rs += prevS; rt += prevT; }
  oS = (rs << 8) >> 8;
  oT = (rt << 8) >> 8;
}
#endif

// ---------------------------------------------------------------------------------------------------------------------
// TEV (spec 10)

int gRegs[16];
int gKk[16];
int gTex[4];
int gRas[4];
int gRasCh[8];
int gLastTex[4];

int clampTev(int r, int clampBit) {
  r = (r << 16) >> 16;
  if (clampBit == 1) return r < 0 ? 0 : (r > 255 ? 255 : r);
  return r < -1024 ? -1024 : (r > 1023 ? 1023 : r);
}

int tevRegular(bool isAlpha, int a, int b, int c, int d, int bias, int op, int scale, int clampBit) {
  int ls = scale == 1 ? 1 : (scale == 2 ? 2 : 0), rs = scale == 3 ? 1 : 0;
  int B = bias == 1 ? 128 : (bias == 2 ? -128 : 0);
  int cw = c + (c >> 7);
  int t = a * (256 - cw) + b * cw;
  t = t << ls;
  if (!isAlpha) {
    t = t + (scale == 3 ? 0 : (op == 1 ? 127 : 128));
    t = t >> 8;
    t = op == 1 ? -t : t;
  } else {
    t = t + (scale != 3 ? 0 : (op == 1 ? 127 : 128));
    t = op == 1 ? ((-t) >> 8) : (t >> 8);
  }
  int r = ((d + B) << ls) + t;
  r = r >> rs;
  return clampTev(r, clampBit);
}

bool compareCond(int mode, ivec3 A, ivec3 B, int k) {
  if (mode == 0) return A.x > B.x;
  if (mode == 1) return A.x == B.x;
  if (mode == 2) return ((A.y << 8) | A.x) > ((B.y << 8) | B.x);
  if (mode == 3) return ((A.y << 8) | A.x) == ((B.y << 8) | B.x);
  if (mode == 4) return ((A.z << 16) | (A.y << 8) | A.x) > ((B.z << 16) | (B.y << 8) | B.x);
  if (mode == 5) return ((A.z << 16) | (A.y << 8) | A.x) == ((B.z << 16) | (B.y << 8) | B.x);
  if (mode == 6) return A[k] > B[k];
  return A[k] == B[k];
}

int ksel8(int i) { return i == 0 ? 255 : (i == 1 ? 223 : (i == 2 ? 191 : (i == 3 ? 159 : (i == 4 ? 128 : (i == 5 ? 96 : (i == 6 ? 64 : 32)))))); }

ivec3 konstColor(int ks) {
  if (ks < 8) return ivec3(ksel8(ks));
  if (ks < 12) return ivec3(0);
  if (ks < 16) { int k = (ks - 12) * 4; return ivec3(gKk[k], gKk[k + 1], gKk[k + 2]); }
  int comp = (ks - 16) >> 2, k = (ks & 3) * 4;
  return ivec3(gKk[k + comp]);
}

int konstAlpha(int ks) {
  if (ks < 8) return ksel8(ks);
  if (ks < 16) return 0;
  int comp = (ks - 16) >> 2, k = (ks & 3) * 4;
  return gKk[k + comp];
}

ivec3 csel(int k) {
  switch (k) {
    case 0: return ivec3(gRegs[0], gRegs[1], gRegs[2]);
    case 1: return ivec3(gRegs[3]);
    case 2: return ivec3(gRegs[4], gRegs[5], gRegs[6]);
    case 3: return ivec3(gRegs[7]);
    case 4: return ivec3(gRegs[8], gRegs[9], gRegs[10]);
    case 5: return ivec3(gRegs[11]);
    case 6: return ivec3(gRegs[12], gRegs[13], gRegs[14]);
    case 7: return ivec3(gRegs[15]);
    case 8: return ivec3(gTex[0], gTex[1], gTex[2]);
    case 9: return ivec3(gTex[3]);
    case 10: return ivec3(gRas[0], gRas[1], gRas[2]);
    case 11: return ivec3(gRas[3]);
    case 12: return ivec3(255);
    case 13: return ivec3(128);
  }
  return ivec3(0);
}

int asel(int k, int kas) {
  switch (k) {
    case 0: return gRegs[3];
    case 1: return gRegs[7];
    case 2: return gRegs[11];
    case 3: return gRegs[15];
    case 4: return gTex[3];
    case 5: return gRas[3];
    case 6: return konstAlpha(kas);
  }
  return 0;
}

void swz(uint t, int v[4], out int o4[4]) {
  uint w0 = S(0xf6u + 2u * t), w1 = S(0xf7u + 2u * t);
  o4[0] = v[bfi(w0, 0, 2)]; o4[1] = v[bfi(w0, 2, 2)]; o4[2] = v[bfi(w1, 0, 2)]; o4[3] = v[bfi(w1, 2, 2)];
}

void loadColorRegs() {
  for (uint r = 0u; r < 4u; r++) {
    uint ra = S(0xe0u + 2u * r), bg = S(0xe1u + 2u * r);
    gRegs[int(r) * 4] = sx11(ra & 0x7ffu); gRegs[int(r) * 4 + 3] = sx11((ra >> 12) & 0x7ffu);
    gRegs[int(r) * 4 + 2] = sx11(bg & 0x7ffu); gRegs[int(r) * 4 + 1] = sx11((bg >> 12) & 0x7ffu);
    uint ka = S(256u + 2u * r), kb = S(257u + 2u * r);
    gKk[int(r) * 4] = sx11(ka & 0x7ffu); gKk[int(r) * 4 + 3] = sx11((ka >> 12) & 0x7ffu);
    gKk[int(r) * 4 + 2] = sx11(kb & 0x7ffu); gKk[int(r) * 4 + 1] = sx11((kb >> 12) & 0x7ffu);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// fog, blend

uint fogFloat(uint w) {
  return (((w >> 19) & 1u) << 31) | (((w >> 11) & 255u) << 23) | ((w & 0x7ffu) << 12);
}

void fogPixel(uint fsel, int z, int x, inout ivec4 c) {
  uint A = fogFloat(S(0xeeu)), C = fogFloat(S(0xf1u) & 0xfffffu);
  uint Bm = S(0xefu);
  int Bs = int(S(0xf0u) & 31u);
  uint ze;
  if (bf(S(0xf1u), 20, 1) == 0u) ze = f_div(f_mul(A, 0x4b7fffffu), f_from_int(int(Bm) - (z >> Bs)));
  else ze = f_mul(A, f_div(f_from_int(z), 0x4b7fffffu));
  ze = f_sub(ze, C);
  uint fog = f_lt(ze, 0u) ? 0u : (f_gt(ze, F_ONE) ? F_ONE : ze);
  int fi = f_trunc(f_mul(fog, 0x43800000u));
  uint fc = S(0xf2u);
  ivec3 fr = ivec3(int((fc >> 16) & 255u), int((fc >> 8) & 255u), int(fc & 255u));
  c.rgb = (c.rgb * (256 - fi) + fr * fi) >> 8;
}

bool cmpOp(uint code, int a, int b) {
  switch (code) {
    case 0u: return false;
    case 1u: return a < b;
    case 2u: return a == b;
    case 3u: return a <= b;
    case 4u: return a > b;
    case 5u: return a != b;
    case 6u: return a >= b;
  }
  return true;
}

int blendFactor(uint code, int self, ivec4 s, ivec4 d, bool isDst) {
  switch (code) {
    case 0u: return 0;
    case 1u: return 255;
    case 2u: return isDst ? self : self;
    case 3u: return 255 - self;
    case 4u: return s.a;
    case 5u: return 255 - s.a;
    case 6u: return d.a;
  }
  return 255 - d.a;
}

ivec4 blendPixel(uint mode, uint dstAlpha, ivec4 s, ivec4 d) {
  ivec4 r;
  bool enable = (mode & 1u) == 1u, logic = ((mode >> 1) & 1u) == 1u, sub = ((mode >> 11) & 1u) == 1u;
  uint dfc = (mode >> 5) & 7u, sfc = (mode >> 8) & 7u, lop = (mode >> 12) & 15u;
  if (enable) {
    if (sub) r = max(ivec4(0), d - s);
    else {
      for (int k = 0; k < 4; k++) {
        int fs = blendFactor(sfc, d[k], s, d, false);
        int fd = blendFactor(dfc, s[k], s, d, true);
        fs += fs >> 7; fd += fd >> 7;
        r[k] = min(255, (s[k] * fs + d[k] * fd) >> 8);
      }
    }
  } else if (logic) {
    uint Sw = uint(s.a) | (uint(s.b) << 8) | (uint(s.g) << 16) | (uint(s.r) << 24);
    uint Dw = uint(d.a) | (uint(d.b) << 8) | (uint(d.g) << 16) | (uint(d.r) << 24);
    uint w;
    switch (lop) {
      case 0u: w = 0u; break;
      case 1u: w = Sw & Dw; break;
      case 2u: w = Sw & ~Dw; break;
      case 3u: w = Sw; break;
      case 4u: w = ~Sw & Dw; break;
      case 5u: w = Dw; break;
      case 6u: w = Sw ^ Dw; break;
      case 7u: w = Sw | Dw; break;
      case 8u: w = ~(Sw | Dw); break;
      case 9u: w = ~(Sw ^ Dw); break;
      case 10u: w = ~Dw; break;
      case 11u: w = Sw | ~Dw; break;
      case 12u: w = ~Sw; break;
      case 13u: w = ~Sw | Dw; break;
      case 14u: w = ~(Sw & Dw); break;
      default: w = 0xffffffffu;
    }
    r = ivec4(int(w >> 24), int((w >> 16) & 255u), int((w >> 8) & 255u), int(w & 255u));
  } else r = s;
  if (((dstAlpha >> 8) & 1u) == 1u) r.a = int(dstAlpha & 255u);
  return r;
}

ivec4 readColor(uint w, uint fmt) {
  if (fmt == 1u) {
    return ivec4(w6(bfi(w, 18, 6)), w6(bfi(w, 12, 6)), w6(bfi(w, 6, 6)), w6(bfi(w, 0, 6)));
  }
  return ivec4(int((w >> 16) & 255u), int((w >> 8) & 255u), int(w & 255u), 255);
}

uint writeColor(uint old, uint fmt, uint mode, ivec4 r) {
  bool colorUpd = ((mode >> 3) & 1u) == 1u, alphaUpd = ((mode >> 4) & 1u) == 1u;
  if (colorUpd) {
    if (fmt == 1u) {
      uint a6 = alphaUpd ? uint(r.a >> 2) : (old & 63u);
      return a6 | (uint(r.b >> 2) << 6) | (uint(r.g >> 2) << 12) | (uint(r.r >> 2) << 18);
    }
    return uint(r.b) | (uint(r.g) << 8) | (uint(r.r) << 16);
  }
  if (alphaUpd && fmt == 1u) return (old & ~63u) | uint(r.a >> 2);
  return old;
}

// ---------------------------------------------------------------------------------------------------------------------
// one pixel of one triangle (spec 8 to 11)

void shade(int x, int y, inout uint col, inout uint dep) {
  uint stIdx = wd(uData, gTri + 17u);
  sbase = stIdx * STATE_WORDS;
  uint b0 = S(0x00u);
  int nStages = bfi(b0, 10, 4) + 1;
  int numCols = bfi(b0, 4, 3);
  uint zmode = S(0x40u);
  bool zEnable = (zmode & 1u) == 1u, zUpdate = ((zmode >> 4) & 1u) == 1u;
  uint zFunc = (zmode >> 1) & 7u;
  uint b43 = S(0x43u);
  uint pixFmt = b43 & 7u;
  bool zEarly = ((b43 >> 6) & 1u) == 1u && zEnable;

  uint dx = f_add(gOx, f_from_int(x - gXi)), dy = f_add(gOy, f_from_int(y - gYi));
  uint zf = planeAt(1u, dx, dy);
  int z = f_trunc(f_gt(zf, 0x4b7fffffu) ? 0x4b7fffffu : (f_lt(zf, 0u) ? 0u : zf)) & 0xffffff;
  int stored = int(dep);
  uint newDep = dep;
  if (zEarly) {
    if (!cmpOp(zFunc, z, stored)) return;
    if (zUpdate) newDep = uint(z);
  }
  // raster colors
  for (int i = 0; i < 8; i++) gRasCh[i] = 0;
  for (int i = 0; i < numCols * 4; i++) {
    int tv = f_trunc(planeAt(uint(2 + i), dx, dy));
    int v16 = tv & 0xffff;
    gRasCh[i] = (v16 & ~(v16 >> 8)) & 0xff;
  }
  loadColorRegs();
  for (int i = 0; i < 4; i++) gLastTex[i] = 0;
  int prevS = 0, prevT = 0;
  for (int si = 0; si < nStages; si++) {
    uint ord = S(0x28u + uint(si >> 1)) >> ((si & 1) == 1 ? 12u : 0u);
    uint texmap = bf(ord, 0, 3), texcoord = bf(ord, 3, 3), rasSel = bf(ord, 7, 3);
    bool texEn = bf(ord, 6, 1) == 1u;
    uint cc = S(0xc0u + uint(2 * si)), ac = S(0xc1u + uint(2 * si));
    uint kw = S(0xf6u + uint(si >> 1));
    int kcs = ((si & 1) == 1) ? bfi(kw, 14, 5) : bfi(kw, 4, 5);
    int kas = ((si & 1) == 1) ? bfi(kw, 19, 5) : bfi(kw, 9, 5);
    uint rsw = bf(ac, 0, 2), tsw = bf(ac, 2, 2);
    int bump = 0;
#ifdef INDIRECT
    uint indWord = bfi(b0, 16, 3) > 0 ? S(0x10u + uint(si)) : 0u;
#endif
    if (texEn) {
      MapI mp = loadMap(texmap);
      int cS, cT, lod;
      bool lin;
      stageCoords(mp, texcoord, x, y, cS, cT, lod, lin);
#ifdef INDIRECT
      if (indWord != 0u) { int oS, oT; indirectStage(indWord, x, y, cS, cT, prevS, prevT, oS, oT, bump); cS = oS; cT = oT; }
#endif
      prevS = cS; prevT = cT;
      ivec4 tx = sampleMap(mp, cS, cT, lod, lin);
      int tv[4] = int[4](tx.r, tx.g, tx.b, tx.a);
      swz(tsw, tv, gTex);
      for (int i = 0; i < 4; i++) gLastTex[i] = gTex[i];
    }
#ifdef INDIRECT
    else if (indWord != 0u) { int oS, oT; indirectStage(indWord, x, y, 0, 0, prevS, prevT, oS, oT, bump); }
#endif
    for (int i = 0; i < 4; i++) gRas[i] = 0;
    if (rasSel == 0u || rasSel == 1u) {
      int rv[4] = int[4](gRasCh[int(rasSel) * 4], gRasCh[int(rasSel) * 4 + 1], gRasCh[int(rasSel) * 4 + 2], gRasCh[int(rasSel) * 4 + 3]);
      swz(rsw, rv, gRas);
    } else if (rasSel == 5u || rasSel == 6u) {
      int bv = rasSel == 5u ? bump : (bump | (bump >> 5));
      gRas[0] = bv; gRas[1] = bv; gRas[2] = bv; gRas[3] = bv;
    }
    ivec3 ca = csel(bfi(cc, 12, 4)), cb = csel(bfi(cc, 8, 4)), ccc = csel(bfi(cc, 4, 4)), cd = csel(bfi(cc, 0, 4));
    if (bfi(cc, 12, 4) == 14) ca = konstColor(kcs);
    if (bfi(cc, 8, 4) == 14) cb = konstColor(kcs);
    if (bfi(cc, 4, 4) == 14) ccc = konstColor(kcs);
    if (bfi(cc, 0, 4) == 14) cd = konstColor(kcs);
    int cbias = bfi(cc, 16, 2), cop = bfi(cc, 18, 1), cclamp = bfi(cc, 19, 1), cscale = bfi(cc, 20, 2), cdest = bfi(cc, 22, 2);
    int aa = asel(bfi(ac, 13, 3), kas), ab = asel(bfi(ac, 10, 3), kas), ac_ = asel(bfi(ac, 7, 3), kas), ad = asel(bfi(ac, 4, 3), kas);
    int abias = bfi(ac, 16, 2), aop = bfi(ac, 18, 1), aclamp = bfi(ac, 19, 1), ascale = bfi(ac, 20, 2), adest = bfi(ac, 22, 2);
    int rc[3];
    int ra;
    if (cbias == 3) {
      int mode = (cscale << 1) | cop;
      ivec3 A = ca & 255, B = cb & 255;
      for (int k = 0; k < 3; k++) {
        bool cond = compareCond(mode, A, B, k);
        rc[k] = clampTev(sx11(uint(cd[k]) & 0x7ffu) + (cond ? (ccc[k] & 255) : 0), cclamp);
      }
    } else {
      for (int k = 0; k < 3; k++) rc[k] = tevRegular(false, ca[k] & 255, cb[k] & 255, ccc[k] & 255, sx11(uint(cd[k]) & 0x7ffu), cbias, cop, cscale, cclamp);
    }
    if (abias == 3) {
      int mode = (ascale << 1) | aop;
      bool cond;
      if (mode >= 6) cond = mode == 6 ? ((aa & 255) > (ab & 255)) : ((aa & 255) == (ab & 255));
      else cond = compareCond(mode, ca & 255, cb & 255, 0);
      ra = clampTev(sx11(uint(ad) & 0x7ffu) + (cond ? (ac_ & 255) : 0), aclamp);
    } else ra = tevRegular(true, aa & 255, ab & 255, ac_ & 255, sx11(uint(ad) & 0x7ffu), abias, aop, ascale, aclamp);
    gRegs[cdest * 4] = rc[0]; gRegs[cdest * 4 + 1] = rc[1]; gRegs[cdest * 4 + 2] = rc[2];
    gRegs[adest * 4 + 3] = ra;
  }
  int lastC = bfi(S(0xc0u + uint(2 * (nStages - 1))), 22, 2), lastA = bfi(S(0xc1u + uint(2 * (nStages - 1))), 22, 2);
  ivec4 src = ivec4(gRegs[lastC * 4] & 255, gRegs[lastC * 4 + 1] & 255, gRegs[lastC * 4 + 2] & 255, gRegs[lastA * 4 + 3] & 255);
  // alpha test
  uint at = S(0xf3u);
  bool a0 = cmpOp(bf(at, 16, 3), src.a, bfi(at, 0, 8)), a1 = cmpOp(bf(at, 19, 3), src.a, bfi(at, 8, 8));
  uint lg = bf(at, 22, 2);
  bool pass = lg == 0u ? (a0 && a1) : (lg == 1u ? (a0 || a1) : (lg == 2u ? (a0 != a1) : (a0 == a1)));
  if (!pass) { dep = newDep; return; }
  // depth texture
  uint dtOp = bf(S(0xf5u), 2, 2);
  if (dtOp != 0u) {
    uint sel = bf(S(0xf5u), 0, 2);
    int X = sel == 0u ? gLastTex[3] : (sel == 1u ? ((gLastTex[3] << 8) | gLastTex[0]) : ((gLastTex[0] << 16) | (gLastTex[1] << 8) | gLastTex[2]));
    z = (int(S(0xf4u)) + X + (dtOp == 1u ? z : 0)) & 0xffffff;
  }
  uint fsel = bf(S(0xf1u), 21, 3);
  if (fsel != 0u) fogPixel(fsel, z, x, src);
  if (!zEarly && zEnable) {
    if (!cmpOp(zFunc, z, stored)) { dep = newDep; return; }
    if (zUpdate) newDep = uint(z);
  }
  ivec4 dst = readColor(col, pixFmt);
  ivec4 res = blendPixel(S(0x41u), S(0x42u), src, dst);
  col = writeColor(col, pixFmt, S(0x41u), res);
  dep = newDep;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uvec2 e = texelFetch(uEfb, p, 0).rg;
  uint col = e.x, dep = e.y;
  int tile = (p.x >> 4) + (p.y >> 4) * uTilesX;
  uvec2 ti = texelFetch(uTiles, ivec2(tile & 1023, tile >> 10), 0).rg;
  for (uint i = 0u; i < ti.y; i++) {
    uint tri = wd(uList, ti.x + i);
    int minx = int(wd(uData, tri + 9u)), maxx = int(wd(uData, tri + 10u)), miny = int(wd(uData, tri + 11u)), maxy = int(wd(uData, tri + 12u));
    int bx = p.x & ~1, by = p.y & ~1;
    if (bx < minx || bx >= maxx || by < miny || by >= maxy) continue;
    int DX12 = int(wd(uData, tri)), DY12 = int(wd(uData, tri + 1u)), DX23 = int(wd(uData, tri + 2u)), DY23 = int(wd(uData, tri + 3u));
    int DX31 = int(wd(uData, tri + 4u)), DY31 = int(wd(uData, tri + 5u));
    int C1 = int(wd(uData, tri + 6u)), C2 = int(wd(uData, tri + 7u)), C3 = int(wd(uData, tri + 8u));
    if (C1 + DX12 * (16 * p.y) - DY12 * (16 * p.x) <= 0) continue;
    if (C2 + DX23 * (16 * p.y) - DY23 * (16 * p.x) <= 0) continue;
    if (C3 + DX31 * (16 * p.y) - DY31 * (16 * p.x) <= 0) continue;
    gTri = tri;
    gXi = int(wd(uData, tri + 13u)); gYi = int(wd(uData, tri + 14u));
    gOx = wd(uData, tri + 15u); gOy = wd(uData, tri + 16u);
    shade(p.x, p.y, col, dep);
  }
  o = uvec4(col, dep, 0u, 0u);
}
`;
}

export const PIXEL_FS = pixelShader();
