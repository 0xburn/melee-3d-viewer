// The percent's timing (hudlogic.ts PlayerHud): the damage the HUD shows at a frame is the replay's percent of that
// frame - its color, its digits and the shake start with the frame whose percent has the hit.
//
//   deno test --no-check --sloppy-imports -A tests/

import test from "node:test";
import assert from "node:assert/strict";
import { PlayerHud, percentColor } from "../src/render3d/hudlogic.ts";
import type { ReplayData } from "../src/common/types.ts";

/** a replay of one player standing (Wait) at a percent a frame */
function replay(percents: number[]): ReplayData {
  const frames = percents.map((percent, i) => ({
    players: [{ playerIndex: 0, state: { frameNumber: i - 123, actionStateId: 14, stocksRemaining: 4, percent,
                                         attackBasedXSpeed: 0, attackBasedYSpeed: 0 } }],
  }));
  return { frames, settings: { playerSettings: [{ startStocks: 4 }] } } as unknown as ReplayData;
}

test("a hit shows with the frame whose replay percent has it, not the frame before", () => {
  const pct = [...Array(20).fill(0), ...Array(20).fill(12)];
  const h = new PlayerHud(replay(pct), 0);
  assert.deepEqual(h.percentAt(19).color, percentColor(0));
  assert.deepEqual(h.percentAt(20).color, percentColor(12));
  // (the shake: from the hit's frame, nine frames)
  assert.equal(h.shakingAt(19), false);
  assert.equal(h.shakingAt(20), true);
  assert.equal(h.shakingAt(28), true);
  assert.equal(h.shakingAt(29), false);
  // (the digits' pictures a frame after: the tens digit's shown at once, its picture the 1 a frame on)
  assert.equal(h.percentAt(20).layout.shown[1], true);
  assert.equal(h.percentAt(20).layout.frame[1], 0);
  assert.equal(h.percentAt(21).layout.frame[1], 2);
});
