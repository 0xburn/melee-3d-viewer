/* 3D replay viewer: Fountain of Dreams' water columns.
 *
 * Each side platform stands on a column of water: a copy of part 4 the
 * stage's code makes at the main part's joint 4 (left) and 6 (right)
 * (grIzumi_801CCBDC), looping its short animation, whose keys send up the
 * spray at its foot and its top. As its platform rises and sinks the code
 * stretches the column's root joint to the platform's height (tall by the
 * height over the column's own, 45; wide by half that and a half), and when
 * the platform goes under the water the column goes with it until it comes
 * back up (grIzumi_801CC358). A viewer track says how high each platform is
 * ("fod"), whatever the replay's version, and so does the replay from Slippi
 * 3.18 on; else they stand where the file starts them. The platforms are the
 * main part's joints, which the stage poses from the heights apply leaves.
 */
import type { Part, Run, Stage, StageFrame, StageLogic } from "../stage";
import type { Emitter } from "./particles";

interface Column { part: Part; side: 0 | 1; tall: number }

/** a platform this low is under the water (the code sets it just under its column's foot) */
const SUNK = -1.5;
const columns = new WeakMap<Stage, Column[]>();

export class Fountain implements StageLogic {
  private cols: Column[] = [];
  private run: Run[] = [{ anim: 0, joint: 0, deep: true, from: 0, rate: 1 }];
  /** the two the main part's code makes as the stage is built and keeps
   *  going (grIzumi_801CBE64: generators 0x7534 at the middle, 0x7536 by the
   *  fountain), each under the stage's scale */
  readonly emitters: Emitter[];

  constructor(st: Stage, private heightAt: (frame: number, side: 0 | 1) => number | undefined) {
    const s = st.scale;
    const at = (x: number, y: number, z: number, gen: number): Emitter =>
      ({ gen, from: 0, to: null, srt: { tx: x * s, ty: y * s, tz: z * s, rx: 0, ry: 0, rz: 0, sx: s, sy: s, sz: s, follow: false } });
    this.emitters = [at(0, 0, 0, 0x7534), at(0, 1, -27, 0x7536)];
    // (made once per stage: another replay on it uses the same two)
    const made = columns.get(st);
    if (made) { this.cols = made; return; }
    columns.set(st, this.cols);
    const main = st.partOf(3);
    if (!main) return;
    main.skeleton.resetPose();
    main.skeleton.update(main.place);
    ([[4, 0], [6, 1]] as const).forEach(([joint, side]) => {
      const at = main.skeleton.position(joint);
      const e = st.copyOf(4, `stage${st.stageId}:column${side}`);
      if (!e) return;
      const m = e.place;
      m[12] = at[0]; m[13] = at[1]; m[14] = at[2];
      e.skeleton.update(m);
      // the column's own height: its joint 2 over its foot
      const tall = e.joints.length > 2 ? (e.skeleton.position(2)[1] - at[1]) / (st.scale || 1) : 45;
      st.extras.push(e);
      // (as a viewer track names them: the game makes the left one first, and its table keeps the second)
      st.named.set(side === 0 ? 1004 : 4, e);
      this.cols.push({ part: e, side, tall: tall || 45 });
    });
  }

  private height(st: Stage, frame: number, side: 0 | 1): number {
    return this.heightAt(frame, side) ?? st.fountainStart?.[side] ?? 20;
  }

  apply(st: Stage, frame: number) {
    st.fodHeights = [this.heightAt(frame, 0), this.heightAt(frame, 1)];
    for (const c of this.cols) {
      if (this.height(st, frame, c.side) >= SUNK) st.extraRuns.set(c.part, this.run);
    }
  }

  pose(st: Stage, frame: number, sf: StageFrame | undefined) {
    for (const c of this.cols) {
      if (!st.extraRuns.has(c.part)) continue;
      // (the track's or the replay's for this frame; the frame handed in when neither says)
      const h = this.heightAt(frame, c.side) ?? (c.side === 0 ? sf?.fodLeftPlatformHeight : sf?.fodRightPlatformHeight) ??
        this.height(st, frame, c.side);
      const f = Math.max(0.01, h / c.tall);
      const sk = c.part.skeleton;
      if (sk.n < 2) continue;
      // (the joint under the object's own root - HSD_JObjGetChild of it: the file's root joint, the part's
      // joint 0 here. The game puts a joint of its own above a stage object's file root, and its
      // Ground_801C3FA4 counts from the file's root: that function's 2 is this part's joint 2, the height)
      sk.scale[0] = 0.5 * f + 0.5;
      sk.scale[1] = f;
    }
  }
}
