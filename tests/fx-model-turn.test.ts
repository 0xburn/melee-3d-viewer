// fx/world.ts: an effect model's turn as the dispatch gives it (efSync 0x4CF, an egg's shell: HSD_JObjSetRotationY
// and HSD_JObjSetRotationX on each piece), from a viewer track's pieces - a made-up bank and model, no game files.

import test from "node:test";
import assert from "node:assert/strict";
import type { EffectBank } from "../src/render3d/fx/bank.ts";
import type { Prop } from "../src/render3d/prop.ts";
import { FxWorld } from "../src/render3d/fx/world.ts";

test("a model the track's piece turns about x and y is posed turned both ways", () => {
  const posed: number[][] = [];
  const prop = { length: 50, pose: (...a: number[]) => { posed.push(a); } } as unknown as Prop;
  const bank = { id: 0, cmds: [], texGroups: [], models: { 0x1e: { life: 0, joint: 0, animJoint: null, matAnimJoint: null } },
                 prop: () => prop, ptclKeys: () => [] } as unknown as EffectBank;
  const w = new FxWorld(bank, (_c, part) => part);
  w.trackFx = () => [];
  // [frame, "fxp", gfx, owner kind, owner, index, "m", id, how, part, tx, ty, tz, rx, ry, rz, sx, sy, sz, callback,
  //  lifetime, p0, p1, p2, mirrored]
  const piece = [0, "fxp", 0x4cf, "n", 0, 0, "m", 0x1e, "place", -1, 4, 5, 6, 0.75, 1.25, 0, 2, 2, 2,
                 "SetOffset_FromParams", 0x32, 0, 0, 0, 0];
  w.trackOrdered = (f) => (f === 123 ? [piece] : []) as never;
  w.step(123, []);
  assert.equal(w.models.length, 1);
  const m = w.models[0];
  assert.equal(m.rotX, 0.75);
  assert.equal(m.rotY, 1.25);
  w.poseModel(m, prop, m.age);
  // (pose(frame, x, y, z, scale, rotY, loop, rotZ, rotX, ...))
  const [, , , , scale, rotY, , rotZ, rotX] = posed.at(-1)!;
  assert.deepEqual([scale, rotY, rotZ, rotX], [2, 1.25, 0, 0.75]);
});
