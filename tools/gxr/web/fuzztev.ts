// Random inputs to the color combiner's vector arithmetic against the CPU reference's scalar one.
import { tevRegular } from "../../../src/render3d/gxr/tev.ts";
import { runFn } from "./fnrun.ts";
const log = (s: string) => fetch("/log", { method: "POST", body: s });
let seed = 7;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const ri = (n: number) => Math.floor(rnd() * n);
const N = 4000;
const inputs = new Uint32Array(N * 16);
const cases: number[][] = [];
for (let i = 0; i < N; i++) {
  const a = [ri(256), ri(256), ri(256)], b = [ri(256), ri(256), ri(256)], c = [ri(256), ri(256), ri(256)], d = [ri(2048) - 1024, ri(2048) - 1024, ri(2048) - 1024];
  const bias = ri(3), op = ri(2), scale = ri(4), clamp = ri(2);
  cases.push([...a, ...b, ...c, ...d, bias, op, scale, clamp]);
  inputs.set([a[0], a[1], a[2], bias], i * 16); inputs.set([b[0], b[1], b[2], op], i * 16 + 4); inputs.set([c[0], c[1], c[2], scale], i * 16 + 8); inputs.set([d[0] >>> 0, d[1] >>> 0, d[2] >>> 0, clamp], i * 16 + 12);
}
const out = runFn("fuzztev", `ivec3 r = tevColor3(ivec3(in0.xyz), ivec3(in1.xyz), ivec3(in2.xyz), ivec3(in3.xyz), int(in0.w), int(in1.w), int(in2.w), int(in3.w)); res = uvec4(uint(r.x), uint(r.y), uint(r.z), 0u);`, inputs, N, null, null);
let bad = 0;
for (let i = 0; i < N; i++) {
  const c = cases[i];
  for (let k = 0; k < 3; k++) {
    const want = tevRegular(false, c[k], c[3 + k], c[6 + k], c[9 + k], c[12], c[13], c[14], c[15]);
    const got = out[i * 4 + k] | 0;
    if (got !== want) { if (bad++ < 6) await log(`case ${JSON.stringify(c)} comp ${k}: got ${got} want ${want}`); }
  }
}
await log(`tev vector arithmetic: ${bad} differences in ${N * 3}`);
await fetch("/done", { method: "POST", body: bad ? "mismatch" : "ok" });
