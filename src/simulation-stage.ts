// Fountain of Dreams' platform heights for replays that do not record them, from the embedding page.
//
// Replays from Slippi 3.18 on record the heights of Fountain's two platforms
// each frame; older ones do not, and without them the stage keeps its
// platforms at their starting height. A page that embeds the viewer and runs
// the game itself (a sound backend, say) can send them: its player's
// "stage-frames" events (src/audio.ts) carry rows of [game frame, left
// height, right height], the platforms' joint translations before the
// stage's scale, game frames from -123. What a replay records always comes
// first. The heights are cleared when another replay is loaded.

import { createSignal } from "solid-js";
import type { ReplayData } from "./common/types";
import { isInVersion } from "./parser/parser";

/** the heights sent, by the viewer's frame index (game frame + 123) */
const heights = new Map<number, { fodLeftPlatformHeight: number; fodRightPlatformHeight: number }>();

/** counts each change to the heights, so the picture is drawn again when more arrive */
export const [stageRevision, setStageRevision] = createSignal(0);

/** forget the heights (another replay, or none) */
export function clearSimulationStage() {
  heights.clear();
  setStageRevision((n) => n + 1);
}

/** take rows of [game frame, left height, right height]; a row with a height that is not a number is left out */
export function receiveSimulationStage(rows: number[][]) {
  for (const [frame, left, right] of rows) {
    if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
    heights.set(frame + 123, { fodLeftPlatformHeight: left, fodRightPlatformHeight: right });
  }
  setStageRevision((n) => n + 1);
}

/** the platforms' heights on a frame: the replay's own from 3.18 on, else the ones sent, if any */
export function stageFrame(data: ReplayData, frame: number) {
  if (isInVersion(data.settings.replayFormatVersion, "3.18.0.0")) return data.frames[frame]?.stage;
  return heights.get(frame);
}
