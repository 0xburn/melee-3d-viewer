/* 3D replay viewer: a small animated model that is not a
 * fighter or a stage part - an effect (Fox's reflector), the angel platform,
 * a stage's item (Yoshi's Story's Shy Guys). Its joint tree, and the joint
 * and material animations that play on it, all read from your game files;
 * the viewer only says where it is and which frame of its animation. */
import { AObj, Archive, DObj, JObj, MatAnim, loadAnimJoint, loadJoint, loadMatAnimJoint } from "./hsd";
import { RENDER } from "./gx";
import { ident, invert, Mat, mul, srt } from "./math";
import { Skeleton } from "./skeleton";

const NO_DOBJS: DObj[] = [];

/** whether an effect model draws over everything: one whose descriptor's
 *  lifetime has a tenths digit (efLib_Create: (u32)(10 * lifetime) % 10 sets
 *  ZMODE_ALWAYS on all its materials) - the shield's bubbles (EfCoData 11-14)
 *  and Fox's and Falco's reflector (EfFxData 0-2) */
export function effectOverAll(life: number): boolean {
  return Math.trunc(Math.fround(10 * Math.fround(life))) % 10 !== 0;
}

export class Prop {
  skeleton: Skeleton;
  private joints: JObj[];
  private anim: (AObj | null)[] | null;
  private matAnim: (MatAnim | null)[][] | null;
  private place: Mat = new Float32Array(16);

  /** rootAtOrigin: the root joint's own translation is dropped, for a model
   *  the game places by its root (an item: the replay says where it is).
   *  blend: every part is blended by its alpha, as an effect's flashes are
   *  meant to be (their vertex alphas fade them out toward the edges) */
  constructor(a: Archive, joint: number, animJoint: number | null, matAnimJoint: number | null, tag: string,
              private rootAtOrigin = false, blend = false) {
    const { all, dobjs } = loadJoint(a, joint);
    this.joints = all;
    this.skeleton = new Skeleton(a, all, dobjs, tag);
    if (blend) for (const d of this.skeleton.drawables) d.translucent = true;
    this.anim = animJoint === null ? null : loadAnimJoint(a, animJoint);
    this.matAnim = matAnimJoint === null ? null : loadMatAnimJoint(a, matAnimJoint);
  }

  /** every material drawn with no depth test (HSD's ZMODE_ALWAYS): over
   *  whatever was drawn before it, a fighter inside it or in front of it */
  zAlways() {
    for (const s of this.skeleton.states) s.mobj = { ...s.mobj, renderMode: s.mobj.renderMode | RENDER.ZMODE_ALWAYS };
  }

  /** how long its animations run (frames), the longest of them */
  get length(): number {
    let n = 0;
    for (const a of this.anim ?? []) if (a) n = Math.max(n, a.end);
    for (const list of this.matAnim ?? []) for (const m of list) {
      if (m?.aobj) n = Math.max(n, m.aobj.end);
      for (const t of m?.tex ?? []) if (t.aobj) n = Math.max(n, t.aobj.end);
    }
    return n;
  }

  /** at frame `frame` of its animations (looped when loop), at (x, y, z),
   *  scaled by `scale`, turned `rotY` about the vertical and `rotZ` in the
   *  picture's plane (as the game sets an effect's root joint), and `rotX`
   *  about its own x axis (a thrown needle's tilt). `rootSet`: the place is the
   *  root joint's own, over the file's (an effect model the game's dispatch
   *  made at a place or on a joint: HSD_JObjSetTranslate on its root).
   *  jointFrame lets a joint animation run faster without speeding materials. */
  pose(frame: number, x: number, y: number, z: number, scale: number, rotY = 0, loop = true, rotZ = 0, rotX = 0, rootSet = false, jointFrame = frame) {
    const sk = this.skeleton;
    sk.resetPose();
    if (this.anim) sk.applyAObjs(this.anim, jointFrame, loop);
    if (this.rootAtOrigin || rootSet) sk.trans[0] = sk.trans[1] = sk.trans[2] = 0;
    if (this.matAnim) {
      sk.resetMaterials();
      sk.applyMatAnims(this.matAnim, (j) => this.joints[j]?.dobjs ?? NO_DOBJS, frame, loop);
    }
    srt(this.place, scale, scale, scale, rotX, rotY, rotZ, x, y, z);
    sk.update(this.place);
  }

  /** HSD_JObjSetRotationY replaces this component after animation; rotating a
   * parent matrix instead would retain and compose the animated root rotation. */
  setRootRotationY(value: number) {
    this.skeleton.rot[1] = value;
    this.skeleton.update(this.place);
  }

  /** Native callbacks mutate the posed joints after their animation step. */
  setJointTranslationZ(joint: number, value: number) {
    if (joint < 0 || joint >= this.skeleton.n) return;
    this.skeleton.trans[joint * 3 + 2] = value;
    this.skeleton.update(this.place);
  }

  /** Shadow Ball's animation callback replaces the first grandchild's
   * scale, leaving the root/attachment scale alone (itmewtwoshadowball.c). */
  setGrandchildScale(value: number, heldScale?: number) {
    const sk = this.skeleton;
    const child = sk.parent.findIndex(p => p === 0);
    if (child < 0) return;
    const grandchild = sk.parent.findIndex(p => p === child);
    if (grandchild < 0) return;
    sk.scale.fill(value, grandchild * 3, grandchild * 3 + 3);
    // Held Shadow Ball cancels its authored offset in the opposite direction
    // at the fighter's size. Use the authored pose, never the previous draw.
    if (heldScale !== undefined) for (let c = 0; c < 3; c++) {
      sk.trans[grandchild * 3 + c] = -this.joints[grandchild].trans[c] * heldScale;
    }
    sk.update(this.place);
  }

  /** at rest, at (x, y, z), scaled each way by `scale` and turned `rotY`
   *  about the vertical (a stand whose height alone grows) */
  poseScaled(x: number, y: number, z: number, scale: [number, number, number], rotY: number) {
    const sk = this.skeleton;
    sk.resetPose();
    if (this.rootAtOrigin) sk.trans[0] = sk.trans[1] = sk.trans[2] = 0;
    srt(this.place, scale[0], scale[1], scale[2], 0, rotY, 0, x, y, z);
    sk.update(this.place);
  }

  /** at frame `frame`, held: its joint `attach` takes the place and the turn
   *  of another model's joint (its world matrix `parent`), at its own
   *  `scale`, and the rest of it goes with that joint - an item the game
   *  ties to a fighter's hand (a position and an orientation constraint) */
  poseUnder(frame: number, parent: Float32Array, scale: number, loop = true, attach = 0) {
    const sk = this.skeleton;
    sk.resetPose();
    if (this.anim) sk.applyAObjs(this.anim, frame, loop);
    if (this.rootAtOrigin) sk.trans[0] = sk.trans[1] = sk.trans[2] = 0;
    if (this.matAnim) {
      sk.resetMaterials();
      sk.applyMatAnims(this.matAnim, (j) => this.joints[j]?.dobjs ?? NO_DOBJS, frame, loop);
    }
    // where the tied joint sits in the item: the root put so that it lands
    // on the holder's joint, turned as that joint is (its size the item's)
    ident(this.place);
    sk.update(this.place);
    const a = Math.max(0, Math.min(attach, sk.n - 1));
    const local = sk.world.slice(a * 16, a * 16 + 16) as Mat;
    invert(this.inv, local);
    for (let c = 0; c < 3; c++) {
      const len = Math.hypot(parent[c * 4], parent[c * 4 + 1], parent[c * 4 + 2]) || 1;
      for (let r = 0; r < 3; r++) this.tied[c * 4 + r] = (parent[c * 4 + r] / len) * scale;
      this.tied[c * 4 + 3] = 0;
    }
    this.tied[12] = parent[12]; this.tied[13] = parent[13]; this.tied[14] = parent[14]; this.tied[15] = 1;
    // (the tied joint's own scale is kept: its local matrix carries it)
    const ls = Math.hypot(local[0], local[1], local[2]) || 1;
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) this.tied[c * 4 + r] *= ls;
    mul(this.place, this.tied, this.inv);
    sk.update(this.place);
  }
  /** efLib_Create_AttachChild installs position and orientation constraints.
   * HSD's resolveCnsOrientation copies the target's basis, retaining this
   * root's animated column lengths; it does not compose root rotations. */
  poseConstrained(frame: number, parent: Float32Array, scale: number, loop = true) {
    this.pose(frame, 0, 0, 0, scale, 0, loop);
    const sk = this.skeleton;
    for (let c = 0; c < 3; c++) {
      const j = c * 4;
      const own = Math.hypot(sk.world[j], sk.world[j + 1], sk.world[j + 2]);
      const len = Math.hypot(parent[j], parent[j + 1], parent[j + 2]) || 1;
      for (let r = 0; r < 3; r++) this.place[j + r] = parent[j + r] * own / len;
      this.place[j + 3] = 0;
      sk.rot[c] = sk.trans[c] = 0;
      sk.scale[c] = 1;
    }
    this.place[12] = parent[12]; this.place[13] = parent[13]; this.place[14] = parent[14]; this.place[15] = 1;
    sk.update(this.place);
  }

  /** at frame `frame`, a child of another model's joint (its world matrix
   *  `parent`, taken at size `scale`): its root's own animation under it (an
   *  effect the game makes a child of a fighter's joint) */
  poseChild(frame: number, parent: Float32Array, scale: number, loop = true) {
    const sk = this.skeleton;
    sk.resetPose();
    if (this.anim) sk.applyAObjs(this.anim, frame, loop);
    if (this.matAnim) {
      sk.resetMaterials();
      sk.applyMatAnims(this.matAnim, (j) => this.joints[j]?.dobjs ?? NO_DOBJS, frame, loop);
    }
    for (let c = 0; c < 3; c++) {
      const len = Math.hypot(parent[c * 4], parent[c * 4 + 1], parent[c * 4 + 2]) || 1;
      for (let r = 0; r < 3; r++) this.place[c * 4 + r] = (parent[c * 4 + r] / len) * scale;
      this.place[c * 4 + 3] = 0;
    }
    this.place[12] = parent[12]; this.place[13] = parent[13]; this.place[14] = parent[14]; this.place[15] = 1;
    sk.update(this.place);
  }

  /** its root given another model's joint's matrix outright (HSD_JObjCopyMtx
   *  with a user-defined matrix: the root's own place is not applied, only
   *  what hangs under it) */
  poseMatrix(m: Float32Array, frame?: number) {
    const sk = this.skeleton;
    sk.resetPose();
    sk.rot[0] = sk.rot[1] = sk.rot[2] = 0;
    sk.trans[0] = sk.trans[1] = sk.trans[2] = 0;
    sk.scale[0] = sk.scale[1] = sk.scale[2] = 1;
    // (at a frame of its animations, when it has some: each looping as its own says)
    if (frame !== undefined) {
      if (this.anim) sk.applyAObjs(this.anim, frame, false);
      if (this.matAnim) {
        sk.resetMaterials();
        sk.applyMatAnims(this.matAnim, (j) => this.joints[j]?.dobjs ?? NO_DOBJS, frame, false);
      }
      // (the root's matrix is the one given, whatever its animation says of it)
      sk.rot[0] = sk.rot[1] = sk.rot[2] = 0;
      sk.trans[0] = sk.trans[1] = sk.trans[2] = 0;
      sk.scale[0] = sk.scale[1] = sk.scale[2] = 1;
    }
    this.place.set(m.subarray(0, 16));
    sk.update(this.place);
  }
  private inv: Mat = new Float32Array(16);
  private tied: Mat = new Float32Array(16);
}
