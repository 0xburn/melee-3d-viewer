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
  L: number; T: number; R: number; B: number;
}

export function setupCtx(bp: Uint32Array): SetupCtx {
  const gm = bp[0x00];
  const tl = bp[0x20], br = bp[0x21], off = bp[0x59];
  const ox = 2 * bits(off, 0, 10), oy = 2 * bits(off, 10, 10);
  return {
    numGens: bits(gm, 0, 4), numCols: bits(gm, 4, 3),
    L: Math.max(0, bits(tl, 12, 12) - ox), T: Math.max(0, bits(tl, 0, 12) - oy),
    R: Math.min(640, bits(br, 12, 12) - ox + 1), B: Math.min(528, bits(br, 0, 12) - oy + 1),
  };
}

const snap = (v: number): number => {
  const t = trunc32(v);
  return (f(v - t) >= 0.5 ? (t + 1) | 0 : t) | 0;
};

const sp = [0, 0, 0];

/** setup one triangle from pool vertices a, b, c (in this order); null when it covers no block */
export function setupTri(pool: Pool, x: XfDraw, sc: SetupCtx, state: number, a: number, b: number, c: number): Tri | null {
  const D = pool.data;
  const sx = [0, 0, 0], sy = [0, 0, 0], sz = [0, 0, 0];
  const vs = [a, b, c];
  for (let i = 0; i < 3; i++) { viewport(x, D, vs[i], sp); sx[i] = sp[0]; sy[i] = sp[1]; sz[i] = sp[2]; }
  const X = [0, 0, 0], Y = [0, 0, 0];
  for (let i = 0; i < 3; i++) { X[i] = (snap(f(16 * sx[i])) - 9) | 0; Y[i] = (snap(f(16 * sy[i])) - 9) | 0; }
  const DX12 = (X[0] - X[1]) | 0, DX23 = (X[1] - X[2]) | 0, DX31 = (X[2] - X[0]) | 0;
  const DY12 = (Y[0] - Y[1]) | 0, DY23 = (Y[1] - Y[2]) | 0, DY31 = (Y[2] - Y[0]) | 0;
  let minx = (Math.min(X[0], X[1], X[2]) + 15) >> 4, maxx = (Math.max(X[0], X[1], X[2]) + 15) >> 4;
  let miny = (Math.min(Y[0], Y[1], Y[2]) + 15) >> 4, maxy = (Math.max(Y[0], Y[1], Y[2]) + 15) >> 4;
  minx = Math.max(minx, sc.L); maxx = Math.min(maxx, sc.R); miny = Math.max(miny, sc.T); maxy = Math.min(maxy, sc.B);
  if (minx >= maxx || miny >= maxy) return null;
  minx &= ~1; miny &= ~1;
  let C1 = (Math.imul(DY12, X[0]) - Math.imul(DX12, Y[0])) | 0;
  let C2 = (Math.imul(DY23, X[1]) - Math.imul(DX23, Y[1])) | 0;
  let C3 = (Math.imul(DY31, X[2]) - Math.imul(DX31, Y[2])) | 0;
  if (DY12 < 0 || (DY12 === 0 && DX12 > 0)) C1 = (C1 + 1) | 0;
  if (DY23 < 0 || (DY23 === 0 && DX23 > 0)) C2 = (C2 + 1) | 0;
  if (DY31 < 0 || (DY31 === 0 && DX31 > 0)) C3 = (C3 + 1) | 0;
  const xi = (X[0] + 15) >> 4, yi = (Y[0] + 15) >> 4;
  const ox = f(f(flt(xi) - sx[0]) + f(0.495)), oy = f(f(flt(yi) - sy[0]) + f(0.495));
  const np = P_TEX + 3 * sc.numGens;
  const planes = new Float32Array(np * 3);
  const fdx31 = f(sx[2] - sx[0]), fdx12 = f(sx[0] - sx[1]), fdy12 = f(sy[0] - sy[1]), fdy31 = f(sy[2] - sy[0]);
  const nfdy12 = -fdy12, nfdx12 = -fdx12;
  const cden = f(f(nfdx12 * fdy31) - f(fdx31 * nfdy12));
  const plane = (k: number, f0: number, f1: number, f2: number): void => {
    const DF31 = f(f2 - f0), DF21 = f(f1 - f0);
    const pa = f(f(DF31 * nfdy12) - f(DF21 * fdy31));
    const pb = f(f(fdx31 * DF21) + f(fdx12 * DF31));
    planes[k * 3] = f0; planes[k * 3 + 1] = f(-pa / cden); planes[k * 3 + 2] = f(-pb / cden);
  };
  const iw = [f(1 / D[a + V_C + 3]), f(1 / D[b + V_C + 3]), f(1 / D[c + V_C + 3])];
  plane(P_INVW, iw[0], iw[1], iw[2]);
  plane(P_Z, sz[0], sz[1], sz[2]);
  for (let k = 0; k < sc.numCols * 4; k++) plane(P_COL + k, D[a + V_COL + k], D[b + V_COL + k], D[c + V_COL + k]);
  for (let n = 0; n < sc.numGens; n++) {
    for (let k = 0; k < 3; k++) {
      const o = V_T + n * 3 + k;
      plane(P_TEX + n * 3 + k, f(D[a + o] * iw[0]), f(D[b + o] * iw[1]), f(D[c + o] * iw[2]));
    }
  }
  return { state, X0: X[0], Y0: Y[0], DX12, DY12, DX23, DY23, DX31, DY31, C1, C2, C3, minx, maxx, miny, maxy, xi, yi, ox, oy, planes, np };
}
