import type { ReplayData, ItemUpdate } from "../common/types";

// itsamusbomb.c: the bomb starts with zero rotation (its item facing flag
// is off), then faces 0 or PI when horizontal motion sets its direction.
// A stationary/grounded bomb retains the last direction, not a quarter turn.
export function samusBombRotation(data: ReplayData, frame: number, item: ItemUpdate): number {
  for (let i = frame; i >= 0; i--) {
    const previous = data.frames[i]?.items?.find(candidate => candidate.spawnId === item.spawnId);
    if (!previous) break;
    if ((previous.state === 1 || previous.state === 2) && Math.abs(previous.xVelocity) >= .0001) {
      return previous.xVelocity < 0 ? Math.PI : 0;
    }
  }
  return 0;
}

// Lucky Stats: the native fuse keeps counting while a landed bomb is still.
// Only its joint animation accelerates at the threshold; materials retain
// their normal clock (itsamusbomb.c / lb_8000BA0C).
export function samusBombClocks(data: ReplayData, frame: number, item: ItemUpdate, threshold: number, rate: number) {
  let material = 0, joint = 0;
  for (let f = frame; f > 0; f--) {
    const now = data.frames[f]?.items?.find(q => q.spawnId === item.spawnId);
    const prev = data.frames[f - 1]?.items?.find(q => q.spawnId === item.spawnId);
    if (!now || !prev || prev.state === 3 || now.state === 3) break;
    const elapsed = Math.max(0, prev.expirationTimer - now.expirationTimer);
    material += elapsed;
    joint += elapsed * (prev.expirationTimer <= threshold ? rate : 1);
  }
  return { material, joint };
}

export function samusBombDetonated(previous: { state?: number } | undefined, current: { typeId: number; state?: number }): boolean {
  return current.typeId === 0x5d && current.state === 3 && previous?.state !== 3;
}
