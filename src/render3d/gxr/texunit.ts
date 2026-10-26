/* GX renderer: the texture unit on the CPU (spec section 9): texel formats, wrap modes, nearest and bilinear sampling,
 * trilinear mixing. This is the reference the shader is checked against. */

export const FMT_I4 = 0, FMT_I8 = 1, FMT_IA4 = 2, FMT_IA8 = 3, FMT_RGB565 = 4, FMT_RGB5A3 = 5, FMT_RGBA8 = 6,
  FMT_C4 = 8, FMT_C8 = 9, FMT_C14X2 = 10, FMT_CMPR = 14;

const w3 = (v: number) => (v << 5) | (v << 2) | (v >> 1);
const w4 = (v: number) => v * 17;
const w5 = (v: number) => (v << 3) | (v >> 2);
const w6 = (v: number) => (v << 2) | (v >> 4);

/** block width and height as shifts, and bytes per block, nibbles per texel for the mip offsets */
export function formatInfo(fmt: number): { kw: number; kh: number; bytes: number; nibbles: number; bw: number; bh: number } {
  switch (fmt) {
    case FMT_I4: case FMT_C4: return { kw: 3, kh: 3, bytes: 32, nibbles: 1, bw: 8, bh: 8 };
    case FMT_I8: case FMT_C8: case FMT_IA4: return { kw: 3, kh: 2, bytes: 32, nibbles: 2, bw: 8, bh: 4 };
    case FMT_IA8: case FMT_RGB565: case FMT_RGB5A3: case FMT_C14X2: return { kw: 2, kh: 2, bytes: 32, nibbles: 4, bw: 4, bh: 4 };
    case FMT_RGBA8: return { kw: 2, kh: 2, bytes: 64, nibbles: 8, bw: 4, bh: 4 };
    case FMT_CMPR: return { kw: 3, kh: 3, bytes: 32, nibbles: 1, bw: 8, bh: 8 };
    default: return { kw: 2, kh: 2, bytes: 32, nibbles: 4, bw: 4, bh: 4 };
  }
}

/** a 16-bit palette entry to r, g, b, a by the palette format (0 IA8, 1 RGB565, 2 RGB5A3) */
export function paletteColor(v: number, pf: number, out: number[]): void {
  if (pf === 0) { out[0] = out[1] = out[2] = v & 255; out[3] = v >> 8; }
  else if (pf === 1) { out[0] = w5(v >> 11); out[1] = w6((v >> 5) & 63); out[2] = w5(v & 31); out[3] = 255; }
  else rgb5a3(v, out);
}

function rgb5a3(v: number, out: number[]): void {
  if (v & 0x8000) { out[0] = w5((v >> 10) & 31); out[1] = w5((v >> 5) & 31); out[2] = w5(v & 31); out[3] = 255; }
  else { out[0] = w4((v >> 8) & 15); out[1] = w4((v >> 4) & 15); out[2] = w4(v & 15); out[3] = w3((v >> 12) & 7); }
}

/** where an image's bytes are: `byte(i)` is byte i of the image data (for RGBA8 in TMEM, of the two banks) */
export interface TexData {
  byte(i: number): number;
  /** palette entry (16 bit) i */
  pal(i: number): number;
}

/** the texel at integer position (s, t), already wrapped into the level, of a level whose width-1 is W (image data starts at `off`) */
export function fetchTexel(fmt: number, data: TexData, off: number, W: number, s: number, t: number, pf: number, out: number[]): void {
  const fi = formatInfo(fmt);
  const bpr = (W >> fi.kw) + 1;
  const blk = (t >> fi.kh) * bpr + (s >> fi.kw);
  const base = off + blk * fi.bytes;
  const tx = s & ((1 << fi.kw) - 1), ty = t & ((1 << fi.kh) - 1);
  const B = data.byte;
  switch (fmt) {
    case FMT_I4: case FMT_C4: {
      const b = data.byte(base + ((ty * 8 + tx) >> 1));
      const n = tx & 1 ? b & 15 : b >> 4;
      if (fmt === FMT_I4) { const v = w4(n); out[0] = out[1] = out[2] = out[3] = v; }
      else paletteColor(data.pal(n), pf, out);
      return;
    }
    case FMT_I8: { const v = data.byte(base + ty * 8 + tx); out[0] = out[1] = out[2] = out[3] = v; return; }
    case FMT_C8: paletteColor(data.pal(data.byte(base + ty * 8 + tx)), pf, out); return;
    case FMT_IA4: { const b = data.byte(base + ty * 8 + tx); out[0] = out[1] = out[2] = w4(b & 15); out[3] = w4(b >> 4); return; }
    case FMT_IA8: { const o = base + (ty * 4 + tx) * 2; out[0] = out[1] = out[2] = data.byte(o + 1); out[3] = data.byte(o); return; }
    case FMT_RGB565: {
      const o = base + (ty * 4 + tx) * 2, v = (data.byte(o) << 8) | data.byte(o + 1);
      out[0] = w5(v >> 11); out[1] = w6((v >> 5) & 63); out[2] = w5(v & 31); out[3] = 255; return;
    }
    case FMT_RGB5A3: { const o = base + (ty * 4 + tx) * 2; rgb5a3((data.byte(o) << 8) | data.byte(o + 1), out); return; }
    case FMT_C14X2: { const o = base + (ty * 4 + tx) * 2; paletteColor(data.pal(((data.byte(o) << 8) | data.byte(o + 1)) & 0x3fff), pf, out); return; }
    case FMT_RGBA8: {
      const k = (ty * 4 + tx) * 2;
      out[3] = data.byte(base + k); out[0] = data.byte(base + k + 1); out[1] = data.byte(base + 32 + k); out[2] = data.byte(base + 32 + k + 1);
      return;
    }
    case FMT_CMPR: {
      const sub = base + (((ty >> 2) << 1) + (tx >> 2)) * 8;
      const c1 = (data.byte(sub) << 8) | data.byte(sub + 1), c2 = (data.byte(sub + 2) << 8) | data.byte(sub + 3);
      const sel = (data.byte(sub + 4 + (ty & 3)) >> (6 - 2 * (tx & 3))) & 3;
      const r1 = w5(c1 >> 11), g1 = w6((c1 >> 5) & 63), b1 = w5(c1 & 31);
      const r2 = w5(c2 >> 11), g2 = w6((c2 >> 5) & 63), b2 = w5(c2 & 31);
      if (c1 > c2) {
        const third = (d: number): number => (((d >>> 1) - (d >>> 3)) >>> 0);
        if (sel === 0) { out[0] = r1; out[1] = g1; out[2] = b1; }
        else if (sel === 1) { out[0] = r2; out[1] = g2; out[2] = b2; }
        else if (sel === 2) {
          out[0] = (r1 + third((r2 - r1) >>> 0)) & 255; out[1] = (g1 + third((g2 - g1) >>> 0)) & 255; out[2] = (b1 + third((b2 - b1) >>> 0)) & 255;
        } else {
          out[0] = (r2 - third((r2 - r1) >>> 0)) & 255; out[1] = (g2 - third((g2 - g1) >>> 0)) & 255; out[2] = (b2 - third((b2 - b1) >>> 0)) & 255;
        }
        out[3] = 255;
      } else {
        if (sel === 0) { out[0] = r1; out[1] = g1; out[2] = b1; out[3] = 255; }
        else if (sel === 1) { out[0] = r2; out[1] = g2; out[2] = b2; out[3] = 255; }
        else { out[0] = (r1 + r2 + 1) >> 1; out[1] = (g1 + g2 + 1) >> 1; out[2] = (b1 + b2 + 1) >> 1; out[3] = sel === 2 ? 255 : 0; }
      }
      return;
    }
    default: out[0] = out[1] = out[2] = out[3] = 0;
  }
  void B;
}

/** wrap coordinate c against S = width-1 of the level; mode 0 clamp, 1 repeat, 2 mirror */
export function wrap(c: number, S: number, mode: number): number {
  if (mode === 0) return Math.min(Math.max(c, 0), S);
  const n = S + 1;
  if (mode === 1) { const r = c % n; return r < 0 ? S + r : r; }
  const q = Math.trunc(c / n);
  let r = c - q * n;
  r = Math.abs(r);
  return q & 1 ? S - r : r;
}

export interface MapInfo {
  fmt: number;
  W: number; H: number;
  wrapS: number; wrapT: number;
  pf: number;
  data: TexData;
  /** start of level 0 in `data` */
  off: number;
}

/** byte offset of level L from the start of the image (L >= 1) */
export function levelOffset(fmt: number, W: number, H: number, L: number): number {
  const fi = formatInfo(fmt);
  let off = 0, w = W + 1, h = H + 1;
  for (let l = 1; l <= L; l++) {
    off += (Math.max(w, fi.bw) * Math.max(h, fi.bh) * fi.nibbles) >> 1;
    w >>= 1; h >>= 1;
  }
  return off;
}

const tex4 = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];

/** one level, nearest or bilinear. s, t in 1/128 texel units of that level. */
function sampleLevel(m: MapInfo, L: number, s: number, t: number, linear: boolean, out: number[]): void {
  const off = m.off + (L ? levelOffset(m.fmt, m.W, m.H, L) : 0);
  const W = m.W >> L, H = m.H >> L;
  if (!linear) {
    fetchTexel(m.fmt, m.data, off, W, wrap(s >> 7, W, m.wrapS), wrap(t >> 7, H, m.wrapT), m.pf, out);
    return;
  }
  const sp = s - 64, tp = t - 64;
  const s0 = sp >> 7, t0 = tp >> 7, fs = sp & 127, ft = tp & 127;
  const xs = [wrap(s0, W, m.wrapS), wrap(s0 + 1, W, m.wrapS)], ys = [wrap(t0, H, m.wrapT), wrap(t0 + 1, H, m.wrapT)];
  fetchTexel(m.fmt, m.data, off, W, xs[0], ys[0], m.pf, tex4[0]);
  fetchTexel(m.fmt, m.data, off, W, xs[1], ys[0], m.pf, tex4[1]);
  fetchTexel(m.fmt, m.data, off, W, xs[0], ys[1], m.pf, tex4[2]);
  fetchTexel(m.fmt, m.data, off, W, xs[1], ys[1], m.pf, tex4[3]);
  const w0 = (128 - fs) * (128 - ft), w1 = fs * (128 - ft), w2 = (128 - fs) * ft, w3_ = fs * ft;
  for (let c = 0; c < 4; c++) out[c] = (tex4[0][c] * w0 + tex4[1][c] * w1 + tex4[2][c] * w2 + tex4[3][c] * w3_) >> 14;
}

const lv = [0, 0, 0, 0], lv2 = [0, 0, 0, 0];

/** the unit's sample (9.3): s, t in 1/128 units (24-bit signed), lod in 1/16 units, linear picks bilinear; mf is mode0.bits(5, 3) */
export function sample(m: MapInfo, s: number, t: number, lod: number, linear: boolean, mf: number, out: number[]): void {
  const fract = lod & 15;
  let mip = 0, mix = false;
  if (lod > 0 && (mf & 3) !== 0) {
    mip = lod >> 4;
    mix = fract !== 0 && (mf & 2) !== 0;
    mip += (fract >> 3) & (mf & 1);
  }
  if (!mix) { sampleLevel(m, mip, s >> mip, t >> mip, linear, out); return; }
  sampleLevel(m, mip, s >> mip, t >> mip, linear, lv);
  sampleLevel(m, mip + 1, s >> (mip + 1), t >> (mip + 1), linear, lv2);
  for (let c = 0; c < 4; c++) out[c] = (lv[c] * (16 - fract) + lv2[c] * fract) >> 4;
}
