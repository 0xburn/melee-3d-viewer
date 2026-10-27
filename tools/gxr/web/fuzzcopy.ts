// EFB copies: random frame buffers (color and depth) copied with every copy format code, pixel format, half size and rectangle; the bytes the CPU reference
// writes (copy.ts) must equal the bytes the shader writes.
import { Memory } from "../../../src/render3d/gxr/dff.ts";
import { copyParams, encodeCopy } from "../../../src/render3d/gxr/copy.ts";
import { GxGl } from "../../../src/render3d/gxr/gl.ts";
import { Efb } from "../../../src/render3d/gxr/raster.ts";
import { GxRegs } from "../../../src/render3d/gxr/state.ts";

const q = new URLSearchParams(location.search);
const log = (s: string) => fetch("/log", { method: "POST", body: s });
const gl = document.createElement("canvas").getContext("webgl2", { antialias: false, alpha: false })!;
const be = new GxGl(gl);
let seed = Number(q.get("seed") ?? 1);
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const int = (n: number) => Math.floor(rnd() * n);
const n = Number(q.get("n") ?? 300);
let bad = 0;
for (let t = 0; t < n; t++) {
  const pixFmt = [0, 0, 1, 3, 3][int(5)];
  const color = new Uint32Array(640 * 528), depth = new Uint32Array(640 * 528);
  for (let i = 0; i < color.length; i++) {
    color[i] = pixFmt === 1 ? int(1 << 24) : int(1 << 24);
    depth[i] = int(1 << 24);
  }
  const tp = int(16), intensity = int(2) === 1, half = int(2) === 1;
  const x0 = int(300), y0 = int(300), w = 1 + int(160), h = 1 + int(120);
  const regs = new GxRegs();
  regs.bp[0x43] = pixFmt;
  regs.bp[0x49] = x0 | (y0 << 10); regs.bp[0x4a] = (w - 1) | ((h - 1) << 10);
  regs.bp[0x4b] = 0x2000 >> 5; regs.bp[0x4d] = 80 + int(20);
  regs.bp[0x52] = (tp << 3) | (half ? 1 << 9 : 0) | (intensity ? 1 << 15 : 0);
  const p = copyParams(regs.bp);
  // the CPU reference
  const efb = new Efb();
  efb.color.set(color); efb.depth.set(depth);
  const cpuMem = new Uint8Array(0x1800000);
  encodeCopy(efb, p, cpuMem);
  // the shader
  be.reset();
  be.writeEfb(color, depth);
  be.copy(regs, new Memory(), 0);
  const len = 0x40000;
  const g = be.readMem(0x2000, len);
  let diff = 0, first = -1;
  for (let i = 0; i < len; i++) if (g[i] !== cpuMem[0x2000 + i]) { diff++; if (first < 0) first = i; }
  if (diff) { bad++; await log(`case ${t}: pixfmt ${pixFmt} tp ${tp} intensity ${intensity} half ${half} rect ${x0},${y0} ${w}x${h}: ${diff} bytes differ, first +${first}: gpu ${g[first]} cpu ${cpuMem[0x2000 + first]}`); }
}
await log(`fuzz copy: ${n - bad}/${n} cases equal`);
await fetch("/done", { method: "POST", body: bad ? "mismatch" : "ok" });
