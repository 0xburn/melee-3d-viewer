import { createSignal } from 'solid-js';
import type { ReplayData } from './common/types';
import { isInVersion } from './parser/parser';
const heights = new Map<number, { fodLeftPlatformHeight: number; fodRightPlatformHeight: number }>();
export const [stageRevision, setStageRevision] = createSignal(0);
export function clearSimulationStage() { heights.clear(); setStageRevision(n => n + 1); }
export function receiveSimulationStage(rows: number[][]) {
  for (const [frame, left, right] of rows) if (Number.isFinite(left) && Number.isFinite(right))
    heights.set(frame + 123, { fodLeftPlatformHeight: left, fodRightPlatformHeight: right });
  setStageRevision(n => n + 1);
}
/** Recorded stage events take precedence; older recordings use native simulation. */
export function stageFrame(data: ReplayData, frame: number) {
  return isInVersion(data.settings.replayFormatVersion, '3.18.0.0') ? data.frames[frame]?.stage : heights.get(frame);
}
