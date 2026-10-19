/* 3D replay viewer: an item's own hitlag.
 *
 * An item that hits (a turnip, the Ice Climbers' ice, a needle stuck where
 * it struck) or is hit takes hitlag of its own (it/item.c: xCBC, set from the
 * damage it dealt, it_8026B424, or the knockback it took), and while it lasts
 * the game runs neither its animation nor its movement (the item's think
 * skips them while flags.x9 is set, from the hit's frame to the one the count
 * runs out). A replay does not record the count, but it shows it: the item
 * stays where it was while its speed says it moves. Those frames its
 * animation stands still too.
 */

/** what an item's frame needs to be read here (a replay item) */
export interface ItemPlace { state: number; xPosition: number; yPosition: number; xVelocity: number; yVelocity: number }

/** whether an item was held still in its hitlag on a frame: where it was the
 *  frame before, while it has a speed */
export function heldInHitlag(prev: ItemPlace | undefined, now: ItemPlace | undefined): boolean {
  if (!prev || !now || prev.state !== now.state) return false;
  return prev.xPosition === now.xPosition && prev.yPosition === now.yPosition && (now.xVelocity !== 0 || now.yVelocity !== 0);
}

/** an item's animation clock in its state: the frames it has been in the
 *  state (`age`) less those it stood still in hitlag. `at(k)` is the same
 *  item on the frame k frames back (0: this one), undefined before it was */
export function itemClock(at: (k: number) => ItemPlace | undefined, age: number): number {
  let still = 0;
  for (let k = 0; k < age; k++) if (heldInHitlag(at(k + 1), at(k))) still++;
  return age - still;
}
