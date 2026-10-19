/* 3D replay viewer: Kirby's Stone (down-B), as his code runs it.
 *
 * Each of the move's states (393 to 398: the start, the stone, the end, on
 * the ground and in the air) takes the move's first variable in its
 * animation callback (ftkirbyspeciallw.c ftKb_SpecialHi_800F346C): the
 * start's script sets it to 1 (its frame 2 on the ground, 8 in the air), the
 * end's to 2 (its frame 0). At 1 he picks a stone and a counter counts up a
 * frame at a time through a table of 22 (ftKb_Init_803CB490), at 2 it counts
 * back down from the end (ftKb_SpecialHi_800F331C): each step shows part 0 in
 * the stone's look and part 1 hidden, or both as they were - a flicker into
 * the stone and back out.
 *
 * Which of his five stones he turns into the game picks at random
 * ((the last one + HSD_Randi(4)) % 5 + 1: never the same twice running),
 * which the replay does not record: a viewer track has it, else a seeded
 * stand-in picks one of the five.
 */
import type { ScriptEvent } from "./fx/script";

export const STONE_FIRST = 393, STONE_LAST = 398;
/** ftKb_Init_803CB490: stone (1) or Kirby (0) on each step */
const FLICKER = [0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 1];
/** ftKb_Init_803CB4EC: part 0's look for each stone (1 to 5) */
const LOOKS = [0, 2, 3, 4, 5, 6];

export interface StoneFrame { actionStateId: number; actionStateFrameCounter: number }

export interface StoneHistory {
  at(g: number): StoneFrame | undefined;
  script(state: number): readonly ScriptEvent[];
}

/** parts 0 and 1 on frame f of a Stone (undefined: not switched); `pick`
 *  the stand-in's choice of stone (1 to 5) for the one begun on frame s */
export function kirbyStoneAt(h: StoneHistory, f: number, pick: (s: number) => number): { part0?: number; part1?: number } | null {
  const now = h.at(f);
  if (!now || now.actionStateId < STONE_FIRST || now.actionStateId > STONE_LAST) return null;
  let e = f;
  while (e > 0 && f - e < 1200) {
    const q = h.at(e - 1);
    if (!q || q.actionStateId < STONE_FIRST || q.actionStateId > STONE_LAST) break;
    e--;
  }
  const out: { part0?: number; part1?: number } = {};
  let v0 = 0, x8 = 0, xC = 0, x10 = 1, x14 = 0;
  let prevState = -1, prevT = -1;
  for (let g = e; g <= f; g++) {
    const st = h.at(g)!;
    const s = st.actionStateId, t = st.actionStateFrameCounter;
    const from = s === prevState && t > prevT ? prevT : -1;
    for (const ev of h.script(s)) {
      if (ev.kind === "cmdVar" && ev.index === 0 && ev.frame > from && ev.frame <= t) v0 = ev.value;
    }
    prevState = s; prevT = t;
    // ftKb_SpecialHi_800F346C
    if (v0 === 1 && x8 === 0 && xC === 0) { x8 = 1; x10 = pick(g); x14 = 0; xC = 1; }
    else if (v0 === 2 && x8 === 0 && xC === 1) { x8 = 2; x14 = FLICKER.length; }
    v0 = 0;
    // ftKb_SpecialHi_800F331C
    if (x8 === 1) x14++;
    else if (x8 === 2) x14--;
    if (x14 >= 0 && x14 < FLICKER.length) {
      if (FLICKER[x14] === 0) { out.part0 = 0; out.part1 = 0; }
      else { out.part0 = LOOKS[x10]; out.part1 = -1; }
    } else x8 = 0;
  }
  return out;
}
