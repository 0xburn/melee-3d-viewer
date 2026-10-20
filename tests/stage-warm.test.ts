// fx/world.ts: the stage's generators after a jump. One made before the warm-up and still running then is made
// at its start as it stands after the frames it ran (Battlefield's stars: 399 frames, made every 400); the
// warm-up goes back to where one was made when what it did then still shows.

import test from "node:test";
import assert from "node:assert/strict";
import type { CmdList, EffectBank } from "../src/render3d/fx/bank.ts";
import { FxWorld, STAGE_FAR, STAGE_WARM } from "../src/render3d/fx/world.ts";

const cmd = (over: Partial<CmdList> = {}): CmdList => ({
  type: 0, texGroup: 0, genLife: 399, life: 300, kind: 0, grav: 0, fric: 1, vx: 0, vy: 0, vz: 0, radius: 0, angle: 0,
  random: -0.1, size: 1, param1: 0, param2: 0, param3: 0, cmd: new Uint8Array([0xff]), ...over,
});
const bank = (cmds: CmdList[] = []) => ({ id: 0, cmds, texGroups: [] } as unknown as EffectBank);

type Ev = (string | number)[];
function world(stage: EffectBank, events: Ev[]) {
  const w = new FxWorld(bank(), (_c, part) => part);
  w.trackFx = () => [];
  w.stageBank = () => stage;
  w.stageJoint = () => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
  // (events by game frame; the replay's index is 123 more)
  w.trackOrdered = (f) => events.filter((e) => Number(e[0]) + 123 === f) as never;
  w.trackStageBefore = (f) => events.filter((e) => Number(e[0]) + 123 < f) as never;
  return w;
}

test("a stage generator still running at the warm-up's start is made there with the frames it ran", () => {
  const stage = bank([]);
  (stage as unknown as { cmds: CmdList[] }).cmds[30002] = cmd();
  const events: Ev[] = [[-113, "gen", 30, 30002, 0, 0, 0, 77, 1, 3]];
  // (stepped from its first frame, as playing on does)
  const played = world(stage, events);
  for (let f = 10; f < 270; f++) played.stepStage(f);
  const [p] = played.ps.gens;
  // (after a jump: made at frame 270, ten frames before the generator's life is over at 409)
  const jumped = world(stage, events);
  assert.equal(jumped.stageFrames(600), STAGE_WARM);
  jumped.stageStart(270);
  const [j] = jumped.ps.gens;
  assert.deepEqual([j.genLife, j.count, j.age], [p.genLife, p.count, p.age]);
  played.stepStage(270);
  jumped.stepStage(270);
  assert.equal(jumped.ps.gens[0].count, played.ps.gens[0].count);
  // (one whose life is over by then is not made)
  const late = world(stage, events);
  late.stageStart(409);
  assert.equal(late.ps.gens.length, 0);
});

test("the warm-up goes back to where a generator was made when its particles outlive the warm-up", () => {
  const stage = bank([]);
  (stage as unknown as { cmds: CmdList[] }).cmds[30002] = cmd({ life: STAGE_WARM + 50 });
  const w = world(stage, [[-113, "gen", 30, 30002, 0, 0, 0, 77, 1, 3]]);
  assert.equal(w.stageFrames(400), 390);
  // (never further than STAGE_FAR)
  (stage as unknown as { cmds: CmdList[] }).cmds[30002] = cmd({ genLife: 0, life: STAGE_WARM + 50 });
  assert.equal(w.stageFrames(5000), STAGE_FAR);
});
