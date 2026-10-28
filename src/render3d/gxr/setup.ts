/* GX renderer: triangle setup (spec section 7): the screen vertices of a clipped triangle to the integer edge
 * constants of the coverage test and the float planes the pixel stage evaluates. */
import { f, flt, trunc32 } from "./f32";
import { bits } from "./state";
import { Pool, V_C, V_COL, V_T, viewport, XfDraw } from "./xform";

/** plane numbers in `Tri.planes` (3 floats each: f0, dfdx, dfdy) */
export const P_INVW = 0, P_Z = 1, P_COL = 2, P_TEX = 10;

export interface Tri {
  /** the draw state (index into the renderer's table) */
  state: number;
  X0: number; Y0: number;
  DX12: number; DY12: number; DX23: number; DY23: number; DX31: number; DY31: number;
  C1: number; C2: number; C3: number;
  /** pixel rectangle of the blocks to visit: minx, miny even, maxx and maxy exclusive */
  minx: number; maxx: number; miny: number; maxy: number;
  xi: number; yi: number; ox: number; oy: number;
  planes: Float32Array;
  np: number;
}

/** register state setup needs from BP */
export interface SetupCtx {
  numGens: number;
  numCols: number;
  /** BP 0x00 bit 19: the depth plane is not recomputed (7.4) */
  zFreeze: boolean;
  L: number; T: number; R: number; B: number;
}

export function setupCtx(bp: Uint32Array): SetupCtx {
  const gm = bp[0x00];
  const tl = bp[0x20], br = bp[0x21], off = bp[0x59];
  const ox = 2 * bits(off, 0, 10), oy = 2 * bits(off, 10, 10);
  return {
    numGens: bits(gm, 0, 4), numCols: bits(gm, 4, 3), zFreeze: bits(gm, 19, 1) === 1,
    L: Math.max(0, bits(tl, 12, 12) - ox), T: Math.max(0, bits(tl, 0, 12) - oy),
    R: Math.min(640, bits(br, 12, 12) - ox + 1), B: Math.min(528, bits(br, 0, 12) - oy + 1),
  };
}

const snap = (v: number): number => {
  const t = trunc32(v);
  return (f(v - t) >= 0.5 ? (t + 1) | 0 : t) | 0;
};

/** the header of the triangle set up last by setupTriInto */
export const TS = {
  X0: 0, Y0: 0, DX12: 0, DY12: 0, DX23: 0, DY23: 0, DX31: 0, DY31: 0, C1: 0, C2: 0, C3: 0,
  minx: 0, maxx: 0, miny: 0, maxy: 0, xi: 0, yi: 0, ox: 0, oy: 0, np: 0,
};

const sp = new Float64Array(3);
const SX = new Float64Array(3), SY = new Float64Array(3), SZ = new Float64Array(3);
const X = new Int32Array(3), Y = new Int32Array(3);
const IW = new Float64Array(3);
/** the depth plane of the last triangle (z freeze reuses it) */
const lastZ = new Float32Array(3);
/** set when a triangle computed a depth plane of its own (not frozen): the draws on another thread tell the main thread which plane z freeze must reuse */
export const zInfo = { wrote: false };
export const getLastZ = (out: Float32Array): void => { out[0] = lastZ[0]; out[1] = lastZ[1]; out[2] = lastZ[2]; };
export const setLastZ = (v: ArrayLike<number>): void => { lastZ[0] = v[0]; lastZ[1] = v[1]; lastZ[2] = v[2]; };
// the plane solver's shared terms (7.4)
let g_fdx31 = 0, g_fdx12 = 0, g_nfdy12 = 0, g_fdy31 = 0, g_cden = 0;

function plane(dst: Float32Array, o: number, f0: number, f1: number, f2: number): void {
  const DF31 = f(f2 - f0), DF21 = f(f1 - f0);
  const pa = f(f(DF31 * g_nfdy12) - f(DF21 * g_fdy31));
  const pb = f(f(g_fdx31 * DF21) + f(g_fdx12 * DF31));
  dst[o] = f0; dst[o + 1] = f(-pa / g_cden); dst[o + 2] = f(-pb / g_cden);
}

/** set up one triangle from pool vertices a, b, c (in this order). Returns false when it covers no block; otherwise the header is in
 *  `TS` and the planes (TS.np of them, 3 floats each) are written to dst from dstOff. */
export function setupTriInto(pool: Pool, x: XfDraw, sc: SetupCtx, a: number, b: number, c: number, dst: Float32Array, dstOff: number, screen: Float64Array | null = null, stride = 3): boolean {
  const D = pool.data;
  if (screen) {
    for (let i = 0; i < 3; i++) { SX[i] = screen[i * 3]; SY[i] = screen[i * 3 + 1]; SZ[i] = screen[i * 3 + 2]; }
  } else {
    viewport(x, D, a, sp); SX[0] = sp[0]; SY[0] = sp[1]; SZ[0] = sp[2];
    viewport(x, D, b, sp); SX[1] = sp[0]; SY[1] = sp[1]; SZ[1] = sp[2];
    viewport(x, D, c, sp); SX[2] = sp[0]; SY[2] = sp[1]; SZ[2] = sp[2];
  }
  for (let i = 0; i < 3; i++) { X[i] = (snap(f(16 * SX[i])) - 9) | 0; Y[i] = (snap(f(16 * SY[i])) - 9) | 0; }
  const DX12 = (X[0] - X[1]) | 0, DX23 = (X[1] - X[2]) | 0, DX31 = (X[2] - X[0]) | 0;
  const DY12 = (Y[0] - Y[1]) | 0, DY23 = (Y[1] - Y[2]) | 0, DY31 = (Y[2] - Y[0]) | 0;
  let minx = (Math.min(X[0], X[1], X[2]) + 15) >> 4, maxx = (Math.max(X[0], X[1], X[2]) + 15) >> 4;
  let miny = (Math.min(Y[0], Y[1], Y[2]) + 15) >> 4, maxy = (Math.max(Y[0], Y[1], Y[2]) + 15) >> 4;
  if (minx < sc.L) minx = sc.L; if (maxx > sc.R) maxx = sc.R; if (miny < sc.T) miny = sc.T; if (maxy > sc.B) maxy = sc.B;
  if (minx >= maxx || miny >= maxy) return false;
  minx &= ~1; miny &= ~1;
  let C1 = (Math.imul(DY12, X[0]) - Math.imul(DX12, Y[0])) | 0;
  let C2 = (Math.imul(DY23, X[1]) - Math.imul(DX23, Y[1])) | 0;
  let C3 = (Math.imul(DY31, X[2]) - Math.imul(DX31, Y[2])) | 0;
  if (DY12 < 0 || (DY12 === 0 && DX12 > 0)) C1 = (C1 + 1) | 0;
  if (DY23 < 0 || (DY23 === 0 && DX23 > 0)) C2 = (C2 + 1) | 0;
  if (DY31 < 0 || (DY31 === 0 && DX31 > 0)) C3 = (C3 + 1) | 0;
  const xi = (X[0] + 15) >> 4, yi = (Y[0] + 15) >> 4;
  const sx0 = SX[0], sy0 = SY[0];
  TS.ox = f(f(flt(xi) - sx0) + f(0.495)); TS.oy = f(f(flt(yi) - sy0) + f(0.495));
  g_fdx31 = f(SX[2] - sx0); g_fdx12 = f(sx0 - SX[1]);
  const fdy12 = f(sy0 - SY[1]);
  g_fdy31 = f(SY[2] - sy0);
  g_nfdy12 = -fdy12;
  g_cden = f(f(-g_fdx12 * g_fdy31) - f(g_fdx31 * g_nfdy12));
  IW[0] = f(1 / D[a + V_C + 3]); IW[1] = f(1 / D[b + V_C + 3]); IW[2] = f(1 / D[c + V_C + 3]);
  plane(dst, dstOff + P_INVW * stride, IW[0], IW[1], IW[2]);
  if (sc.zFreeze) { const o = dstOff + P_Z * stride; dst[o] = lastZ[0]; dst[o + 1] = lastZ[1]; dst[o + 2] = lastZ[2]; }
  else { plane(dst, dstOff + P_Z * stride, SZ[0], SZ[1], SZ[2]); const o = dstOff + P_Z * stride; lastZ[0] = dst[o]; lastZ[1] = dst[o + 1]; lastZ[2] = dst[o + 2]; zInfo.wrote = true; }
  const nc = sc.numCols * 4;
  for (let k = 0; k < 8; k++) {
    if (k < nc) plane(dst, dstOff + (P_COL + k) * stride, D[a + V_COL + k], D[b + V_COL + k], D[c + V_COL + k]);
    else { const o = dstOff + (P_COL + k) * stride; dst[o] = 0; dst[o + 1] = 0; dst[o + 2] = 0; }
  }
  const ng = sc.numGens;
  for (let n = 0; n < ng; n++) {
    for (let k = 0; k < 3; k++) {
      const o = V_T + n * 3 + k;
      plane(dst, dstOff + (P_TEX + n * 3 + k) * stride, f(D[a + o] * IW[0]), f(D[b + o] * IW[1]), f(D[c + o] * IW[2]));
    }
  }
  TS.X0 = X[0]; TS.Y0 = Y[0]; TS.DX12 = DX12; TS.DY12 = DY12; TS.DX23 = DX23; TS.DY23 = DY23; TS.DX31 = DX31; TS.DY31 = DY31;
  TS.C1 = C1; TS.C2 = C2; TS.C3 = C3; TS.minx = minx; TS.maxx = maxx; TS.miny = miny; TS.maxy = maxy; TS.xi = xi; TS.yi = yi;
  TS.np = P_TEX + 3 * ng;
  return true;
}

/** the number of planes a triangle carries */
export const planeCount = (sc: SetupCtx): number => P_TEX + 3 * sc.numGens;

/** set up one triangle into a new Tri (the CPU reference keeps these); null when it covers no block */
export function setupTri(pool: Pool, x: XfDraw, sc: SetupCtx, state: number, a: number, b: number, c: number): Tri | null {
  const planes = new Float32Array(planeCount(sc) * 3);
  if (!setupTriInto(pool, x, sc, a, b, c, planes, 0)) return null;
  return {
    state, X0: TS.X0, Y0: TS.Y0, DX12: TS.DX12, DY12: TS.DY12, DX23: TS.DX23, DY23: TS.DY23, DX31: TS.DX31, DY31: TS.DY31,
    C1: TS.C1, C2: TS.C2, C3: TS.C3, minx: TS.minx, maxx: TS.maxx, miny: TS.miny, maxy: TS.maxy, xi: TS.xi, yi: TS.yi, ox: TS.ox, oy: TS.oy,
    planes, np: TS.np,
  };
}
