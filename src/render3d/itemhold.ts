/* 3D replay viewer: a hand's pose around an item it holds.
 *
 * A fighter holding a light item has one of its part animations (face.ts:
 * ftData+0x1C, a hand's joints and a list of poses) put on the hand, by how
 * the item is held (the item's attributes' hold kind, itGetHoldKind): each
 * fighter's OnItemPickup (ft/inlines.h Fighter_OnItemPickup; Kirby's and
 * Jigglypuff's their own) makes a pose the slot's default (ftAnim_80070FB4),
 * and when the pick-up says so puts it on at once (ftAnim_80070C48). Every
 * change of action state takes every slot's pose off and puts the defaults
 * back on (Fighter_ChangeMotionState: ftAnim_80070F28, ftAnim_80070E74), so a
 * hand that held the item through a move's own part poses has the hold's
 * again in the next. A move's script hiding the item (command 35,
 * ftAction_80071F34: ftCommon_8007F5CC) takes the pose off and showing it
 * puts it back (OnItemInvisible: ftAnim_80070CC4, OnItemVisible); letting the
 * item go clears the default and ends the pose (OnItemDrop, from
 * ftCommon_8007E6DC, always with its flag set when an item leaves a hand:
 * ftLib_80086724).
 *
 * The posed joints take the pose's turn, place and size whole (the pose is
 * on the blend's shadow joint, copied each frame: ftAnim_800707B0,
 * lbCopyJObjSRT) and the body's animation leaves them alone. For a turnip
 * or a bomb (hold kind 3) that is the fingers' grip and the turn of the
 * hand's own joint and of the joint the item hangs on.
 *
 * From the replay: the item a fighter owns in one of its held states. Only
 * the items listed here are known held (each from its own code); any other
 * leaves the hand as its animation has it. */
import { Archive } from "./hsd";

/** which slot a fighter's hold pose is the default of (`set`), which slot a
 *  pick-up puts on and a drop ends (`apply`), and the pose by hold kind */
export interface HoldSlots { set: number; apply: number; poses: Record<number, number> }

const GENERIC: Record<number, number> = { 1: 1, 2: 0, 3: 2, 4: 3 };
const RIGHT: HoldSlots = { set: 1, apply: 1, poses: GENERIC };
const LEFT: HoldSlots = { set: 0, apply: 0, poses: GENERIC };
// (Marth's and Roy's make it slot 0's default and put on, and end, slot 1: ftMs_Init_OnItemPickup, ftFe's)
const SWORD: HoldSlots = { set: 0, apply: 1, poses: GENERIC };
/** by internal character id; none for Mewtwo (his callbacks do nothing: the item floats) */
const SLOTS: Record<number, HoldSlots> = {
  0: RIGHT, 1: RIGHT, 2: RIGHT, 3: RIGHT, 5: RIGHT, 6: RIGHT, 7: RIGHT, 8: RIGHT, 9: RIGHT, 10: RIGHT, 11: RIGHT, 14: RIGHT,
  17: RIGHT, 19: RIGHT, 20: RIGHT, 21: RIGHT, 22: RIGHT, 24: RIGHT, 25: RIGHT,
  12: LEFT, 13: LEFT, 23: LEFT,
  18: SWORD, 26: SWORD,
  4: { set: 1, apply: 1, poses: { 1: 0, 3: 1, 4: 2 } },   // ftKb_Init_OnItemPickup
  15: { set: 0, apply: 0, poses: { 3: 0, 4: 1 } },        // ftPr_Init_OnItemPickup
};
export function holdSlots(char: number): HoldSlots | null {
  return SLOTS[char] ?? null;
}

/** the item states an item is in a hand in, and whether its coming into the
 *  hand puts the pose on at once (the flag its code gives
 *  ftpickupitem_80094818), by the replay's item type:
 *  - Peach's turnip (itpeachturnip.c: 0 as it is pulled, 4 picked up again;
 *    the pull's flag is false, ftPe_SpecialLw's setupVeg - a catch's is true,
 *    ftpickupitem_800948A8)
 *  - Link's and Young Link's bombs (itlinkbomb.c: 0; the pull's flag is true,
 *    ftLk_SpecialLw's spawnBomb) */
const HELD: Record<number, { states: number[]; now: (state: number) => boolean }> = {
  0x63: { states: [0, 4], now: (s) => s === 4 },
  0x3a: { states: [0], now: () => true },
  0x3b: { states: [0], now: () => true },
};
/** whether an item of this type in this state is in its owner's hand, and
 *  whether it came into it with the flag that puts the pose on at once */
export function heldIn(typeId: number, state: number): { now: boolean } | null {
  const h = HELD[typeId];
  return h && h.states.includes(state) ? { now: h.now(state) } : null;
}
/** the fighter whose own article an item type is (internal id): its hold
 *  kind is read from that fighter's file, so only in its hands is it known */
export const HELD_MAKER: Record<number, number> = { 0x63: 9, 0x3a: 6, 0x3b: 20 };

/** what holding does to a fighter's hand on a frame: the pose its item
 *  makes the default (-1: none for that hold kind, the default stays as it
 *  was), and whether its coming into the hand puts it on at once */
export interface Hold { pose: number; now: boolean }

/** the hold of an item with this hold kind in this fighter's hand; null for a
 *  heavy one (the callbacks leave the hands alone) or a fighter with none */
export function holdOf(char: number, kind: number, heavy: boolean, now: boolean): Hold | null {
  const s = SLOTS[char];
  if (!s || heavy) return null;
  return { pose: s.poses[kind] ?? -1, now };
}

/** the frames of a move's script that hide or show a held item (command 35:
 *  the script's own frames, as fx/script.ts counts them without a clock) */
export interface ItemVis { frame: number; on: boolean }

// words each command takes (fx/script.ts)
const GENERIC_WORDS = [1, 1, 1, 1, 1, 2, 1, 2, 1, 1];
const FIGHTER_WORDS = [5, 5, 1, 1, 1, 1, 1, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1, 1, 1, 7, 4, 1, 1, 1, 1, 1,
                       1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 3, 2, 1, 4];
export function itemVisEvents(a: Archive, start: number): ItemVis[] {
  const d = a.data, reloc = a.reloc, out: ItemVis[] = [];
  let p: number | null = start, frame = 0, base = start, jumps = 0;
  const stack: { kind: "loop" | "sub"; at: number; count: number; base?: number }[] = [];
  for (let steps = 0; p !== null && steps < 4000; steps++) {
    if (p + 4 > d.byteLength) break;
    const w: number = d.getUint32(p), op = w >>> 26;
    const next: number = p + (op < 10 ? GENERIC_WORDS[op] : FIGHTER_WORDS[op - 10] ?? 1) * 4;
    if (op === 0) break;
    if (op === 1) frame += w & 0x3ffffff;
    else if (op === 2) frame = Math.max(frame, w & 0x3ffffff);
    else if (op === 3) stack.push({ kind: "loop", at: next, count: w & 0x3ffffff });
    else if (op === 4) {
      const top = stack[stack.length - 1];
      if (top?.kind === "loop" && --top.count > 0) { p = top.at; continue; }
      if (top?.kind === "loop") stack.pop();
    } else if (op === 5) {
      const target: number | null = reloc.has(p + 4) ? d.getUint32(p + 4) : null;
      if (target !== null && stack.length < 16) { stack.push({ kind: "sub", at: next, count: 0, base }); base = p = target; continue; }
    } else if (op === 6) {
      const top = stack.pop();
      if (top?.kind !== "sub") break;
      p = top.at; base = top.base ?? base;
      continue;
    } else if (op === 7) {
      const target: number | null = reloc.has(p + 4) ? d.getUint32(p + 4) : null;
      if (target === null || !(target < base || target > p) || jumps >= 8) break;
      jumps++; base = target; p = target;
      continue;
    } else if (op === 35) out.push({ frame, on: (w & 0x3ffffff) !== 0 });
    p = next;
  }
  return out;
}

/** One fighter's hold pose through a run of an action state, frame by frame
 *  as the game's callbacks come (the comment at the top): `enter` as the
 *  state begins, then `step` for each frame after it. `slot` and `pose` say
 *  what is on the hand's slots because of the item: a pose put on, or a
 *  slot's pose ended. */
export class HoldRun {
  private visible = true;
  constructor(private slots: HoldSlots, private put: (slot: number, pose: number, frame: number) => void,
              private end: (slot: number) => void) {}

  /** the state begins on replay frame `g`: `now` the hold at its end, `before` the frame before's */
  enter(g: number, now: Hold | null, before: Hold | null) {
    // (Fighter_ChangeMotionState shows the item again, and the defaults go on)
    this.visible = true;
    if (now && (before || now.now) && now.pose >= 0) this.put(this.slots.set, now.pose, g);
  }

  /** replay frame `g` of the state: the hold then and the frame before, and the script's hides and shows that
   *  ran on it, in order */
  step(g: number, now: Hold | null, before: Hold | null, vis: readonly boolean[]) {
    // (into the hand: the default is the pose; put on when the pick-up says so, on the slot it names)
    if (now && !before && now.now && now.pose >= 0 && this.slots.apply === this.slots.set) this.put(this.slots.apply, now.pose, g);
    // (out of it: the pose on the slot the drop names ends)
    if (!now && before) this.end(this.slots.apply);
    for (const on of vis) {
      // (ftCommon_8007F5CC: only with an item, and only on a change)
      if (now && on !== this.visible) {
        if (!on) this.end(this.slots.set);
        else if (now.pose >= 0) this.put(this.slots.set, now.pose, g);
      }
      this.visible = on;
    }
  }
}
