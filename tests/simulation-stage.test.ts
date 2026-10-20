// simulation-stage.ts: Fountain of Dreams' platform heights sent by the embedding page, for older replays.

import test from "node:test";
import assert from "node:assert/strict";
import type { ReplayData } from "../src/common/types.ts";
import { clearSimulationStage, receiveSimulationStage, stageFrame } from "../src/simulation-stage.ts";

test("heights sent fill an older replay, any frame in any order, and go with the next replay", () => {
  const old = { settings: { replayFormatVersion: "3.17.0.0" }, frames: [] } as unknown as ReplayData;
  clearSimulationStage();
  assert.equal(stageFrame(old, 123), undefined);
  // (game frames from -123: the viewer's frame 123 is game frame 0; a row with a height not a number is left out)
  receiveSimulationStage([[0, 20, 28], [1, 21, 27], [2, NaN, 26]]);
  assert.deepEqual(stageFrame(old, 124), { fodLeftPlatformHeight: 21, fodRightPlatformHeight: 27 });
  assert.deepEqual(stageFrame(old, 123), { fodLeftPlatformHeight: 20, fodRightPlatformHeight: 28 });
  assert.equal(stageFrame(old, 125), undefined);
  // (a replay that records them: its own)
  const recorded = { fodLeftPlatformHeight: 4, fodRightPlatformHeight: 5 };
  const frames: unknown[] = [];
  frames[123] = { stage: recorded };
  const recent = { settings: { replayFormatVersion: "3.18.0.0" }, frames } as unknown as ReplayData;
  assert.equal(stageFrame(recent, 123), recorded);
  clearSimulationStage();
  assert.equal(stageFrame(old, 123), undefined);
});
