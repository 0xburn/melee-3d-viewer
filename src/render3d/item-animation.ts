import type { ItemUpdate, ReplayData } from '../common/types';
import { ITEM_ANIMATIONS } from './item-animations.generated';
import { heldInHitlag } from './itemlag';

export const itemAnimationIndex = (type: number, state: number): number => ITEM_ANIMATIONS[type]?.[state] ?? -1;
export interface ItemAnimation { index: number; age: number; frozen: boolean }
const cache = new WeakMap<ReplayData, Map<number, Map<number, ItemAnimation>>>();

// Lucky Stats: use the native animation id, not the motion-state number.
// A -1 state removes animation controllers but leaves the last pose in place.
// Cache the forward history once so repeated seeks cannot alter item clocks.
export function itemAnimation(data: ReplayData, frame: number, item: ItemUpdate): ItemAnimation {
  let byFrame = cache.get(data);
  if (!byFrame) {
    byFrame = new Map();
    const previous = new Map<number, { item: ItemUpdate; frame: number; animation: ItemAnimation }>();
    for (let f = 0; f < data.frames.length; f++) {
      const row = new Map<number, ItemAnimation>();
      for (const q of data.frames[f]?.items ?? []) {
        const before = previous.get(q.spawnId);
        const last = before?.frame === f - 1 && before.item.typeId === q.typeId ? before : undefined;
        const index = itemAnimationIndex(q.typeId, q.state);
        const same = last?.item.state === q.state;
        // Samus's grounded/airborne transitions use flags 0x11 (no animation reset).
        // Boomerang return from state 2 uses 0x110; return from state 1 reloads.
        const preserve = !!last && ((q.typeId === 0x5d && q.state < 3 && last.item.state < 3) ||
          ([0x3c, 0x3d].includes(q.typeId) && q.state === 3 && last.item.state !== 1));
        let animation: ItemAnimation;
        if (last && (same || preserve)) {
          animation = { ...last.animation, age: last.animation.age +
            (last.animation.frozen || heldInHitlag(last.item, q) ? 0 : 1) };
        } else if (index < 0) {
          animation = { index: last?.animation.index ?? -1, age: last?.animation.age ?? 0, frozen: true };
        } else animation = { index, age: 0, frozen: false };
        row.set(q.spawnId, animation);
        previous.set(q.spawnId, { item: q, frame: f, animation });
      }
      if (row.size) byFrame.set(f, row);
    }
    cache.set(data, byFrame);
  }
  return byFrame.get(frame)?.get(item.spawnId) ?? { index: itemAnimationIndex(item.typeId, item.state), age: 0, frozen: false };
}
