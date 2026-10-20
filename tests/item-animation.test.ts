import test from 'node:test';
import assert from 'node:assert/strict';
import { itemAnimation, itemAnimationIndex } from '../src/render3d/item-animation';
import { itemTransitionEffects } from '../src/render3d/item-effects';
import { spawnFor } from '../src/render3d/fx/dispatch';

const item = { spawnId: 1, typeId: 0x40, state: 1, xPosition: 0, yPosition: 0, xVelocity: 0, yVelocity: 0 };
function data(states: number[], typeId = item.typeId) {
  return { frames: states.map(state => ({ items: [{ ...item, typeId, state }] })) } as any;
}
test('native state mappings include frozen states and all Shadow Ball charge levels', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(s => itemAnimationIndex(0x40, s)), [-1, 0, -1, -1, -1]);
  for (const type of [0x70, 0x90]) {
    assert.deepEqual(Array.from({ length: 18 }, (_, s) => itemAnimationIndex(type, s)),
      [0,1,2,3,4,5,6,7,8,9,1,2,3,4,5,6,7,8]);
  }
  assert.deepEqual([0,1,2,3].map(s => itemAnimationIndex(0x6a, s)), [-1,-1,0,0]);
});
test('arrow sticks at its last animated pose, independently of seek order', () => {
  const d = data([0,1,1,1,2,2,3]);
  const at = (f: number) => itemAnimation(d, f, d.frames[f].items[0]);
  assert.deepEqual(at(6), { index: 0, age: 2, frozen: true });
  assert.deepEqual(at(0), { index: -1, age: 0, frozen: true });
  assert.deepEqual(at(3), { index: 0, age: 2, frozen: false });
  assert.deepEqual(at(6), { index: 0, age: 2, frozen: true });
});
test('boomerang return preserves flight animation only on native preserve transition', () => {
  for (const type of [0x3c, 0x3d]) {
    const d = data([1,1,2,2,3,3], type);
    assert.deepEqual(itemAnimation(d, 5, d.frames[5].items[0]), { index: 1, age: 3, frozen: false });
    const e = data([1,1,3], type);
    assert.deepEqual(itemAnimation(e, 2, e.frames[2].items[0]), { index: 2, age: 0, frozen: false });
  }
});
test('native impact effects fire once on entry, including Kirby Shadow Ball', () => {
  const cases = [[0x5d,3,[0x40c]], [0x5f,2,[0x40c]], [0x5f,3,[0x40e]],
    [0x3a,5,[0x40e]], [0x3b,5,[0x40e]], [0x56,2,[0x4ce,0x4cf]],
    [0x70,17,[0x40e]], [0x90,16,[0x40e]]] as const;
  for (const [typeId,state,expected] of cases) {
    const now = {typeId,state};
    assert.deepEqual(itemTransitionEffects({typeId,state:0}, now), expected);
    assert.deepEqual(itemTransitionEffects(now, now), []);
    assert.deepEqual(itemTransitionEffects(undefined, {typeId,state:0}), []);
    for (const id of expected) assert.ok(spawnFor(id));
  }
});
test('character effect assets select their own banks instead of common models', () => {
  assert.deepEqual(spawnFor(0x4e2), {m:2,bank:13});
  assert.deepEqual(spawnFor(0x4ce), {g:9000,bank:9});
  assert.deepEqual(spawnFor(0x4ec), {g:14007,bank:14,attach:true});
  assert.deepEqual(spawnFor(0x4b0), {g:46006,bank:46,face:1});
});

test('Kirby retains copied full charges across cancellation and clears on copy loss', async () => {
  const { storedCharges, storedAnim } = await import('../src/render3d/fx/charges');
  for (const [kind, start, loop, end, color, maxOffset, rateOffset] of [
    [3,455,456,14,58,0x190,-1], [13,407,408,409,54,0x168,0x170],
    [16,500,501,502,93,0x384,0x390], [7,467,468,469,87,-1,-1],
  ]) {
    const states = [start,loop,...Array(20).fill(loop),end,14,14];
    const d = {frames:states.map(actionStateId=>({players:[{state:{internalCharacterId:4,actionStateId,actionStateFrameCounter:0}}]}))} as any;
    const attrs = {int:(o:number)=>o===maxOffset ? 2 : o===rateOffset ? 0 : 0,
      float:(o:number)=>o===maxOffset ? 2 : 0};
    const result = storedCharges(d,()=>attrs,(_,f)=>f===states.length-1 ? -1 : kind).get('0:0');
    assert.ok(result, `copy ${kind} produces a charge indicator`);
    assert.equal(storedAnim(result[states.length-2]),color);
    assert.equal(result[states.length-1],0);
  }
});

test('Ice Shot ends its trail in air and restarts only ground spray on landing', async () => {
  const {iceTransitionEffects} = await import('../src/render3d/item-effects');
  for (const [typeId,spawn,launch,spray] of [[0x6a,0x4e9,0x4ea,0x4eb],[0x85,0x4ae,0x4af,0x4b0]]) {
    const at=(state:number)=>({typeId,state});
    assert.deepEqual(iceTransitionEffects(undefined,at(1)),{stop:false,effects:[spawn]});
    assert.deepEqual(iceTransitionEffects(at(1),at(2)),{stop:false,effects:[launch,spray]});
    assert.deepEqual(iceTransitionEffects(at(2),at(3)),{stop:true,effects:[]});
    assert.deepEqual(iceTransitionEffects(at(3),at(2)),{stop:false,effects:[spray]});
    assert.equal(iceTransitionEffects(at(2),at(2)),null);
  }
});
