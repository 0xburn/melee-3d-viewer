/* GX renderer: the transform unit (spec sections 3, 5, 6): vertices to eye and clip space, the lit channel colors, the
 * texture coordinates; then culling, clipping and the viewport. Every float operation is rounded to binary32 (f.ts).
 *
 * A transformed vertex is a run of doubles (each holding a float exactly) in one big pool, `Pool`, at a vertex's offset:
 * eye position (3), clip position (4), normal, tangent, binormal (3 each), texture coordinates u v w of generators 0..7
 * (24), then the two color channels' bytes as numbers (8). Clipping makes new vertices in the same pool.
 */
import { f, fromBits, fsqrt, ONE_MINUS_EPS, trunc32 } from "./f32";
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

/** XF registers as floats and words, for one draw */
export class XfView {
  readonly w: Uint32Array;
  readonly fl: Float32Array;
  constructor(regs: GxRegs) {
    this.w = regs.xf;
    this.fl = new Float32Array(regs.xf.buffer, regs.xf.byteOffset, regs.xf.length);
  }
}

const max0 = (v: number): number => (0 < v ? v : 0);
const safeDiv = (n: number, d: number): number => (d === 0 ? (n > 0 ? 1 : 0) : f(n / d));

interface Light {
  color: number;
  k: [number, number, number];
  d: [number, number, number];
  pos: [number, number, number];
  dir: [number, number, number];
}

function readLight(xf: XfView, n: number): Light {
  const b = 0x600 + 16 * n, F = xf.fl;
  return {
    color: xf.w[b + 3],
    k: [F[b + 4], F[b + 5], F[b + 6]], d: [F[b + 7], F[b + 8], F[b + 9]],
    pos: [F[b + 10], F[b + 11], F[b + 12]], dir: [F[b + 13], F[b + 14], F[b + 15]],
  };
}

const dot3 = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): number =>
  f(f(f(ax * bx) + f(ay * by)) + f(az * bz));

/** normalize by multiplying with 1/length; a zero vector stays zero */
function normalize3(v: number[]): void {
  const len = fsqrt(dot3(v[0], v[1], v[2], v[0], v[1], v[2]));
  if (len === 0) { v[0] = v[1] = v[2] = 0; return; }
  const inv = f(1 / len);
  v[0] = f(v[0] * inv); v[1] = f(v[1] * inv); v[2] = f(v[2] * inv);
}

export interface XfDraw {
  xf: XfView;
  numChannels: number;
  numGens: number;
  lights: Light[];
  /** projection */
  proj: number[];
  ortho: boolean;
  /** viewport wd, ht, zr, xo, yo, zf */
  vp: number[];
  special: boolean;
}

export function xfDraw(regs: GxRegs, vd: VertexData): XfDraw {
  const xf = new XfView(regs);
  const F = xf.fl;
  const lights: Light[] = [];
  for (let n = 0; n < 8; n++) lights.push(readLight(xf, n));
  const L = vd.layout;
  const special = L.pos.kind !== 0 && L.tex[0].kind !== 0 && !L.tex.slice(1).some((a) => a.kind) && !L.posMtx && !L.texMtx.some((x) => x) &&
    L.nrm.kind === 0 && L.col[0].kind === 0 && L.col[1].kind === 0;
  return {
    xf, numChannels: bits(xf.w[0x1009], 0, 2), numGens: bits(xf.w[0x103f], 0, 4), lights,
    proj: [F[0x1020], F[0x1021], F[0x1022], F[0x1023], F[0x1024], F[0x1025]], ortho: xf.w[0x1026] !== 0,
    vp: [F[0x101a], F[0x101b], F[0x101c], F[0x101d], F[0x101e], F[0x101f]], special,
  };
}

/** the per-light attenuation and diffuse terms for a control word, E the eye position, N the unit normal */
function lightTerms(ctrl: number, lt: Light, E: number[], N: number[], out: number[]): void {
  const dfn = bits(ctrl, 7, 2), afn = bits(ctrl, 9, 2);
  const ldir = [f(lt.pos[0] - E[0]), f(lt.pos[1] - E[1]), f(lt.pos[2] - E[2])];
  let attn = 1;
  if (afn === 3) {
    const dist2 = dot3(ldir[0], ldir[1], ldir[2], ldir[0], ldir[1], ldir[2]);
    const dist = fsqrt(dist2);
    const inv = f(1 / dist);
    ldir[0] = f(ldir[0] * inv); ldir[1] = f(ldir[1] * inv); ldir[2] = f(ldir[2] * inv);
    const a = max0(dot3(ldir[0], ldir[1], ldir[2], lt.dir[0], lt.dir[1], lt.dir[2]));
    const cosAtt = f(f(lt.k[0] + f(lt.k[1] * a)) + f(f(lt.k[2] * a) * a));
    const distAtt = f(f(lt.d[0] + f(lt.d[1] * dist)) + f(lt.d[2] * dist2));
    attn = safeDiv(max0(cosAtt), distAtt);
  } else {
    normalize3(ldir);
    if (ldir[0] === 0 && ldir[1] === 0 && ldir[2] === 0) { ldir[0] = N[0]; ldir[1] = N[1]; ldir[2] = N[2]; }
    if (afn === 1) {
      const a = dot3(ldir[0], ldir[1], ldir[2], N[0], N[1], N[2]) >= 0 ? max0(dot3(lt.dir[0], lt.dir[1], lt.dir[2], N[0], N[1], N[2])) : 0;
      const a2 = f(a * a);
      const dd = [lt.d[0], lt.d[1], lt.d[2]];
      if (dfn !== 0) normalize3(dd);
      const num = max0(f(f(f(1 * lt.k[0]) + f(a * lt.k[1])) + f(a2 * lt.k[2])));
      const den = f(f(f(1 * dd[0]) + f(a * dd[1])) + f(a2 * dd[2]));
      attn = safeDiv(num, den);
    }
  }
  out[0] = attn;
  out[1] = dot3(ldir[0], ldir[1], ldir[2], N[0], N[1], N[2]);
}

const lightOut = [0, 0];

/** one channel's 4 bytes: the color control word at XF 0x100E + ch, the alpha control at 0x1010 + ch */
function channelBytes(x: XfDraw, ch: number, vcol: Uint8Array | null, vi: number, E: number[], N: number[], out: number[]): void {
  const w = x.xf.w;
  const matReg = w[0x100c + ch], ambReg = w[0x100a + ch];
  for (let part = 0; part < 2; part++) {
    const ctrl = w[(part === 0 ? 0x100e : 0x1010) + ch];
    const comps = part === 0 ? 3 : 1;
    const base = part === 0 ? 0 : 3;
    const shifts = part === 0 ? [24, 16, 8] : [0];
    const ambV = bits(ctrl, 6, 1) === 1, matV = bits(ctrl, 0, 1) === 1;
    if (bits(ctrl, 1, 1) === 0) {
      for (let c = 0; c < comps; c++) out[base + c] = matV ? (vcol ? vcol[vi * 4 + base + c] : 0) : (matReg >>> shifts[c]) & 255;
      continue;
    }
    const L = [0, 0, 0];
    for (let c = 0; c < comps; c++) L[c] = ambV ? (vcol ? vcol[vi * 4 + base + c] : 0) : (ambReg >>> shifts[c]) & 255;
    const dfn = bits(ctrl, 7, 2);
    for (let n = 0; n < 8; n++) {
      const mbit = n < 4 ? 2 + n : 11 + (n - 4);
      if (!bits(ctrl, mbit, 1)) continue;
      const lt = x.lights[n];
      lightTerms(ctrl, lt, E, N, lightOut);
      const attn = lightOut[0], dif = lightOut[1];
      for (let c = 0; c < comps; c++) {
        const lc = (lt.color >>> (part === 0 ? shifts[c] : 0)) & 255;
        if (part === 0) {
          const s = dfn === 0 ? attn : dfn === 1 ? f(attn * dif) : f(attn * max0(dif));
          L[c] = f(L[c] + f(lc * s));
        } else {
          let t = f(lc * attn);
          if (dfn === 1) t = f(t * dif); else if (dfn === 2) t = f(t * max0(dif));
          L[c] = f(L[c] + t);
        }
      }
    }
    for (let c = 0; c < comps; c++) {
      const t = trunc32(L[c]);
      const li = t < 0 ? 0 : t > 255 ? 255 : t;
      const mat = matV ? (vcol ? vcol[vi * 4 + base + c] : 0) : (matReg >>> shifts[c]) & 255;
      out[base + c] = (mat * (li + (li >> 7))) >> 8;
    }
  }
}

/** transform all vertices of a draw into the pool; returns the pool offset of vertex 0 (vertex i is at base + i * V_STRIDE) */
export function transformVertices(x: XfDraw, regs: GxRegs, vd: VertexData, pool: Pool): number {
  const base = pool.n * V_STRIDE;
  const F = x.xf.fl, W = x.xf.w;
  const L = vd.layout;
  const [p0, p1, p2, p3, p4, p5] = x.proj;
  const colOut = [0, 0, 0, 0];
  const E = [0, 0, 0], N = [0, 0, 1];
  const bp = regs.bp;
  for (let i = 0; i < vd.n; i++) {
    const o = pool.alloc();
    const D = pool.data;
    const pm = vd.pmtx[i] | 0;
    const px = vd.pos[i * 3], py = vd.pos[i * 3 + 1], pz = vd.pos[i * 3 + 2];
    const mb = pm * 4;
    const m0 = F[mb], m1 = F[mb + 1], m2 = F[mb + 2], m3 = F[mb + 3], m4 = F[mb + 4], m5 = F[mb + 5], m6 = F[mb + 6], m7 = F[mb + 7],
      m8 = F[mb + 8], m9 = F[mb + 9], m10 = F[mb + 10], m11 = F[mb + 11];
    const ex = f(f(f(f(m0 * px) + f(m1 * py)) + f(m2 * pz)) + m3);
    const ey = f(f(f(f(m4 * px) + f(m5 * py)) + f(m6 * pz)) + m7);
    const ez = f(f(f(f(m8 * px) + f(m9 * py)) + f(m10 * pz)) + m11);
    D[o + V_E] = ex; D[o + V_E + 1] = ey; D[o + V_E + 2] = ez;
    if (!x.ortho) {
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
    let tn1x = 0, tn1y = 0, tn1z = 0, tn2x = 0, tn2y = 0, tn2z = 0;
    let rawN = [0, 0, 0];
    if (L.nrm.kind) {
      const nb = 0x400 + (pm & 31) * 3;
      const q0 = F[nb], q1 = F[nb + 1], q2 = F[nb + 2], q3 = F[nb + 3], q4 = F[nb + 4], q5 = F[nb + 5], q6 = F[nb + 6], q7 = F[nb + 7], q8 = F[nb + 8];
      const mul = (nx: number, ny: number, nz: number): number[] => [
        f(f(f(q0 * nx) + f(q1 * ny)) + f(q2 * nz)), f(f(f(q3 * nx) + f(q4 * ny)) + f(q5 * nz)), f(f(f(q6 * nx) + f(q7 * ny)) + f(q8 * nz))];
      rawN = [vd.nrm[i * 3], vd.nrm[i * 3 + 1], vd.nrm[i * 3 + 2]];
      const n0 = mul(rawN[0], rawN[1], rawN[2]);
      const len = fsqrt(dot3(n0[0], n0[1], n0[2], n0[0], n0[1], n0[2]));
      const inv = f(1 / len);
      N[0] = f(n0[0] * inv); N[1] = f(n0[1] * inv); N[2] = f(n0[2] * inv);
      D[o + V_N0] = N[0]; D[o + V_N0 + 1] = N[1]; D[o + V_N0 + 2] = N[2];
      if (L.nbt) {
        const t1 = mul(vd.nrm1[i * 3], vd.nrm1[i * 3 + 1], vd.nrm1[i * 3 + 2]);
        const t2 = mul(vd.nrm2[i * 3], vd.nrm2[i * 3 + 1], vd.nrm2[i * 3 + 2]);
        tn1x = t1[0]; tn1y = t1[1]; tn1z = t1[2]; tn2x = t2[0]; tn2y = t2[1]; tn2z = t2[2];
        D[o + V_N1] = tn1x; D[o + V_N1 + 1] = tn1y; D[o + V_N1 + 2] = tn1z;
        D[o + V_N2] = tn2x; D[o + V_N2 + 1] = tn2y; D[o + V_N2 + 2] = tn2z;
      }
    } else { N[0] = N[1] = 0; N[2] = 0; }
    // channel colors
    E[0] = ex; E[1] = ey; E[2] = ez;
    for (let ch = 0; ch < 2; ch++) {
      if (ch < x.numChannels) {
        channelBytes(x, ch, L.col[ch].kind ? vd.col[ch] : null, i, E, N, colOut);
        for (let k = 0; k < 4; k++) D[o + V_COL + ch * 4 + k] = colOut[k];
      } else for (let k = 0; k < 4; k++) D[o + V_COL + ch * 4 + k] = 0;
    }
    // texture coordinates
    for (let n = 0; n < x.numGens; n++) {
      const T = W[0x1040 + n];
      const proj3 = bits(T, 1, 1) === 1, abc1 = bits(T, 2, 1) === 1, type = bits(T, 4, 3), src = bits(T, 7, 5);
      let u = 0, v = 0, w = 1;
      const tmIdx = L.texMtx[n] ? vd.tmtx[n][i] | 0 : n < 4 ? bits(W[0x1018], 6 + 6 * n, 6) : bits(W[0x1019], 6 * (n - 4), 6);
      if (type === 0) {
        let sx = 0, sy = 0, sz = 0;
        if (src === 0) { sx = px; sy = py; sz = pz; }
        else if (src === 1) { sx = rawN[0]; sy = rawN[1]; sz = rawN[2]; }
        else if (src === 3 && L.nbt) { sx = vd.nrm1[i * 3]; sy = vd.nrm1[i * 3 + 1]; sz = vd.nrm1[i * 3 + 2]; }
        else if (src === 4 && L.nbt) { sx = vd.nrm2[i * 3]; sy = vd.nrm2[i * 3 + 1]; sz = vd.nrm2[i * 3 + 2]; }
        else if (src >= 5) {
          const k = src - 5;
          if (k < 8 && L.tex[k].kind) {
            sx = vd.tex[k][i * 2]; sy = vd.tex[k][i * 2 + 1];
            sz = k + 1 < 8 && L.tex[k + 1].kind ? vd.tex[k + 1][i * 2] : 0;
          }
        }
        const tb = tmIdx * 4;
        const a0 = F[tb], a1 = F[tb + 1], a2 = F[tb + 2], a3 = F[tb + 3], a4 = F[tb + 4], a5 = F[tb + 5], a6 = F[tb + 6], a7 = F[tb + 7],
          a8 = F[tb + 8], a9 = F[tb + 9], a10 = F[tb + 10], a11 = F[tb + 11];
        const sp = x.special && !proj3;
        const useZ = abc1 && !sp;
        if (useZ) {
          u = f(f(f(f(a0 * sx) + f(a1 * sy)) + f(a2 * sz)) + a3);
          v = f(f(f(f(a4 * sx) + f(a5 * sy)) + f(a6 * sz)) + a7);
        } else {
          u = f(f(f(f(a0 * sx) + f(a1 * sy)) + a2) + a3);
          v = f(f(f(f(a4 * sx) + f(a5 * sy)) + a6) + a7);
        }
        if (proj3) {
          w = useZ ? f(f(f(f(a8 * sx) + f(a9 * sy)) + f(a10 * sz)) + a11) : f(f(f(f(a8 * sx) + f(a9 * sy)) + a10) + a11);
        } else w = 1;
        if (bits(W[0x1012], 0, 1)) {
          const pi = bits(W[0x1050 + n], 0, 6), qb = 0x500 + pi * 4;
          const q0 = F[qb], q1 = F[qb + 1], q2 = F[qb + 2], q3 = F[qb + 3], q4 = F[qb + 4], q5 = F[qb + 5], q6 = F[qb + 6], q7 = F[qb + 7],
            q8 = F[qb + 8], q9 = F[qb + 9], q10 = F[qb + 10], q11 = F[qb + 11];
          if (sp) {
            const nu = f(f(f(f(q0 * u) + f(q1 * v)) + q2) + q3);
            const nv = f(f(f(f(q4 * u) + f(q5 * v)) + q6) + q7);
            u = nu; v = nv; w = 1;
          } else {
            let iu = u, iv = v, iw = w;
            if (bits(W[0x1050 + n], 8, 1)) {
              const inv = f(1 / fsqrt(dot3(iu, iv, iw, iu, iv, iw)));
              iu = f(iu * inv); iv = f(iv * inv); iw = f(iw * inv);
            }
            u = f(f(f(f(q0 * iu) + f(q1 * iv)) + f(q2 * iw)) + q3);
            v = f(f(f(f(q4 * iu) + f(q5 * iv)) + f(q6 * iw)) + q7);
            w = f(f(f(f(q8 * iu) + f(q9 * iv)) + f(q10 * iw)) + q11);
          }
        }
      } else if (type === 1) {
        // emboss: the generated coordinate of generator `esrc` moved by the light direction's share on the tangent and binormal
        const esrc = bits(T, 12, 3), li = bits(T, 15, 3);
        const lt = x.lights[li];
        const ld = [f(lt.pos[0] - ex), f(lt.pos[1] - ey), f(lt.pos[2] - ez)];
        normalize3(ld);
        const d1 = dot3(ld[0], ld[1], ld[2], tn1x, tn1y, tn1z);
        const d2 = dot3(ld[0], ld[1], ld[2], tn2x, tn2y, tn2z);
        const so = o + V_T + esrc * 3;
        u = f(D[so] + d1); v = f(D[so + 1] + d2); w = D[so + 2];
      } else {
        const c = type === 2 ? 0 : 1;
        u = f(D[o + V_COL + c * 4] / 255); v = f(D[o + V_COL + c * 4 + 1] / 255); w = 1;
      }
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

const PLANES = [[-1, 0, 0, 1], [1, 0, 0, 1], [0, -1, 0, 1], [0, 1, 0, 1], [0, 0, 0, 1], [0, 0, 1, 1]];

function planeDist(D: Float64Array, o: number, p: number[]): number {
  return f(f(f(f(D[o + V_C] * p[0]) + f(D[o + V_C + 1] * p[1])) + f(D[o + V_C + 2] * p[2])) + f(D[o + V_C + 3] * p[3]));
}

/** a new vertex a + (b - a) * t in the pool */
function lerpVertex(pool: Pool, t: number, a: number, b: number): number {
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

/** the screen position of a vertex (6) */
export function viewport(x: XfDraw, D: Float64Array, o: number, out: number[]): void {
  const winv = f(1 / D[o + V_C + 3]);
  const [wd, ht, zr, xo, yo, zf] = x.vp;
  out[0] = f(f(f(D[o + V_C] * winv) * wd) + f(xo - 342));
  out[1] = f(f(f(D[o + V_C + 1] * winv) * ht) + f(yo - 342));
  out[2] = f(f(f(D[o + V_C + 2] * winv) * zr) + zf);
}

export interface ClipResult { polys: number[][] }

/** cull and clip one triangle (5.2, 5.3). Returns the pool offsets of the polygon's vertices (back-face swap applied), or null when
 *  the triangle is discarded. */
export function cullClip(pool: Pool, cullMode: number, a: number, b: number, c: number): number[] | null {
  const D = pool.data;
  const ca = clipCode(D, a), cb = clipCode(D, b), cc = clipCode(D, c);
  if (ca & cb & cc) return null;
  const x0 = D[a + V_C], y0 = D[a + V_C + 1], w0 = D[a + V_C + 3];
  const x1 = D[b + V_C], y1 = D[b + V_C + 1], w1 = D[b + V_C + 3];
  const x2 = D[c + V_C], y2 = D[c + V_C + 1], w2 = D[c + V_C + 3];
  const nz = f(f(f(f(x0 * w2) - f(x2 * w0)) * y1) + f(f(f(x2 * y0) - f(x0 * y2)) * w1)) + f(f(f(y2 * w0) - f(y0 * w2)) * x1);
  const back = nz <= 0;
  if ((cullMode & 1) && !back) return null;
  if ((cullMode & 2) && back) return null;
  let poly = back ? [a, c, b] : [a, b, c];
  const orc = ca | cb | cc;
  if (orc === 0) return poly;
  for (let k = 0; k < 6; k++) {
    if (!(orc & (1 << k))) continue;
    const p = PLANES[k];
    const out: number[] = [];
    let prev = poly[0];
    let dprev = planeDist(pool.data, prev, p);
    for (let i = 1; i <= poly.length; i++) {
      const cur = poly[i % poly.length];
      const dcur = planeDist(pool.data, cur, p);
      if (dprev >= 0) out.push(prev);
      if ((dcur <= 0 && dprev > 0) || (dcur > 0 && dprev <= 0)) {
        if (dcur < 0) {
          const t = f(dcur / f(dcur - dprev));
          out.push(lerpVertex(pool, t, cur, prev));
        } else {
          const t = f(dprev / f(dprev - dcur));
          out.push(lerpVertex(pool, t, prev, cur));
        }
      }
      prev = cur; dprev = dcur;
    }
    if (out.length < 3) return null;
    poly = out;
  }
  return poly;
}
