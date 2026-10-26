// Runs one window through the CPU reference and the GPU backend together and reports the first pass whose EFB differs.
import { parseDff } from "../../../src/render3d/gxr/dff.ts";
import { GxGpu } from "../../../src/render3d/gxr/gpu.ts";
import { GxGl } from "../../../src/render3d/gxr/gl.ts";
import { CpuBackend } from "../../../src/render3d/gxr/cpu.ts";

const q = new URLSearchParams(location.search);
const log = (s: string) => fetch("/log", { method: "POST", body: s });
const get = async (u: string) => new Uint8Array(await (await fetch(u)).arrayBuffer());
const gl = document.createElement("canvas").getContext("webgl2", { antialias: false, alpha: false })!;
const manifest = await (await fetch("/spec/manifest.json")).json();
const w = manifest.windows.find((x: any) => x.name === q.get("window"))!;
const dff = parseDff(await get("/spec/" + w.recording));
const mem1 = await get("/spec/" + w.memory);
const frameSel = Number(q.get("frame") ?? 1);
const gpuBe = new GxGl(gl);
let gpu!: GxGpu;
const cpuMem = new Uint8Array(0x1800000);
const cpuBe = new CpuBackend(() => ({ mem: cpuMem, tmem: gpu.regs.tmem, tluts: gpu.regs.tluts }));
let drawIdx = 0, frame = 0, passNo = 0, lastPassDraw = 0, reported = false;
const both = {
  draw(regs: any, mem: any, vd: any, tris: any, lines: any, points: any, prims: any) {
    gpuBe.draw(regs, mem, vd, tris, lines, points, prims);
    cpuBe.draw(regs, mem, vd, tris, lines, points, prims);
    drawIdx++;
  },
  copy(regs: any, mem: any, value: number) {
    const a = gpuBe.copy(regs, mem, value);
    if (!a.toXfb) {
      const dest = regs.bp[0x4b] * 32 & 0x1ffffff;
      const before = gpuBe.readMem(dest, 0x80000);
      cpuBe.copy(regs, { data: cpuMem, touch() {} } as any, value);
      const cpuBytes = cpuMem.slice(dest, dest + 0x80000);
      let n = 0, first = -1;
      for (let i = 0; i < before.length; i++) if (before[i] !== cpuBytes[i]) { n++; if (first < 0) first = i; }
      if (n) log(`frame ${frame}: copy to ${dest.toString(16)} fmt tp=${(regs.bp[0x52] >> 3) & 15} int=${(regs.bp[0x52] >> 15) & 1} half=${(regs.bp[0x52] >> 9) & 1} stride=${regs.bp[0x4d]} wm=${regs.bp[0x4a] & 1023} hm=${regs.bp[0x4a] >> 10}: ${n} bytes differ, first at +${first}: gpu ${before[first]} cpu ${cpuBytes[first]}`);
    } else cpuBe.copy(regs, { data: cpuMem, touch() {} } as any, value);
    return a;
  },
  copyClear(regs: any) { gpuBe.copyClear(regs); cpuBe.copyClear(regs); compare("clear"); },
};
function compare(why: string) {
  if (reported) return;
  const g = gpuBe.readEfb();
  const c = cpuBe.efb;
  let n = 0, first = -1;
  for (let i = 0; i < c.color.length; i++) if (g.color[i] !== c.color[i] || g.depth[i] !== c.depth[i]) { n++; if (first < 0) first = i; }
  if (n) {
    reported = true;
    log(`frame ${frame}: EFB differs after ${why} (pass ${passNo}, draws ${lastPassDraw}..${drawIdx - 1}): ${n} pixels, first (${first % 640},${(first / 640) | 0}) gpu ${g.color[first].toString(16)}/${g.depth[first]} cpu ${c.color[first].toString(16)}/${c.depth[first]}`);
  }
}
gpuBe.onFlush = () => { compare("flush"); passNo++; lastPassDraw = drawIdx; };
gpu = new GxGpu(both as any, dff, mem1);
cpuMem.set(gpu.mem.data);
const origWrite = gpu.mem.write.bind(gpu.mem);
gpu.mem.write = (a: number, b: Uint8Array) => { if (frame === 1 && a < 0x700000 && a + b.length > 0x4f0000) log(`write ${a.toString(16)} len ${b.length} at draw ${drawIdx} passNo ${passNo}`); origWrite(a, b); };
const origTouch = gpu.mem.touch.bind(gpu.mem);
gpu.mem.touch = (a: number, n: number) => { origTouch(a, n); cpuMem.set(gpu.mem.data.subarray(a, a + n), a); };
for (let i = 0; i < dff.frames.length && !reported; i++) {
  frame = i;
  gpuBe.drawing = cpuBe.drawing = i > 0;
  gpu.runFrame(dff.frames[i]);
}
await log(reported ? "mismatch found" : "no mismatch");
await fetch("/done", { method: "POST", body: "ok" });
