// fx/native-callbacks.ts and the effects it starts in fx/world.ts: what a fighter's own code starts besides its
// move scripts. The tests marked withGameFiles read your game files (tests/game-files.ts).

import test from "node:test";
import assert from "node:assert/strict";
import {
  cutterAnimationFrame, NativeCallbackClock, nativeEffectEvents, nativeEffectIds, outgoingNativeScriptEvents,
} from "../src/render3d/fx/native-callbacks.ts";
import { EffectBank } from "../src/render3d/fx/bank.ts";
import { type ActorFrame, FxWorld } from "../src/render3d/fx/world.ts";
import type { ScriptEvent } from "../src/render3d/fx/script.ts";
import { effectBanks, readGameFile, withGameFiles } from "./game-files.ts";

const DK = 3, KIRBY = 4, POPO = 10, NANA = 11, MEWTWO = 16, FOX = 1, FALCO = 22;

/** a script that sets command variable 0 to 0, then 1 on frame 12, then 2 on frame 30 */
const commands: ScriptEvent[] = [
  { kind: "cmdVar", frame: 0, index: 0, value: 0 },
  { kind: "cmdVar", frame: 12, index: 0, value: 1 },
  { kind: "cmdVar", frame: 30, index: 0, value: 2 },
];

/** a fighter joint's world matrix: no turn, at (x, y, z) */
const at = (x: number, y: number, z: number) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

/** what FxWorld keeps to itself that these tests look at */
type WorldInside = { sts: Map<string, object>; modelParticles(m: unknown): void };

test("Giant Punch, Donkey Kong's and Kirby's copy, starts on the first nonzero command once", () => {
  for (const [character, ground, air, gfx] of [[DK, 372, 377, 0x4c8], [KIRBY, 458, 463, 0x4a9]]) {
    const clock = new NativeCallbackClock();
    clock.enter(character, ground);
    const events = nativeEffectEvents(character, ground, commands);
    assert.deepEqual(clock.take(events, 11), []);
    assert.equal(clock.take(events, 12)[0]?.gfx, gfx);
    // (not again as its animation starts over, nor on the later commands)
    assert.deepEqual(clock.take(events, 12), []);
    assert.deepEqual(clock.take(events, 0), []);
    assert.deepEqual(clock.take(events, 30), []);
    // (the air version carries on from the ground's)
    assert.equal(clock.enter(character, air), false);
    assert.deepEqual(clock.take(nativeEffectEvents(character, air, commands), 30), []);
    // (another move in between: it starts again)
    assert.equal(clock.enter(character, 14), true);
    clock.enter(character, ground);
    assert.equal(clock.take(events, 12).length, 1);
  }
});

test("Blizzard starts from the command on both climbers; Teleport starts as it begins", () => {
  for (const character of [POPO, NANA]) {
    assert.deepEqual(nativeEffectEvents(character, 357, commands), [{ frame: 12, gfx: 0x4ec, part: 29 }]);
  }
  assert.deepEqual(nativeEffectEvents(MEWTWO, 356, commands), [{ frame: 0, gfx: 0x4e8, part: 5 }]);
  assert.deepEqual(nativeEffectEvents(MEWTWO, 354, commands), []);
});

test("a seek into the move starts what is due by then, once", () => {
  const clock = new NativeCallbackClock();
  clock.enter(DK, 384);
  const events = nativeEffectEvents(DK, 384, []);
  assert.equal(clock.take(events, 24).length, 1);
  assert.deepEqual(clock.take(events, 0), []);
  const rebuilt = new NativeCallbackClock();
  rebuilt.enter(DK, 384);
  assert.deepEqual(rebuilt.take(events, 24), events);
});

test("the learned table is told every effect a callback starts, state by state", () => {
  const cases: [number, number, number[]][] = [
    [DK, 372, [0x4c8]], [DK, 378, [0x4c9]], [KIRBY, 459, [0x4a9]], [KIRBY, 464, [0x4aa]], [KIRBY, 389, [0x494]],
    [DK, 381, [0x4ca]], [DK, 384, [0x4cc]], [POPO, 358, [0x4ec]], [NANA, 357, [0x4ec]], [MEWTWO, 353, [0x4e8]],
    [FOX, 354, [0x48b]], [FALCO, 355, [0x48c]], [DK, 14, []], [FOX, 357, []],
  ];
  for (const [character, state, ids] of cases) {
    assert.deepEqual(nativeEffectIds(character, state), ids, `character ${character} state ${state}`);
    // (the same ones the callbacks start, given the commands they wait for)
    const started = nativeEffectEvents(character, state, [{ kind: "cmdVar", frame: 0, index: 0, value: 1 }]).map((e) => e.gfx);
    assert.deepEqual(started, ids);
  }
});

test("Teleport's frame-8 flash is made though the replay already shows its travel", () => {
  const flash: ScriptEvent = { kind: "gfx", frame: 8, gfx: 0x3f4, bone: 0, common: false, destroyOnChange: false,
                               offset: [0, 6, 0], range: [0, 0, 0] };
  for (const [from, to] of [[353, 354], [356, 357]]) {
    assert.deepEqual(outgoingNativeScriptEvents(MEWTWO, from, to, 7, 1, [flash]), [flash]);
    assert.deepEqual(outgoingNativeScriptEvents(MEWTWO, from, to, 8, 1, [flash]), []);
    assert.deepEqual(outgoingNativeScriptEvents(MEWTWO, from, 87, 7, 1, [flash]), []);
  }
});

test("an animation that ran to its end makes its last step's effects; one cut short does not", () => {
  const e: ScriptEvent = { kind: "gfx", frame: 20, gfx: 0x3f4, bone: 0, common: false, destroyOnChange: false,
                           offset: [0, 0, 0], range: [0, 0, 0] };
  assert.deepEqual(outgoingNativeScriptEvents(DK, 44, 14, 19, 1, [e], true), [e]);
  assert.deepEqual(outgoingNativeScriptEvents(DK, 44, 87, 19, 1, [e], false), []);
  assert.deepEqual(outgoingNativeScriptEvents(DK, 44, 14, 20, 1, [e], true), []);
});

test("Final Cutter keeps its effects through all its states, then can start them again", () => {
  const clock = new NativeCallbackClock();
  clock.enter(KIRBY, 389);
  assert.equal(clock.take(nativeEffectEvents(KIRBY, 389, []), 0)[0]?.gfx, 0x494);
  for (const state of [390, 391, 388]) {
    assert.equal(clock.enter(KIRBY, state), false);
    assert.deepEqual(clock.take(nativeEffectEvents(KIRBY, state, []), 0), []);
  }
  clock.enter(KIRBY, 14);
  clock.enter(KIRBY, 385);
  assert.equal(clock.take(nativeEffectEvents(KIRBY, 385, []), 0).length, 1);
  assert.deepEqual([63, 64, 65, 68, 69].map((f) => cutterAnimationFrame(f)), [63, 60, 61, 64, 60]);
  assert.deepEqual([90, 91, 100].map((f) => cutterAnimationFrame(f, 90)), [65, 66, 75]);
});

test("Fire Fox and Fire Bird: the charge, then the launch, each through its ground and air versions", () => {
  for (const character of [FOX, FALCO]) {
    const clock = new NativeCallbackClock();
    clock.enter(character, 353);
    assert.deepEqual(clock.take(nativeEffectEvents(character, 353, []), 0), [{ frame: 0, gfx: 0x48b, part: 1, commonPart: true }]);
    assert.equal(clock.enter(character, 354), false);
    assert.deepEqual(clock.take(nativeEffectEvents(character, 354, []), 10), []);
    assert.equal(clock.enter(character, 356), true);
    assert.deepEqual(clock.take(nativeEffectEvents(character, 356, []), 0), [{ frame: 0, gfx: 0x48c, part: 4, commonPart: true }]);
    assert.equal(clock.enter(character, 355), false);
    assert.deepEqual(clock.take(nativeEffectEvents(character, 355, []), 20), []);
    assert.equal(clock.enter(character, 357), true);
  }
});

test("game files: callbacks' joints, the offsetY and jabZ callbacks, and the punches' first step", withGameFiles, () => {
  const banks = effectBanks([0, 5, 8, 13, 39]);
  const w = new FxWorld(banks.get(0)!, (_, p) => p, banks);
  const joint = at(10, 20, 30);
  const ctx = { pos: [10, 20, 30] as [number, number, number], follow: () => joint, facing: 1, angle: 0, damage: 0, scale: 2, owner: null };
  // (offsetY: the call's height, at the fighter's size, kept above the joint as it moves)
  w.spawn(0x4e1, { ...ctx, offset: [3, 7, 9] });
  const kept = w.models.at(-1)!;
  assert.deepEqual(w.modelPlace(kept), [10, 34, 30]);
  joint[13] = 40;
  assert.deepEqual(w.modelPlace(kept), [10, 54, 30]);
  // (jabZ: joint 1 along z by its age, whichever way it is posed)
  w.spawn(0x49d, ctx);
  const jab = w.models.at(-1)!;
  const prop = jab.bank.prop(jab.index, 0, true)!;
  w.poseModel(jab, prop, 4);
  assert.equal(prop.skeleton.trans[5], 32);
  w.poseModel(jab, prop, 1);
  assert.equal(prop.skeleton.trans[5], 26);
  w.poseModel(jab, prop, 4);
  assert.equal(prop.skeleton.trans[5], 32);
  // (the punches' models start a frame in)
  for (const id of [0x4c8, 0x4c9, 0x4a9, 0x4aa]) {
    w.spawn(id, ctx);
    assert.equal(w.models.at(-1)?.age, 1);
  }
});

test("game files: the fighters' scripts set each command a callback waits for", withGameFiles, async () => {
  const { Fighter, fighterFiles } = await import("../src/render3d/fighter.ts");
  const { motionTableFromDol } = await import("../src/render3d/dol.ts");
  const motion = motionTableFromDol(readGameFile("main.dol"));
  for (const [character, states] of [[DK, [372, 373, 377, 378]], [KIRBY, [458, 459, 463, 464]], [POPO, [357, 358]]] as const) {
    const files = fighterFiles(character, 0)!;
    const fighter = new Fighter(character, readGameFile(files[0]), readGameFile(files[1]), readGameFile(files[2]), 0, motion, "test");
    for (const state of states) {
      const events = nativeEffectEvents(character, state, fighter.scriptFor(state));
      assert.equal(events.length, 1, `character ${character} state ${state} has its callback's command`);
      assert.ok(events[0].frame >= 0);
    }
  }
});

test("game files: Final Cutter's three models on two parts, lasting past their first animation", withGameFiles, () => {
  const banks = effectBanks([0, 5]);
  const w = new FxWorld(banks.get(0)!, (_, p) => p, banks);
  const parts = new Map([1, 44].map((part) => [part, at(part, 10, 0)]));
  const partFollow = (p: number) => parts.get(p) ?? null;
  const ctx = { pos: [0, 0, 0] as [number, number, number], follow: null, partFollow, facing: 1, angle: 0, damage: 0, scale: 1 };
  w.spawn(0x494, { ...ctx, owner: "0:0:native", age: 90 });
  assert.equal(w.models.length, 3);
  assert.deepEqual(w.models.map((m) => m.index), [0, 1, 2]);
  assert.deepEqual(w.models.map((m) => m.life), [Infinity, Infinity, Infinity]);
  assert.equal(w.models[0].under?.()?.[12], 44);
  const child = banks.get(5)!.prop(0, 0, true)!;
  w.poseModel(w.models[0], child, 10);
  const matrix = child.skeleton.world;
  assert.deepEqual(Array.from(matrix.slice(12, 15)), [44, 10, 0]);
  // (held by a turn constraint to a joint with no turn: its animation may size it, but adds no turn)
  for (const index of [1, 2, 4, 6, 8, 9]) assert.ok(Math.abs(matrix[index]) < 1e-6);
  assert.deepEqual(w.models.slice(1).map((m) => w.modelPlace(m)[0]), [44, 1]);
  const posed = banks.get(5)!.prop(1, 0, true)!;
  w.poseModel(w.models[1], posed, 90);
  assert.ok(Array.from(posed.skeleton.world).every(Number.isFinite));
  // (made after the move let go of them: 11 frames from there)
  w.spawn(0x494, { ...ctx, owner: "1:0:native", age: 92, cutterRelease: 90 });
  assert.deepEqual(w.models.slice(-3).map((m) => m.life), [101, 101, 101]);
});

test("game files: a callback's part is the fighter's own joint, not a script's common bone", withGameFiles, async () => {
  const { Fighter } = await import("../src/render3d/fighter.ts");
  const { motionTableFromDol } = await import("../src/render3d/dol.ts");
  const motion = motionTableFromDol(readGameFile("main.dol"));
  const fighter = new Fighter(KIRBY, readGameFile("PlKb.dat"), readGameFile("PlKbAJ.dat"), readGameFile("PlKbNr.dat"), 0, motion, "anchors");
  const banks = effectBanks([0, 5]);
  const w = new FxWorld(banks.get(0)!, () => -1, banks);
  const world = new Float32Array(60 * 16);
  for (let i = 0; i < 60; i++) world.set(at(i * 10, 20, 0), i * 16);
  const st = { internalCharacterId: KIRBY, actionStateId: 389, actionStateFrameCounter: 1, isGrounded: false, isDead: false,
               facingDirection: 1, xPosition: 0, yPosition: 0, hitlagRemaining: 0 };
  w.step(0, [{ key: "0:0", fighter, world, st } as unknown as ActorFrame]);
  const cutter = w.models.filter((m) => m.cutter);
  assert.equal(cutter.length, 3);
  assert.equal(cutter[0].under?.()?.[12], 440);
  assert.deepEqual(cutter.slice(1).map((m) => w.modelPlace(m)[0]), [440, 10]);
});

/** Fox's effect file and the common one, as banks */
function foxBanks() {
  const fox = new EffectBank(readGameFile("EfFxData.dat"), "effFoxDataTable", 3);
  const common = new EffectBank(readGameFile("EfCoData.dat"), "effCommonDataTable", 0);
  return { fox, world: new FxWorld(common, (_, p) => p, new Map([[0, common], [3, fox]])) };
}

test("game files: Fire Fox's launch is turned the way it flies, its root's turns set rather than added", withGameFiles, () => {
  const { fox, world: w } = foxBanks();
  const st = { actionStateId: 356, isGrounded: true, facingDirection: -1, selfInducedAirXSpeed: -2, selfInducedAirYSpeed: 3,
               selfInducedGroundXSpeed: 0 };
  (w as unknown as WorldInside).sts.set("0:0", st);
  w.spawn(0x48c, { pos: [0, 0, 0], follow: null, facing: -1, angle: 0, damage: 0, scale: 1, owner: null, by: "0:0" });
  const m = w.models.at(-1)!;
  assert.equal(m.index, 4);
  assert.equal(m.bank, fox);
  assert.equal(m.life, Infinity);
  assert.ok(Math.abs(m.rotZ - (Math.PI / 2 - Math.atan2(3, 2))) < 1e-8);
  assert.ok(fox.ptclKeys(4).length > 0);
  const p = fox.prop(4, 0, true)!;
  assert.ok(p);
  m.rotZ = 0.7;
  w.poseModel(m, p, 5);
  assert.equal(p.skeleton.rot[1], Math.fround(-Math.PI / 2));
  assert.equal(p.skeleton.rot[2], Math.fround(0.7));
});

test("game files: Fire Fox's charging fire, with no lifetime of its own, goes on past its first cycle", withGameFiles, () => {
  const { fox, world: w } = foxBanks();
  w.spawn(0x48b, { pos: [0, 0, 0], follow: null, facing: 1, angle: 0, damage: 0, scale: 1, owner: "0:0", by: "0:0" });
  const m = w.models.at(-1)!;
  assert.equal(m.life, Infinity);
  assert.ok(fox.ptclKeys(3).some((k) => k.every === 19));
  m.age = 38;
  (w as unknown as WorldInside).modelParticles(m);
  assert.ok(w.ps.gens.length > 0, "a later cycle still makes fire during the charge");
});
