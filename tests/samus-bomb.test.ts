import test from 'node:test';
import assert from 'node:assert/strict';
import { samusBombRotation } from '../src/render3d/item-facing';
test('Samus bomb starts face-on and retains its moving direction when grounded', () => {
  const item = { spawnId: 1, state: 1, xVelocity: 0 };
  const data = { frames: [
    { items: [item] },
    { items: [{ ...item, xVelocity: -1 }] },
    { items: [{ ...item, state: 0 }] },
    { items: [{ ...item, state: 2, xVelocity: 1 }] },
  ] } as any;
  assert.equal(samusBombRotation(data, 0, item as any), 0);
  assert.equal(samusBombRotation(data, 1, item as any), Math.PI);
  assert.equal(samusBombRotation(data, 2, item as any), Math.PI);
  assert.equal(samusBombRotation(data, 3, item as any), 0);
  assert.equal(samusBombRotation(data, 3, { ...item, spawnId: 2 } as any), 0);
});

test('Samus fuse advances on the ground, accelerates joints only, and pauses in hitlag', async () => {
  const { samusBombClocks, samusBombDetonated } = await import('../src/render3d/item-facing.ts');
  const item = { spawnId: 7, typeId: 0x5d, state: 1, xPosition: 1, yPosition: 0, xVelocity: 0, yVelocity: -1 };
  const states = [1, 0, 0, 0, 0, 3, 3];
  const timers = [42, 41, 40, 40, 39, 80, 79];
  const data = { frames: timers.map((expirationTimer, i) => ({ items: [{ ...item, state: states[i], expirationTimer }] })) } as any;
  assert.deepEqual(samusBombClocks(data, 4, item as any, 40, 2), { material: 3, joint: 4 });
  assert.equal(samusBombDetonated(data.frames[4].items[0], data.frames[5].items[0]), true);
  assert.equal(samusBombDetonated(data.frames[5].items[0], data.frames[6].items[0]), false);
  assert.equal(samusBombDetonated(undefined, { typeId: 0x5d, state: 1 }), false);
  assert.equal(samusBombDetonated(undefined, { typeId: 0x5e, state: 3 }), false);
});
