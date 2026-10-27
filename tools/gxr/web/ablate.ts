/// <reference lib="dom" />
// Compile-time ablation: how long the browser's shader compiler takes with parts of the pixel shader taken out.
import { PIXEL_FS } from "../../../src/render3d/gxr/glsl-pixel.ts";
const q = new URLSearchParams(location.search);
const log = (s: string) => fetch("/log", { method: "POST", body: s });
const gl = document.createElement("canvas").getContext("webgl2")!;
import { variants } from "./ablations.ts";
const names = (q.get("v") ?? Object.keys(variants).join(",")).split(",");
for (const nm of names) {
  const fs = variants[nm](PIXEL_FS);
  const vs = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vs, `#version 300 es\nvoid main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`);
  gl.compileShader(vs);
  const f = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(f, fs);
  gl.compileShader(f);
  const p = gl.createProgram()!;
  gl.attachShader(p, vs); gl.attachShader(p, f);
  const t1 = performance.now();
  gl.linkProgram(p);
  const ok = gl.getProgramParameter(p, gl.LINK_STATUS);
  await log(`${nm}: link ${(performance.now() - t1).toFixed(0)} ms ok=${ok}`);
}
await fetch("/done", { method: "POST", body: "ok" });
