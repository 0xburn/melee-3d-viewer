// Random inputs to the texture unit: the CPU reference's sample() against the shader's sampleMap().
import { STATE_WORDS } from "../../../src/render3d/gxr/glsl-pixel.ts";
import { sample } from "../../../src/render3d/gxr/texunit.ts";
import { runFn } from "./fnrun.ts";

const q = new URLSearchParams(location.search);
const log = (s: string) => fetch("/log", { method: "POST", body: s });
let seed = Number(q.get("seed") ?? 1);
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const ri = (n: number) => Math.floor(rnd() * n);
const N = Number(q.get("n") ?? 4000);
const FMTS = [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 14];

const mem = new Uint8Array(4096 * 256);
for (let i = 0; i < mem.length; i++) mem[i] = ri(256);
const PAL = 0x80000;
const states = new Uint32Array(N * STATE_WORDS);
const inputs = new Uint32Array(N * 16);
const infos: { fmt: number; W: number; H: number; ws: number; wt: number; pf: number; mf: number; s: number; t: number; lod: number; linear: boolean; base: number }[] = [];
for (let i = 0; i < N; i++) {
  const fmt = FMTS[ri(FMTS.length)];
  const W = ri(64), H = ri(64);
  const ws = ri(3), wt = ri(3), pf = ri(3), mf = [0, 1, 2, 4, 5, 6][ri(6)];
  const base = (ri(64) * 4096) & 0x7ffe0;
  const lod = ri(100) - 12, linear = rnd() < 0.5;
  const sRange = 1 << (8 + ri(14));
  const s = ri(2 * sRange) - sRange, t = ri(2 * sRange) - sRange;
  const st = states.subarray(i * STATE_WORDS, (i + 1) * STATE_WORDS);
  st[0x88] = (fmt << 20) | (H << 10) | W; st[0x94] = base >> 5; st[0x98] = pf << 10; st[0x80] = ws | (wt << 2) | (mf << 5); st[264] = PAL; st[274] = 0x80000;
  inputs.set([i, s >>> 0, t >>> 0, W], i * 16);
  inputs.set([lod >>> 0, linear ? 1 : 0, 0, 0], i * 16 + 4);
  infos.push({ fmt, W, H, ws, wt, pf, mf, s, t, lod, linear, base });
}
// states are limited by the test texture (64 rows of 4096 words): run in batches
const bad: string[] = [];
const BATCH = Math.floor(4096 * 64 / STATE_WORDS);
for (let b0 = 0; b0 < N; b0 += BATCH) {
  const n = Math.min(BATCH, N - b0);
  const inp = inputs.slice(b0 * 16, (b0 + n) * 16);
  for (let i = 0; i < n; i++) inp[i * 16] = i;
  const out = runFn("fuzzsample", `sbase = in0.x * STATE_WORDS; MapI mp = loadMap(0u); res = uvec4(sampleMap(mp, int(in0.y), int(in0.z), int(in1.x), in1.y == 1u));`, inp, n, states.slice(b0 * STATE_WORDS, (b0 + n) * STATE_WORDS), mem);
  for (let i = 0; i < n; i++) {
    const c = infos[b0 + i];
    const data = {
      byte: (k: number) => mem[(c.base + k) & 0xfffff],
      pal: (k: number) => (mem[PAL + k * 2] << 8) | mem[PAL + k * 2 + 1],
    };
    const want = [0, 0, 0, 0];
    sample({ fmt: c.fmt, W: c.W, H: c.H, wrapS: c.ws, wrapT: c.wt, pf: c.pf, data, off: 0 }, c.s, c.t, c.lod, c.linear, c.mf, want);
    const got = [out[i * 4], out[i * 4 + 1], out[i * 4 + 2], out[i * 4 + 3]];
    if (got.join() !== want.join()) bad.push(`${JSON.stringify(c)} got ${got} want ${want}`);
  }
}
await log(`texture unit fuzz: ${N - bad.length}/${N} equal${bad.length ? "\n  " + bad.slice(0, 5).join("\n  ") : ""}`);
await fetch("/done", { method: "POST", body: bad.length ? "mismatch" : "ok" });
