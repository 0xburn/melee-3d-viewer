// Items' animations (item-animation.ts), their state changes' effects (item-effects.ts) and Kirby's copied
// charges (fx/charges.ts), on made-up replays.

import test from "node:test";
import assert from "node:assert/strict";
import type { ItemUpdate, ReplayData } from "../src/common/types.ts";
import { itemAnimation, itemAnimationIndex } from "../src/render3d/item-animation.ts";
import { iceTransitionEffects, itemRuleEffects, itemTransitionEffects } from "../src/render3d/item-effects.ts";
import { spawnFor } from "../src/render3d/fx/dispatch.ts";
import { storedAnim, storedCharges } from "../src/render3d/fx/charges.ts";

const LINK_ARROW = 0x40;
const item = { spawnId: 1, typeId: LINK_ARROW, state: 1, xPosition: 0, yPosition: 0, xVelocity: 0, yVelocity: 0 };

/** a replay of one item going through these states, a frame each */
function replay(states: number[], typeId = item.typeId): ReplayData & { frames: { items: ItemUpdate[] }[] } {
  return { frames: states.map((state) => ({ items: [{ ...item, typeId, state }] })) } as unknown as ReplayData & { frames: { items: ItemUpdate[] }[] };
}

test("each state's animation, from the game's tables: states with none, and Shadow Ball's at every charge", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((s) => itemAnimationIndex(LINK_ARROW, s)), [-1, 0, -1, -1, -1]);
  for (const type of [0x70, 0x90]) {
    assert.deepEqual(Array.from({ length: 18 }, (_, s) => itemAnimationIndex(type, s)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4, 5, 6, 7, 8]);
  }
  assert.deepEqual([0, 1, 2, 3].map((s) => itemAnimationIndex(0x6a, s)), [-1, -1, 0, 0]);
  // (the heart container's states have none: 0xFFFFFFFF in the game's table is -1)
  assert.deepEqual([0, 1, 2, 3, 4].map((s) => itemAnimationIndex(0x08, s)), [-1, -1, -1, -1, -1]);
});

test("an arrow that sticks keeps its last pose, whatever order the frames are asked in", () => {
  const d = replay([0, 1, 1, 1, 2, 2, 3]);
  const on = (f: number) => itemAnimation(d, f, d.frames[f].items[0]);
  assert.deepEqual(on(6), { index: 0, age: 2, frozen: true });
  assert.deepEqual(on(0), { index: -1, age: 0, frozen: true });
  assert.deepEqual(on(3), { index: 0, age: 2, frozen: false });
  assert.deepEqual(on(6), { index: 0, age: 2, frozen: true });
});

test("a boomerang turning back keeps its flight's animation, except from state 1", () => {
  for (const type of [0x3c, 0x3d]) {
    const d = replay([1, 1, 2, 2, 3, 3], type);
    assert.deepEqual(itemAnimation(d, 5, d.frames[5].items[0]), { index: 1, age: 3, frozen: false });
    const e = replay([1, 1, 3], type);
    assert.deepEqual(itemAnimation(e, 2, e.frames[2].items[0]), { index: 2, age: 0, frozen: false });
  }
});

test("bursts start once, as the item enters its state, Kirby's Shadow Ball's too", () => {
  const cases: [number, number, number[]][] = [
    [0x5d, 3, [0x40c]], [0x5f, 2, [0x40c]], [0x5f, 3, [0x40e]], [0x3a, 5, [0x40e]], [0x3b, 5, [0x40e]],
    [0x56, 2, [0x4ce, 0x4cf]], [0x70, 17, [0x40e]], [0x90, 16, [0x40e]],
  ];
  for (const [typeId, state, expected] of cases) {
    const now = { typeId, state };
    assert.deepEqual(itemTransitionEffects({ typeId, state: 0 }, now), expected);
    assert.deepEqual(itemTransitionEffects(now, now), []);
    assert.deepEqual(itemTransitionEffects(undefined, { typeId, state: 0 }), []);
    for (const id of expected) {
      assert.ok(spawnFor(id));
      // (and the learned table leaves them to these rules)
      assert.ok(itemRuleEffects(typeId).includes(id));
    }
  }
  assert.deepEqual(itemRuleEffects(0x6a), [0x4e9, 0x4ea, 0x4eb]);
  assert.deepEqual(itemRuleEffects(0x85), [0x4ae, 0x4af, 0x4b0]);
  assert.deepEqual(itemRuleEffects(0x30), []);
});

test("the fighters' own effects come from their own effect files", () => {
  assert.deepEqual(spawnFor(0x4e2), { m: 2, bank: 13 });
  assert.deepEqual(spawnFor(0x4ce), { g: 9000, bank: 9 });
  assert.deepEqual(spawnFor(0x4ec), { g: 14007, bank: 14, attach: true });
  assert.deepEqual(spawnFor(0x4b0), { g: 46006, bank: 46, face: 1 });
});

test("Kirby keeps a copied full charge when he cancels it, and loses it with the copy", () => {
  // (the copy, its states: started, looping, letting go; the offsets of its most charge and its rate)
  const copies: [number, number, number, number, number, number, number][] = [
    [3, 455, 456, 14, 58, 0x190, -1], [13, 407, 408, 409, 54, 0x168, 0x170],
    [16, 500, 501, 502, 93, 0x384, 0x390], [7, 467, 468, 469, 87, -1, -1],
  ];
  for (const [kind, start, loop, end, color, most, rate] of copies) {
    const states = [start, loop, ...Array(20).fill(loop), end, 14, 14];
    const frames = states.map((actionStateId) => ({ players: [{ state: { internalCharacterId: 4, actionStateId, actionStateFrameCounter: 0 } }] }));
    const d = { frames } as unknown as ReplayData;
    const attrs = { int: (o: number) => o === most ? 2 : o === rate ? 0 : 0, float: (o: number) => o === most ? 2 : 0 };
    const copyAt = (_: number, f: number) => f === states.length - 1 ? -1 : kind;
    const result = storedCharges(d, () => attrs, copyAt).get("0:0");
    assert.ok(result, `copy ${kind} has a stored charge`);
    assert.equal(storedAnim(result[states.length - 2]), color);
    assert.equal(result[states.length - 1], 0);
  }
});

test("Ice Shot: its trail ends in the air, and landing starts its spray alone", () => {
  for (const [typeId, made, trail, spray] of [[0x6a, 0x4e9, 0x4ea, 0x4eb], [0x85, 0x4ae, 0x4af, 0x4b0]]) {
    const inState = (state: number) => ({ typeId, state });
    assert.deepEqual(iceTransitionEffects(undefined, inState(1)), { stop: false, effects: [made] });
    assert.deepEqual(iceTransitionEffects(inState(1), inState(2)), { stop: false, effects: [trail, spray] });
    assert.deepEqual(iceTransitionEffects(inState(2), inState(3)), { stop: true, effects: [] });
    assert.deepEqual(iceTransitionEffects(inState(3), inState(2)), { stop: false, effects: [spray] });
    assert.equal(iceTransitionEffects(inState(2), inState(2)), null);
  }
});
