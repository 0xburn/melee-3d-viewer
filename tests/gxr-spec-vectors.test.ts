// The raster spec's test vectors (spec/vectors/*.json) against the CPU reference.
import nodeTest from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basicScene, colorVertices, FifoWriter } from "../src/render3d/gxr/encode.ts";
import { EFB_W, Efb, fogPixel, fogShape, readColor } from "../src/render3d/gxr/raster.ts";
import { copyParams, encodeCopy } from "../src/render3d/gxr/copy.ts";
import { fetchTexel, sample, TexData } from "../src/render3d/gxr/texunit.ts";
import { blend, tevRegular } from "../src/render3d/gxr/tev.ts";
import { bitsOf, f, fromBits, trunc32 } from "../src/render3d/gxr/f32.ts";
import { hex, runStream, toHex } from "./gxr/scene.ts";

// the spec's vector files: the folder is named by GX_SPEC_VECTORS (the tests skip without it)
const DIR = Deno.env.get("GX_SPEC_VECTORS");
const have = !!DIR;
const V = (n: string) => JSON.parse(readFileSync(`${DIR}/${n}.json`, "utf8"));
const test = have ? nodeTest : (name: string, ...rest: unknown[]) => nodeTest(name, { skip: "GX_SPEC_VECTORS is not set" }, ...(rest.slice(-1) as [() => void]));

function texData(img: Uint8Array, pal?: Uint8Array): TexData {
  return { byte: (i) => img[i] ?? 0, pal: (i) => (pal ? (pal[i * 2] << 8) | pal[i * 2 + 1] : 0) };
}

test("texel decode", () => {
  for (const c of V("texel-decode")) {
    const d = texData(hex(c.image), c.tlut ? hex(c.tlut) : undefined);
    for (const t of c.texels) {
      const out = [0, 0, 0, 0];
      fetchTexel(c.format, d, 0, c.width - 1, t.s, t.t, c.tlutFormat ?? 0, out);
      assert.deepEqual(out, t.rgba, `${c.name} pal ${c.tlutFormat} at ${t.s},${t.t}`);
    }
  }
});

test("cmpr blocks", () => {
  for (const c of V("cmpr-blocks")) {
    const d = texData(hex(c.subblock));
    for (const t of c.texels) {
      const out = [0, 0, 0, 0];
      fetchTexel(14, d, 0, 3, t.s, t.t, 0, out);
      assert.deepEqual(out, t.rgba, `${c.c1} ${c.c2} at ${t.s},${t.t}`);
    }
  }
});

test("sampling and wrap", () => {
  const v = V("sample");
  const img = hex(v.image);
  const WR: Record<string, number> = { clamp: 0, repeat: 1, mirror: 2 };
  for (const c of v.cases) {
    const m = { fmt: 6, W: 7, H: 7, wrapS: WR[c.wrap], wrapT: WR[c.wrap], pf: 0, data: texData(img), off: 0 };
    const out = [0, 0, 0, 0];
    sample(m, c.s, c.t, 0, c.linear, 0, out);
    assert.deepEqual(out, c.rgba, JSON.stringify(c));
  }
});

const SCALE: Record<string, number> = { x1: 0, x2: 1, x4: 2, "/2": 3 };
const BIAS: Record<string, number> = { "0": 0, "+128": 1, "-128": 2 };

test("tev color arithmetic", () => {
  for (const c of V("tev-color").cases) {
    for (let k = 0; k < 3; k++) {
      const r = tevRegular(false, c.a[k], c.b[k], c.c[k], c.d[k], BIAS[c.bias], c.op === "subtract" ? 1 : 0, SCALE[c.scale], c.clamp) & 255;
      assert.equal(r, c.result[k], JSON.stringify(c) + " comp " + k);
    }
  }
});

// The result alpha is what shows: the stored alpha (the clamp bit decides its range) saturated to 0..255 by the next stage's color combiner.
test("tev alpha arithmetic", () => {
  for (const c of V("tev-alpha").cases) {
    const r = Math.max(0, Math.min(255, tevRegular(true, c.a, c.b, c.c, c.d, BIAS[c.bias], c.op === "subtract" ? 1 : 0, SCALE[c.scale], c.clamp)));
    assert.equal(r, c.resultAlpha, JSON.stringify(c));
  }
});

const FACTOR: Record<string, number> = { zero: 0, one: 1, "dstcolor/srccolor": 2, "inv dstcolor/srccolor": 3, srcalpha: 4, "inv srcalpha": 5, dstalpha: 6, "inv dstalpha": 7 };

test("blend", () => {
  for (const c of V("blend").cases) {
    let mode = (1 << 3) | (1 << 4);
    if (c.blend === "add") mode |= 1 | (FACTOR[c.dstFactor] << 5) | (FACTOR[c.srcFactor] << 8);
    else if (c.blend === "subtract") mode |= 1 | (1 << 11);
    else mode |= 2 | (Number(c.blend.split(" ")[2]) << 12);
    const out = [0, 0, 0, 0];
    blend(mode, c.constantDstAlpha !== undefined && c.constantDstAlpha !== null ? 0x100 | c.constantDstAlpha : 0, c.srcRGBA, [...c.dstRGB, 255], out);
    assert.deepEqual(out.slice(0, 3), c.result, JSON.stringify(c));
  }
});

const CF: Record<string, [number, boolean]> = {
  I4: [0, true], I8: [1, true], IA4: [2, true], IA8: [3, true], RGB565: [4, false], RGB5A3: [5, false], RGBA8: [6, false], R4: [0, false],
  RA4: [2, false], RA8: [3, false], A8: [7, false], R8: [8, false], G8: [9, false], B8: [10, false], RG8: [11, false], GB8: [12, false],
};

test("efb copy formats", () => {
  const v = V("efb-copy");
  const efb = new Efb();
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) efb.color[(y + 2) * EFB_W + x + 3] = parseInt(v.pattern[y * 32 + x], 16);
  for (const c of v.cases) {
    const bp = new Uint32Array(256);
    const [cf, inten] = CF[c.format];
    const tp = cf < 8 ? cf * 2 : (cf - 8) * 2 + 1;
    bp[0x49] = c.srcX | (c.srcY << 10);
    bp[0x4a] = (c.width - 1) | ((c.height - 1) << 10);
    bp[0x4b] = 0; bp[0x4d] = c.strideBlocks32;
    bp[0x52] = (tp << 3) | (c.halfSize ? 1 << 9 : 0) | (inten ? 1 << 15 : 0);
    const mem = new Uint8Array(1 << 16);
    encodeCopy(efb, copyParams(bp), mem);
    const want = hex(c.bytes);
    assert.equal(toHex(mem.subarray(0, want.length)), c.bytes, `${c.format} half=${c.halfSize}`);
  }
});

test("log2 of deltas", () => {
  const log2fix = (d: number) => { const b = bitsOf(d); return ((b & 0x7f800000) >>> 19) - 2032 + ((b & 0x007fffff) >>> 19); };
  for (const c of V("lod-log2").cases) if (c.log2Fixed !== null) assert.equal(log2fix(f(c.delta)), c.log2Fixed, `${c.delta}`);
});

test("snap", () => {
  const snap = (v: number) => { const t = trunc32(v); return (f(v - t) >= 0.5 ? t + 1 : t) - 9; };
  for (const c of V("snap").cases) assert.equal(snap(f(16 * c.x)), c.snapped, `${c.x}`);
});

function tri(verts: number[][], extra?: (w: FifoWriter) => void) {
  const w = basicScene();
  extra?.(w);
  w.draw(2, 0, 3, colorVertices(verts.map((p) => ({ x: p[0], y: p[1], z: p[2] ?? -100, rgba: (p[3] !== undefined ? [p[3], p[4], p[5], 255] : [255, 255, 255, 255]) }))));
  return runStream(w).be.efb;
}

test("coverage", () => {
  for (const c of V("coverage")) {
    const efb = tri(c.vertices.map((p: number[]) => [p[0], p[1]]));
    const got: Record<string, number[]> = {};
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) if (efb.color[y * EFB_W + x] !== 0) (got[y] ??= []).push(x);
    assert.deepEqual(got, c.coveredPixelsByRow, JSON.stringify(c.vertices));
  }
});

test("color plane", () => {
  const v = V("color-plane");
  const efb = tri(v.vertices.map((p: any) => [p[0], p[1], -100, ...p[2]]));
  for (const c of v.cases) {
    const out = [0, 0, 0, 0];
    readColor(efb.color[c.pixel[1] * EFB_W + c.pixel[0]], 0, out);
    assert.deepEqual(out.slice(0, 3), c.rgb, JSON.stringify(c));
  }
});

test("depth plane", () => {
  const v = V("depth-plane");
  const efb = tri([[10, 10, -100], [50, 12, -400], [20, 52, -700]], (w) => w.bp(0x40, 0x1f));
  for (const c of v.cases) assert.equal(efb.depth[c.pixel[1] * EFB_W + c.pixel[0]], c.depth, JSON.stringify(c));
});

test("linear perspective fog", () => {
  const reg = (x: number) => { const b = bitsOf(x); return ((b >>> 31) << 19) | (((b >>> 23) & 255) << 11) | ((b >>> 12) & 0x7ff); };
  for (const c of V("fog-linear-perspective").cases) {
    const bp = new Uint32Array(256);
    bp[0xee] = reg(f(c.fogA)); bp[0xef] = c.fogBmagnitude; bp[0xf0] = c.fogBshift; bp[0xf1] = reg(f(c.fogC)) | (2 << 21);
    bp[0xf2] = (c.fogColor[0] << 16) | (c.fogColor[1] << 8) | c.fogColor[2];
    const px = [...c.baseColor, 255];
    fogPixel(bp, 2, c.depth24, px, 0, 320);
    assert.deepEqual(px.slice(0, 3), c.result, JSON.stringify(c));
  }
});

test("fog shapes (exponential forms)", () => {
  const bad: string[] = [];
  for (const c of V("fog-shapes").cases) {
    const fog = fromBits(parseInt(c.fogBits, 16));
    for (const [name, fsel] of [["exp", 4], ["exp2", 5], ["backwardExp", 6], ["backwardExp2", 7]] as [string, number][]) {
      const got = fogShape(fsel, fog);
      if (bitsOf(got) !== parseInt(c[name].bits, 16) || trunc32(f(got * 256)) !== c[name].level) bad.push(`${name} ${c.fogBits}`);
    }
  }
  if (bad.length) throw new Error(bad.slice(0, 5).join("; "));
});
