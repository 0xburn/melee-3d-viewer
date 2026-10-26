import { PIXEL_FS } from "../../../src/render3d/gxr/glsl-pixel.ts";
import { compile, FULLSCREEN_VS, intTexture, uploadRows } from "../../../src/render3d/gxr/glutil.ts";

export const gl = document.createElement("canvas").getContext("webgl2", { antialias: false, alpha: false })!;
gl.getExtension("EXT_color_buffer_float");

const BODY = PIXEL_FS.slice(0, PIXEL_FS.lastIndexOf("void main() {"));
const progs = new Map<string, WebGLProgram>();

/** run `main` (GLSL statements that read in0..in3 (uvec4) and the case index i, and set `res`) for every case */
export function runFn(name: string, main: string, inputs: Uint32Array, nCases: number, states: Uint32Array | null, mem: Uint8Array | null, extraData: Uint32Array | null = null): Uint32Array {
  let p = progs.get(name);
  if (!p) {
    const fs = BODY + `
uniform usampler2D uIn;
uvec4 inp(int i, int k) { int t = i * 4 + k; return texelFetch(uIn, ivec2(t & 4095, t >> 12), 0); }
void main() {
  int i = int(gl_FragCoord.x) + int(gl_FragCoord.y) * 1024;
  uvec4 in0 = inp(i, 0), in1 = inp(i, 1), in2 = inp(i, 2), in3 = inp(i, 3);
  uvec4 res = uvec4(0u);
  ${main}
  o = res;
}`;
    p = compile(gl, FULLSCREEN_VS, fs);
    progs.set(name, p);
  }
  const W = 1024, H = Math.max(1, Math.ceil(nCases / 1024));
  const tex = intTexture(gl, "RGBA32UI", 4096, Math.max(1, Math.ceil(nCases * 4 / 4096)));
  const data = new Uint32Array(tex.h * 4096 * 4);
  data.set(inputs);
  uploadRows(gl, tex, 0, 0, 4096, tex.h, data);
  const memTex = intTexture(gl, "R8UI", 4096, 256);
  const mb = new Uint8Array(4096 * 256);
  if (mem) mb.set(mem);
  uploadRows(gl, memTex, 0, 0, 4096, 256, mb);
  const sTex = intTexture(gl, "R32UI", 4096, 64);
  const sb = new Uint32Array(4096 * 64);
  if (states) sb.set(states);
  uploadRows(gl, sTex, 0, 0, 4096, 64, sb);
  const dTex = intTexture(gl, "R32UI", 4096, 64);
  const db = new Uint32Array(4096 * 64);
  if (extraData) db.set(extraData);
  uploadRows(gl, dTex, 0, 0, 4096, 64, db);
  const out = intTexture(gl, "RGBA32UI", W, H);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out.tex, 0);
  gl.viewport(0, 0, W, H);
  gl.useProgram(p);
  const bind = (unit: number, uname: string, t: WebGLTexture) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(gl.getUniformLocation(p!, uname), unit); };
  bind(0, "uIn", tex.tex); bind(1, "uMem", memTex.tex); bind(2, "uStates", sTex.tex);
  // the shader declares the other samplers too; point them at something valid
  bind(3, "uData", dTex.tex);
  for (const [u, n] of [[4, "uTiles"], [5, "uList"], [6, "uEfb"]] as [number, string][]) bind(u, n, sTex.tex);
  gl.uniform4i(gl.getUniformLocation(p, "uK"), 4, 25, 3, 2);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const raw = new Uint32Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA_INTEGER, gl.UNSIGNED_INT, raw);
  for (const t of [tex, memTex, sTex, out, dTex]) gl.deleteTexture(t.tex);
  return raw;
}

