/* GX renderer: the pixel stage on the CPU (spec sections 8 to 11): the reference implementation the shader is checked
 * against, and what the tests of the rules run. It draws one triangle (setup.ts's Tri) into an EFB. */
import { bitsOf, f, flt, fromBits, trunc32 } from "./f32";
import { bits } from "./state";
import { P_COL, P_INVW, P_TEX, P_Z, Tri } from "./setup";
import { blend, clampTev, sext11, tevCompare, tevRegular } from "./tev";
import { MapInfo, sample, TexData } from "./texunit";

export const EFB_W = 640, EFB_H = 528;

export class Efb {
  /** the color word of the pixel format (spec 1.2) */
  color = new Uint32Array(EFB_W * EFB_H);
  depth = new Uint32Array(EFB_W * EFB_H);
}

/** everything the pixel stage reads that is not in the triangle: BP (with the TEV color registers of bank 0 in place), the constant
 *  colors (bank 1), and the projection flags of the texgens (XF 0x1040 + n, bit 1) and the viewport half width */
export interface PixState {
  bp: Uint32Array;
  kc: Uint32Array;
  texProj: boolean[];
  wd: number;
}

/** the memories texture reads come from */
export interface Env {
  mem: Uint8Array;
  tmem: Uint8Array;
  tluts: Map<number, Uint8Array>;
}

export function makeTexData(env: Env, bp: Uint32Array, m: number): { data: TexData; off: number; fmt: number; W: number; H: number; pf: number } {
  const hi = m >= 4, k = m & 3;
  const img0 = bp[(hi ? 0xa8 : 0x88) + k], img1 = bp[(hi ? 0xac : 0x8c) + k], img2 = bp[(hi ? 0xb0 : 0x90) + k], img3 = bp[(hi ? 0xb4 : 0x94) + k];
  const tl = bp[(hi ? 0xb8 : 0x98) + k];
  const fmt = bits(img0, 20, 4), W = bits(img0, 0, 10), H = bits(img0, 10, 10);
  const pf = bits(tl, 10, 2);
  const pal = env.tluts.get(bits(tl, 0, 10));
  const palf = (i: number): number => {
    if (!pal) return 0;
    const o = i * 2;
    return o + 1 < pal.length ? (pal[o] << 8) | pal[o + 1] : 0;
  };
  let data: TexData;
  if ((img1 >> 21) & 1) {
    const l1 = bits(img1, 0, 15) * 32, l2 = bits(img2, 0, 15) * 32;
    const T = env.tmem;
    data = {
      byte: (i) => {
        if (fmt === 6) {
          const blk = i >> 6, r = i & 63;
          return T[((r < 32 ? l1 + blk * 32 + r : l2 + blk * 32 + r - 32)) & 0xfffff];
        }
        return T[(l1 + i) & 0xfffff];
      },
      pal: palf,
    };
  } else {
    const base = bits(img3, 0, 24) * 32, M = env.mem;
    data = { byte: (i) => M[(base + i) & 0x1ffffff], pal: palf };
  }
  return { data, off: 0, fmt, W, H, pf };
}

// ---------------------------------------------------------------------------------------------------------------------

const f16 = (v: number): number => bits(v, 0, 16);

function log2fix(d: number): number {
  const b = bitsOf(d);
  return (((b & 0x7f800000) >>> 19) - 2032 + ((b & 0x007fffff) >>> 19)) | 0;
}

const cmpOp = (code: number, a: number, b: number): boolean => {
  switch (code) {
    case 0: return false; case 1: return a < b; case 2: return a === b; case 3: return a <= b;
    case 4: return a > b; case 5: return a !== b; case 6: return a >= b; default: return true;
  }
};

const KSEL = [255, 223, 191, 159, 128, 96, 64, 32];

class Pixel {
  // per-draw state (decoded once)
  st!: PixState;
  env!: Env;
  maps: (MapInfo | null)[] = [];
  nStages = 0;
  /** TEV register file per pixel: [prev, c0, c1, c2][r, g, b, a], 11-bit signed */
  regs0 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  kk = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
}

function colorRegs(words: Uint32Array, out: number[]): void {
  for (let r = 0; r < 4; r++) {
    const ra = words[2 * r], bg = words[2 * r + 1];
    out[r * 4] = sext11(ra & 0x7ff); out[r * 4 + 3] = sext11((ra >> 12) & 0x7ff);
    out[r * 4 + 2] = sext11(bg & 0x7ff); out[r * 4 + 1] = sext11((bg >> 12) & 0x7ff);
  }
}

/** the offsets and the alpha bump an indirect sample `tx` gives a TEV stage (spec 10.5); (S, T) are the stage's own coordinates */
export function indirectOffsets(bp: Uint32Array, ind: number, tx: number[], S: number, T: number, prevS: number, prevT: number): [number, number, number] {
  const fmt = bits(ind, 2, 2), biasBits = bits(ind, 4, 3), bs = bits(ind, 7, 2), mid = bits(ind, 9, 4);
  const sw = bits(ind, 13, 3), tw = bits(ind, 16, 3), addprev = bits(ind, 20, 1);
    const i = [tx[3], tx[2], tx[1]];
    const mask = fmt === 0 ? 0xf8 : fmt === 1 ? 0xe0 : fmt === 2 ? 0xf0 : 0xf8;
    const bump = bs === 0 ? 0 : i[bs - 1] & mask;
    const vmask = fmt === 0 ? 0xff : fmt === 1 ? 0x1f : fmt === 2 ? 0x0f : 0x07;
    const v = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      v[k] = i[k] & vmask;
      if ((biasBits >> k) & 1) v[k] += fmt === 0 ? -128 : 1;
    }
    let o0 = 0, o1 = 0;
    const m = mid & 3;
    if (m !== 0) {
      const A = bp[0x06 + 3 * (m - 1)], B = bp[0x07 + 3 * (m - 1)], C = bp[0x08 + 3 * (m - 1)];
      const ma = sext11(A & 0x7ff), mb = sext11((A >> 11) & 0x7ff), mc = sext11(B & 0x7ff), md = sext11((B >> 11) & 0x7ff), me = sext11(C & 0x7ff), mf = sext11((C >> 11) & 0x7ff);
      const exp = bits(A, 22, 2) | (bits(B, 22, 2) << 2) | (bits(C, 22, 2) << 4);
      const shift = 17 - exp;
      const type = mid & 12;
      // matrix type 12 is not defined: the stage's coordinate stays what the previous stage left (spec 10.5)
      if (type === 12) return [prevS, prevT, bump];
      if (type === 0) { o0 = (ma * v[0] + mc * v[1] + me * v[2]) >> 3; o1 = (mb * v[0] + md * v[1] + mf * v[2]) >> 3; }
      else if (type === 4) { o0 = Math.trunc((S * v[0]) / 256); o1 = Math.trunc((T * v[0]) / 256); }
      else if (type === 8) { o0 = Math.trunc((S * v[1]) / 256); o1 = Math.trunc((T * v[1]) / 256); }
      if (shift >= 0) { o0 >>= shift; o1 >>= shift; } else { o0 <<= -shift; o1 <<= -shift; }
    }
    const wrapMask = (c: number, w: number): number => (w === 0 ? c : w === 6 || w === 7 ? 0 : c & (((256 >> (w - 1)) << 7) - 1));
    let rs = wrapMask(S, sw) + o0, rt = wrapMask(T, tw) + o1;
    if (addprev) { rs += prevS; rt += prevT; }
    return [(rs << 8) >> 8, (rt << 8) >> 8, bump];
  }

/** prepared state of a draw for the CPU pixel stage */
/** counters for profiling scenes (not part of the rules): pixels that pass the coverage test, and how many of them fail the depth test */
export const RSTAT = { covered: 0, zFail: 0, zOff: 0, textured: 0 };

export class DrawPixels {
  readonly bp: Uint32Array;
  readonly st: PixState;
  readonly maps: (MapInfo | null)[] = new Array(8).fill(null);
  readonly kk = new Array(16).fill(0);
  readonly reg0 = new Array(16).fill(0);
  readonly nStages: number;
  readonly numGens: number;
  readonly numCols: number;
  readonly mode0: number[] = [];
  readonly mode1: number[] = [];

  constructor(st: PixState, readonly env: Env) {
    this.st = st;
    const bp = this.bp = st.bp;
    this.nStages = bits(bp[0], 10, 4) + 1;
    this.numGens = bits(bp[0], 0, 4);
    this.numCols = bits(bp[0], 4, 3);
    colorRegs(bp.subarray(0xe0, 0xe8), this.reg0);
    colorRegs(st.kc, this.kk);
    for (let m = 0; m < 8; m++) {
      const hi = m >= 4, k = m & 3;
      this.mode0.push(bp[(hi ? 0xa0 : 0x80) + k]);
      this.mode1.push(bp[(hi ? 0xa4 : 0x84) + k]);
    }
  }

  private map(m: number): MapInfo {
    let mi = this.maps[m];
    if (!mi) {
      const t = makeTexData(this.env, this.bp, m);
      const m0 = this.mode0[m];
      mi = this.maps[m] = { fmt: t.fmt, W: t.W, H: t.H, wrapS: bits(m0, 0, 2), wrapT: bits(m0, 2, 2), pf: t.pf, data: t.data, off: t.off };
    }
    return mi;
  }

  /** s and t (floats) of generator n at the pixel (px, py) */
  st2(tri: Tri, n: number, px: number, py: number, out: number[]): void {
    const dx = f(tri.ox + flt(px - tri.xi)), dy = f(tri.oy + flt(py - tri.yi));
    // a generator the triangle has no planes for (numbered past BP's count) reads zeros
    const pl = (k: number): number => {
      if (k >= tri.np) return 0;
      const o = k * 3, P = tri.planes;
      return f(f(P[o] + f(P[o + 1] * dx)) + f(P[o + 2] * dy));
    };
    const iw = f(1 / pl(P_INVW));
    let proj = iw;
    if (this.st.texProj[n]) {
      const q = f(pl(P_TEX + n * 3 + 2) * iw);
      proj = q !== 0 ? f(iw / q) : iw;
    }
    out[0] = f(pl(P_TEX + n * 3) * proj);
    out[1] = f(pl(P_TEX + n * 3 + 1) * proj);
  }

  /** LOD of map m for the coordinates of generator n in the block of (x, y) (8.4); returns [lod, linear] */
  lodOf(tri: Tri, m: number, n: number, x: number, y: number): [number, boolean] {
    const bx = x & ~1, by = y & ~1;
    const c = [0, 0];
    const s = [0, 0, 0, 0], t = [0, 0, 0, 0];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      this.st2(tri, n, bx + i, by + j, c);
      s[j * 2 + i] = c[0]; t[j * 2 + i] = c[1];
    }
    const mx = (a: number, b: number): number => (a < b ? b : a);
    const m0 = this.mode0[m], m1 = this.mode1[m];
    let ds: number, dt: number;
    if ((m0 >> 8) & 1) { ds = Math.abs(f(s[0] - s[3])); dt = Math.abs(f(t[0] - t[3])); }
    else {
      ds = mx(Math.abs(f(s[0] - s[1])), Math.abs(f(s[0] - s[2])));
      dt = mx(Math.abs(f(t[0] - t[1])), Math.abs(f(t[0] - t[2])));
    }
    const d = mx(ds, dt);
    const bias = (bits(m0, 9, 8) << 24) >> 24;
    let lod = (log2fix(d) + (bias >> 1)) | 0;
    const mf = bits(m0, 5, 3);
    const linear = (lod > 0 && (mf & 4) !== 0) || (lod <= 0 && bits(m0, 4, 1) === 1);
    const maxl = bits(m1, 8, 8), minl = bits(m1, 0, 8);
    if (lod > maxl) lod = maxl; else if (lod < minl) lod = minl;
    return [lod, linear];
  }

  /** the indirect unit for one TEV stage (spec 10.5): returns the stage's modified coordinates and its alpha bump */
  private indirect(tri: Tri, x: number, y: number, ind: number, S: number, T: number, prevS: number, prevT: number): [number, number, number] {
    const bp = this.bp;
    const bt = bits(ind, 0, 2), fmt = bits(ind, 2, 2), biasBits = bits(ind, 4, 3), bs = bits(ind, 7, 2), mid = bits(ind, 9, 4);
    const sw = bits(ind, 13, 3), tw = bits(ind, 16, 3), addprev = bits(ind, 20, 1);
    // the indirect stage: its texture map and coordinate generator, the scale exponents
    const iref = bp[0x27];
    const imap = bits(iref, 6 * bt, 3), icoord = bits(iref, 6 * bt + 3, 3);
    const ssw = bp[0x25 + (bt >> 1)];
    const ss = bits(ssw, (bt & 1) * 8, 4), ts = bits(ssw, (bt & 1) * 8 + 4, 4);
    const c = [0, 0];
    this.st2(tri, icoord, x, y, c);
    const IS = (trunc32(f(c[0] * 128)) << 8) >> 8, IT = (trunc32(f(c[1] * 128)) << 8) >> 8;
    // the level of detail uses the low two bits of the map and coordinate numbers (a quirk of the reference)
    const [lod, linear] = this.lodOf(tri, imap & 3, icoord & 3, x, y);
    const tx = [0, 0, 0, 0];
    sample(this.map(imap), IS >> ss, IT >> ts, lod, linear, bits(this.mode0[imap], 5, 3), tx);
    const res = indirectOffsets(bp, ind, tx, S, T, prevS, prevT);
    if ((globalThis as any).DBG?.(x, y)) console.log(`indirect ind=${ind.toString(16)} bt=${bt} imap=${imap} icoord=${icoord} ss=${ss} ts=${ts} IS=${IS} IT=${IT} lod=${lod} linear=${linear} tx=${tx} stage S,T=${S},${T} prev=${prevS},${prevT} -> ${res}`);
    return res;
  }

  /** draw a triangle into the EFB */
  draw(efb: Efb, tri: Tri): void {
    const bp = this.bp;
    const nStages = this.nStages;
    const zEarly = bits(bp[0x43], 6, 1) === 1 && bits(bp[0x40], 0, 1) === 1;
    const zEnable = bits(bp[0x40], 0, 1) === 1, zFunc = bits(bp[0x40], 1, 3), zUpdate = bits(bp[0x40], 4, 1) === 1;
    const pixFmt = bits(bp[0x43], 0, 3);
    const regs = new Array(16).fill(0);
    const ras = [[0, 0, 0, 0], [0, 0, 0, 0]];
    const tex = [0, 0, 0, 0];
    const texel = [0, 0, 0, 0];
    const dst = [0, 0, 0, 0], src = [0, 0, 0, 0], res = [0, 0, 0, 0];
    for (let by = tri.miny; by < tri.maxy; by += 2) {
      for (let bx = tri.minx; bx < tri.maxx; bx += 2) {
        for (let q = 0; q < 4; q++) {
          const x = bx + (q & 1), y = by + (q >> 1);
          if (x >= EFB_W || y >= EFB_H) continue;
          if (((tri.C1 + Math.imul(tri.DX12, 16 * y) - Math.imul(tri.DY12, 16 * x)) | 0) <= 0) continue;
          if (((tri.C2 + Math.imul(tri.DX23, 16 * y) - Math.imul(tri.DY23, 16 * x)) | 0) <= 0) continue;
          if (((tri.C3 + Math.imul(tri.DX31, 16 * y) - Math.imul(tri.DY31, 16 * x)) | 0) <= 0) continue;
          const pi = y * EFB_W + x;
          const dx = f(tri.ox + flt(x - tri.xi)), dy = f(tri.oy + flt(y - tri.yi));
          const pl = (k: number): number => {
            const o = k * 3, P = tri.planes;
            return f(f(P[o] + f(P[o + 1] * dx)) + f(P[o + 2] * dy));
          };
          // depth
          const zf = pl(P_Z);
          let z = trunc32(zf > 16777215 ? 16777215 : zf < 0 ? 0 : zf);
          z &= 0xffffff;
          const stored = efb.depth[pi];
          RSTAT.covered++;
          if (!zEnable) RSTAT.zOff++; else if (!cmpOp(zFunc, z, stored)) RSTAT.zFail++;
          if (zEarly) {
            if (!cmpOp(zFunc, z, stored) || !zEnable) continue;
            if (zUpdate) efb.depth[pi] = z;
          }
          // colors
          for (let ch = 0; ch < 2; ch++) for (let c = 0; c < 4; c++) {
            if (ch * 4 + c >= this.numCols * 4) { ras[ch][c] = 0; continue; }
            const v = trunc32(pl(P_COL + ch * 4 + c));
            const v16 = v & 0xffff;
            ras[ch][c] = (v16 & ~(v16 >> 8)) & 0xff;
          }
          // TEV
          for (let i = 0; i < 16; i++) regs[i] = this.reg0[i];
          let lastTexel = [0, 0, 0, 0];
          // a stage whose texture is off keeps the value of the stage before; the first has none (zero)
          tex[0] = tex[1] = tex[2] = tex[3] = 0;
          let prevS = 0, prevT = 0;
          for (let si = 0; si < nStages; si++) {
            const ord = bp[0x28 + (si >> 1)] >> (si & 1 ? 12 : 0);
            const texmap = bits(ord, 0, 3), texcoord = bits(ord, 3, 3), texEn = bits(ord, 6, 1), rasSel = bits(ord, 7, 3);
            const cc = bp[0xc0 + 2 * si], ac = bp[0xc1 + 2 * si];
            const kw = bp[0xf6 + (si >> 1)];
            const kcs = si & 1 ? bits(kw, 14, 5) : bits(kw, 4, 5), kas = si & 1 ? bits(kw, 19, 5) : bits(kw, 9, 5);
            const rsw = bits(ac, 0, 2), tsw = bits(ac, 2, 2);
            const swz = (t: number, v: number[], o: number[]): void => {
              const w0 = bp[0xf6 + 2 * t], w1 = bp[0xf7 + 2 * t];
              o[0] = v[bits(w0, 0, 2)]; o[1] = v[bits(w0, 2, 2)]; o[2] = v[bits(w1, 0, 2)]; o[3] = v[bits(w1, 2, 2)];
            };
            const indWord = bits(bp[0], 16, 3) > 0 ? bp[0x10 + si] : 0;
            let bump = 0;
            let S = 0, T = 0;
            if (texEn) {
              const c = [0, 0];
              this.st2(tri, texcoord, x, y, c);
              S = (trunc32(f(c[0] * 128)) << 8) >> 8; T = (trunc32(f(c[1] * 128)) << 8) >> 8;
            }
            if (indWord !== 0) {
              const r = this.indirect(tri, x, y, indWord, S, T, prevS, prevT);
              if (texEn) { S = r[0]; T = r[1]; }
              bump = r[2];
            }
            if (texEn) {
              const m = this.map(texmap);
              const [lod, linear] = this.lodOf(tri, texmap, texcoord, x, y);
              prevS = S; prevT = T;
              sample(m, S, T, lod, linear, bits(this.mode0[texmap], 5, 3), texel);
              if ((globalThis as any).DBG?.(x, y)) console.log(`stage ${si} map ${texmap} gen ${texcoord} S=${S} T=${T} lod=${lod} linear=${linear} fmt=${m.fmt} W=${m.W} H=${m.H} wrap=${m.wrapS}${m.wrapT} texel=${texel}`);
              swz(tsw, texel, tex);
              lastTexel = tex.slice();
            }
            const rs = [0, 0, 0, 0];
            if (rasSel === 0) swz(rsw, ras[0], rs);
            else if (rasSel === 1) swz(rsw, ras[1], rs);
            else if (rasSel === 5) rs[0] = rs[1] = rs[2] = rs[3] = bump;
            else if (rasSel === 6) rs[0] = rs[1] = rs[2] = rs[3] = bump | (bump >> 5);
            // color combiner
            const csel = (k: number): number[] => {
              const r = regs;
              switch (k) {
                case 0: return [r[0], r[1], r[2]]; case 1: return [r[3], r[3], r[3]];
                case 2: return [r[4], r[5], r[6]]; case 3: return [r[7], r[7], r[7]];
                case 4: return [r[8], r[9], r[10]]; case 5: return [r[11], r[11], r[11]];
                case 6: return [r[12], r[13], r[14]]; case 7: return [r[15], r[15], r[15]];
                case 8: return [tex[0], tex[1], tex[2]]; case 9: return [tex[3], tex[3], tex[3]];
                case 10: return [rs[0], rs[1], rs[2]]; case 11: return [rs[3], rs[3], rs[3]];
                case 12: return [255, 255, 255]; case 13: return [128, 128, 128];
                case 14: return this.konstColor(kcs);
                default: return [0, 0, 0];
              }
            };
            const asel = (k: number): number => {
              const r = regs;
              switch (k) {
                case 0: return r[3]; case 1: return r[7]; case 2: return r[11]; case 3: return r[15];
                case 4: return tex[3]; case 5: return rs[3]; case 6: return this.konstAlpha(kas);
                default: return 0;
              }
            };
            const ca = csel(bits(cc, 12, 4)), cb = csel(bits(cc, 8, 4)), ccc = csel(bits(cc, 4, 4)), cd = csel(bits(cc, 0, 4));
            const cbias = bits(cc, 16, 2), cop = bits(cc, 18, 1), cclamp = bits(cc, 19, 1), cscale = bits(cc, 20, 2), cdest = bits(cc, 22, 2);
            const aa = asel(bits(ac, 13, 3)), ab = asel(bits(ac, 10, 3)), ac_ = asel(bits(ac, 7, 3)), ad = asel(bits(ac, 4, 3));
            const abias = bits(ac, 16, 2), aop = bits(ac, 18, 1), aclamp = bits(ac, 19, 1), ascale = bits(ac, 20, 2), adest = bits(ac, 22, 2);
            const rc = [0, 0, 0];
            let ra: number;
            if (cbias === 3) {
              const mode = (cscale << 1) | cop;
              const A = [ca[0] & 255, ca[1] & 255, ca[2] & 255], B = [cb[0] & 255, cb[1] & 255, cb[2] & 255];
              for (let k = 0; k < 3; k++) {
                const cond = compareCond(mode, A, B, k);
                rc[k] = tevCompare(cond, ccc[k] & 255, sext11(cd[k] & 0x7ff), cclamp);
              }
            } else {
              for (let k = 0; k < 3; k++) rc[k] = tevRegular(false, ca[k] & 255, cb[k] & 255, ccc[k] & 255, sext11(cd[k] & 0x7ff), cbias, cop, cscale, cclamp);
            }
            if (abias === 3) {
              const mode = (ascale << 1) | aop;
              let cond: boolean;
              if (mode >= 6) cond = mode === 6 ? (aa & 255) > (ab & 255) : (aa & 255) === (ab & 255);
              else cond = compareCond(mode, [ca[0] & 255, ca[1] & 255, ca[2] & 255], [cb[0] & 255, cb[1] & 255, cb[2] & 255], 0);
              ra = tevCompare(cond, ac_ & 255, sext11(ad & 0x7ff), aclamp);
            } else ra = tevRegular(true, aa & 255, ab & 255, ac_ & 255, sext11(ad & 0x7ff), abias, aop, ascale, aclamp);
            regs[cdest * 4] = rc[0]; regs[cdest * 4 + 1] = rc[1]; regs[cdest * 4 + 2] = rc[2];
            regs[adest * 4 + 3] = ra;
            if ((globalThis as any).DBG?.(x, y)) console.log(`stage ${si}: ca=${ca} cb=${cb} cc=${ccc} cd=${cd} aa=${aa} ab=${ab} ac=${ac_} ad=${ad} tex=${tex} ras=${rs} -> rc=${rc} ra=${ra} dest ${cdest}/${adest}; regs=${regs}`);
          }
          // result: the last stage's destinations
          const lastC = bits(bp[0xc0 + 2 * (nStages - 1)], 22, 2), lastA = bits(bp[0xc1 + 2 * (nStages - 1)], 22, 2);
          src[0] = regs[lastC * 4] & 255; src[1] = regs[lastC * 4 + 1] & 255; src[2] = regs[lastC * 4 + 2] & 255; src[3] = regs[lastA * 4 + 3] & 255;
          // alpha test
          const at = bp[0xf3];
          const a0 = cmpOp(bits(at, 16, 3), src[3], bits(at, 0, 8)), a1 = cmpOp(bits(at, 19, 3), src[3], bits(at, 8, 8));
          const logic = bits(at, 22, 2);
          const pass = logic === 0 ? a0 && a1 : logic === 1 ? a0 || a1 : logic === 2 ? a0 !== a1 : a0 === a1;
          if (!pass) continue;
          // depth texture
          const dtOp = bits(bp[0xf5], 2, 2);
          if (dtOp !== 0) {
            const sel = bits(bp[0xf5], 0, 2);
            const X = sel === 0 ? lastTexel[3] : sel === 1 ? (lastTexel[3] << 8) | lastTexel[0] : (lastTexel[0] << 16) | (lastTexel[1] << 8) | lastTexel[2];
            z = (bp[0xf4] + X + (dtOp === 1 ? z : 0)) & 0xffffff;
          }
          // fog
          const fsel = bits(bp[0xf1], 21, 3);
          if (fsel !== 0) fogPixel(bp, fsel, z, src, x, this.st.wd);
          // late depth
          if (!zEarly && zEnable) {
            if (!cmpOp(zFunc, z, stored)) continue;
            if (zUpdate) efb.depth[pi] = z;
          }
          // blend and write
          readColor(efb.color[pi], pixFmt, dst);
          blend(bp[0x41], bp[0x42], src, dst, res);
          writeColor(efb, pi, pixFmt, bp[0x41], res);
        }
      }
    }
  }

  private konstColor(ks: number): number[] {
    if (ks < 8) return [KSEL[ks], KSEL[ks], KSEL[ks]];
    if (ks < 12) return [0, 0, 0];
    if (ks < 16) { const k = (ks - 12) * 4; return [this.kk[k], this.kk[k + 1], this.kk[k + 2]]; }
    const comp = ((ks - 16) >> 2), k = (ks & 3) * 4;
    const v = comp === 0 ? this.kk[k] : comp === 1 ? this.kk[k + 1] : comp === 2 ? this.kk[k + 2] : this.kk[k + 3];
    return [v, v, v];
  }

  private konstAlpha(ks: number): number {
    if (ks < 8) return KSEL[ks];
    if (ks < 16) return 0;
    const comp = ((ks - 16) >> 2), k = (ks & 3) * 4;
    return comp === 0 ? this.kk[k] : comp === 1 ? this.kk[k + 1] : comp === 2 ? this.kk[k + 2] : this.kk[k + 3];
  }
}

function compareCond(mode: number, A: number[], B: number[], k: number): boolean {
  switch (mode) {
    case 0: return A[0] > B[0];
    case 1: return A[0] === B[0];
    case 2: return ((A[1] << 8) | A[0]) > ((B[1] << 8) | B[0]);
    case 3: return ((A[1] << 8) | A[0]) === ((B[1] << 8) | B[0]);
    case 4: return ((A[2] << 16) | (A[1] << 8) | A[0]) > ((B[2] << 16) | (B[1] << 8) | B[0]);
    case 5: return ((A[2] << 16) | (A[1] << 8) | A[0]) === ((B[2] << 16) | (B[1] << 8) | B[0]);
    case 6: return A[k] > B[k];
    default: return A[k] === B[k];
  }
}

function fogFloat(w: number): number {
  const sign = (w >> 19) & 1, exp = (w >> 11) & 255, man = w & 0x7ff;
  return fromBits(((sign << 31) | (exp << 23) | (man << 12)) >>> 0);
}

/** the exponential fog shapes (spec 11.3): 2^x is computed in double precision and rounded once to binary32 */
export function fogShape(fsel: number, fog: number): number {
  if (fsel === 4) return f(1 - f(Math.pow(2, f(-8 * fog))));
  if (fsel === 5) return f(1 - f(Math.pow(2, f(f(-8 * fog) * fog))));
  if (fsel === 6) { const g = f(1 - fog); return f(Math.pow(2, f(-8 * g))); }
  if (fsel === 7) { const g = f(1 - fog); return f(Math.pow(2, f(f(-8 * g) * g))); }
  return fog;
}

export function fogPixel(bp: Uint32Array, fsel: number, z: number, c: number[], x: number, wd: number): void {
  const A = fogFloat(bp[0xee]), C = fogFloat(bp[0xf1] & 0xfffff);
  const Bm = bp[0xef], Bs = bp[0xf0] & 31;
  const ortho = (bp[0xf1] >> 20) & 1;
  let ze: number;
  if (!ortho) ze = f(f(A * 16777215) / flt(Bm - (z >> Bs)));
  else ze = f(A * f(flt(z) / 16777215));
  if ((bp[0xe8] >> 10) & 1) {
    const o = f(flt(x - ((bp[0xe8] & 0x3ff) - 342)) / wd);
    let fidx = f(9 - f(Math.abs(o) * 9));
    if (fidx < 0) fidx = 0; else if (fidx > 9) fidx = 9;
    const lo = Math.floor(fidx), up = lo + 1;
    const K = (i: number): number => {
      const w = bp[0xe9 + (i >> 1)];
      return f(f(((i & 1) ? w & 0xfff : (w >> 12) & 0xfff) / 256) * 4);
    };
    const factor = f(up - fidx);
    const k = f(f(K(lo) * factor) + f(K(up) * f(1 - factor)));
    ze = f(ze * f(f(Math.sqrt(f(f(o * o) + f(k * k)))) / k));
  }
  ze = f(ze - C);
  let fog = ze < 0 ? 0 : ze > 1 ? 1 : ze;
  if (!(ze === ze)) fog = ze;
  fog = fogShape(fsel, fog);
  const fi = trunc32(f(fog * 256));
  const fc = bp[0xf2];
  const fr = [(fc >> 16) & 255, (fc >> 8) & 255, fc & 255];
  for (let k = 0; k < 3; k++) c[k] = (c[k] * (256 - fi) + fr[k] * fi) >> 8;
}

/** the destination bytes (r, g, b, a) of a color word */
export function readColor(w: number, fmt: number, out: number[]): void {
  if (fmt === 1) {
    const e = (v: number): number => (v << 2) | (v >> 4);
    out[3] = e(w & 63); out[2] = e((w >> 6) & 63); out[1] = e((w >> 12) & 63); out[0] = e((w >> 18) & 63);
  } else { out[3] = 255; out[2] = w & 255; out[1] = (w >> 8) & 255; out[0] = (w >> 16) & 255; }
}

export function writeColor(efb: Efb, pi: number, fmt: number, mode: number, r: number[]): void {
  const colorUpd = (mode >> 3) & 1, alphaUpd = (mode >> 4) & 1;
  if (colorUpd) {
    if (fmt === 1) {
      const old = efb.color[pi];
      const a6 = alphaUpd ? r[3] >> 2 : old & 63;
      efb.color[pi] = a6 | ((r[2] >> 2) << 6) | ((r[1] >> 2) << 12) | ((r[0] >> 2) << 18);
    } else efb.color[pi] = r[2] | (r[1] << 8) | (r[0] << 16);
  } else if (alphaUpd && fmt === 1) {
    efb.color[pi] = (efb.color[pi] & ~63) | (r[3] >> 2);
  }
}

void f16; void clampTev;
