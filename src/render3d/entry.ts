/* 3D replay viewer: a fighter entering the match (ft_0C31.c).
 *
 * Before GO each fighter is in three states. Entry (322): not drawn, waiting
 * its turn. EntryStart (323): a stand (PlCo's entry 16) rises under it over
 * ftCommonData 0x6BC frames, lifting it by 1.497345 of the stand's scale,
 * while the fighter grows up from 0x6C4 of its height, playing its Entry
 * animation; an effect (0x43E) and a white flash start with it. EntryEnd
 * (324): no animation of its own (the entry's holds), the stand sinks back
 * over 0x6C0 frames (as a share of 0x6BC). The replay's position is the
 * fighter's, on top of the stand; the stand stands there, turned the way the
 * fighter faces, set back by the fighter's x40 (the Ice Climbers' gap).
 */

export const ENTRY = 322, ENTRY_START = 323, ENTRY_END = 324;

export interface EntryTiming { rise: number; fall: number; from: number }

export interface EntryPose {
  /** not drawn (waiting to enter) */
  hidden: boolean;
  /** the stand's height as a share of its full height (0: none) */
  stand: number;
  /** the fighter's height scale, when it is still growing */
  yScale?: number;
  /** the state whose animation it holds at its end */
  holdAnimOf?: number;
}

/** how an entering fighter looks `age` frames into its state (0 on the
 *  frame it began), or null for a state that is not the entry's */
export function entryPose(state: number, age: number, t: EntryTiming, modelScale: number): EntryPose | null {
  if (state === ENTRY) return { hidden: true, stand: 0 };
  if (state === ENTRY_START) {
    // (made from Entry's code, its physics the same frame at its full count:
    // 0 then; each frame after, one more: ftCo_EntryStart_Phys)
    const k = Math.min(1, Math.max(0, age / t.rise));
    return { hidden: false, stand: k, yScale: t.from + k * (modelScale - t.from) };
  }
  if (state === ENTRY_END) {
    // (its count starts at 0x6C0 and falls a frame at a time, taken as a
    // share of 0x6BC: ftCo_EntryEnd_Phys)
    const k = Math.min(1, Math.max(0, (t.fall - age) / t.rise));
    return { hidden: false, stand: k, holdAnimOf: ENTRY_START };
  }
  return null;
}

/** the stand's scale: the player's scale (x34_scale: 1 in a versus match) times the fighter's trophy scale */
export function standScale(playerScale: number, trophyScale: number): number {
  return playerScale * trophyScale;
}
