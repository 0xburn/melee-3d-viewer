// A stream played on a fresh GxGl and again after reset() (with another stream played in between) must give the same pictures.
import { parseDff } from "../../../src/render3d/gxr/dff.ts";
import { GxGpu } from "../../../src/render3d/gxr/gpu.ts";
import { GxGl } from "../../../src/render3d/gxr/gl.ts";

const q = new URLSearchParams(location.search);
const log = (s: string) => fetch("/log", { method: "POST", body: s });
const get = async (u: string) => new Uint8Array(await (await fetch(u)).arrayBuffer());
const gl = document.createElement("canvas").getContext("webgl2", { antialias: false, alpha: false })!;
const a = parseDff(await get("/spec/" + q.get("a")));
const b = parseDff(await get("/spec/" + q.get("b")));
const workers = Number(q.get("workers") ?? 0);
const be = new GxGl(gl, {}, { workers, factory: () => new Worker("/frontworker.js", { type: "module" }) });
function play(d: ReturnType<typeof parseDff>): Uint8Array[] {
  be.reset();
  const pics: Uint8Array[] = [];
  be.onPicture = (rgba) => { pics.push(rgba.slice()); };
  const gpu = new GxGpu(be, d, new Uint8Array(0x1800000));
  for (let i = 0; i < d.frames.length; i++) { be.drawing = i > 0; gpu.runFrame(d.frames[i]); }
  return pics;
}
const p1 = play(a);
play(b);
const p2 = play(a);
let bad = 0;
for (let i = 0; i < p1.length; i++) { let n = 0; for (let k = 0; k < p1[i].length; k++) if (p1[i][k] !== p2[i]?.[k]) n++; if (n) { bad++; await log(`picture ${i}: ${n} values differ after reset`); } }
await log(bad ? "reset changes pictures" : `pictures equal after reset (${p1.length})`);
await fetch("/done", { method: "POST", body: "ok" });
