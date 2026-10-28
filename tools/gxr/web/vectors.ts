// The spec's test vectors against the shader's own functions (and the copy and fog passes) in a real GPU.
import { STATE_WORDS } from "../../../src/render3d/gxr/glsl-pixel.ts";
import { GxGl } from "../../../src/render3d/gxr/gl.ts";
import { GxRegs } from "../../../src/render3d/gxr/state.ts";
import { Memory } from "../../../src/render3d/gxr/dff.ts";
import { FifoWriter, basicScene, colorVertices } from "../../../src/render3d/gxr/encode.ts";
import { GxGpu } from "../../../src/render3d/gxr/gpu.ts";
import { bitsOf, f } from "../../../src/render3d/gxr/f32.ts";

const log = (s: string) => fetch("/log", { method: "POST", body: s });
const J = async (n: string) => (await fetch("/vec/" + n + ".json")).json();
const hex = (s: string) => Uint8Array.from(s.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
import { gl, runFn } from "./fnrun.ts";
let failures = 0;

function report(name: string, bad: string[], total: number) {
  if (bad.length) failures++;
  return log(`${bad.length ? "FAIL" : "ok  "} ${name}: ${total - bad.length}/${total}${bad.length ? "\n   " + bad.slice(0, 6).join("\n   ") : ""}`);
}

// state words of a map-0 texture for the texel and sampling tests
function mapState(fmt: number, W: number, H: number, addr: number, pf: number, palAddr: number, wrap: number, mode0Extra = 0): Uint32Array {
  const s = new Uint32Array(STATE_WORDS);
  s[0x88] = (fmt << 20) | (H << 10) | W;
  s[0x94] = addr >> 5;
  s[0x98] = pf << 10;
  s[0x80] = wrap | (wrap << 2) | mode0Extra;
  s[264] = palAddr;
  s[274] = 0x40000;
  return s;
}

// ---- texel decode and CMPR
{
  const tex = await J("texel-decode"), cm = await J("cmpr-blocks");
  const mem = new Uint8Array(4096 * 256);
  const states: number[] = [];
  const cases: number[] = [];
  const expect: number[][] = [];
  const names: string[] = [];
  let slot = 0, palCursor = 0;
  const addCase = (st: Uint32Array, s: number, t: number, W: number, want: number[], nm: string) => {
    const idx = states.length / STATE_WORDS;
    for (const w of st) states.push(w);
    cases.push(idx, s, t, W);
    expect.push(want); names.push(nm);
  };
  for (const c of tex) {
    const base = (slot++) * 4096 % (4096 * 128), img = hex(c.image);
    mem.set(img, base);
    let pal = 0xffffffff;
    if (c.tlut) { pal = 0x80000 + palCursor; const tb = hex(c.tlut); mem.set(tb, pal); palCursor += (tb.length + 31) & ~31; }
    const st = mapState(c.format, c.width - 1, c.height - 1, base, c.tlutFormat ?? 0, pal, 0);
    for (const t of c.texels) addCase(st, t.s, t.t, c.width - 1, t.rgba, `${c.name} pal ${c.tlutFormat}`);
  }
  for (const c of cm) {
    const base = (slot++) * 4096 % (4096 * 128);
    mem.set(hex(c.subblock), base);
    const st = mapState(14, 3, 3, base, 0, 0xffffffff, 0);
    for (const t of c.texels) addCase(st, t.s, t.t, 3, t.rgba, `cmpr ${c.c1} ${c.c2}`);
  }
  const n = cases.length / 4;
  const inputs = new Uint32Array(n * 16);
  const sdat = new Uint32Array(states);
  for (let i = 0; i < n; i++) { inputs.set(cases.slice(i * 4, i * 4 + 4), i * 16); }
  // states may exceed the 64 rows of the test texture: only 4096*64/280 = 936 states fit
  const out = runFn("texel", `sbase = in0.x * STATE_WORDS; MapI mp = loadMap(0u); ivec4 c = fetchTexel(mp, 0u, int(in0.w), int(in0.y), int(in0.z)); res = uvec4(c);`, inputs, n, sdat, mem);
  const bad: string[] = [];
  for (let i = 0; i < n; i++) {
    const got = [out[i * 4], out[i * 4 + 1], out[i * 4 + 2], out[i * 4 + 3]];
    if (got.join() !== expect[i].join()) bad.push(`${names[i]} case ${i}: got ${got} want ${expect[i]}`);
  }
  const hist: Record<string, number> = {};
  for (const b of bad) { const k = b.split(" case ")[0]; hist[k] = (hist[k] ?? 0) + 1; }
  await log("texel failures by kind: " + JSON.stringify(hist));
  await report("texel decode + cmpr", bad, n);
}

// ---- sampling
{
  const v = await J("sample");
  const mem = new Uint8Array(4096 * 256);
  mem.set(hex(v.image), 0);
  const WR: Record<string, number> = { clamp: 0, repeat: 1, mirror: 2 };
  const states = new Uint32Array(3 * STATE_WORDS);
  for (const k of [0, 1, 2]) states.set(mapState(6, 7, 7, 0, 0, 0xffffffff, k), k * STATE_WORDS);
  const n = v.cases.length;
  const inputs = new Uint32Array(n * 16);
  v.cases.forEach((c: any, i: number) => { inputs.set([WR[c.wrap], c.s >>> 0, c.t >>> 0, c.linear ? 1 : 0], i * 16); });
  const out = runFn("sample", `sbase = in0.x * STATE_WORDS; MapI mp = loadMap(0u); res = uvec4(sampleMap(mp, int(in0.y), int(in0.z), 0, in0.w == 1u));`, inputs, n, states, mem);
  const bad: string[] = [];
  v.cases.forEach((c: any, i: number) => {
    const got = [out[i * 4], out[i * 4 + 1], out[i * 4 + 2], out[i * 4 + 3]];
    if (got.join() !== c.rgba.join()) bad.push(`${JSON.stringify(c)} got ${got}`);
  });
  await report("sampling and wrap", bad, n);
}

// ---- TEV arithmetic
{
  const SCALE: Record<string, number> = { x1: 0, x2: 1, x4: 2, "/2": 3 }, BIAS: Record<string, number> = { "0": 0, "+128": 1, "-128": 2 };
  const col = (await J("tev-color")).cases, al = (await J("tev-alpha")).cases;
  const rows: { in: number[]; want: number; nm: string; check: boolean }[] = [];
  for (const c of col) for (let k = 0; k < 3; k++) rows.push({ in: [0, c.a[k], c.b[k], c.c[k], c.d[k], BIAS[c.bias], c.op === "subtract" ? 1 : 0, SCALE[c.scale], c.clamp], want: c.result[k], nm: JSON.stringify(c) + k, check: true });
  const nCol = rows.length;
  for (const c of al) rows.push({ in: [1, c.a, c.b, c.c, c.d, BIAS[c.bias], c.op === "subtract" ? 1 : 0, SCALE[c.scale], c.clamp], want: c.resultAlpha, nm: JSON.stringify(c), check: false });
  const inputs = new Uint32Array(rows.length * 16);
  rows.forEach((r, i) => { inputs.set(r.in.slice(0, 4), i * 16); inputs.set(r.in.slice(4, 8), i * 16 + 4); inputs.set([r.in[8], 0, 0, 0], i * 16 + 8); });
  const out = runFn("tev", `res = uvec4(uint(tevRegular(in0.x == 1u, int(in0.y), int(in0.z), int(in0.w), int(in1.x), int(in1.y), int(in1.z), int(in1.w), int(in2.x))) & 0xffffu);`, inputs, rows.length, null, null);
  const bad: string[] = [], badA: string[] = [];
  // colors show the low 8 bits; the alpha result shows saturated to 0..255 (the stored value is 11 bits signed)
  rows.forEach((r, i) => {
    const raw = (out[i * 4] << 16) >> 16;
    const shown = i >= nCol ? Math.max(0, Math.min(255, raw)) : raw & 255;
    if (shown !== r.want) (i >= nCol ? badA : bad).push(`${r.nm} got ${shown}`);
  });
  await report("tev color arithmetic", bad, nCol);
  await report("tev alpha arithmetic", badA, al.length);
}

// ---- blend
{
  const FACTOR: Record<string, number> = { zero: 0, one: 1, "dstcolor/srccolor": 2, "inv dstcolor/srccolor": 3, srcalpha: 4, "inv srcalpha": 5, dstalpha: 6, "inv dstalpha": 7 };
  const cs = (await J("blend")).cases;
  const inputs = new Uint32Array(cs.length * 16);
  cs.forEach((c: any, i: number) => {
    let mode = (1 << 3) | (1 << 4);
    if (c.blend === "add") mode |= 1 | (FACTOR[c.dstFactor] << 5) | (FACTOR[c.srcFactor] << 8);
    else if (c.blend === "subtract") mode |= 1 | (1 << 11);
    else mode |= 2 | (Number(c.blend.split(" ")[2]) << 12);
    inputs.set([mode, c.constantDstAlpha != null ? 0x100 | c.constantDstAlpha : 0, 0, 0], i * 16);
    inputs.set(c.srcRGBA, i * 16 + 4); inputs.set([...c.dstRGB, 255], i * 16 + 8);
  });
  const out = runFn("blend", `res = uvec4(blendPixel(in0.x, in0.y, ivec4(in1), ivec4(in2)));`, inputs, cs.length, null, null);
  const bad: string[] = [];
  cs.forEach((c: any, i: number) => { const got = [out[i * 4], out[i * 4 + 1], out[i * 4 + 2]]; if (got.join() !== c.result.join()) bad.push(`${JSON.stringify(c)} got ${got}`); });
  await report("blend", bad, cs.length);
}

// ---- log2 of LOD deltas
{
  const cs = (await J("lod-log2")).cases.filter((c: any) => c.log2Fixed !== null);
  const inputs = new Uint32Array(cs.length * 16);
  cs.forEach((c: any, i: number) => inputs.set([bitsOf(f(c.delta))], i * 16));
  const out = runFn("lod", `res = uvec4(uint(log2fix(in0.x)));`, inputs, cs.length, null, null);
  const bad: string[] = [];
  cs.forEach((c: any, i: number) => { if ((out[i * 4] | 0) !== c.log2Fixed) bad.push(`${c.delta}: got ${out[i * 4] | 0} want ${c.log2Fixed}`); });
  await report("log2 of deltas", bad, cs.length);
}

// ---- fog
{
  const cs = (await J("fog-linear-perspective")).cases;
  const reg = (x: number) => { const b = bitsOf(x); return ((b >>> 31) << 19) | (((b >>> 23) & 255) << 11) | ((b >>> 12) & 0x7ff); };
  const states = new Uint32Array(cs.length * STATE_WORDS);
  const inputs = new Uint32Array(cs.length * 16);
  cs.forEach((c: any, i: number) => {
    const s = states.subarray(i * STATE_WORDS, (i + 1) * STATE_WORDS);
    s[0xee] = reg(f(c.fogA)); s[0xef] = c.fogBmagnitude; s[0xf0] = c.fogBshift; s[0xf1] = reg(f(c.fogC)) | (2 << 21);
    s[0xf2] = (c.fogColor[0] << 16) | (c.fogColor[1] << 8) | c.fogColor[2];
    inputs.set([i, c.depth24, 0, 0], i * 16); inputs.set([...c.baseColor, 255], i * 16 + 4);
  });
  const out = runFn("fog", `sbase = in0.x * STATE_WORDS; ivec4 c = ivec4(in1); fogPixel(2u, int(in0.y), 0, c); res = uvec4(c);`, inputs, cs.length, states, null);
  const bad: string[] = [];
  cs.forEach((c: any, i: number) => { const got = [out[i * 4], out[i * 4 + 1], out[i * 4 + 2]]; if (got.join() !== c.result.join()) bad.push(`${JSON.stringify(c)} got ${got}`); });
  await report("linear perspective fog", bad, cs.length);
}

// ---- scenes through the whole GPU pipeline: coverage, color plane, depth plane, copy formats
const be = new GxGl(gl);
function scene(verts: number[][], extra?: (w: FifoWriter) => void): { color: Uint32Array; depth: Uint32Array } {
  const w = basicScene();
  extra?.(w);
  w.draw(2, 0, 3, colorVertices(verts.map((p) => ({ x: p[0], y: p[1], z: p[2] ?? -100, rgba: p[3] !== undefined ? [p[3], p[4], p[5], 255] : [255, 255, 255, 255] }))));
  be.reset();
  be.drawing = true;
  const dff = { version: 4, bp: new Uint32Array(256), cp: new Uint32Array(256), xfMem: new Uint32Array(0x1000), xfRegs: new Uint32Array(0x60), texMem: new Uint8Array(0), frames: [] };
  const gpu = new GxGpu(be, dff, null);
  gpu.runFrame({ fifo: w.bytes(), updates: [] });
  be.flush();
  return be.readEfb();
}
{
  const cov = await J("coverage");
  const bad: string[] = [];
  for (const c of cov) {
    const efb = scene(c.vertices.map((p: number[]) => [p[0], p[1]]));
    const got: Record<string, number[]> = {};
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) if (efb.color[y * 640 + x] !== 0) (got[y] ??= []).push(x);
    if (JSON.stringify(got) !== JSON.stringify(c.coveredPixelsByRow)) bad.push(JSON.stringify(c.vertices));
  }
  await report("coverage", bad, cov.length);
  const cp = await J("color-plane");
  const efb = scene(cp.vertices.map((p: any) => [p[0], p[1], -100, ...p[2]]));
  const bad2: string[] = [];
  for (const c of cp.cases) {
    const w = efb.color[c.pixel[1] * 640 + c.pixel[0]];
    const got = [(w >> 16) & 255, (w >> 8) & 255, w & 255];
    if (got.join() !== c.rgb.join()) bad2.push(`${JSON.stringify(c)} got ${got}`);
  }
  await report("color plane", bad2, cp.cases.length);
  const dp = await J("depth-plane");
  const efb2 = scene([[10, 10, -100], [50, 12, -400], [20, 52, -700]], (w) => w.bp(0x40, 0x1f));
  const bad3: string[] = [];
  for (const c of dp.cases) { const got = efb2.depth[c.pixel[1] * 640 + c.pixel[0]]; if (got !== c.depth) bad3.push(`${JSON.stringify(c)} got ${got}`); }
  await report("depth plane", bad3, dp.cases.length);
}
{
  const v = await J("efb-copy");
  const CF: Record<string, [number, boolean]> = { I4: [0, true], I8: [1, true], IA4: [2, true], IA8: [3, true], RGB565: [4, false], RGB5A3: [5, false], RGBA8: [6, false], R4: [0, false], RA4: [2, false], RA8: [3, false], A8: [7, false], R8: [8, false], G8: [9, false], B8: [10, false], RG8: [11, false], GB8: [12, false] };
  const bad: string[] = [];
  for (const c of v.cases) {
    be.reset();
    const regs = new GxRegs();
    const mem = new Memory();
    // the pattern sits at (srcX, srcY) of the EFB: draw it with a copy from a prepared EFB: upload it through the backend's test hook
    const color = new Uint32Array(640 * 528), depth = new Uint32Array(640 * 528);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) color[(y + c.srcY) * 640 + x + c.srcX] = parseInt(v.pattern[y * 32 + x], 16);
    be.writeEfb(color, depth);
    const [cf, inten] = CF[c.format];
    const tp = cf < 8 ? cf * 2 : (cf - 8) * 2 + 1;
    regs.bp[0x49] = c.srcX | (c.srcY << 10); regs.bp[0x4a] = (c.width - 1) | ((c.height - 1) << 10);
    regs.bp[0x4b] = 0x1000 >> 5; regs.bp[0x4d] = c.strideBlocks32;
    regs.bp[0x52] = (tp << 3) | (c.halfSize ? 1 << 9 : 0) | (inten ? 1 << 15 : 0);
    be.copy(regs, mem, 0);
    const want = hex(c.bytes);
    const got = be.readMem(0x1000, want.length);
    if (got.join() !== want.join()) bad.push(`${c.format} half=${c.halfSize}`);
  }
  await report("efb copy formats", bad, v.cases.length);
}
await fetch("/done", { method: "POST", body: failures ? "failures" : "ok" });
