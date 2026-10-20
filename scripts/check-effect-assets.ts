// Checks that every effect in fx/dispatch.ts's SPAWNS names a model or particle generator that is in your
// effect files: each one's effect file has it, and each model has a joint. It prints only the counts; nothing
// from the files is written anywhere.
//
//   deno run --sloppy-imports --allow-read scripts/check-effect-assets.ts <folder of your game files>

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { EffectBank } from "../src/render3d/fx/bank.ts";
import { EFFECT_FILES, type Spawn, SPAWNS } from "../src/render3d/fx/dispatch.ts";

const dir = process.argv[2];
if (!dir) throw new Error("give the folder of your game files");

const banks = new Map<number, EffectBank>();
let checked = 0;

/** the effect file with this number, as a bank (each read once) */
function bank(id: number, effect: string): EffectBank {
  let b = banks.get(id);
  if (b) return b;
  const file = EFFECT_FILES[id];
  assert.ok(file, `effect ${effect}: no effect file ${id}`);
  const data = fs.readFileSync(path.join(dir, file.name));
  b = new EffectBank(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), file.table, id);
  banks.set(id, b);
  return b;
}

function check(s: Spawn, effect: string) {
  if ("all" in s) {
    for (const part of s.all) check(part, effect);
    return;
  }
  const id = "bank" in s ? s.bank ?? 0 : 0;
  const b = bank(id, effect);
  if ("g" in s) {
    assert.ok(b.cmds[s.g], `effect ${effect}: file ${id} has no generator ${s.g}`);
  } else {
    const models = "pieces" in s ? s.pieces : Array.isArray(s.m) ? s.m : [s.m];
    for (const m of models) assert.ok(b.models[m]?.joint >= 0, `effect ${effect}: file ${id} has no model ${m}`);
  }
  checked++;
}

for (const [effect, spawn] of Object.entries(SPAWNS)) check(spawn, Number(effect).toString(16));
console.log(`Checked ${checked} models and generators in ${banks.size} effect files`);
