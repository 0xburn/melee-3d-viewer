// The shader's correctly rounded 2^x (glsl-pixel.ts, EXP2_GLSL) for binary32 x in [-8, 0], against an exact computation with 200-bit integers, and against
// the CPU reference's Math.pow(2, x) rounded to binary32.
import { EXP2_GLSL, expConstants } from "../../../src/render3d/gxr/glsl-pixel.ts";
import { SOFT_FLOAT_GLSL } from "../../../src/render3d/gxr/glsl-float.ts";
import { compile, FULLSCREEN_VS, intTexture, uploadRows } from "../../../src/render3d/gxr/glutil.ts";

const q = new URLSearchParams(location.search);
const log = (s: string) => fetch("/log", { method: "POST", body: s });
const gl = document.createElement("canvas").getContext("webgl2", { antialias: false, alpha: false })!;
const W = 1024;
const FS = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D uIn;
out uint o;
${EXP2_GLSL}
void main() { ivec2 p = ivec2(gl_FragCoord.xy); o = f_exp2(texelFetch(uIn, p, 0).r); }`;
const prog = compile(gl, FULLSCREEN_VS, FS);
const inT = intTexture(gl, "R32UI", W, W), outT = intTexture(gl, "R32UI", W, W);
const fbo = gl.createFramebuffer()!;
gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outT.tex, 0);
function run(xs: Uint32Array): Uint32Array {
  uploadRows(gl, inT, 0, 0, W, W, xs);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0, 0, W, W);
  gl.useProgram(prog);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, inT.tex);
  gl.uniform1i(gl.getUniformLocation(prog, "uIn"), 0);
  gl.uniform4uiv(gl.getUniformLocation(prog, "uExpC"), expConstants());
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const raw = new Uint32Array(W * W * 4);
  gl.readPixels(0, 0, W, W, gl.RGBA_INTEGER, gl.UNSIGNED_INT, raw);
  const out = new Uint32Array(W * W);
  for (let i = 0; i < out.length; i++) out[i] = raw[i * 4];
  return out;
}

// exact 2^x rounded to binary32 (nearest even): x = -(m * 2^-q), 200-bit fixed point
const PREC = 220n, ONE = 1n << PREC;
let LN2 = 0n;
for (let k = 1n; k < 250n; k++) LN2 += ONE / (k << k);
function exact(xb: number): number {
  const e = (xb >>> 23) & 255, m = (xb & 0x7fffff) | 0x800000;
  if (e === 0) return 0x3f800000;
  const qq = 150 - e;
  // y = m / 2^qq as a fixed-point number
  const y = qq >= 0 ? (BigInt(m) << PREC) >> BigInt(qq) : (BigInt(m) << PREC) << BigInt(-qq);
  const n = y >> PREC, t = y - (n << PREC);
  // 2^-t = e^(-t ln2)
  const w = (t * LN2) / ONE;
  let term = ONE, sum = ONE;
  for (let j = 1n; term !== 0n; j++) { term = (term * w) / ONE / j; sum += j % 2n === 1n ? -term : term; }
  // value = sum * 2^-n / ONE, in (2^-9, 1]: find the 24-bit mantissa
  let v = sum; let exp = -Number(n);
  // normalize v to [ONE/2, ONE)
  while (v >= ONE) { v >>= 1n; exp += 1; }
  while (v < (ONE >> 1n)) { v <<= 1n; exp -= 1; }
  // v / ONE in [0.5, 1): mantissa bits = top 24 of v
  const shift = PREC - 24n;
  let mant = v >> shift;
  const rem = v - (mant << shift), half = 1n << (shift - 1n);
  if (rem > half || (rem === half && (mant & 1n) === 1n)) mant += 1n;
  if (mant === 1n << 24n) { mant >>= 1n; exp += 1; }
  return (((exp + 126) << 23) | (Number(mant) & 0x7fffff)) >>> 0;
}

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const toF = (b: number) => { u32[0] = b; return f32[0]; };
// the spec's vectors/fog-shapes.json: the four shaped values (bits) and the levels, all in the shader's own float arithmetic
const shapesRes = await fetch("/vec/fog-shapes.json");
if (!shapesRes.ok) await log("fog-shapes.json is not available (GX_SPEC_VECTORS): that part is skipped");
else {
  const cases = await shapesRes.json();
  const FS2 = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D uIn;
out uvec4 o;
${SOFT_FLOAT_GLSL}
${EXP2_GLSL}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uint fog = texelFetch(uIn, p, 0).r;
  uint g = f_sub(F_ONE, fog);
  uint e1 = f_sub(F_ONE, f_exp2(f_mul(0xc1000000u, fog)));
  uint e2 = f_sub(F_ONE, f_exp2(f_mul(f_mul(0xc1000000u, fog), fog)));
  uint b1 = f_exp2(f_mul(0xc1000000u, g));
  uint b2 = f_exp2(f_mul(f_mul(0xc1000000u, g), g));
  o = uvec4(e1, e2, b1, b2);
}`;
  const pr = compile(gl, FULLSCREEN_VS, FS2);
  const inp = new Uint32Array(W * W);
  cases.cases.forEach((c: any, i: number) => { inp[i] = parseInt(c.fogBits, 16); });
  uploadRows(gl, inT, 0, 0, W, W, inp);
  const o4 = intTexture(gl, "RGBA32UI", W, W);
  const fb2 = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb2);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, o4.tex, 0);
  gl.viewport(0, 0, W, W);
  gl.useProgram(pr);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, inT.tex);
  gl.uniform1i(gl.getUniformLocation(pr, "uIn"), 0);
  gl.uniform4uiv(gl.getUniformLocation(pr, "uExpC"), expConstants());
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const raw = new Uint32Array(W * W * 4);
  gl.readPixels(0, 0, W, W, gl.RGBA_INTEGER, gl.UNSIGNED_INT, raw);
  const bad: string[] = [];
  const names = ["exp", "exp2", "backwardExp", "backwardExp2"];
  cases.cases.forEach((c: any, i: number) => {
    for (let k = 0; k < 4; k++) {
      const bits = raw[i * 4 + k];
      f32[0] = 0; u32[0] = bits;
      const level = Math.trunc(f32[0] * 256);
      if (bits !== parseInt(c[names[k]].bits, 16) || level !== c[names[k]].level) bad.push(`${names[k]} ${c.fogBits}: got ${bits.toString(16)}/${level}`);
    }
  });
  await log(bad.length ? `fog shapes: ${bad.length} of ${cases.cases.length * 4} differ: ${bad.slice(0, 4).join("; ")}` : `ok   fog shapes: ${cases.cases.length * 4}/${cases.cases.length * 4}`);
}

const total = Number(q.get("n") ?? 2000000);
let seed = Number(q.get("seed") ?? 7);
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
let badExact = 0, badCpu = 0, cpuWrong = 0, done = 0;
const xs = new Uint32Array(W * W);
while (done < total) {
  for (let i = 0; i < xs.length; i++) {
    const kind = rnd() % 8;
    let v: number;
    if (kind === 0) v = -8 * ((rnd() >>> 8) / 16777216);                       // a fog level times -8
    else if (kind === 1) { const f = (rnd() >>> 8) / 16777216; v = Math.fround(Math.fround(-8 * f) * f); } // the exp2 form
    else if (kind === 2) v = -(rnd() % 129) / 16;                               // short fractions
    else if (kind === 3) { const x = rnd(); v = -Math.pow(2, -(x % 40)) * (1 + (rnd() >>> 9) / 8388608); }  // tiny arguments
    else if (kind === 4) v = -Math.floor(rnd() % 9);                           // integers
    else { u32[0] = (rnd() & 0x007fffff) | ((120 + (rnd() % 11)) << 23); v = -f32[0]; }
    f32[0] = Math.max(-8, Math.min(0, v));
    xs[i] = u32[0];
  }
  const got = run(xs);
  for (let i = 0; i < xs.length; i++) {
    const want = exact(xs[i]);
    u32[0] = 0; f32[0] = Math.pow(2, toF(xs[i]));
    const cpu = u32[0];
    if (got[i] !== want) { if (badExact++ < 10) await log(`x ${toF(xs[i])} (${xs[i].toString(16)}): gpu ${got[i].toString(16)} exact ${want.toString(16)} cpu ${cpu.toString(16)}`); }
    if (cpu !== want) { if (cpuWrong++ < 5) await log(`CPU reference differs from the exact value at x ${toF(xs[i])}: cpu ${cpu.toString(16)} exact ${want.toString(16)}`); }
    if (got[i] !== cpu) badCpu++;
  }
  done += xs.length;
}
await log(`exp2: ${done} inputs, shader != exact ${badExact}, shader != CPU reference ${badCpu}, CPU reference != exact ${cpuWrong}`);
await fetch("/done", { method: "POST", body: badExact ? "mismatch" : "ok" });
