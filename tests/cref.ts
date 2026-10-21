// The C references the tests check the TypeScript against (tests/c/*.c): built once with the C compiler there is
// (CC, else cc, gcc or clang), as the SDK's C is built - single precision, nothing contracted that the source does
// not fuse itself - and run on text in, text out (a file of each, named on its command line). Without a compiler `compiler()` is null and those tests are skipped.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let cc: string | null | undefined;

/** the C compiler, or null */
export function compiler(): string | null {
  if (cc !== undefined) return cc;
  const env = (() => { try { return Deno.env.get("CC"); } catch { return undefined; } })();
  cc = null;
  for (const c of [env, "cc", "gcc", "clang"]) {
    if (!c) continue;
    try { execFileSync(c, ["--version"], { stdio: "ignore" }); cc = c; break; } catch { /* the next */ }
  }
  return cc;
}

/** build tests/c/<name>.c and run it on `input`, returning what it printed */
export function runC(name: string, input: string): string {
  const c = compiler();
  if (!c) throw new Error("no C compiler");
  const dir = mkdtempSync(join(tmpdir(), "cref-"));
  try {
    const exe = join(dir, name);
    const src = new URL(`./c/${name}.c`, import.meta.url).pathname;
    execFileSync(c, ["-O2", "-std=c99", "-ffp-contract=off", "-fno-fast-math", "-o", exe, src, "-lm"], { stdio: "inherit" });
    // (the input in a file it is given the name of, the output in another: a big one through pipes can stall)
    const inPath = join(dir, "in.txt"), outPath = join(dir, "out.txt");
    writeFileSync(inPath, input);
    execFileSync(exe, [inPath, outPath], { stdio: "inherit" });
    return readFileSync(outPath, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
