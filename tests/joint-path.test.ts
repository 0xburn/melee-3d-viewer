// A joint on a PATH track (Yoshi's Story's Randall) stands at the spline's
// point as it is: JObjUpdateFunc's HSD_A_J_PATH sets the translate to
// splArcLengthPoint's point, the spline joint's own place (turned half round
// and moved, a sibling) not applied.
//
//   deno test --no-check --sloppy-imports tests/

import test from "node:test";
import assert from "node:assert/strict";
import { Skeleton } from "../src/render3d/skeleton.ts";
import type { AObj, Spline } from "../src/render3d/hsd.ts";

test("a PATH track's point is the joint's translate, not carried through the spline joint", () => {
  // straight segments (0, 0, 0) -> (10, 0, 0) -> (10, 20, 0), a third and two thirds of the length
  const spline: Spline = { type: 0, n: 3, tension: 0, cv: new Float32Array([0, 0, 0, 10, 0, 0, 10, 20, 0]), total: 30,
                           seg: new Float32Array([0, 1 / 3, 1]), poly: new Float32Array(0) };
  // joint 0 the root, joint 1 the spline (turned half round about z, moved), joint 2 on the path
  const sk = Object.create(Skeleton.prototype);
  Object.assign(sk, {
    n: 3, parent: [-1, 0, 0],
    joints: [{ index: 0, offset: 100 }, { index: 1, offset: 200, spline }, { index: 2, offset: 300 }],
    rot: new Float32Array([0, 0, 0, 0, 0, Math.PI, 0, 0, 0]), scale: new Float32Array(9).fill(1),
    trans: new Float32Array([0, 0, 0, 37, -50, 0, 0, 0, 0]),
  });
  const path: AObj = { tracks: [{ type: 4, keys: [{ time: 0, duration: 10, kind: 1, p0: 0, p1: 1, d0: 0, d1: 0 }] }],
                       end: 10, loop: false, obj: 200 };
  sk.applyAObjs([null, null, path], 5, false);
  const t = [...sk.trans.subarray(6, 9)];
  assert.ok(Math.abs(t[0] - 10) < 1e-4 && Math.abs(t[1] - 5) < 1e-4 && t[2] === 0, `${t}`);
});
