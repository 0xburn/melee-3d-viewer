/* GX renderer: the transform unit (spec sections 3, 5, 6): vertices to eye and clip space, the lit channel colors, the
 * texture coordinates; then culling, clipping and the viewport. Every float operation is rounded to binary32 (f32.ts).
 *
 * A transformed vertex is a run of doubles (each holding a float exactly) in one big pool, `Pool`, at a vertex's offset:
 * eye position (3), clip position (4), normal, tangent, binormal (3 each), texture coordinates u v w of generators 0..7
 * (24), then the two color channels' bytes as numbers (8). Clipping makes new vertices in the same pool.
 *
 * This is the hot part of the CPU half, so it allocates nothing per vertex: scratch values live in module variables and typed arrays.
 */
import { f, fsqrt, ONE_MINUS_EPS, trunc32 } from "./f32";
import { bits, GxRegs } from "./state";
import { VertexData } from "./vertex";

export const V_E = 0, V_C = 3, V_N0 = 7, V_N1 = 10, V_N2 = 13, V_T = 16, V_COL = 40, V_STRIDE = 48;

export class Pool {
  data = new Float64Array(V_STRIDE * 4096);
  n = 0;
  alloc(): number {
    if ((this.n + 1) * V_STRIDE > this.data.length) {
      const d = new Float64Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    return this.n++ * V_STRIDE;
  }
  clear(): void { this.n = 0; }
}

const max0 = (v: number): number => (0 < v ? v : 0);
const safeDiv = (n: number, d: number): number => (d === 0 ? (n > 0 ? 1 : 0) : f(n / d));

/** what the vertex transform reads of the XF unit for one draw */
export interface XfDraw {
  /** XF memory and registers as words and as floats */
  W: Uint32Array;
  F: Float32Array;
  numChannels: number;
  numGens: number;
  p0: number; p1: number; p2: number; p3: number; p4: number; p5: number;
  ortho: boolean;
  /** viewport wd, ht, zr, xo, yo, zf */
  vp: number[];
  special: boolean;
}

export function xfDraw(regs: GxRegs, vd: VertexData): XfDraw {
  const W = regs.xf;
  const F = new Float32Array(W.buffer, W.byteOffset, W.length);
  const L = vd.layout;
  const special = L.pos.kind !== 0 && L.tex[0].kind !== 0 && !L.tex[1].kind && !L.tex[2].kind && !L.tex[3].kind && !L.tex[4].kind && !L.tex[5].kind &&
    !L.tex[6].kind && !L.tex[7].kind && !L.posMtx && !L.texMtx[0] && !L.texMtx[1] && !L.texMtx[2] && !L.texMtx[3] && !L.texMtx[4] && !L.texMtx[5] &&
    !L.texMtx[6] && !L.texMtx[7] && L.nrm.kind === 0 && L.col[0].kind === 0 && L.col[1].kind === 0;
  return {
    W, F, numChannels: bits(W[0x1009], 0, 2), numGens: bits(W[0x103f], 0, 4),
    p0: F[0x1020], p1: F[0x1021], p2: F[0x1022], p3: F[0x1023], p4: F[0x1024], p5: F[0x1025], ortho: W[0x1026] !== 0,
    vp: [F[0x101a], F[0x101b], F[0x101c], F[0x101d], F[0x101e], F[0x101f]], special,
  };
}

const dot3 = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): number =>
  f(f(f(ax * bx) + f(ay * by)) + f(az * bz));

// results of lightTerms
let L_attn = 0, L_dif = 0;

/** the attenuation and diffuse terms of light `b` (its XF memory base) for a control word, E the eye position, N the unit normal */
function lightTerms(F: Float32Array, ctrl: number, b: number, ex: number, ey: number, ez: number, nx: number, ny: number, nz: number): void {
  const dfn = (ctrl >> 7) & 3, afn = (ctrl >> 9) & 3;
  let lx = f(F[b + 10] - ex), ly = f(F[b + 11] - ey), lz = f(F[b + 12] - ez);
  let attn = 1;
  if (afn === 3) {
    const dist2 = dot3(lx, ly, lz, lx, ly, lz);
    const dist = fsqrt(dist2);
    const inv = f(1 / dist);
    lx = f(lx * inv); ly = f(ly * inv); lz = f(lz * inv);
    const a = max0(dot3(lx, ly, lz, F[b + 13], F[b + 14], F[b + 15]));
    const cosAtt = f(f(F[b + 4] + f(F[b + 5] * a)) + f(f(F[b + 6] * a) * a));
    const distAtt = f(f(F[b + 7] + f(F[b + 8] * dist)) + f(F[b + 9] * dist2));
    attn = safeDiv(max0(cosAtt), distAtt);
  } else {
    const len = fsqrt(dot3(lx, ly, lz, lx, ly, lz));
    if (len === 0) { lx = ly = lz = 0; } else { const inv = f(1 / len); lx = f(lx * inv); ly = f(ly * inv); lz = f(lz * inv); }
    if (lx === 0 && ly === 0 && lz === 0) { lx = nx; ly = ny; lz = nz; }
    if (afn === 1) {
      const a = dot3(lx, ly, lz, nx, ny, nz) >= 0 ? max0(dot3(F[b + 13], F[b + 14], F[b + 15], nx, ny, nz)) : 0;
      const a2 = f(a * a);
      let d0 = F[b + 7], d1 = F[b + 8], d2 = F[b + 9];
      if (dfn !== 0) {
        const dl = fsqrt(dot3(d0, d1, d2, d0, d1, d2));
        if (dl === 0) { d0 = d1 = d2 = 0; } else { const inv = f(1 / dl); d0 = f(d0 * inv); d1 = f(d1 * inv); d2 = f(d2 * inv); }
      }
      const num = max0(f(f(f(1 * F[b + 4]) + f(a * F[b + 5])) + f(a2 * F[b + 6])));
      const den = f(f(f(1 * d0) + f(a * d1)) + f(a2 * d2));
      attn = safeDiv(num, den);
    }
  }
  L_attn = attn;
  L_dif = dot3(lx, ly, lz, nx, ny, nz);
}

const Lc = new Float64Array(3);
const SHIFTS = [24, 16, 8];

/** one channel's 4 bytes, written to D[o .. o + 3]: the color control word at XF 0x100E + ch, the alpha control at 0x1010 + ch */
function channelBytes(x: XfDraw, ch: number, vcol: Uint8Array | null, vi: number, ex: number, ey: number, ez: number, nx: number, ny: number, nz: number, D: Float64Array, o: number): void {
  const W = x.W, F = x.F;
  const matReg = W[0x100c + ch], ambReg = W[0x100a + ch];
  for (let part = 0; part < 2; part++) {
    const ctrl = W[(part === 0 ? 0x100e : 0x1010) + ch];
    const comps = part === 0 ? 3 : 1;
    const base = part === 0 ? 0 : 3;
    const ambV = (ctrl >> 6) & 1, matV = ctrl & 1;
    if (((ctrl >> 1) & 1) === 0) {
      for (let c = 0; c < comps; c++) D[o + base + c] = matV ? (vcol ? vcol[vi * 4 + base + c] : 0) : (matReg >>> (part === 0 ? SHIFTS[c] : 0)) & 255;
      continue;
    }
    for (let c = 0; c < comps; c++) Lc[c] = ambV ? (vcol ? vcol[vi * 4 + base + c] : 0) : (ambReg >>> (part === 0 ? SHIFTS[c] : 0)) & 255;
    const dfn = (ctrl >> 7) & 3;
    for (let n = 0; n < 8; n++) {
      if (!((ctrl >> (n < 4 ? 2 + n : 7 + n)) & 1)) continue;
      const b = 0x600 + 16 * n;
      lightTerms(F, ctrl, b, ex, ey, ez, nx, ny, nz);
      const attn = L_attn, dif = L_dif;
      const color = W[b + 3];
      if (part === 0) {
        const s = dfn === 0 ? attn : dfn === 1 ? f(attn * dif) : f(attn * max0(dif));
        for (let c = 0; c < 3; c++) Lc[c] = f(Lc[c] + f(((color >>> SHIFTS[c]) & 255) * s));
      } else {
        let t = f((color & 255) * attn);
        if (dfn === 1) t = f(t * dif); else if (dfn === 2) t = f(t * max0(dif));
        Lc[0] = f(Lc[0] + t);
      }
    }
    for (let c = 0; c < comps; c++) {
      const t = trunc32(Lc[c]);
      const li = t < 0 ? 0 : t > 255 ? 255 : t;
      const mat = matV ? (vcol ? vcol[vi * 4 + base + c] : 0) : (matReg >>> (part === 0 ? SHIFTS[c] : 0)) & 255;
      D[o + base + c] = (mat * (li + (li >> 7))) >> 8;
    }
  }
}

// the generated coordinates before the size scale (what emboss reads)
const pre = new Float64Array(24);

/** transform all vertices of a draw into the pool; returns the pool offset of vertex 0 (vertex i is at base + i * V_STRIDE).
 *  `need` (optional) marks the vertices some triangle uses; the others are left untouched. */
export function transformVertices(x: XfDraw, regs: GxRegs, vd: VertexData, pool: Pool, need?: Uint8Array | null): number {
  const base = pool.n * V_STRIDE;
  const F = x.F, W = x.W;
  const L = vd.layout;
  const { p0, p1, p2, p3, p4, p5 } = x;
  const bp = regs.bp;
  const nrmOn = L.nrm.kind !== 0, nbt = L.nbt;
  const nch = x.numChannels, ngen = x.numGens;
  const ortho = x.ortho;
  const dual = bits(W[0x1012], 0, 1) === 1;
  for (let i = 0; i < vd.n; i++) {
    const o = pool.alloc();
    if (need && !need[i]) continue;
    const D = pool.data;
    const pm = vd.pmtx[i] | 0;
    const px = vd.pos[i * 3], py = vd.pos[i * 3 + 1], pz = vd.pos[i * 3 + 2];
    const mb = pm * 4;
    const ex = f(f(f(f(F[mb] * px) + f(F[mb + 1] * py)) + f(F[mb + 2] * pz)) + F[mb + 3]);
    const ey = f(f(f(f(F[mb + 4] * px) + f(F[mb + 5] * py)) + f(F[mb + 6] * pz)) + F[mb + 7]);
    const ez = f(f(f(f(F[mb + 8] * px) + f(F[mb + 9] * py)) + f(F[mb + 10] * pz)) + F[mb + 11]);
    D[o + V_E] = ex; D[o + V_E + 1] = ey; D[o + V_E + 2] = ez;
    if (!ortho) {
      D[o + V_C] = f(f(p0 * ex) + f(p1 * ez));
      D[o + V_C + 1] = f(f(p2 * ey) + f(p3 * ez));
      D[o + V_C + 2] = f(f(f(p4 * ez) + p5) * ONE_MINUS_EPS);
      D[o + V_C + 3] = f(-ez);
    } else {
      D[o + V_C] = f(f(p0 * ex) + p1);
      D[o + V_C + 1] = f(f(p2 * ey) + p3);
      D[o + V_C + 2] = f(f(p4 * ez) + p5);
      D[o + V_C + 3] = 1;
    }
    // normals
    let nx = 0, ny = 0, nz = 0;
    let rx = 0, ry = 0, rz = 0;
    let t1x = 0, t1y = 0, t1z = 0, t2x = 0, t2y = 0, t2z = 0;
    if (nrmOn) {
      const nb = 0x400 + (pm & 31) * 3;
      const q0 = F[nb], q1 = F[nb + 1], q2 = F[nb + 2], q3 = F[nb + 3], q4 = F[nb + 4], q5 = F[nb + 5], q6 = F[nb + 6], q7 = F[nb + 7], q8 = F[nb + 8];
      rx = vd.nrm[i * 3]; ry = vd.nrm[i * 3 + 1]; rz = vd.nrm[i * 3 + 2];
      const ax = f(f(f(q0 * rx) + f(q1 * ry)) + f(q2 * rz)), ay = f(f(f(q3 * rx) + f(q4 * ry)) + f(q5 * rz)), az = f(f(f(q6 * rx) + f(q7 * ry)) + f(q8 * rz));
      const len = fsqrt(dot3(ax, ay, az, ax, ay, az));
      const inv = f(1 / len);
      nx = f(ax * inv); ny = f(ay * inv); nz = f(az * inv);
      D[o + V_N0] = nx; D[o + V_N0 + 1] = ny; D[o + V_N0 + 2] = nz;
      if (nbt) {
        const bx = vd.nrm1[i * 3], by = vd.nrm1[i * 3 + 1], bz = vd.nrm1[i * 3 + 2];
        t1x = f(f(f(q0 * bx) + f(q1 * by)) + f(q2 * bz)); t1y = f(f(f(q3 * bx) + f(q4 * by)) + f(q5 * bz)); t1z = f(f(f(q6 * bx) + f(q7 * by)) + f(q8 * bz));
        const cx = vd.nrm2[i * 3], cy = vd.nrm2[i * 3 + 1], cz = vd.nrm2[i * 3 + 2];
        t2x = f(f(f(q0 * cx) + f(q1 * cy)) + f(q2 * cz)); t2y = f(f(f(q3 * cx) + f(q4 * cy)) + f(q5 * cz)); t2z = f(f(f(q6 * cx) + f(q7 * cy)) + f(q8 * cz));
        D[o + V_N1] = t1x; D[o + V_N1 + 1] = t1y; D[o + V_N1 + 2] = t1z;
        D[o + V_N2] = t2x; D[o + V_N2 + 1] = t2y; D[o + V_N2 + 2] = t2z;
      }
    }
    // channel colors
    for (let ch = 0; ch < 2; ch++) {
      if (ch < nch) channelBytes(x, ch, L.col[ch].kind ? vd.col[ch] : null, i, ex, ey, ez, nx, ny, nz, D, o + V_COL + ch * 4);
      else { const k = o + V_COL + ch * 4; D[k] = 0; D[k + 1] = 0; D[k + 2] = 0; D[k + 3] = 0; }
    }
    // texture coordinates
    for (let n = 0; n < ngen; n++) {
      const T = W[0x1040 + n];
      const proj3 = (T >> 1) & 1, abc1 = (T >> 2) & 1, type = (T >> 4) & 7, src = (T >> 7) & 31;
      let u = 0, v = 0, w = 1;
      if (type === 0) {
        const tmIdx = L.texMtx[n] ? vd.tmtx[n][i] | 0 : n < 4 ? bits(W[0x1018], 6 + 6 * n, 6) : bits(W[0x1019], 6 * (n - 4), 6);
        let sx = 0, sy = 0, sz = 0;
        if (src === 0) { sx = px; sy = py; sz = pz; }
        else if (src === 1) { sx = rx; sy = ry; sz = rz; }
        else if (src === 3 && nbt) { sx = vd.nrm1[i * 3]; sy = vd.nrm1[i * 3 + 1]; sz = vd.nrm1[i * 3 + 2]; }
        else if (src === 4 && nbt) { sx = vd.nrm2[i * 3]; sy = vd.nrm2[i * 3 + 1]; sz = vd.nrm2[i * 3 + 2]; }
        else if (src >= 5) {
          const k = src - 5;
          if (k < 8 && L.tex[k].kind) {
            sx = vd.tex[k][i * 2]; sy = vd.tex[k][i * 2 + 1];
            sz = k + 1 < 8 && L.tex[k + 1].kind ? vd.tex[k + 1][i * 2] : 0;
          }
        }
        const tb = tmIdx * 4;
        const sp = x.special && !proj3;
        const useZ = abc1 && !sp;
        if (useZ) {
          u = f(f(f(f(F[tb] * sx) + f(F[tb + 1] * sy)) + f(F[tb + 2] * sz)) + F[tb + 3]);
          v = f(f(f(f(F[tb + 4] * sx) + f(F[tb + 5] * sy)) + f(F[tb + 6] * sz)) + F[tb + 7]);
        } else {
          u = f(f(f(f(F[tb] * sx) + f(F[tb + 1] * sy)) + F[tb + 2]) + F[tb + 3]);
          v = f(f(f(f(F[tb + 4] * sx) + f(F[tb + 5] * sy)) + F[tb + 6]) + F[tb + 7]);
        }
        if (proj3) {
          w = useZ ? f(f(f(f(F[tb + 8] * sx) + f(F[tb + 9] * sy)) + f(F[tb + 10] * sz)) + F[tb + 11]) : f(f(f(f(F[tb + 8] * sx) + f(F[tb + 9] * sy)) + F[tb + 10]) + F[tb + 11]);
        }
        if (dual) {
          const pw = W[0x1050 + n];
          const qb = 0x500 + (pw & 63) * 4;
          if (sp) {
            const nu = f(f(f(f(F[qb] * u) + f(F[qb + 1] * v)) + F[qb + 2]) + F[qb + 3]);
            const nv = f(f(f(f(F[qb + 4] * u) + f(F[qb + 5] * v)) + F[qb + 6]) + F[qb + 7]);
            u = nu; v = nv; w = 1;
          } else {
            let iu = u, iv = v, iw = w;
            if ((pw >> 8) & 1) {
              const inv = f(1 / fsqrt(dot3(iu, iv, iw, iu, iv, iw)));
              iu = f(iu * inv); iv = f(iv * inv); iw = f(iw * inv);
            }
            u = f(f(f(f(F[qb] * iu) + f(F[qb + 1] * iv)) + f(F[qb + 2] * iw)) + F[qb + 3]);
            v = f(f(f(f(F[qb + 4] * iu) + f(F[qb + 5] * iv)) + f(F[qb + 6] * iw)) + F[qb + 7]);
            w = f(f(f(f(F[qb + 8] * iu) + f(F[qb + 9] * iv)) + f(F[qb + 10] * iw)) + F[qb + 11]);
          }
        }
      } else if (type === 1) {
        // emboss: the generated coordinate (before its size scale) of generator `esrc` moved by the light direction's share on the tangent and binormal
        const esrc = (T >> 12) & 7, li = (T >> 15) & 7;
        const lb = 0x600 + 16 * li;
        let lx = f(F[lb + 10] - ex), ly = f(F[lb + 11] - ey), lz = f(F[lb + 12] - ez);
        const len = fsqrt(dot3(lx, ly, lz, lx, ly, lz));
        if (len === 0) { lx = ly = lz = 0; } else { const inv = f(1 / len); lx = f(lx * inv); ly = f(ly * inv); lz = f(lz * inv); }
        const d1 = dot3(lx, ly, lz, t1x, t1y, t1z);
        const d2 = dot3(lx, ly, lz, t2x, t2y, t2z);
        u = f(pre[esrc * 3] + d1); v = f(pre[esrc * 3 + 1] + d2); w = pre[esrc * 3 + 2];
      } else {
        const c = type === 2 ? 0 : 1;
        u = f(D[o + V_COL + c * 4] / 255); v = f(D[o + V_COL + c * 4 + 1] / 255); w = 1;
      }
      pre[n * 3] = u; pre[n * 3 + 1] = v; pre[n * 3 + 2] = w;
      // scale by the texture size
      u = f(u * (bits(bp[0x30 + 2 * n], 0, 16) + 1));
      v = f(v * (bits(bp[0x31 + 2 * n], 0, 16) + 1));
      D[o + V_T + n * 3] = u; D[o + V_T + n * 3 + 1] = v; D[o + V_T + n * 3 + 2] = w;
    }
  }
  return base;
}

// ---------------------------------------------------------------------------------------------------------------------
// primitive assembly (4), clipping (5), viewport (6)

/** the vertex triples of a primitive of `count` vertices starting at `base`, in the order the spec lists them */
export function assemble(type: number, count: number, base: number, out: number[]): void {
  switch (type) {
    case 0: case 1: {
      let i = 0;
      for (; i + 3 < count; i += 4) out.push(base + i, base + i + 1, base + i + 2, base + i, base + i + 2, base + i + 3);
      if (count - i === 3) out.push(base + i, base + i + 1, base + i + 2);
      break;
    }
    case 2:
      for (let i = 0; i + 2 < count; i += 3) out.push(base + i, base + i + 1, base + i + 2);
      break;
    case 3:
      for (let i = 0; i + 2 < count; i++) {
        if (i & 1) out.push(base + i, base + i + 2, base + i + 1);
        else out.push(base + i, base + i + 1, base + i + 2);
      }
      break;
    case 4:
      for (let i = 1; i + 1 < count; i++) out.push(base, base + i, base + i + 1);
      break;
  }
}

/** clip codes of a vertex (5.1) */
export function clipCode(D: Float64Array, o: number): number {
  const cx = D[o + V_C], cy = D[o + V_C + 1], cz = D[o + V_C + 2], cw = D[o + V_C + 3];
  let c = 0;
  if (f(cw - cx) < 0) c |= 1;
  if (f(cx + cw) < 0) c |= 2;
  if (f(cw - cy) < 0) c |= 4;
  if (f(cy + cw) < 0) c |= 8;
  if (f(cw * cz) > 0) c |= 16;
  if (f(cz + cw) < 0) c |= 32;
  return c;
}

// the plane coefficients A B C D of 5.3
const PA = [-1, 1, 0, 0, 0, 0], PB = [0, 0, -1, 1, 0, 0], PC = [0, 0, 0, 0, 0, 1], PD = [1, 1, 1, 1, 1, 1];

function planeDist(D: Float64Array, o: number, k: number): number {
  return f(f(f(f(D[o + V_C] * PA[k]) + f(D[o + V_C + 1] * PB[k])) + f(D[o + V_C + 2] * PC[k])) + f(D[o + V_C + 3] * PD[k]));
}

/** a new vertex a + (b - a) * t in the pool */
export function lerpVertex(pool: Pool, t: number, a: number, b: number): number {
  const o = pool.alloc();
  const D = pool.data;
  for (let k = 0; k < V_COL; k++) D[o + k] = f(D[a + k] + f(f(D[b + k] - D[a + k]) * t));
  const ti = trunc32(f(t * 256)) & 0xffff;
  for (let k = 0; k < 8; k++) {
    const ca = D[a + V_COL + k], cb = D[b + V_COL + k];
    D[o + V_COL + k] = (ca + (((cb - ca) * ti) >> 8)) & 255;
  }
  return o;
}

/** the polygon of a clipped triangle: pool offsets of its vertices, `polyState.n` of them */
export const poly: Int32Array = new Int32Array(16);
export const polyState = { n: 0 };
const tmpPoly = new Int32Array(16);

/** the screen position of a vertex (6) */
export function viewport(x: XfDraw, D: Float64Array, o: number, out: Float64Array | number[]): void {
  const winv = f(1 / D[o + V_C + 3]);
  const vp = x.vp;
  out[0] = f(f(f(D[o + V_C] * winv) * vp[0]) + f(vp[3] - 342));
  out[1] = f(f(f(D[o + V_C + 1] * winv) * vp[1]) + f(vp[4] - 342));
  out[2] = f(f(f(D[o + V_C + 2] * winv) * vp[2]) + vp[5]);
}

/** cull and clip one triangle (5.2, 5.3). Fills `poly` / `polyState.n` with the polygon's vertices (back-face swap applied) and returns
 *  true, or returns false when the triangle is discarded. */
export function cullClipInto(pool: Pool, cullMode: number, a: number, b: number, c: number): boolean {
  const D = pool.data;
  const ca = clipCode(D, a), cb = clipCode(D, b), cc = clipCode(D, c);
  if (ca & cb & cc) return false;
  const x0 = D[a + V_C], y0 = D[a + V_C + 1], w0 = D[a + V_C + 3];
  const x1 = D[b + V_C], y1 = D[b + V_C + 1], w1 = D[b + V_C + 3];
  const x2 = D[c + V_C], y2 = D[c + V_C + 1], w2 = D[c + V_C + 3];
  const nz = f(f(f(f(x0 * w2) - f(x2 * w0)) * y1) + f(f(f(x2 * y0) - f(x0 * y2)) * w1)) + f(f(f(y2 * w0) - f(y0 * w2)) * x1);
  const back = nz <= 0;
  if ((cullMode & 1) && !back) return false;
  if ((cullMode & 2) && back) return false;
  let n = 3;
  poly[0] = a; poly[1] = back ? c : b; poly[2] = back ? b : c;
  const orc = ca | cb | cc;
  if (orc !== 0) {
    for (let k = 0; k < 6; k++) {
      if (!(orc & (1 << k))) continue;
      let m = 0;
      let prev = poly[0];
      let dprev = planeDist(pool.data, prev, k);
      for (let i = 1; i <= n; i++) {
        const cur = poly[i === n ? 0 : i];
        const dcur = planeDist(pool.data, cur, k);
        if (dprev >= 0) tmpPoly[m++] = prev;
        if ((dcur <= 0 && dprev > 0) || (dcur > 0 && dprev <= 0)) {
          if (dcur < 0) {
            const t = f(dcur / f(dcur - dprev));
            tmpPoly[m++] = lerpVertex(pool, t, cur, prev);
          } else {
            const t = f(dprev / f(dprev - dcur));
            tmpPoly[m++] = lerpVertex(pool, t, prev, cur);
          }
        }
        prev = cur; dprev = dcur;
      }
      if (m < 3) return false;
      for (let i = 0; i < m; i++) poly[i] = tmpPoly[i];
      n = m;
    }
  }
  polyState.n = n;
  return true;
}

/** as cullClipInto, returning the polygon as an array (or null) */
export function cullClip(pool: Pool, cullMode: number, a: number, b: number, c: number): number[] | null {
  if (!cullClipInto(pool, cullMode, a, b, c)) return null;
  return Array.from(poly.subarray(0, polyState.n));
}

// ---------------------------------------------------------------------------------------------------------------------
// lines (4.4, 5.4, 8.5): UNVERIFIED by the recorded windows

const LC = [0, 0, 0, 0, -1, 1];

function lineDist(D: Float64Array, o: number, k: number): number {
  return f(f(f(f(D[o + V_C] * PA[k]) + f(D[o + V_C + 1] * PB[k])) + f(D[o + V_C + 2] * LC[k])) + f(D[o + V_C + 3] * PD[k]));
}

/** clip a line (5.4): the pool offsets of its ends (new vertices where an end was cut), or null when it is discarded */
export function clipLine(pool: Pool, a: number, b: number): [number, number] | null {
  const D = pool.data;
  const c0 = clipCode(D, a), c1 = clipCode(D, b);
  const orc = c0 | c1;
  if (orc === 0) return [a, b];
  let t0 = 0, t1 = 0;
  for (let k = 0; k < 6; k++) {
    if (!(orc & (1 << k))) continue;
    const d0 = lineDist(D, a, k), d1 = lineDist(D, b, k);
    if (d0 < 0 && d1 < 0) return null;
    if (d1 < 0) { const t = f(d1 / f(d1 - d0)); if (t > t1) t1 = t; }
    else if (d0 < 0) { const t = f(d0 / f(d0 - d1)); if (t > t0) t0 = t; }
  }
  const na = c0 !== 0 ? lerpVertex(pool, t0, a, b) : a;
  const nb = c1 !== 0 ? lerpVertex(pool, t1, b, a) : b;
  return [na, nb];
}

/** The two triangles of a clipped line (8.5), as screen positions (9 numbers each: x, y, depth for three corners) and the pool vertices whose
 *  color, depth and coordinates they carry. The pieces have clip w 0 (the spec's quirk). `size` is BP 0x22 bits 0..7. */
export function lineTriangles(pool: Pool, x: XfDraw, a: number, b: number, size: number, out: { scr: Float64Array; v: [number, number, number] }[]): void {
  const D = pool.data;
  const p0 = new Float64Array(3), p1 = new Float64Array(3);
  viewport(x, D, a, p0); viewport(x, D, b, p1);
  const dx = f(p1[0] - p0[0]), dy = f(p1[1] - p0[1]);
  let ox: number, oy: number;
  if (Math.abs(dx) > Math.abs(dy)) { ox = 0; oy = dx > 0 ? f(size / -12) : f(size / 12); }
  else { oy = 0; ox = dy > 0 ? f(size / 12) : f(size / -12); }
  // four pieces' vertices: ends with their colors, depths and coordinates, clip w 0
  const mk = (src: number): number => {
    const o = pool.alloc();
    const E = pool.data;
    for (let k = 0; k < V_STRIDE; k++) E[o + k] = E[src + k];
    E[o + V_C + 3] = 0;
    for (let k = 4; k < 8; k++) E[o + V_COL + k] = 0;
    return o;
  };
  const va = mk(a), vb = mk(b);
  const P = (p: Float64Array, sx: number, sy: number): [number, number, number] => [f(p[0] + sx), f(p[1] + sy), p[2]];
  const tri = (c: [number, number, number][], v: [number, number, number]) => {
    const scr = new Float64Array(9);
    for (let i = 0; i < 3; i++) { scr[i * 3] = c[i][0]; scr[i * 3 + 1] = c[i][1]; scr[i * 3 + 2] = c[i][2]; }
    out.push({ scr, v });
  };
  // triangle A: (p1 - o, p1 + o, p0 + o), triangle B: (p0 + o, p0 - o, p1 - o)
  tri([P(p1, -ox, -oy), P(p1, ox, oy), P(p0, ox, oy)], [vb, vb, va]);
  tri([P(p0, ox, oy), P(p0, -ox, -oy), P(p1, -ox, -oy)], [va, va, vb]);
}
