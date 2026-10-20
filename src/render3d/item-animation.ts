/* 3D replay viewer: which animation an item plays, and how far into it it is.
 *
 * An item's state number is not its animation's: each kind of item has a
 * table of states, and each names the animation it plays
 * (item-animations.generated.ts). A state that names none (-1) takes the
 * animation off and leaves the item in the pose it had. A change of state
 * starts the new state's animation from its first frame, except the few the
 * game changes without doing so (below). The clock stands still while the
 * item is in its own hitlag (itemlag.ts).
 */
import type { ItemUpdate, ReplayData } from "../common/types";
import { ITEM_ANIMATIONS } from "./item-animations.generated";
import { heldInHitlag } from "./itemlag";

/** the animation a kind of item plays in a state, or -1 for none */
export const itemAnimationIndex = (type: number, state: number): number => ITEM_ANIMATIONS[type]?.[state] ?? -1;

/** an item's animation on a frame: which (`index`), how many frames into it (`age`), and whether it is held
 *  in the last pose of the one before (`frozen`: its state has none) */
export interface ItemAnimation { index: number; age: number; frozen: boolean }

const SAMUS_BOMB = 0x5d;
const BOOMERANGS = [0x3c, 0x3d];

/** whether an item's change of state from `before` to `now` keeps its animation going: Samus's bomb between
 *  its rolling, falling and resting states (the change's flags 0x11: itsamusbomb.c), and Link's boomerangs
 *  turning to come back (state 3, flags 0x110), except from state 1, which loads the animation again
 *  (itlinkboomerang.c) */
function keepsAnimation(before: ItemUpdate, now: ItemUpdate): boolean {
  if (now.typeId === SAMUS_BOMB) return now.state < 3 && before.state < 3;
  if (BOOMERANGS.includes(now.typeId)) return now.state === 3 && before.state !== 1;
  return false;
}

// (each replay's items' animations, frame by frame, worked out once from its first frame: the same however
// the player seeks)
const cache = new WeakMap<ReplayData, Map<number, Map<number, ItemAnimation>>>();

function history(data: ReplayData): Map<number, Map<number, ItemAnimation>> {
  const byFrame = new Map<number, Map<number, ItemAnimation>>();
  const last = new Map<number, { item: ItemUpdate; frame: number; animation: ItemAnimation }>();
  for (let f = 0; f < data.frames.length; f++) {
    const row = new Map<number, ItemAnimation>();
    for (const q of data.frames[f]?.items ?? []) {
      const seen = last.get(q.spawnId);
      // (the same item on the frame before)
      const before = seen?.frame === f - 1 && seen.item.typeId === q.typeId ? seen : undefined;
      const index = itemAnimationIndex(q.typeId, q.state);
      let animation: ItemAnimation;
      if (before && (before.item.state === q.state || keepsAnimation(before.item, q))) {
        const still = before.animation.frozen || heldInHitlag(before.item, q);
        animation = { ...before.animation, age: before.animation.age + (still ? 0 : 1) };
      } else if (index < 0) {
        animation = { index: before?.animation.index ?? -1, age: before?.animation.age ?? 0, frozen: true };
      } else {
        animation = { index, age: 0, frozen: false };
      }
      row.set(q.spawnId, animation);
      last.set(q.spawnId, { item: q, frame: f, animation });
    }
    if (row.size) byFrame.set(f, row);
  }
  return byFrame;
}

/** an item's animation on a frame of the replay */
export function itemAnimation(data: ReplayData, frame: number, item: ItemUpdate): ItemAnimation {
  let byFrame = cache.get(data);
  if (!byFrame) {
    byFrame = history(data);
    cache.set(data, byFrame);
  }
  return byFrame.get(frame)?.get(item.spawnId) ?? { index: itemAnimationIndex(item.typeId, item.state), age: 0, frozen: false };
}
