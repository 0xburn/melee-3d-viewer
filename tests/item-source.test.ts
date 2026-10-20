// item-source.ts: an item's model is its maker's, though its owner changes.

import test from "node:test";
import assert from "node:assert/strict";
import type { ItemUpdate, ReplayData } from "../src/common/types.ts";
import { itemSource } from "../src/render3d/item-source.ts";

const player = (internalCharacterId: number) => ({ state: { internalCharacterId } });
type Replay = ReplayData & { frames: { items: ItemUpdate[] }[] };

test("a reflected item is still its maker's, costume and all, whatever the frame and later changes", () => {
  const data = {
    settings: { playerSettings: [{ costumeIndex: 2 }, { costumeIndex: 1 }] },
    frames: [
      { players: [player(16), player(1)], items: [{ spawnId: 1, owner: 0 }] },
      { players: [player(16), player(1)], items: [{ spawnId: 1, owner: 1 }] },
      { players: [player(19), player(1)], items: [{ spawnId: 1, owner: 1 }, { spawnId: 2, owner: 0 }] },
    ],
  } as unknown as Replay;
  const source = (f: number, i = 0) => itemSource(data, data.frames[f].items[i]);
  assert.deepEqual(source(2), { character: 16, costume: 2 });
  assert.deepEqual(source(0), source(2));
  // (one made after its maker's port changed character: the new character's)
  assert.deepEqual(source(2, 1), { character: 19, costume: 2 });
});

test("an item no fighter owns has no maker", () => {
  const data = { settings: { playerSettings: [] }, frames: [{ players: [], items: [{ spawnId: 1, owner: -1 }] }] } as unknown as Replay;
  assert.equal(itemSource(data, data.frames[0].items[0]), null);
});
