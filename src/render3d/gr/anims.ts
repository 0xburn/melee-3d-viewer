/* 3D replay viewer: the animations a stage's code starts, as
 * the viewer track has them.
 *
 * Each time a stage's code starts one of a part's animation sets on the
 * whole part (grAnime_801C8138), the simulator notes it ("ganim": the part,
 * the set, and the frame). The part then plays that set from there: Dream
 * Land's Whispy blinking, turning and blowing, Battlefield's background
 * starting over when it comes back, as the game ran them for this replay.
 */
import type { Run, Stage, StageLogic } from "../stage";
import type { ViewerTrack } from "../track";

/** a set started: from which frame (the replay's index) its time is 0, the set, its rate */
interface Start { from: number; anim: number; rate: number }

export class TrackAnims implements StageLogic {
  private starts = new Map<number, Start[]>();

  constructor(tr: ViewerTrack) {
    for (const key of tr.keys("ganim")) {
      const list: Start[] = [];
      for (const [f, , anim, , rate] of tr.changes("ganim", key)) {
        // the replay's index of the frame; a part started as the stage is
        // built (the track's first frame) has been played once more by then
        // than one started during the match, whose time is 0 on its frame
        const at = Number(f) + 123;
        list.push({ from: Number(f) === -123 ? at - 1 : at, anim: Number(anim), rate: Number(rate) || 1 });
      }
      this.starts.set(Number(key), list);
    }
  }

  /** the parts it has */
  get parts(): number[] {
    return [...this.starts.keys()];
  }

  /** the last start of a part at or before this frame, or null */
  startOf(part: number, frame: number): Start | null {
    const list = this.starts.get(part);
    if (!list || !list.length || list[0].from > frame) return null;
    let lo = 0, hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (list[mid].from <= frame) lo = mid;
      else hi = mid - 1;
    }
    return list[lo];
  }

  apply(st: Stage, frame: number) {
    for (const part of this.starts.keys()) {
      const s = this.startOf(part, frame);
      if (!s) continue;
      const run: Run = { anim: s.anim, joint: 0, deep: true, from: s.from, rate: s.rate };
      st.runs.set(part, [run]);
    }
  }
}
