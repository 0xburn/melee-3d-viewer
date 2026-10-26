// Compile-time ablation: how long the browser's shader compiler takes with parts of the pixel shader taken out.
import { PIXEL_FS } from "../../../src/render3d/gxr/glsl-pixel.ts";
const q = new URLSearchParams(location.search);
const log = (s: string) => fetch("/log", { method: "POST", body: s });
const gl = document.createElement("canvas").getContext("webgl2")!;
const rep = (fs: string, a: string, b: string): string => { if (!fs.includes(a)) throw new Error("missing: " + a); return fs.replace(a, b); };
const cut = (fs: string, from: string, to: string, body: string): string => { const a = fs.indexOf(from), b = fs.indexOf(to); if (a < 0 || b < 0) throw new Error("cut " + from); return fs.slice(0, a) + body + fs.slice(b); };
const NA = "uint f_add(uint a, uint b) { return floatBitsToUint(uintBitsToFloat(a) + uintBitsToFloat(b)); }\n";
const NM = "uint f_mul(uint a, uint b) { return floatBitsToUint(uintBitsToFloat(a) * uintBitsToFloat(b)); }\n";
const ND = "uint f_div(uint a, uint b) { return floatBitsToUint(uintBitsToFloat(a) / uintBitsToFloat(b)); }\n";
const cutAdd = (s: string) => cut(s, "uint f_add(uint a, uint b) {", "uint f_sub(uint a, uint b)", NA);
const cutMul = (s: string) => cut(s, "uint f_mul(uint a, uint b) {", "uint f_div(uint a, uint b)", NM);
const cutDiv = (s: string) => cut(s, "uint f_div(uint a, uint b) {", "// float(n) for", ND);
const variants: Record<string, (fs: string) => string> = {
  nativef: (s) => cutDiv(cutMul(cutAdd(s))),
  nativeadd: cutAdd,
  nativemul: cutMul,
  nativediv: cutDiv,
  full: (s) => s,
  nofog: (s) => rep(s, "  if (fsel != 0u) fogPixel(fsel, z, x, src);", ""),
  noblend: (s) => rep(rep(s, "  ivec4 res = blendPixel(S(0x41u), S(0x42u), src, dst);", "  ivec4 res = src;"), "  ivec4 dst = readColor(col, pixFmt);", "  ivec4 dst = ivec4(0);"),
  notex: (s) => rep(s, "bool texEn = bf(ord, 6, 1) == 1u;", "bool texEn = false;"),
  nocomb: (s) => rep(s, "    ivec3 ca = csel(", "    gRegs[0] = int(cc); continue;\n    ivec3 ca = csel("),
  nosample: (s) => rep(s, "      ivec4 tx = sampleMap(mp, cS, cT, lod, lin);", "      ivec4 tx = ivec4(cS, cT, lod, lin ? 1 : 0);"),
  nocoords: (s) => rep(s, "  for (int j = 0; j < uK.x; j++) genST(n, bx + (j & 1), by + (j >> 1), sv[j], tv[j]);", "  for (int j = 0; j < uK.x; j++) { sv[j] = uint(bx + j); tv[j] = uint(by + j); }"),
  nofetch: (s) => rep(s, "      sum += fetchTexel(mp, off, W, wrapC(s0 + dx, W, mp.ws), wrapC(t0 + dy, H, mp.wt)) * wgt;", "      sum += ivec4(wrapC(s0 + dx, W, mp.ws), wrapC(t0 + dy, H, mp.wt), int(off), 0) * wgt;"),
};
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
