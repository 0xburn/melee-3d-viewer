/* 3D replay viewer: Yoshi's Story's Randall.
 *
 * The cloud that rides round the stage (part 2, joint 1) leaves a puff
 * behind it every 10 to 29 frames: generator 44 of the common effects' bank,
 * made on the joint (grStory_801E366C via grLib_801C97DC). The gaps are the
 * game's random numbers, which the replay does not have: a seeded stand-in
 * with the game's range.
 */
import type { ReplayData } from "~/common/types";
import { Rng } from "../fx/particles";
import type { Stage, StageLogic } from "../stage";
import type { Emitter } from "./particles";

export class Randall implements StageLogic {
  readonly emitters: Emitter[] = [];

  constructor(_st: Stage, data: ReplayData) {
    const rng = new Rng(0x5a11);
    // (its timer starts at 0 as the stage is built: the first puff a frame into the match)
    for (let at = 1; at < data.frames.length; at += 12 + Math.floor(rng.next() * 20)) {
      this.emitters.push({ gen: 44, bank: "common", from: at, to: null, joint: { part: 2, joint: 1 },
                           srt: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, follow: false } });
    }
  }

  apply(_st: Stage, _frame: number) {}
}
