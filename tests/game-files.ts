// The tests' access to your own game files, for the ones that read them.
//
// Those tests run only when MELEE_ASSETS names a folder of the game's files
// (the flat folder README.md's "Your game files" describes) and the test run
// may read it:
//
//   MELEE_ASSETS=<folder> deno test --no-check --sloppy-imports --allow-env --allow-read tests/
//
// Without it (or without the permission to read the variable) they are
// skipped. Nothing from the files is written anywhere.

import fs from "node:fs";
import path from "node:path";
import { EffectBank } from "../src/render3d/fx/bank.ts";
import { EFFECT_FILES } from "../src/render3d/fx/dispatch.ts";

/** the folder of game files, or undefined when none is given (or the variable may not be read) */
export const gameFiles: string | undefined = (() => {
  try {
    return process.env.MELEE_ASSETS || undefined;
  } catch {
    // (Deno without --allow-env: as if none were given)
    return undefined;
  }
})();

/** a test's options: skipped without the game files */
export const withGameFiles = { skip: !gameFiles };

/** one of the game's files, by its name on the disc */
export function readGameFile(name: string): ArrayBuffer {
  const b = fs.readFileSync(path.join(gameFiles!, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** the effect files with these numbers (EFFECT_FILES), each as a bank */
export function effectBanks(ids: number[]): Map<number, EffectBank> {
  const banks = new Map<number, EffectBank>();
  for (const id of ids) {
    const file = EFFECT_FILES[id];
    banks.set(id, new EffectBank(readGameFile(file.name), file.table, id));
  }
  return banks;
}
