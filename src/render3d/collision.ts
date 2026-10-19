/* 3D replay viewer: a stage's floors, from its collision data.
 *
 * A stage file's "coll_data" (MapCollData, mp/types.h) lists its collision
 * vertices and the lines between them; a fighter on the ground stands on
 * one of those lines, which a replay names (Slippi's last ground id: the
 * line's index). The game takes the line's normal from its two ends
 * (mpLineGetNormal: (-(y1 - y0), x1 - x0), made unit length) - a hit on the
 * ground shakes along it (hitlag.ts). The vertices are read as the file has
 * them, at the stage's scale: a line on a part that moves keeps its slope
 * as long as the part does not turn.
 */
import { Archive, ptr } from "./hsd";

/** a stage's floor lines' normals, by line index */
export interface Floors {
  /** the normal of line `id` ([x, y], unit length), or null for none */
  normal(id: number): [number, number] | null;
  /** line `id`'s material (its flags' low byte, +0xF: mpLineGetFlags), or -1 */
  material(id: number): number;
}

/** the floors of a stage file (its "coll_data"), or null without them */
export function readFloors(a: Archive): Floors | null {
  const cd = a.publics.get("coll_data");
  if (cd === undefined || cd + 0x10 > a.data.byteLength) return null;
  const d = a.data;
  const verts = ptr(a, cd), lines = ptr(a, cd + 8);
  const nv = d.getInt32(cd + 4), nl = d.getInt32(cd + 0xc);
  if (verts === null || lines === null || nv <= 0 || nl <= 0 || nv > 100000 || nl > 100000) return null;
  if (verts + nv * 8 > d.byteLength || lines + nl * 0x10 > d.byteLength) return null;
  const cache = new Map<number, [number, number] | null>();
  return {
    normal(id: number) {
      if (!Number.isInteger(id) || id < 0 || id >= nl) return null;
      if (cache.has(id)) return cache.get(id)!;
      const l = lines + id * 0x10, i0 = d.getUint16(l), i1 = d.getUint16(l + 2);
      let out: [number, number] | null = null;
      if (i0 < nv && i1 < nv) {
        const x0 = d.getFloat32(verts + i0 * 8), y0 = d.getFloat32(verts + i0 * 8 + 4);
        const x1 = d.getFloat32(verts + i1 * 8), y1 = d.getFloat32(verts + i1 * 8 + 4);
        const nx = -(y1 - y0), ny = x1 - x0, len = Math.hypot(nx, ny);
        out = len > 1e-6 ? [nx / len, ny / len] : null;
      }
      cache.set(id, out);
      return out;
    },
    material(id: number) {
      if (!Number.isInteger(id) || id < 0 || id >= nl) return -1;
      return d.getUint8(lines + id * 0x10 + 0xf);
    },
  };
}

/** a stage's collision for the floor test: its vertices as the file has them, each floor line's two vertices,
 *  and its groups (MapCollData +0x24, MapJoint: each one's floor lines and vertices). A group the stage's code
 *  binds to one of its joints (mpLib_800552B0) holds its vertices in that joint's own space: the game moves
 *  them by the joint's matrix every frame (mpLib_80055E9C); the others stand where the file has them. */
export interface Collision {
  verts: Float32Array;
  /** the floor lines: their two vertices, and the group each is of (-1: none) */
  floors: { v0: number; v1: number; group: number }[];
  groups: { vtxStart: number; vtxCount: number }[];
}

export function readCollision(a: Archive): Collision | null {
  const cd = a.publics.get("coll_data");
  if (cd === undefined || cd + 0x2c > a.data.byteLength) return null;
  const d = a.data;
  const vp = ptr(a, cd), lp = ptr(a, cd + 8);
  const nv = d.getInt32(cd + 4), nl = d.getInt32(cd + 0xc);
  const start = d.getInt16(cd + 0x10), count = d.getInt16(cd + 0x12);
  if (vp === null || lp === null || nv <= 0 || nl <= 0 || nv > 100000 || nl > 100000 || count <= 0 || start < 0 || start + count > nl) return null;
  const verts = new Float32Array(nv * 2);
  for (let i = 0; i < nv * 2; i++) verts[i] = d.getFloat32(vp + i * 4);
  // (each group's floor lines, +0: start and count; its vertices, +0x24)
  const groups: Collision["groups"] = [], lineGroup = new Map<number, number>();
  const gp = ptr(a, cd + 0x24), ng = d.getInt32(cd + 0x28);
  if (gp !== null && ng > 0 && ng < 256) {
    for (let g = 0; g < ng; g++) {
      const o = gp + g * 0x28, fs = d.getInt16(o), fc = d.getInt16(o + 2);
      for (let l = fs; l < fs + fc; l++) lineGroup.set(l, g);
      groups.push({ vtxStart: d.getInt16(o + 0x24), vtxCount: d.getInt16(o + 0x26) });
    }
  }
  const floors: Collision["floors"] = [];
  for (let i = start; i < start + count; i++) {
    const l = lp + i * 0x10, v0 = d.getUint16(l), v1 = d.getUint16(l + 2);
    if (v0 < nv && v1 < nv) floors.push({ v0, v1, group: lineGroup.get(i) ?? -1 });
  }
  return { verts, floors, groups };
}

/** the collision groups a stage part's code binds to its joints (Ground_InitMapColl: the part's map_head entry,
 *  +0x20 its list of {group, -, joint} and +0x24 how many): the joint is its place in the part's tree */
export function partBindings(a: Archive, entry: number): { group: number; joint: number }[] {
  const d = a.data, list = ptr(a, entry + 0x20), n = d.getInt32(entry + 0x24);
  if (list === null || !(n > 0 && n < 64)) return [];
  const out: { group: number; joint: number }[] = [];
  for (let k = 0; k < n; k++) out.push({ group: d.getInt16(list + k * 6), joint: d.getInt16(list + k * 6 + 4) });
  return out;
}

/** the floor test over the floor lines given (x0, y0, x1, y1 each) */
export function floorTestOf(segs: number[][]): FloorFn {
  return (ax, ay, bx, by, lift) => {
    let best = Infinity, out: [number, number] | null = null;
    for (const [x0, y0r, x1, y1r] of segs) {
      const y0 = y0r + lift, y1 = y1r + lift;
      const p = Math.abs(y0 - y1) > 0.0001 ? lineHit(x0, y0, x1, y1, ax, ay, bx, by) : ay >= by ? flatHit(x0, y0, x1, ax, ay, bx, by) : null;
      if (!p) continue;
      const d2 = (p[0] - ax) ** 2 + (p[1] - ay) ** 2;
      if (d2 < best) { best = d2; out = p; }
    }
    return out;
  };
}
export type FloorFn = (ax: number, ay: number, bx: number, by: number, lift: number) => [number, number] | null;

/** the floor test the swinging chains use (dynamics.ts: mpCheckFloor from a
 *  to b, the floors raised by `lift`): the stage file's floor lines (its
 *  collision data's floor group, +0x10) where the file has them - the
 *  nearest crossing to a. (A part that moves: Stage.floorTestAt.) */
export function readFloorTest(a: Archive): ((ax: number, ay: number, bx: number, by: number, lift: number) => [number, number] | null) | null {
  const cd = a.publics.get("coll_data");
  if (cd === undefined || cd + 0x14 > a.data.byteLength) return null;
  const d = a.data;
  const verts = ptr(a, cd), lines = ptr(a, cd + 8);
  const nv = d.getInt32(cd + 4), nl = d.getInt32(cd + 0xc);
  const start = d.getInt16(cd + 0x10), count = d.getInt16(cd + 0x12);
  if (verts === null || lines === null || nv <= 0 || nl <= 0 || count <= 0 || start < 0 || start + count > nl) return null;
  const segs: number[][] = [];
  for (let i = start; i < start + count; i++) {
    const l = lines + i * 0x10, i0 = d.getUint16(l), i1 = d.getUint16(l + 2);
    if (i0 >= nv || i1 >= nv) continue;
    segs.push([d.getFloat32(verts + i0 * 8), d.getFloat32(verts + i0 * 8 + 4), d.getFloat32(verts + i1 * 8), d.getFloat32(verts + i1 * 8 + 4)]);
  }
  return floorTestOf(segs);
}

/** mpLineIntersection: line a (a floor) crossed by segment b, from above */
function lineHit(a0x: number, a0y: number, a1x: number, a1y: number, b0x: number, b0y: number, b1x: number, b1y: number): [number, number] | null {
  if (a0x <= a1x) { if ((b0x < a0x && b1x < a0x) || (a1x < b0x && a1x < b1x)) return null; }
  else if ((b0x < a1x && b1x < a1x) || (a0x < b0x && a0x < b1x)) return null;
  if (a0y <= a1y) { if ((b0y < a0y && b1y < a0y) || (a1y < b0y && a1y < b1y)) return null; }
  else if ((b0y < a1y && b1y < a1y) || (a0y < b0y && a0y < b1y)) return null;
  let below = false, above = false;
  const ah = a1y - a0y, aw = a1x - a0x, d0x = b0x - a0x, d0y = b0y - a0y;
  const h0 = aw * d0y - ah * d0x;
  if (h0 < 0) { if (h0 < -0.1) return null; below = true; }
  const d1x = b1x - a1x, d1y = b1y - a1y;
  const h1 = aw * d1y - ah * d1x;
  if (h1 > 0) { if (h1 > 0.1) return null; above = true; }
  if (h0 === 0 && h1 === 0) return null;
  const det = d0x * d1y - d0y * d1x;
  if (det < h0) { if (det < h1) return null; } else if (det > h0) { if (det > h1) return null; }
  const bw = b1x - b0x, bh = b1y - b0y;
  if ((bw === 0 && bh === 0) || (below && above) || (h0 >= 0 && above)) return null;
  const area = bw * ah - bh * aw;
  if (Math.abs(area) <= 0.0001) return null;
  const t = (bw * d0y - bh * d0x) / area;
  return t > 0 ? (t < 1 ? [aw * t + a0x, ah * t + a0y] : [a1x, a1y]) : [a0x, a0y];
}

/** mpLineIntersectionH: a flat line (at a0y, from a0x to a1x) crossed by segment b */
function flatHit(a0x: number, a0y: number, a1x: number, b0x: number, b0y: number, b1x: number, b1y: number): [number, number] | null {
  let lo: number, hi: number;
  if (a0x < a1x) {
    if ((b0x < a0x && b1x < a0x) || (a1x < b0x && a1x < b1x)) return null;
    if (b0y - a0y < -0.0001 || b1y - a0y > 0.0001) return null;
    lo = a0x; hi = a1x;
  } else {
    if ((b0x < a1x && b1x < a1x) || (a0x < b0x && a0x < b1x)) return null;
    if (b1y - a0y < -0.0001 || b0y - a0y > 0.0001) return null;
    lo = a1x; hi = a0x;
  }
  const dby = b1y - b0y, dbx = b1x - b0x;
  if (Math.abs(dby) < 0.0001) return null;
  let x = (dbx / dby) * (a0y - b0y) + b0x;
  if (x - lo < 0) { if (x - lo < -0.1) return null; x = lo; }
  if (x - hi > 0) { if (x - hi > 0.1) return null; x = hi; }
  return [x, a0y];
}
