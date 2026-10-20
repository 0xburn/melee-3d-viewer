// shadow.ts: the fighters' shadows as lbShadow_8000F38C makes them - the light they come from, the shadow camera,
// its texture matrix and the gray the copy keeps.

import test from "node:test";
import assert from "node:assert/strict";
import type { Light } from "../src/render3d/hsd.ts";
import { pickShadowLight, shadowCamera, shadowGray } from "../src/render3d/shadow.ts";

const light = (kind: Light["kind"], flags: number, desc: number): Light =>
  ({ desc, kind, flags, color: [1, 1, 1, 1], position: [0, 0, 1], interest: null, raw: null, spot: null, dist: null, anim: null });
const at = (m: Float32Array, p: number[]) =>
  [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
const round = (v: number[]) => v.map((x) => Math.round(x * 1e4) / 1e4 + 0);

test("the shadows' light: the first flagged 0x400, else the last that is not ambient", () => {
  const a = light("ambient", 4, 1), b = light("infinite", 5, 2), c = light("infinite", 5 | 0x400, 3), d = light("point", 6, 4);
  assert.equal(pickShadowLight([a, b, c, d])?.desc, 3);
  assert.equal(pickShadowLight([a, b, d])?.desc, 4);
  assert.equal(pickShadowLight([a]), null);
});

test("the shadow camera looks at the bone from the light, 100 away at least, over 1.2 times the box's depth", () => {
  const bone = [10, 20, 0];
  const cam = shadowCamera([3, 4, 0], null, bone, 10)!;
  // (the bone in the middle of the picture and of the texture)
  assert.deepEqual(round(at(cam.viewProj, bone)).slice(0, 2), [0, 0]);
  assert.deepEqual(round(at(cam.tex, bone)).slice(0, 2), [0.5, 0.5]);
  // (the eye 100 from the bone, toward the light)
  assert.deepEqual(round(at(cam.view, bone)), [0, 0, -100, 1]);
  // (a point 12 across, at the box's edge: at the texture's 0.05 or 0.95)
  const s = at(cam.tex, [bone[0], bone[1], bone[2] + 12]);
  assert.ok(Math.abs(Math.abs(s[0] - 0.5) - 0.45) < 1e-5 || Math.abs(Math.abs(s[1] - 0.5) - 0.45) < 1e-5);
  // (a light where its interest is casts none)
  assert.equal(shadowCamera([1, 1, 1], [1, 1, 1], bone, 10), null);
});

test("the copy keeps the gray's top four bits", () => {
  assert.equal(shadowGray(192), 0xcc / 255);
  assert.equal(shadowGray(255), 1);
  assert.equal(shadowGray(220), 0xdd / 255);
});
