/* 3D replay viewer: a particle transform's matrix and the size of a particle drawn under it, as
 * psDispSubAppSRT (sysdolphin/baselib/psdisp.c) makes them.
 *
 * Each frame the transform is first drawn in (its frameNum), its matrix is made from its scale, turn and place
 * (HSD_MtxSRT) - unless its status is STILL - and a transform made ONCE (psAddGeneratorAppSRT's status 1) is
 * STILL from then on: its matrix kept as that first draw made it, whatever its place or scale do after. The
 * matrix the particles are drawn by is the camera's times it (S = vmtx mmtx), and a particle's quad is
 * |S's first column| times its size across and |S's second column| times it up.
 *
 * TODO: use src/render3d/gxmath.ts (HSD_MtxSRT, PSMTXConcat, sqrtf, HSD_MtxGetScale: the console's float32
 * steps and fused operations exactly) once it is on this branch; these are its plain float32 stand-ins.
 */
import { cosf, sinf } from "./gamemath";
import type { AppSRT } from "./particles";

const f32 = Math.fround;

/** psAddGeneratorAppSRT's status: made again each frame, made once (then still), kept as it is */
export const APP_DYNAMIC = 0, APP_ONCE = 1, APP_STILL = 2;

/** HSD_MtxSRT with no parent scale: a 3 x 4, row major (sysdolphin/baselib/mtx.c) */
export function mtxSRT(out: Float32Array, s: AppSRT): Float32Array {
  const sinX = sinf(s.rx), cosX = cosf(s.rx), sinY = sinf(s.ry), cosY = cosf(s.ry), sinZ = sinf(s.rz), cosZ = cosf(s.rz);
  const x = f32(s.sx), y = f32(s.sy), z = f32(s.sz);
  const sxsy = f32(sinX * sinY), cxsy = f32(cosX * sinY);
  out[0] = f32(cosZ * f32(x * cosY));
  out[4] = f32(sinZ * f32(x * cosY));
  out[8] = f32(-x * sinY);
  out[1] = f32(y * f32(cosZ * sxsy - f32(cosX * sinZ)));
  out[5] = f32(y * f32(sinZ * sxsy + f32(cosX * cosZ)));
  out[9] = f32(cosY * f32(y * sinX));
  out[2] = f32(z * f32(cosZ * cxsy + f32(sinX * sinZ)));
  out[6] = f32(z * f32(sinZ * cxsy - f32(sinX * cosZ)));
  out[10] = f32(cosY * f32(z * cosX));
  out[3] = f32(s.tx); out[7] = f32(s.ty); out[11] = f32(s.tz);
  return out;
}

/** the transform's matrix as the frame's draw has it (psDispSubAppSRT's first half): made again unless STILL,
 *  a ONCE one made STILL */
export function appMatrix(s: AppSRT): Float32Array {
  const m = (s.mmtx ??= new Float32Array(12));
  if (s.status !== APP_STILL) mtxSRT(m, s);
  if (s.status === APP_ONCE) s.status = APP_STILL;
  return m;
}

/** a point through a 3 x 4 */
export function mtxPoint(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
  return [m[3] + m[2] * z + (m[0] * x + m[1] * y), m[7] + m[6] * z + (m[4] * x + m[5] * y),
          m[11] + m[10] * z + (m[8] * x + m[9] * y)];
}

/** a direction through a 3 x 4 (no move) */
export function mtxDir(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
  return [m[0] * x + m[1] * y + m[2] * z, m[4] * x + m[5] * y + m[6] * z, m[8] * x + m[9] * y + m[10] * z];
}

/** a particle's half-extents under a transform: |S col 0| size and |S col 1| size, S the camera's view
 *  (column-major 4 x 4, GL's) times the transform's matrix (PSMTXConcat), or the matrix alone without a view */
export function appExtents(m: Float32Array, size: number, view?: ArrayLike<number> | null): [number, number] {
  let a0 = m[0], a1 = m[4], a2 = m[8], b0 = m[1], b1 = m[5], b2 = m[9];
  if (view) {
    const r = (row: number, c0: number, c1: number, c2: number) =>
      f32(f32(f32(view[row] * c0) + f32(view[4 + row] * c1)) + f32(view[8 + row] * c2));
    [a0, a1, a2] = [r(0, m[0], m[4], m[8]), r(1, m[0], m[4], m[8]), r(2, m[0], m[4], m[8])];
    [b0, b1, b2] = [r(0, m[1], m[5], m[9]), r(1, m[1], m[5], m[9]), r(2, m[1], m[5], m[9])];
  }
  const sx = f32(Math.sqrt(f32(f32(f32(a0 * a0) + f32(a1 * a1)) + f32(a2 * a2))));
  const sy = f32(Math.sqrt(f32(f32(f32(b0 * b0) + f32(b1 * b1)) + f32(b2 * b2))));
  return [f32(sx * size), f32(sy * size)];
}

/** HSD_MtxGetScale of a column-major 4 x 4 (a joint's world matrix): the first column's length, the second's
 *  once the first is taken out of it, the third's once both are, all negative when the three turn the other
 *  way (a generator of type 0x1000 takes its joint's this way each update: generator.c) */
export function mtxGetScale(w: ArrayLike<number>): [number, number, number] {
  const mag = (v: number[]) => f32(Math.sqrt(f32(f32(f32(v[0] * v[0]) + f32(v[1] * v[1])) + f32(v[2] * v[2]))));
  const unit = (v: number[]) => { const l = mag(v) || 1; return v.map((x) => f32(x / l)); };
  const dot = (a: number[], b: number[]) => f32(f32(f32(a[0] * b[0]) + f32(a[1] * b[1])) + f32(a[2] * b[2]));
  const less = (a: number[], b: number[], k: number) => a.map((x, i) => f32(x - f32(b[i] * k)));
  let v1 = [w[0], w[1], w[2]];
  const sx = mag(v1);
  v1 = unit(v1);
  let v2 = less([w[4], w[5], w[6]], v1, dot(v1, [w[4], w[5], w[6]]));
  const sy = mag(v2);
  v2 = unit(v2);
  let v3 = [w[8], w[9], w[10]];
  v3 = less(v3, v2, dot(v2, v3));
  v3 = less(v3, v1, dot(v1, v3));
  const sz = mag(v3);
  v3 = unit(v3);
  const c = [v2[1] * v3[2] - v2[2] * v3[1], v2[2] * v3[0] - v2[0] * v3[2], v2[0] * v3[1] - v2[1] * v3[0]];
  return dot(v1, c) < 0 ? [-sx, -sy, -sz] : [sx, sy, sz];
}
