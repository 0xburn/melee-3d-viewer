/* 3D replay viewer: the fighters' swinging parts - Peach's and
 * Zelda's dresses and hair, Marth's, Roy's and Ganondorf's capes, Dr.
 * Mario's coat, Fox's tail, Donkey Kong's tie, Link's and Young Link's caps,
 * Mewtwo's tail - as the game swings them (ftdynamics.c, lb_00F9.c
 * lb_8001044C).
 *
 * A fighter's data (ftData +0x2C) lists chains: a part and how many joints
 * from it, down the first child, each with its stiffness, damping and limits.
 * Each frame, after the fighter has moved (the fighter's proc 16), each
 * joint's direction is pulled from where its child was toward where the
 * animation would have it, by gravity, by its own swing, kept within its
 * limits and out of the fighter's own spheres (ftData +0x2C's colliders) and
 * the floor, and written back as the joint's turn; the animation leaves those
 * joints alone. Not in hitlag. Each animation says how much of each chain it
 * drives itself (its flags +0x10: 0x10000000 all of it, 0x08000000 the first
 * so many joints of each by its slot, ftData +0x10 and +0x2C's +0x10; else
 * none), the rest swinging. The lengths are the model's at rest at size 1
 * (the chains are set up before the fighter's size is put on it).
 *
 * The game's own approximations stay: the turns about an axis use its
 * quintic sine and cosine (lbVector_RotateAboutUnitAxis), the matrices from
 * angles too (lbVector_CreateEulerMatrix). */
import { Archive, ptr } from "./hsd";

export interface DynNode {
  stiff: number; conv: number; rest: [number, number, number]; maxDev: number; damp: number; maxAng: number;
}
export interface DynChain { part: number; count: number; stiffMul: number; gravity: number; nodes: DynNode[] }
export interface DynCollider { part: number; off: [number, number, number]; radius: number }
export interface DynData {
  chains: DynChain[];
  colliders: DynCollider[];
  /** per slot, per chain: how many of the chain's first joints the animation drives (256: all, none swinging) */
  slots: number[][] | null;
}

/** a fighter file's dynamics (ftData +0x2C), or null for none */
export function readDynamics(a: Archive, ftData: number): DynData | null {
  const d = a.data;
  const dyn = ptr(a, ftData + 0x2c);
  if (dyn === null) return null;
  const num = d.getInt32(dyn), bones = ptr(a, dyn + 4);
  if (num <= 0 || num > 16 || bones === null) return null;
  const chains: DynChain[] = [];
  for (let i = 0; i < num; i++) {
    const b = bones + i * 0x18;
    const data = ptr(a, b + 4), count = d.getUint32(b + 8);
    if (data === null || count < 2 || count > 32) return null;
    const nodes: DynNode[] = [];
    for (let k = 0; k < count; k++) {
      const p = data + k * 0x3c, f = (o: number) => d.getFloat32(p + o);
      nodes.push({ stiff: f(0), conv: f(4), rest: [f(8), f(12), f(16)], maxDev: f(0x18), damp: f(0x34), maxAng: f(0x38) });
    }
    chains.push({ part: d.getInt32(b), count, stiffMul: d.getFloat32(b + 12), gravity: d.getFloat32(b + 20), nodes });
  }
  const colliders: DynCollider[] = [];
  const nc = d.getInt32(dyn + 8), cols = ptr(a, dyn + 0xc);
  if (cols !== null) for (let i = 0; i < nc && i < 12; i++) {
    const c = cols + i * 0x14;
    colliders.push({ part: d.getInt32(c), off: [d.getFloat32(c + 4), d.getFloat32(c + 8), d.getFloat32(c + 12)], radius: d.getFloat32(c + 16) });
  }
  let slots: number[][] | null = null;
  const x10 = ptr(a, dyn + 0x10);
  if (x10 !== null) {
    slots = [];
    for (let s = 0; s < 256; s++) {
      const row = ptr(a, x10 + s * 4);
      if (row === null) { if (d.getUint32(x10 + s * 4) !== 0) break; slots.push([]); continue; }
      slots.push(chains.map((_, c) => d.getUint32(row + c * 4)));
    }
  }
  return { chains, colliders, slots };
}

/** how many of each chain's first joints an animation drives (its flags and
 *  slot): ftCo_8009E7B4 */
export function animDriven(data: DynData, flags: number, slot: number): number[] {
  if (flags & 0x08000000) {
    const row = data.slots?.[slot];
    if (!row || !row.length) return data.chains.map(() => 256);
    return data.chains.map((_, c) => row[c] ?? 256);
  }
  if (flags & 0x10000000) return data.chains.map(() => 256);
  return data.chains.map(() => 0);
}

// ---- the game's vector helpers (lbvector.c), 3x4 row-major matrices (PSMTX)
type V3 = [number, number, number];
type M34 = Float64Array;
const PI = Math.PI, TAU = 2 * Math.PI;
function qsin(a: number): number {
  if (a > PI) a -= TAU; else if (a < -PI) a += TAU;
  return 0.9878619909286499 * a - 0.15527099370956421 * a * a * a + 0.0056429998949170113 * a * a * a * a * a;
}
function qcos(a: number): number {
  a += PI / 2;
  if (a > PI) a -= TAU; else if (a < -PI) a += TAU;
  return 0.9878619909286499 * a - 0.15527099370956421 * a * a * a + 0.0056429998949170113 * a * a * a * a * a;
}
const len = (v: V3) => Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
function norm(v: V3): number {
  const l = len(v);
  if (l === 0) return 0;
  v[0] /= l; v[1] /= l; v[2] /= l;
  return l;
}
function angle(a: V3, b: V3): number {
  const ll = len(a) * len(b);
  if (ll > 1e-10) return Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / ll)));
  return 0;
}
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function rotAbout(v: V3, axis: V3, ang: number) {
  const lyz = Math.sqrt(axis[1] * axis[1] + axis[2] * axis[2]);
  const s = qsin(ang), c = qcos(ang);
  let x: number, y: number, z: number, uy = 0, uz = 0;
  if (lyz > 1e-10) {
    uy = axis[2] / lyz; uz = axis[1] / lyz;
    x = v[0]; y = v[1] * uy - v[2] * uz; z = v[1] * uz + v[2] * uy;
  } else { x = v[0]; y = v[1]; z = v[2]; }
  const x2 = x * lyz - z * axis[0], z2 = x * axis[0] + z * lyz;
  const x3 = x2 * c - y * s, y3 = x2 * s + y * c;
  x = x3 * lyz + z2 * axis[0]; y = y3; z = -x3 * axis[0] + z2 * lyz;
  if (lyz > 1e-10) { v[0] = x; v[1] = y * uy + z * uz; v[2] = -y * uz + z * uy; } else { v[0] = x; v[1] = y; v[2] = z; }
}
function eulerMtx(m: M34, r: ArrayLike<number>) {
  const sx = qsin(r[0]), cx = qcos(r[0]), sy = qsin(r[1]), cy = qcos(r[1]), sz = qsin(r[2]), cz = qcos(r[2]);
  const sxsy = sx * sy, cxsy = cx * sy;
  m[0] = cy * cz; m[4] = cy * sz; m[8] = -sy;
  m[1] = cz * sxsy - cx * sz; m[5] = sz * sxsy + cx * cz; m[9] = sx * cy;
  m[2] = cz * cxsy + sx * sz; m[6] = sz * cxsy - sx * cz; m[10] = cx * cy;
  m[3] = m[7] = m[11] = 0;
}
function concat(a: M34, b: M34, out: M34) {
  const t = new Float64Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      t[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0);
    }
  }
  out.set(t);
}
const trans = (x: number, y: number, z: number): M34 => Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z);
const scaleM = (x: number, y: number, z: number): M34 => Float64Array.of(x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0);
const multVec = (m: M34, v: ArrayLike<number>): V3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[3], m[4] * v[0] + m[5] * v[1] + m[6] * v[2] + m[7], m[8] * v[0] + m[9] * v[1] + m[10] * v[2] + m[11]];
export function quatMtx(q: [number, number, number, number]): M34 {
  const [x, y, z, w] = q, n = x * x + y * y + z * z + w * w, s = n > 0 ? 2 / n : 0;
  return Float64Array.of(1 - s * (y * y + z * z), s * (x * y - w * z), s * (x * z + w * y), 0,
                         s * (x * y + w * z), 1 - s * (x * x + z * z), s * (y * z - w * x), 0,
                         s * (x * z - w * y), s * (y * z + w * x), 1 - s * (x * x + y * y), 0);
}
export function eulerToQuat(e: ArrayLike<number>): [number, number, number, number] {
  const cx = Math.cos(0.5 * e[0]), cy = Math.cos(0.5 * e[1]), cz = Math.cos(0.5 * e[2]);
  const sx = Math.sin(0.5 * e[0]), sy = Math.sin(0.5 * e[1]), sz = Math.sin(0.5 * e[2]);
  const ss = sy * sz, cc = cy * cz;
  return [sx * cc - cx * ss, cz * (cx * sy) + sz * (sx * cy), sz * (cx * cy) - cz * (sx * sy), cx * cc + sx * ss];
}
function quatMul(p: number[], q: number[]): [number, number, number, number] {
  return [q[3] * p[0] + p[3] * q[0] + (p[1] * q[2] - q[1] * p[2]), q[3] * p[1] + p[3] * q[1] + (q[0] * p[2] - p[0] * q[2]),
          q[3] * p[2] + p[3] * q[2] + (p[0] * q[1] - q[0] * p[1]), p[3] * q[3] - (p[2] * q[2] + (p[0] * q[0] + p[1] * q[1]))];
}
export function mtxEuler(m: M34): V3 {
  const l = Math.sqrt(m[0] * m[0] + m[4] * m[4]);
  if (l > 1e-5) return [Math.atan2(m[9], m[10]), Math.atan2(-m[8], l), Math.atan2(m[4], m[0])];
  return [Math.atan2(-m[6], m[5]), Math.atan2(-m[8], l), 0];
}
/** HSD_QuatLib_8037EF28: from p toward q by t */
export function slerp(p: number[], q: number[], t: number): [number, number, number, number] {
  const cosom = p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3];
  let sp: number, sq: number;
  if (1 + cosom > 1e-10) {
    if (1 - cosom > 1e-10) {
      const th = Math.acos(cosom), so = Math.sin(th);
      sp = Math.sin((1 - t) * th) / so; sq = Math.sin(t * th) / so;
    } else { sq = t; sp = 1 - t; }
    return [sp * p[0] + sq * q[0], sp * p[1] + sq * q[1], sp * p[2] + sq * q[2], sp * p[3] + sq * q[3]];
  }
  const o = [-p[1], p[0], -p[3], p[2]];
  if (t < 0.5) {
    sp = Math.sin((PI / 2) * (1 - 2 * t)); sq = Math.sin((PI / 2) * (2 * t));
    return [sp * p[0] + sq * q[0], sp * p[1] + sq * q[1], sp * p[2] + sq * q[2], sp * p[3] + sq * q[3]];
  }
  const t2 = 2 * (t - 0.5);
  sp = Math.sin((PI / 2) * (1 - t2)); sq = Math.sin((PI / 2) * t2);
  return [sp * o[0] + sq * q[0], sp * o[1] + sq * q[1], sp * o[2] + sq * q[2], sp * o[3] + sq * q[3]];
}

/** lb_8000C868's turn: a joint tree's turn (`a`, Euler) and a joint's (`b`)
 *  blended, `t` of the way to `a`, through quaternions (as Euler again) */
export function blendTurn(a: ArrayLike<number>, b: ArrayLike<number>, t: number): V3 {
  if (Math.abs(a[0] - b[0]) <= 1e-4 && Math.abs(a[1] - b[1]) <= 1e-4 && Math.abs(a[2] - b[2]) <= 1e-4) return [a[0], a[1], a[2]];
  const qa = eulerToQuat(a);
  let qb = eulerToQuat(b);
  const sum = qa.reduce((s, v, i) => s + (v + qb[i]) ** 2, 0), dif = qa.reduce((s, v, i) => s + (v - qb[i]) ** 2, 0);
  if (dif > sum) qb = qb.map((v) => -v) as [number, number, number, number];
  return mtxEuler(quatMtx(slerp(qa, qb, 1 - t)));
}

/** a GL column-major 4x4 as a 3x4 row-major */
export function from44(w: ArrayLike<number>, o = 0): M34 {
  return Float64Array.of(w[o], w[o + 4], w[o + 8], w[o + 12], w[o + 1], w[o + 5], w[o + 9], w[o + 13], w[o + 2], w[o + 6], w[o + 10], w[o + 14]);
}

/** the stage's floors for the chain's floor test (mpCheckFloor from a to b,
 *  the floors raised by `lift`): where it meets the nearest, or null */
export type FloorTest = (ax: number, ay: number, bx: number, by: number, lift: number) => [number, number] | null;

interface NodeState {
  joint: number; rot: V3; pos: V3; axis: V3; vel: number; len: number; dom: number;
  restT: V3; restS: V3; swing: boolean;
  /** its place and size now: the rest ones as it starts swinging; a joint
   *  tree laid on the fighter (the guard pose) sets them */
  t: V3; sc: V3;
}
interface ChainState { first: number; nodes: NodeState[] }

/** what one frame's step needs of the fighter as the animation has it */
export interface DynPose {
  /** a model joint's world matrix (GL column-major 4x4), as posed by the animation */
  world(joint: number): ArrayLike<number>;
  /** a model joint's turn as posed by the animation */
  rot(joint: number): ArrayLike<number>;
  /** model joint of a part (-1: none), and a joint's parent */
  jointOf(part: number): number;
  parent(joint: number): number;
  /** rest translation and scale of a joint */
  restT(joint: number): V3;
  restS(joint: number): V3;
  /** a joint's place and size as posed (in its parent's frame) */
  ts(joint: number): { t: V3; s: V3 };
  /** the first child of a joint (-1: none) */
  child(joint: number): number;
}

/** one fighter's swinging chains, stepped a frame at a time */
export class Dynamics {
  chains: ChainState[] = [];
  frame = -1;
  /** the checks' (pose checks): each joint's floor test as it is made - chain, joint in the
   *  chain, the joint's place, the link's end, which test (1 the joint, 2 the link, 3 the end while on the
   *  floor) and where it met a floor (NaN for none) */
  debug: ((row: number[]) => void) | null = null;
  constructor(public data: DynData) {}

  /** set up from the fighter as posed (ftCo_8009CF84: every joint swinging).
   *  The lengths are the model's at rest before the fighter's size is put on
   *  it (Fighter_Create sets the chains up first): `size` is taken off */
  init(p: DynPose, size = 1) {
    this.chains = this.data.chains.map((c) => {
      const nodes: NodeState[] = [];
      let j = p.jointOf(c.part);
      for (let k = 0; k < c.count && j >= 0; k++) {
        const w = p.world(j), r = p.rot(j);
        nodes.push({ joint: j, rot: [r[0], r[1], r[2]], pos: [w[12], w[13], w[14]], axis: [1, 0, 0], vel: 0, len: 0, dom: 0,
                     restT: p.restT(j), restS: p.restS(j), swing: true, t: p.restT(j), sc: p.restS(j) });
        j = p.child(j);
      }
      for (let k = 0; k + 1 < nodes.length; k++) {
        // (as the model stands at rest: its child's rest place through the
        // joint's own size - the animation may move the child)
        const w = p.world(nodes[k].joint), t0 = nodes[k + 1].restT;
        nodes[k].len = Math.hypot(w[0] * t0[0] + w[4] * t0[1] + w[8] * t0[2], w[1] * t0[0] + w[5] * t0[1] + w[9] * t0[2],
                                  w[2] * t0[0] + w[6] * t0[1] + w[10] * t0[2]) / (size || 1);
        const t = nodes[k + 1].restT.map(Math.abs);
        nodes[k].dom = t[2] > t[1] ? (t[2] > t[0] ? -1 : 0) : t[1] > t[0] ? 1 : 0;
      }
      return { first: 0, nodes };
    });
  }

  /** an animation's say over the chains (ftCo_8009CB40): its driven joints
   *  follow it; a joint it lets go of starts swinging from where it was last
   *  frame, turned as the animation had it then, still */
  setDriven(driven: number[]) {
    this.chains.forEach((c, i) => {
      const n = Math.min(256, driven[i] ?? 0);
      c.first = n >= 256 ? 256 : n;
      c.nodes.forEach((s, k) => {
        const swing = n < 256 && k >= n;
        if (swing && !s.swing) { s.vel = 0; s.t = [...s.restT]; s.sc = [...s.restS]; }
        s.swing = swing;
      });
    });
  }

  /** a joint tree laid on the fighter that reaches the swinging joints too
   *  (the guard pose: ftAnim_8006FA58, lb_8000B6A4): their places and sizes
   *  become the tree's, as posed, their turns stay */
  holdPlaces(p: DynPose) {
    for (const c of this.chains) for (const s of c.nodes) if (s.swing) { const v = p.ts(s.joint); s.t = v.t; s.sc = v.s; }
  }

  /** an animation set with no blend lays the model's own joint tree on the fighter first (ftAnim_8006EBE8:
   *  ftAnim_8006FA58 on the joints themselves, lb_8000B6A4 for a swinging one): the swinging joints' places
   *  and sizes are the model's again, their turns stay. With a blend the tree goes on the blend's shadow
   *  joints instead and these keep what they had (the guard pose's, after a shield) */
  restPlaces() {
    for (const c of this.chains) for (const s of c.nodes) if (s.swing) { s.t = [...s.restT]; s.sc = [...s.restS]; }
  }

  /** the joints the animation drives, as it has them this frame (where a
   *  joint it lets go of next starts from) */
  follow(p: DynPose) {
    for (const c of this.chains) {
      for (const s of c.nodes) {
        if (s.swing) continue;
        const w = p.world(s.joint), r = p.rot(s.joint);
        s.pos = [w[12], w[13], w[14]];
        s.rot = [r[0], r[1], r[2]];
      }
    }
  }

  /** one frame (lb_8001044C for each chain); `ground`: the floor test while
   *  on the ground at size 1, else null; `colliders`: the fighter's spheres
   *  (world place and radius) */
  step(p: DynPose, ground: FloorTest | null, colliders: { pos: V3; radius: number }[]) {
    this.data.chains.forEach((cd, ci) => {
      const c = this.chains[ci];
      if (!c || c.first > 0xff || c.first >= c.nodes.length) return;
      const head = c.nodes[c.first];
      const par = p.parent(head.joint);
      const parent = par >= 0 ? from44(p.world(par), par * 0) : Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);
      let onGround = false;
      const tmp = new Float64Array(12), bone = new Float64Array(12), con = new Float64Array(12);
      let k = c.first;
      for (; k + 1 < c.nodes.length; k++) {
        const s = c.nodes[k], next = c.nodes[k + 1], prm = cd.nodes[k];
        const tm = trans(s.t[0], s.t[1], s.t[2]);
        concat(parent, tm, bone);
        eulerMtx(tmp, prm.rest);
        concat(bone, tmp, con);
        eulerMtx(tmp, s.rot);
        concat(bone, tmp, bone);
        const sm = scaleM(s.sc[0], s.sc[1], s.sc[2]);
        concat(bone, sm, bone);
        concat(con, sm, con);
        s.pos = [bone[3], bone[7], bone[11]];
        const nat = multVec(con, next.t), cur = multVec(bone, next.t);
        const natural: V3 = [nat[0] - s.pos[0], nat[1] - s.pos[1], nat[2] - s.pos[2]];
        const current: V3 = [cur[0] - s.pos[0], cur[1] - s.pos[1], cur[2] - s.pos[2]];
        const link: V3 = [next.pos[0] - s.pos[0], next.pos[1] - s.pos[1], next.pos[2] - s.pos[2]];
        norm(natural); norm(current); norm(link);
        const saved: V3 = [link[0], link[1], link[2]];
        // stiffness: toward the animation's direction
        if (prm.stiff * cd.stiffMul < 1) {
          const a = Math.abs(angle(link, current));
          if (a !== 0) {
            const ax = cross(link, current);
            norm(ax);
            rotAbout(link, ax, a * (1 - prm.stiff * cd.stiffMul));
          }
        }
        // gravity
        const grav: V3 = [0, -1, 0];
        const ga = angle(link, grav);
        const gk = s.len !== 0 ? cd.gravity / s.len : 0;
        if (ga !== 0) {
          const gr = Math.abs(gk * Math.sin(ga));
          const ax = cross(link, grav);
          norm(ax);
          rotAbout(link, ax, gr);
        }
        // its own swing
        if (s.vel !== 0) rotAbout(link, s.axis, s.vel);
        // the most it turns in a frame (no outside force: 0 < gravity x length)
        if (0 < gk * s.len) {
          const cl: V3 = [saved[0], saved[1], saved[2]];
          if (angle(cl, link) > prm.maxAng) {
            const ax = cross(cl, link);
            norm(ax);
            rotAbout(cl, ax, prm.maxAng);
            link[0] = cl[0]; link[1] = cl[1]; link[2] = cl[2];
          }
        }
        // drawn back toward its rest direction
        if (prm.conv > 0) {
          if (angle(natural, link) < prm.conv) { link[0] = natural[0]; link[1] = natural[1]; link[2] = natural[2]; } else {
            const ax = cross(link, natural);
            norm(ax);
            rotAbout(link, ax, prm.conv);
          }
        }
        // no further from it than its limit
        const dev = angle(natural, link);
        if (dev > prm.maxDev) {
          const ax = cross(link, natural);
          norm(ax);
          rotAbout(link, ax, dev - prm.maxDev);
        }
        // out of the fighter's spheres
        if (colliders.length) {
          norm(link);
          for (const col of colliders) {
            const end: V3 = [link[0] * s.len + s.pos[0], link[1] * s.len + s.pos[1], link[2] * s.len + s.pos[2]];
            const cdv: V3 = [col.pos[0] - s.pos[0], col.pos[1] - s.pos[1], col.pos[2] - s.pos[2]];
            const dist = Math.sqrt(cdv[2] * cdv[2] + (cdv[0] * cdv[0] + cdv[1] * cdv[1]));
            if (dist > col.radius && segSphere(s.pos, end, col.pos, 0.1, col.radius)) {
              const ca = angle(cdv, link);
              if (ca !== 0) {
                const ar = 0.1 + col.radius;
                const side = Math.sqrt(dist * dist - ar * ar);
                let av = Math.abs(Math.atan2(ar, side));
                av -= ca;
                if (av > 0) {
                  const ax = cross(cdv, link);
                  norm(ax);
                  rotAbout(link, ax, av);
                }
              }
            }
          }
        }
        // the floor
        if (ground) {
          const down: V3 = [0, -1, 0];
          norm(link);
          const dbg = this.debug;
          if (onGround) {
            const ex = link[0] * s.len + s.pos[0], ey = link[1] * s.len + s.pos[1];
            const hit = ground(ex, ey + 1, ex, ey - 1, 0.1);
            dbg?.([ci, k, s.pos[0], s.pos[1], ex, ey, 3, hit?.[0] ?? NaN, hit?.[1] ?? NaN]);
            const ax = cross(down, link);
            norm(ax);
            rotAbout(down, ax, 1.5707964);
            link[0] = down[0]; link[1] = down[1]; link[2] = down[2];
            onGround = hit !== null;
          } else {
            const hit = ground(s.pos[0], s.pos[1] + 1, s.pos[0], s.pos[1], 0.1);
            dbg?.([ci, k, s.pos[0], s.pos[1], s.pos[0], s.pos[1], 1, hit?.[0] ?? NaN, hit?.[1] ?? NaN]);
            if (hit) {
              const ax = cross(down, link);
              norm(ax);
              rotAbout(down, ax, 1.5707964);
              onGround = true;
              link[0] = down[0]; link[1] = down[1]; link[2] = down[2];
            } else {
              const ex = link[0] * s.len + s.pos[0], ey = link[1] * s.len + s.pos[1];
              const h2 = ground(s.pos[0], s.pos[1], ex, ey, 0.1);
              dbg?.([ci, k, s.pos[0], s.pos[1], ex, ey, 2, h2?.[0] ?? NaN, h2?.[1] ?? NaN]);
              if (h2) {
                const hd = Math.abs(s.pos[1] - h2[1]);
                const hz = Math.sqrt(-(hd * hd - s.len * s.len));
                const ga2 = Math.abs(Math.atan2(hz, hd));
                const ax = cross(down, link);
                norm(ax);
                rotAbout(down, ax, ga2);
                onGround = true;
                link[0] = down[0]; link[1] = down[1]; link[2] = down[2];
              } else onGround = false;
            }
          }
        }
        // the turn from the animation's direction to the new one
        const diff = angle(current, link);
        const raxis = cross(current, link);
        norm(raxis);
        const adj: V3 = [current[0], current[1], current[2]];
        rotAbout(adj, raxis, diff);
        link[0] = adj[0]; link[1] = adj[1]; link[2] = adj[2];
        s.vel = onGround ? 0 : angle(saved, link);
        if (Math.abs(s.vel) > 0) {
          const ax = cross(saved, link);
          norm(ax);
          s.axis = ax;
        }
        if (s.vel !== 0) {
          if (s.vel > prm.damp) s.vel -= prm.damp;
          else if (s.vel < -prm.damp) s.vel += prm.damp;
          else s.vel = 0;
        }
        if (!(diff > -1e-5 && diff < 1e-5)) {
          // (its axis in the joint's parent's frame: the parent's transpose)
          const pt = Float64Array.of(parent[0], parent[4], parent[8], 0, parent[1], parent[5], parent[9], 0, parent[2], parent[6], parent[10], 0);
          const la = multVec(pt, raxis);
          if (!(Math.abs(la[0]) < 1e-5 && Math.abs(la[1]) < 1e-5 && Math.abs(la[2]) < 1e-5)) {
            const ll = Math.sqrt(la[0] * la[0] + la[1] * la[1] + la[2] * la[2]);
            if (Math.abs(ll) >= 1.1754944e-38) {
              const h = 0.5 * diff, sn = Math.sin(h);
              const aq = [sn * la[0] / ll, sn * la[1] / ll, sn * la[2] / ll, Math.cos(h)];
              const r = mtxEuler(quatMtx(quatMul(aq, eulerToQuat(s.rot))));
              s.rot = r;
            }
          }
        }
        // (its turn about its own length's axis eased off)
        if (s.dom === -1) s.rot[2] *= 0.9;
        else if (s.dom === 0) s.rot[0] *= 0.9;
        else s.rot[1] *= 0.9;
        // the parent of the next
        concat(parent, tm, parent);
        eulerMtx(tmp, s.rot);
        concat(parent, tmp, parent);
        concat(parent, sm, parent);
      }
      const tail = c.nodes[k];
      if (tail) {
        concat(parent, trans(tail.t[0], tail.t[1], tail.t[2]), parent);
        eulerMtx(tmp, tail.rot);
        concat(parent, tmp, parent);
        concat(parent, scaleM(tail.sc[0], tail.sc[1], tail.sc[2]), parent);
        tail.pos = [parent[3], parent[7], parent[11]];
      }
    });
  }

  /** the swinging joints' turns as they stand: joint, x, y, z for each (what a blend that takes one of them
   *  over starts from) */
  swung(): Float32Array {
    const out: number[] = [];
    for (const c of this.chains) for (const s of c.nodes) if (s.swing) out.push(s.joint, s.rot[0], s.rot[1], s.rot[2]);
    return Float32Array.from(out);
  }

  /** onto the posed model: each swinging joint's turn, its rest place and size */
  apply(rot: Float32Array, transA: Float32Array, scaleA: Float32Array) {
    for (const c of this.chains) {
      for (const s of c.nodes) {
        if (!s.swing) continue;
        rot.set(s.rot, s.joint * 3);
        transA.set(s.t, s.joint * 3);
        scaleA.set(s.sc, s.joint * 3);
      }
    }
  }
}

/** lbColl_80005C44: does the segment a-b come within r0 + r1 of c */
function segSphere(a: V3, b: V3, c: V3, r0: number, r1: number): boolean {
  const t = r0 + r1;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) { if (a[i] + t < c[i] || b[i] - t > c[i]) return false; }
    else if (a[i] - t > c[i] || b[i] + t < c[i]) return false;
  }
  const d1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], d2 = [a[0] - c[0], a[1] - c[1], a[2] - c[2]];
  const dd = d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2], dp = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
  let sc = Math.abs(dd) < 1e-5 ? 0 : -dp / dd;
  sc = Math.max(0, Math.min(1, sc));
  const p = [d1[0] * sc + a[0] - c[0], d1[1] * sc + a[1] - c[1], d1[2] * sc + a[2] - c[2]];
  return !(t * t < p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
}
