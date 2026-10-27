// The gx player's pacing (src/render3d/gxpath/playback.ts) on a stand-in session and a made-up clock: "console" plays 60000/1001 game frames a
// second, "60" plays 60 (one a refresh on a 60 Hz display), and every frame stepped is drawn. `deno test -A --no-check --sloppy-imports tests/gxpath-playback.test.ts`
import test from "node:test";
import assert from "node:assert/strict";
import { GxPlayback, type Pace } from "../src/render3d/gxpath/playback.ts";
import type { GxSession } from "../src/render3d/gxpath/session.ts";

function run(pace: Pace, tickMs: number, seconds: number, speed = 1) {
  let now = 0, steps = 0, undrawn = 0;
  const session = {
    index: 0, frameCount: 1e9, shown: -1, wantsRetry: false, onPicture: null,
    step(draw: boolean) { this.index++; steps++; if (!draw) undrawn++; return true; },
  };
  const p = new GxPlayback(session as unknown as GxSession, { onPicture() {}, onState() {}, onError(e) { throw e; } }, () => now);
  p.setPace(pace);
  p.setSpeed(speed);
  p.play();
  const ticks = Math.round((seconds * 1000) / tickMs);
  for (let i = 0; i < ticks; i++) { now += tickMs; p.tick(); }
  return { steps, undrawn };
}

test("console pace: 60000/1001 frames a second by the clock, whatever the refresh", () => {
  for (const tick of [1000 / 60, 1000 / 144, 10, 25]) {
    const { steps, undrawn } = run("console", tick, 1001);
    assert.ok(Math.abs(steps - 60000) <= 2, `tick ${tick}: ${steps}`);
    assert.equal(undrawn, 0);
  }
});

test("60 pace: one frame a refresh on a 60 Hz display, 60 a second on others", () => {
  assert.equal(run("60", 1000 / 60, 100).steps, 6000);
  assert.equal(run("60", 16.9, 100).steps, Math.round(100000 / 16.9)); // (a 59.17 Hz display: one a refresh)
  for (const tick of [1000 / 144, 10, 25]) {
    const { steps, undrawn } = run("60", tick, 100);
    assert.ok(Math.abs(steps - 6000) <= 2, `tick ${tick}: ${steps}`);
    assert.equal(undrawn, 0);
  }
});

test("other speeds draw every frame too", () => {
  const { steps, undrawn } = run("60", 1000 / 60, 10, 2);
  assert.ok(Math.abs(steps - 1200) <= 2, `${steps}`);
  assert.equal(undrawn, 0);
});
