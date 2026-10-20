// item-facing.ts: Samus's bomb, the way it faces and its two clocks.

import test from "node:test";
import assert from "node:assert/strict";
import type { ItemUpdate, ReplayData } from "../src/common/types.ts";
import { samusBombClocks, samusBombDetonated, samusBombRotation } from "../src/render3d/item-facing.ts";

test("the bomb starts straight on and keeps the way it last rolled", () => {
  const item = { spawnId: 1, state: 1, xVelocity: 0 };
  const data = {
    frames: [
      { items: [item] },
      { items: [{ ...item, xVelocity: -1 }] },
      { items: [{ ...item, state: 0 }] },
      { items: [{ ...item, state: 2, xVelocity: 1 }] },
    ],
  } as unknown as ReplayData;
  const bomb = item as unknown as ItemUpdate;
  assert.equal(samusBombRotation(data, 0, bomb), 0);
  assert.equal(samusBombRotation(data, 1, bomb), Math.PI);
  assert.equal(samusBombRotation(data, 2, bomb), Math.PI);
  assert.equal(samusBombRotation(data, 3, bomb), 0);
  assert.equal(samusBombRotation(data, 3, { ...bomb, spawnId: 2 }), 0);
});

test("the fuse counts on the floor, its joints speed up near the end, and it stands still in hitlag", () => {
  const item = { spawnId: 7, typeId: 0x5d, state: 1, xPosition: 1, yPosition: 0, xVelocity: 0, yVelocity: -1 };
  const states = [1, 0, 0, 0, 0, 3, 3];
  const timers = [42, 41, 40, 40, 39, 80, 79];
  const frames = timers.map((expirationTimer, i) => ({ items: [{ ...item, state: states[i], expirationTimer }] }));
  const data = { frames } as unknown as ReplayData;
  assert.deepEqual(samusBombClocks(data, 4, item as unknown as ItemUpdate, 40, 2), { material: 3, joint: 4 });
  assert.equal(samusBombDetonated(frames[4].items[0], frames[5].items[0]), true);
  assert.equal(samusBombDetonated(frames[5].items[0], frames[6].items[0]), false);
  assert.equal(samusBombDetonated(undefined, { typeId: 0x5d, state: 1 }), false);
  assert.equal(samusBombDetonated(undefined, { typeId: 0x5e, state: 3 }), false);
});
