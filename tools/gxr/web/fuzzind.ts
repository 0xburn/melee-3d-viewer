// Random inputs to the indirect unit's offsets: the CPU reference's indirectOffsets() against the shader's.
import { STATE_WORDS } from "../../../src/render3d/gxr/glsl-pixel.ts";
import { indirectOffsets } from "../../../src/render3d/gxr/raster.ts";
import { runFn } from "./fnrun.ts";
const log = (s: string) => fetch("/log", { method: "POST", body: s });
let seed = Number(new URLSearchParams(location.search).get("seed") ?? 5);
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const ri = (n: number) => Math.floor(rnd() * n);
const N = 3000;
const states = new Uint32Array(N * STATE_WORDS);
const inputs = new Uint32Array(N * 16);
const cases: { bp: Uint32Array; ind: number; tx: number[]; S: number; T: number; ps: number; pt: number }[] = [];
for (let i = 0; i < N; i++) {
  const bp = new Uint32Array(256);
  for (let k = 0; k < 9; k++) bp[6 + k] = ri(1 << 24);
  const ind = ri(2) | (ri(4) << 2) | (ri(8) << 4) | (ri(4) << 7) | (ri(16) << 9) | (ri(7) << 13) | (ri(7) << 16) | (ri(2) << 20);
  const tx = [ri(256), ri(256), ri(256), ri(256)];
  const S = ri(1 << 24) - (1 << 23), T = ri(1 << 24) - (1 << 23), ps = ri(1 << 24) - (1 << 23), pt = ri(1 << 24) - (1 << 23);
  cases.push({ bp, ind, tx, S, T, ps, pt });
  states.set(bp.subarray(0, 256), i * STATE_WORDS);
  inputs.set([i, ind, S >>> 0, T >>> 0], i * 16); inputs.set([tx[0], tx[1], tx[2], tx[3]], i * 16 + 4); inputs.set([ps >>> 0, pt >>> 0, 0, 0], i * 16 + 8);
}
let bad = 0;
const BATCH = Math.floor(4096 * 64 / STATE_WORDS);
for (let b0 = 0; b0 < N; b0 += BATCH) {
  const n = Math.min(BATCH, N - b0);
  const inp = inputs.slice(b0 * 16, (b0 + n) * 16);
  for (let i = 0; i < n; i++) inp[i * 16] = i;
  const out = runFn("fuzzind", `sbase = in0.x * STATE_WORDS; int oS, oT, bump; indirectOffsets(in0.y, ivec4(in1), int(in0.z), int(in0.w), int(in2.x), int(in2.y), oS, oT, bump); res = uvec4(uint(oS), uint(oT), uint(bump), 0u);`, inp, n, states.slice(b0 * STATE_WORDS, (b0 + n) * STATE_WORDS), null, null, true);
  for (let i = 0; i < n; i++) {
    const c = cases[b0 + i];
    const want = indirectOffsets(c.bp, c.ind, c.tx, c.S, c.T, c.ps, c.pt);
    const got = [out[i * 4] | 0, out[i * 4 + 1] | 0, out[i * 4 + 2] | 0];
    if (got.join() !== want.join()) { if (bad++ < 6) await log(`ind ${c.ind.toString(16)} tx ${c.tx} S ${c.S} T ${c.T} prev ${c.ps},${c.pt}: got ${got} want ${want}`); }
  }
}
await log(`indirect offsets fuzz: ${N - bad}/${N} equal`);
await fetch("/done", { method: "POST", body: bad ? "mismatch" : "ok" });
