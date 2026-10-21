// camera.ts: the camera run goes on as far as it is asked, and the result is the same as run all at once.

import test from "node:test";
import assert from "node:assert/strict";
import { cameraRun, CAM_STRIDE, runCamera, type CamActor, type StageCamera } from "../src/render3d/camera.ts";

const stage: StageCamera = {
  left: -150, right: 150, top: 120, bottom: -80, cx: 0, cy: 20,
  blast: { left: -240, right: 240, top: 190, bottom: -140 },
  quakes: [null, { x: null, y: null, end: 10 }, null, null],
  pitchK: 0.0185, yawK: 0.0125, pan: 0, near: 120, far: 760, trackRatio: 1, smooth: 1, fixedZoom: 1, fov: 30,
};

// a fixed pseudo-random game: two fighters wandering, one KO'd and coming back, a quake asked now and then
function game(n: number): CamActor[][] {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out: CamActor[][] = [];
  const at = [[-30, 0], [40, 0]];
  for (let f = 0; f < n; f++) {
    const row: CamActor[] = [];
    for (let p = 0; p < 2; p++) {
      at[p][0] += (rnd() - 0.5) * 8; at[p][1] = Math.max(-60, at[p][1] + (rnd() - 0.55) * 6);
      const state = p === 1 && f % 900 > 700 && f % 900 < 760 ? 2 : p === 1 && f % 900 === 761 ? 11 : 14;
      row.push({ key: String(p), x: at[p][0], y: at[p][1], facing: rnd() < 0.5 ? -1 : 1, state, scale: 1,
                 box: p === 0 ? { lift: 10, back: -8, ahead: 8, v: [12, -2, 0] } : null, quake: rnd() < 0.01 ? 1 : undefined });
    }
    out.push(row);
  }
  return out;
}

test("the run advanced a few frames at a time is the run made at once", () => {
  const frames = game(3000);
  const whole = runCamera(stage, frames);
  const run = cameraRun(stage, (f) => frames[f], frames.length);
  for (const to of [1, 1, 5, 400, 399, 2999, 3000, 3000]) run.advance(to);
  assert.equal(run.done, 3000);
  assert.deepEqual(Array.from(run.out), Array.from(whole));
  // (and asked for in a jump, as a seek does)
  const jump = cameraRun(stage, (f) => frames[f], frames.length);
  jump.advance(2000);
  jump.advance(3000);
  assert.deepEqual(Array.from(jump.out), Array.from(whole));
});

test("only the frames asked for are run", () => {
  const frames = game(500);
  let asked = 0;
  const run = cameraRun(stage, (f) => { asked++; return frames[f]; }, frames.length);
  run.advance(40);
  assert.equal(asked, 40);
  assert.equal(run.done, 40);
});

test("a fixed track's frames replace the run's, which goes on from its own state", () => {
  const frames = game(200);
  const whole = runCamera(stage, frames);
  const fixed = new Float32Array(200 * CAM_STRIDE).fill(7);
  const run = cameraRun(stage, (f) => frames[f], frames.length, { track: fixed, frames: 50 });
  run.advance(200);
  assert.deepEqual(Array.from(run.out.subarray(0, 50 * CAM_STRIDE)), Array.from(fixed.subarray(0, 50 * CAM_STRIDE)));
  assert.deepEqual(Array.from(run.out.subarray(50 * CAM_STRIDE)), Array.from(whole.subarray(50 * CAM_STRIDE)));
});
