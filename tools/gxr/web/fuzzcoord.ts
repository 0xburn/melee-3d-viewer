// Random triangles and pixels: the planes, perspective division and level of detail of the CPU reference against the shader's stageCoords().
import { HEADER_WORDS, STATE_WORDS } from "../../../src/render3d/gxr/glsl-pixel.ts";
import { DrawPixels } from "../../../src/render3d/gxr/raster.ts";
import { setupCtx, setupTri, setupTriInto, TS } from "../../../src/render3d/gxr/setup.ts";
import { Pool, V_COL, V_C, V_T, xfDraw } from "../../../src/render3d/gxr/xform.ts";
import { bitsOf, f } from "../../../src/render3d/gxr/f32.ts";
import { GxRegs } from "../../../src/render3d/gxr/state.ts";
import { VertexData, vertexLayout } from "../../../src/render3d/gxr/vertex.ts";
import { runFn } from "./fnrun.ts";

const q = new URLSearchParams(location.search);
const log = (s: string) => fetch("/log", { method: "POST", body: s });
let seed = Number(q.get("seed") ?? 1);
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const ri = (n: number) => Math.floor(rnd() * n);
const N = Number(q.get("n") ?? 2000);

const regs = new GxRegs();
regs.xf.set([0], 0);
const F = new Float32Array(regs.xf.buffer);
[320, -240, 16777215, 662, 582, 16777215].forEach((v, i) => (F[0x101a + i] = v));
const vd = new VertexData(vertexLayout(regs.cp, 0));
const x = xfDraw(regs, vd);

const bad: string[] = [];
const BATCH = 200;
for (let b0 = 0; b0 < N; b0 += BATCH) {
  const n = Math.min(BATCH, N - b0);
  const states = new Uint32Array(n * STATE_WORDS);
  const data = new Uint32Array(4096 * 64);
  const inputs = new Uint32Array(n * 16);
  const want: number[][] = [];
  let off = 0;
  const mark = (v: number) => v;
  void mark;
  for (let i = 0; i < n; i++) {
    const pool = new Pool();
    const gens = 1 + ri(3);
    const verts: number[] = [];
    for (let v = 0; v < 3; v++) {
      const o = pool.alloc();
      const D = pool.data;
      const cw = f(0.3 + rnd() * 20);
      D[o + V_C] = f((rnd() * 2 - 1) * cw); D[o + V_C + 1] = f((rnd() * 2 - 1) * cw); D[o + V_C + 2] = f(-rnd() * cw); D[o + V_C + 3] = cw;
      for (let k = 0; k < 8; k++) D[o + V_COL + k] = ri(256);
      for (let g = 0; g < gens; g++) {
        const size = 1 << ri(7);
        D[o + V_T + g * 3] = f((rnd() * 2 - 0.5) * size); D[o + V_T + g * 3 + 1] = f((rnd() * 2 - 0.5) * size); D[o + V_T + g * 3 + 2] = f(0.5 + rnd() * 2);
      }
      verts.push(o);
    }
    const bp = regs.bp;
    bp[0] = gens | (1 << 4);
    bp[0x20] = 0; bp[0x21] = (639 << 12) | 479; bp[0x59] = 0;
    const sc = setupCtx(bp);
    const tri = setupTri(pool, x, sc, 0, verts[0], verts[1], verts[2]);
    if (!tri) { want.push([0, 0, 0, 0]); inputs.set([0, 0, 0, 0], i * 16); continue; }
    // GPU copy of the triangle
    const words = HEADER_WORDS + tri.np * 3;
    const pw = new Uint32Array(tri.planes.buffer, tri.planes.byteOffset, tri.np * 3);
    data.set(pw, off + HEADER_WORDS);
    data[off + 13] = tri.xi >>> 0; data[off + 14] = tri.yi >>> 0; data[off + 15] = bitsOf(tri.ox); data[off + 16] = bitsOf(tri.oy);
    // state: map modes
    const mode0 = ri(2) | (ri(2) << 2) | (ri(2) << 4) | ([0, 1, 2, 4, 5, 6][ri(6)] << 5) | (ri(2) << 8) | ((rnd() < 0.7 ? 0 : (ri(40) - 20) & 255) << 9);
    const mode1 = (rnd() < 0.8 ? 0 : ri(24)) | ((rnd() < 0.8 ? 255 : 8 + ri(40)) << 8);
    const st = states.subarray(i * STATE_WORDS, (i + 1) * STATE_WORDS);
    st[0x80] = mode0; st[0x84] = mode1;
    let proj = 0;
    for (let g = 0; g < gens; g++) if (rnd() < 0.5) proj |= 1 << g;
    st[272] = proj;
    const px = tri.xi + ri(40) - 20, py = tri.yi + ri(40) - 20;
    const gen = ri(gens);
    inputs.set([i, off, px, py], i * 16);
    inputs.set([gen, 0, 0, 0], i * 16 + 4);
    // CPU
    const ps = { bp: new Uint32Array(256), kc: new Uint32Array(8), texProj: [0, 1, 2, 3, 4, 5, 6, 7].map((g) => ((proj >> g) & 1) === 1), wd: 320 };
    ps.bp[0x80] = mode0; ps.bp[0x84] = mode1;
    const dp = new DrawPixels(ps, { mem: new Uint8Array(0), tmem: new Uint8Array(0), tluts: new Map() });
    const c = [0, 0];
    dp.st2(tri, gen, px, py, c);
    const S = (Math.trunc(f(c[0] * 128)) << 8) >> 8, T = (Math.trunc(f(c[1] * 128)) << 8) >> 8;
    const [lod, lin] = dp.lodOf(tri, 0, gen, px, py);
    want.push([S, T, lod, lin ? 1 : 0]);
    off += words;
    void TS; void setupTriInto;
  }
  const out = runFn("fuzzcoord", `
    sbase = in0.x * STATE_WORDS; gTri = in0.y; gXi = int(wd(uData, gTri + 13u)); gYi = int(wd(uData, gTri + 14u)); gOx = wd(uData, gTri + 15u); gOy = wd(uData, gTri + 16u);
    MapI mp = loadMap(0u);
    int S, T, lod; bool lin;
    stageCoords(mp, in1.x, int(in0.z), int(in0.w), S, T, lod, lin);
    res = uvec4(uint(S), uint(T), uint(lod), lin ? 1u : 0u);`, inputs, n, states, null, data);
  for (let i = 0; i < n; i++) {
    const got = [out[i * 4] | 0, out[i * 4 + 1] | 0, out[i * 4 + 2] | 0, out[i * 4 + 3]];
    if (got.join() !== want[i].join()) bad.push(`case ${b0 + i}: got ${got} want ${want[i]}`);
  }
}
await log(`coordinate fuzz: ${N - bad.length}/${N} equal${bad.length ? "\n  " + bad.slice(0, 6).join("\n  ") : ""}`);
await fetch("/done", { method: "POST", body: bad.length ? "mismatch" : "ok" });
