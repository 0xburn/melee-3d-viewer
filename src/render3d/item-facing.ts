/* 3D replay viewer: Samus's bomb, the way it faces and its two clocks (itsamusbomb.c).
 *
 * The bomb is made facing straight on (its item facing flag is off) and
 * turns to face the way it rolls once it moves sideways; resting or on the
 * floor, it keeps the last way it rolled. Its fuse counts down whether it
 * moves or not, and near the end its joints' animation runs faster
 * (lb_8000BA0C) while its materials' (its flashing colors) keep the normal
 * rate.
 */
import type { ItemUpdate, ReplayData } from "../common/types";

/** the bomb's turn about the vertical: 0, or a half turn after it last rolled to the left */
export function samusBombRotation(data: ReplayData, frame: number, item: ItemUpdate): number {
  for (let f = frame; f >= 0; f--) {
    const then = data.frames[f]?.items?.find((q) => q.spawnId === item.spawnId);
    if (!then) break;
    const rolling = then.state === 1 || then.state === 2;
    if (rolling && Math.abs(then.xVelocity) >= 0.0001) return then.xVelocity < 0 ? Math.PI : 0;
  }
  return 0;
}

/** how far the bomb's animations are on a frame, by its fuse: its materials' frame (`material`) and its
 *  joints', which run `rate` times as fast once the fuse is at `threshold` or less (`joint`) */
export function samusBombClocks(data: ReplayData, frame: number, item: ItemUpdate, threshold: number, rate: number) {
  let material = 0;
  let joint = 0;
  for (let f = frame; f > 0; f--) {
    const now = data.frames[f]?.items?.find((q) => q.spawnId === item.spawnId);
    const before = data.frames[f - 1]?.items?.find((q) => q.spawnId === item.spawnId);
    if (!now || !before || before.state === 3 || now.state === 3) break;
    const elapsed = Math.max(0, before.expirationTimer - now.expirationTimer);
    material += elapsed;
    joint += elapsed * (before.expirationTimer <= threshold ? rate : 1);
  }
  return { material, joint };
}

/** whether the bomb goes off on this frame (enters state 3) */
export function samusBombDetonated(previous: { state?: number } | undefined, current: { typeId: number; state?: number }): boolean {
  return current.typeId === 0x5d && current.state === 3 && previous?.state !== 3;
}
