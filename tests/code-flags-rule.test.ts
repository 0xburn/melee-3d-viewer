// The page's gameplay-code flags are the replay driver's: one rule, two implementations, held equal here
// against the cases the fork's tools/replay/replay_drive.py code_flags produced (tools/replay/code_flags_cases.json).
//
//   deno test --no-check --sloppy-imports -A tests/code-flags-rule.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { codeFlags } from "../src/sim/tape.ts";

const CASES = "D:/work/gxpath/w10/sim/tools/replay/code_flags_cases.json";

test("codeFlags equals replay_drive.py code_flags on every case", async () => {
  const cases = JSON.parse(await Deno.readTextFile(CASES)) as { codes: number[]; online: boolean; flags: Record<string, boolean> }[];
  assert.ok(cases.length >= 18);
  for (const c of cases) {
    assert.deepEqual(codeFlags(new Map(c.codes.map((a) => [a, 0])), c.online), c.flags, JSON.stringify(c));
  }
});

test("a gecko list decides, and its absence falls back to the online code set", () => {
  assert.equal(codeFlags(new Map([[0xc216e510, 0]]), true).whispy_dead_fighter_fix, false);
  assert.equal(codeFlags(new Map(), true).whispy_dead_fighter_fix, true);
  assert.equal(codeFlags(new Map(), false).brawl_offscreen_damage, false);
});
