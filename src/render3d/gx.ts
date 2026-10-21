/* 3D replay viewer: the GameCube's fixed-function graphics as
 * the game's library (sysdolphin, HSD) sets them up, written out once so the
 * renderer's shaders and the tests share one account of it.
 *
 * - Lights: GX lights a vertex, not a pixel. Each light has an angle
 *   attenuation (a0 + a1 c + a2 c^2, c the cosine to its axis) and a distance
 *   attenuation (k0 + k1 d + k2 d^2); HSD derives them from a light's spot
 *   cutoff and reference brightness and distance. A lit material's color
 *   channel is the ambient light times the material's ambient plus every
 *   diffuse light, clamped to 1; a specular material has a second channel
 *   whose lights aim along the half-way vector.
 * - The texture environment (TEV): HSD builds a material's stages from its
 *   render mode and its textures' flags - the textures that change the
 *   diffuse color first, then the lighting, then the specular term with its
 *   own textures, then the textures laid on after lighting. `compileMaterial`
 *   turns a material into that list; `evalMaterial` runs it, as the fragment
 *   shader does.
 * - Texture coordinates, fog, mip levels.
 *
 * Written from the GX SDK's documented formulas and from what
 * the sysdolphin library does with them; no code from the game or from any
 * emulator is in it.
 */
import type { MObj, TObj } from "./hsd";

// ---------------------------------------------------------------- lights

/** a light's GX attenuation: angle (a0, a1, a2) then distance (k0, k1, k2) */
export type Attn = [number, number, number, number, number, number];

/** the angle attenuation of a spot light with this cutoff (degrees) and
 *  falloff (GX_SP_OFF, FLAT, COS, COS2, SHARP, RING1, RING2) */
export function spotAttn(cutoff: number, func: number): [number, number, number] {
  if (cutoff <= 0 || cutoff > 90) func = 0;
  const cr = Math.cos((cutoff * Math.PI) / 180);
  const d = (1 - cr) * (1 - cr);
  switch (func) {
    case 1: return [-1000 * cr, 1000, 0];
    case 2: return [-cr / (1 - cr), 1 / (1 - cr), 0];
    case 3: return [0, -cr / (1 - cr), 1 / (1 - cr)];
    case 4: return [(cr * (cr - 2)) / d, 2 / d, -1 / d];
    case 5: return [(-4 * cr) / d, (4 * (1 + cr)) / d, -4 / d];
    case 6: return [1 - (2 * cr * cr) / d, (4 * cr) / d, -2 / d];
    default: return [1, 0, 0];
  }
}

/** the distance attenuation of a light that is `refBright` as bright at
 *  `refDist` (GX_DA_OFF, GENTLE, MEDIUM, STEEP) */
export function distAttn(refDist: number, refBright: number, func: number): [number, number, number] {
  if (refDist < 0 || refBright <= 0 || refBright >= 1) func = 0;
  const r = (1 - refBright) / refBright;
  switch (func) {
    case 1: return [1, r / refDist, 0];
    case 2: return [1, (0.5 * r) / refDist, (0.5 * r) / (refDist * refDist)];
    case 3: return [1, 0, r / (refDist * refDist)];
    default: return [1, 0, 0];
  }
}

/** the attenuation of a specular light for a material this shiny */
export function specAttn(shininess: number): Attn {
  const k0 = shininess * 0.5;
  return [0, 0, 1, k0, 0, 1 - k0];
}

export const LOBJ = { INFINITE: 1, POINT: 2, SPOT: 3, DIFFUSE: 4, SPECULAR: 8, ALPHA: 0x10, HIDDEN: 0x20, RAW: 0x40 };

/** one light as the shaders take it: where it is (w 1) or which way it is
 *  from everything (w 0), its axis (toward the light), color, attenuation,
 *  and whether it lights the diffuse channel, the specular one or both */
export interface GxLight {
  pos: [number, number, number, number];
  axis: [number, number, number];
  color: [number, number, number, number];
  attn: Attn;
  diffuse: boolean;
  specular: boolean;
}

type V3 = [number, number, number] | number[];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): number[] => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** the direction to a light from a point, and how far it is (0 for a light
 *  infinitely far) */
function toLight(l: GxLight, p: V3): { ld: number[]; dist: number } {
  if (l.pos[3] === 0) return { ld: norm(l.pos), dist: 0 };
  const v = [l.pos[0] - p[0], l.pos[1] - p[1], l.pos[2] - p[2]];
  const dist = Math.hypot(v[0], v[1], v[2]) || 1e-6;
  return { ld: [v[0] / dist, v[1] / dist, v[2] / dist], dist };
}

/** the diffuse color channel at a vertex (the shader's, in JS): position
 *  and normal in world space, the ambient light and the material's ambient */
export function diffuseChannel(lights: GxLight[], ambient: V3, matAmbient: V3, p: V3, n: V3): number[] {
  const N = norm(n);
  const out = [ambient[0] * matAmbient[0], ambient[1] * matAmbient[1], ambient[2] * matAmbient[2]];
  for (const l of lights) {
    if (!l.diffuse) continue;
    const { ld, dist } = toLight(l, p);
    const c = Math.max(dot(ld, l.axis), 0);
    const [a0, a1, a2, k0, k1, k2] = l.attn;
    const att = Math.max(a0 + a1 * c + a2 * c * c, 0) / Math.max(k0 + k1 * dist + k2 * dist * dist, 1e-6);
    const f = att * Math.max(dot(N, ld), 0);
    for (let i = 0; i < 3; i++) out[i] += l.color[i] * f;
  }
  return out.map((v) => Math.min(Math.max(v, 0), 1));
}

/** the specular channel at a vertex: each specular light aimed along the
 *  half-way vector between it and the eye, as seen from the model's joint */
export function specularChannel(lights: GxLight[], shininess: number, eye: V3, joint: V3, p: V3, n: V3): number[] {
  const N = norm(n);
  const cdir = norm([joint[0] - eye[0], joint[1] - eye[1], joint[2] - eye[2]]);
  const [, , , k0, , k2] = specAttn(shininess);
  const out = [0, 0, 0];
  for (const l of lights) {
    if (!l.specular) continue;
    // the light's own vector: from the light toward the scene
    const lv = l.pos[3] === 0 ? norm([-l.pos[0], -l.pos[1], -l.pos[2]])
      : norm([joint[0] - l.pos[0], joint[1] - l.pos[1], joint[2] - l.pos[2]]);
    const h = norm([-(lv[0] + cdir[0]), -(lv[1] + cdir[1]), -(lv[2] + cdir[2])]);
    const { ld } = toLight(l, p);
    const nl = dot(N, ld);
    const c = nl >= 0 ? Math.max(dot(N, h), 0) : 0;
    const att = (c * c) / Math.max(k0 + k2 * c * c, 1e-6);
    const f = att * Math.max(nl, 0);
    for (let i = 0; i < 3; i++) out[i] += l.color[i] * f;
  }
  return out.map((v) => Math.min(Math.max(v, 0), 1));
}

// ---------------------------------------------------------------- materials

export const RENDER = {
  CONSTANT: 1, VERTEX: 2, DIFFUSE: 4, SPECULAR: 8, XLU: 1 << 30, NO_ZUPDATE: 1 << 29, ZMODE_ALWAYS: 1 << 27,
  SHADOW: 1 << 26,
};
export const TEX = {
  COORD_MASK: 0xf, LIGHTMAP_DIFFUSE: 1 << 4, LIGHTMAP_SPECULAR: 1 << 5, LIGHTMAP_AMBIENT: 1 << 6,
  LIGHTMAP_EXT: 1 << 7, LIGHTMAP_SHADOW: 1 << 8, BUMP: 1 << 24,
};

/** how a texture's coordinates are made: a UV set, the reflection of the
 *  view-space normal, the highlight of the first infinite light, or where a
 *  point falls in a stage's mirror image (Fountain of Dreams' pond: the
 *  game's code turns that texture into a shadow-style projection) */
export const enum TexGen { UV0 = 0, UV1 = 1, REFLECTION = 2, HIGHLIGHT = 3, MIRROR = 4 }

/** one TEV step of a material: a texture laid on the color (and alpha)
 *  carried so far, in the part of the material it belongs to */
export interface MatStage {
  /** which of the material's textures (its sampler) */
  tex: number;
  /** TEX_COLORMAP_* (0..8) */
  colorMap: number;
  /** TEX_ALPHAMAP_* (0..7), or -1: a texture laid on a second time leaves the alpha alone */
  alphaMap: number;
  /** 0 the diffuse color (before lighting), 1 the specular color, 2 after
   *  lighting, 3 after everything (a shadow texture's modulation) */
  phase: 0 | 1 | 2 | 3;
}

/** a material, compiled: its lighting channel, its textures and its stages */
export interface MatProgram {
  /** the color channel (HSD's channel setup by the render mode's low bits):
   *  0 plain white, 1 the vertex color, 2 lit */
  channel: 0 | 1 | 2;
  /** the color it starts from is the channel's (RENDER_VERTEX), else the material's */
  vertexBase: boolean;
  /** its color is multiplied by the channel (RENDER_DIFFUSE) */
  lit: boolean;
  /** it has a specular term (RENDER_SPECULAR) */
  specular: boolean;
  /** the textures it samples (index into the material's texture list), at most 4 */
  textures: number[];
  /** how each sampled texture's coordinates are made */
  texGen: TexGen[];
  stages: MatStage[];
  /** the sampler of its emboss bump map (HSD's volatile emboss stages: the
   *  color plus the map, minus the map shifted toward the first diffuse
   *  light, both times the lit color), or -1 */
  bump: number;
}

/** HSD's TEV for a material: its textures in the order they are laid on.
 *  `tobjs` is the material's texture list; `skip` says which to leave out
 *  (images the game renders into at runtime). */
export function compileMaterial(mo: MObj, tobjs: TObj[], skip?: (t: TObj) => boolean,
                                mirror?: (t: TObj) => boolean): MatProgram {
  const mode = mo.renderMode;
  const low = mode & 7;
  const prog: MatProgram = {
    channel: low === RENDER.VERTEX ? 1 : low === RENDER.DIFFUSE ? 2 : 0,
    vertexBase: (mode & RENDER.VERTEX) !== 0,
    lit: (mode & RENDER.DIFFUSE) !== 0,
    specular: (mode & RENDER.SPECULAR) !== 0,
    textures: [], texGen: [], stages: [], bump: -1,
  };
  // the textures that get a sampler: shadow and toon textures are the
  // game's own additions, a bump map's emboss is left out
  const sampler = new Map<number, number>();
  const use = (i: number): number => {
    let s = sampler.get(i);
    if (s !== undefined) return s;
    if (prog.textures.length >= 4) return -1;
    const t = tobjs[i];
    const coord = t.flags & TEX.COORD_MASK;
    s = prog.textures.length;
    prog.textures.push(i);
    prog.texGen.push(mirror && mirror(t) ? TexGen.MIRROR : coord === 1 ? TexGen.REFLECTION : coord === 2 ? TexGen.HIGHLIGHT
      : t.src === 5 ? TexGen.UV1 : TexGen.UV0);
    sampler.set(i, s);
    return s;
  };
  const usable = (t: TObj) => {
    const coord = t.flags & TEX.COORD_MASK;
    return coord !== 3 && coord !== 4 && !(skip && skip(t));
  };
  let done = 0;
  const pass = (lightmap: number, phase: 0 | 1 | 2) => {
    tobjs.forEach((t, i) => {
      const lm = t.flags & (TEX.LIGHTMAP_DIFFUSE | TEX.LIGHTMAP_SPECULAR | TEX.LIGHTMAP_AMBIENT | TEX.LIGHTMAP_EXT);
      if (!(lm & lightmap) || !usable(t)) return;
      const s = use(i);
      if (s < 0) return;
      // a texture laid on in an earlier part leaves the alpha as it is
      const again = (done & lm) !== 0;
      prog.stages.push({ tex: s, colorMap: (t.flags >> 16) & 0xf, alphaMap: again ? -1 : (t.flags >> 20) & 0xf, phase });
    });
  };
  pass(TEX.LIGHTMAP_DIFFUSE | TEX.LIGHTMAP_AMBIENT, 0);
  done |= TEX.LIGHTMAP_DIFFUSE | TEX.LIGHTMAP_AMBIENT;
  if (prog.specular) {
    pass(TEX.LIGHTMAP_SPECULAR, 1);
    done |= TEX.LIGHTMAP_SPECULAR;
  }
  pass(TEX.LIGHTMAP_EXT, 2);
  // a bump map's emboss (one at most)
  const bi = tobjs.findIndex((t) => (t.flags & TEX.BUMP) !== 0 && usable(t));
  if (bi >= 0) prog.bump = use(bi);
  // a texture the game turned into a shadow texture after the material was
  // compiled keeps its stage above and modulates the color at the very end
  // (HSD's volatile shadow stage)
  if (mirror) tobjs.forEach((t, i) => {
    if (!mirror(t)) return;
    const s = use(i);
    if (s >= 0) prog.stages.push({ tex: s, colorMap: 4, alphaMap: -1, phase: 3 });
  });
  return prog;
}

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** a texture's color map laid on the color so far (TObjMakeTExp) */
export function colorMap(op: number, c: number[], t: number[], blend: number): number[] {
  return [0, 1, 2].map((i) => {
    switch (op) {
      case 1: return clamp01(mix(c[i], t[i], t[3])); // alpha mask
      case 2: return clamp01(mix(c[i], t[i], t[i])); // RGB mask
      case 3: return clamp01(mix(c[i], t[i], blend)); // blend
      case 4: return clamp01(c[i] * t[i]); // modulate
      case 5: return clamp01(t[i]); // replace
      case 7: return clamp01(c[i] + t[i]); // add
      case 8: return clamp01(c[i] - t[i]); // subtract
      default: return c[i]; // none, pass
    }
  });
}

/** a texture's alpha map laid on the alpha so far */
export function alphaMap(op: number, a: number, t: number, blend: number): number {
  switch (op) {
    case 1: return clamp01(mix(a, t, t)); // alpha mask
    case 2: return clamp01(mix(a, t, blend)); // blend
    case 3: return clamp01(a * t); // modulate
    case 4: return clamp01(t); // replace
    case 6: return clamp01(a + t); // add
    case 7: return clamp01(a - t); // subtract
    default: return a; // none, pass (and -1: left alone)
  }
}

/** what a material's TEV makes of its inputs (the fragment shader, in JS):
 *  its colors, each stage's texel (after its own TEV step) and blend, the
 *  two lighting channels */
export function evalMaterial(p: MatProgram, inp: {
  diffuse: number[]; alpha: number; specular: number[]; ras0: number[]; ras1: number[];
  texels: number[][]; blend: number[];
  /** the bump map's texel at its shifted coordinates */
  bumpShifted?: number[];
}): number[] {
  let c = p.vertexBase ? inp.ras0.slice(0, 3) : inp.diffuse.slice(0, 3);
  let a = p.vertexBase ? inp.ras0[3] : inp.alpha;
  const run = (phase: number, col: number[]): number[] => {
    for (const s of p.stages) {
      if (s.phase !== phase) continue;
      const t = inp.texels[s.tex], b = inp.blend[s.tex] ?? 1;
      col = colorMap(s.colorMap, col, t, b);
      if (s.alphaMap >= 0) a = alphaMap(s.alphaMap, a, t[3], b);
    }
    return col;
  };
  c = run(0, c);
  if (p.lit) { c = c.map((v, i) => clamp01(v * inp.ras0[i])); a = clamp01(a * inp.ras0[3]); }
  if (p.specular) {
    let s = run(1, inp.specular.slice(0, 3));
    s = s.map((v, i) => clamp01(v * inp.ras1[i]));
    c = c.map((v, i) => clamp01(v + s[i]));
  }
  c = run(2, c);
  if (p.bump >= 0 && inp.bumpShifted) {
    // (the first emboss stage is not clamped, the second is)
    const t = inp.texels[p.bump], u = inp.bumpShifted;
    c = c.map((v, i) => clamp01(v + t[i] * inp.ras0[i] - u[i] * inp.ras0[i]));
  }
  for (const s of p.stages) if (s.phase === 3) c = colorMap(s.colorMap, c, inp.texels[s.tex], 1);
  return [...c, a];
}

/** a texture's own TEV step (HSD_TObjTevDesc) on its texel: inputs a..d per
 *  channel (GX_CC_*, GX_CA_*, or the TOBJ_TEV_* picks of its konst, tev0 and
 *  tev1 colors), d + lerp(a, b, c) or d - lerp(..), biased, scaled, clamped */
export function tevDescStep(desc: {
  colorOp: number; alphaOp: number; colorBias: number; alphaBias: number; colorScale: number; alphaScale: number;
  colorClamp: number; alphaClamp: number; colorIn: number[]; alphaIn: number[]; active: number;
}, konst: number[], tev0: number[], tev1: number[], t: number[]): number[] {
  const cIn = (code: number): number[] => {
    switch (code) {
      case 8: return t.slice(0, 3);
      case 9: return [t[3], t[3], t[3]];
      case 12: return [1, 1, 1];
      case 13: return [0.5, 0.5, 0.5];
      case 0x80: return konst.slice(0, 3);
      case 0x81: return [konst[0], konst[0], konst[0]];
      case 0x82: return [konst[1], konst[1], konst[1]];
      case 0x83: return [konst[2], konst[2], konst[2]];
      case 0x84: return [konst[3], konst[3], konst[3]];
      case 0x85: return tev0.slice(0, 3);
      case 0x86: return [tev0[3], tev0[3], tev0[3]];
      case 0x87: return tev1.slice(0, 3);
      case 0x88: return [tev1[3], tev1[3], tev1[3]];
      default: return [0, 0, 0];
    }
  };
  const aIn = (code: number): number => {
    switch (code) {
      case 4: return t[3];
      case 0x40: return konst[0];
      case 0x41: return konst[1];
      case 0x42: return konst[2];
      case 0x43: return konst[3];
      case 0x44: return tev0[3];
      case 0x45: return tev1[3];
      default: return 0;
    }
  };
  const step = (a: number, b: number, c: number, d: number, op: number, bias: number, scale: number, clamp: number) => {
    let v = op === 1 ? d - mix(a, b, c) : d + mix(a, b, c);
    v += bias === 1 ? 0.5 : bias === 2 ? -0.5 : 0;
    v *= scale === 1 ? 2 : scale === 2 ? 4 : scale === 3 ? 0.5 : 1;
    return clamp ? clamp01(v) : v;
  };
  const out = t.slice();
  if (desc.active & 0x40000000) {
    const [a, b, c, d] = desc.colorIn.map(cIn);
    for (let i = 0; i < 3; i++) out[i] = step(a[i], b[i], c[i], d[i], desc.colorOp, desc.colorBias, desc.colorScale, desc.colorClamp);
  }
  if (desc.active & 0x80000000) {
    const [a, b, c, d] = desc.alphaIn.map(aIn);
    out[3] = step(a, b, c, d, desc.alphaOp, desc.alphaBias, desc.alphaScale, desc.alphaClamp);
  }
  return out;
}

// ---------------------------------------------------------------- the pixel engine

/** GX's alpha test: two comparisons (GX_NEVER .. GX_ALWAYS) against their
 *  references (0..255) joined by GX_AOP_AND, OR, XOR or XNOR */
export function alphaTest(a255: number, comp0: number, ref0: number, op: number, comp1: number, ref1: number): boolean {
  const cmp = (f: number, r: number) => [false, a255 < r, a255 === r, a255 <= r, a255 > r, a255 !== r, a255 >= r, true][f] ?? true;
  const p = cmp(comp0, ref0), q = cmp(comp1, ref1);
  return op === 0 ? p && q : op === 1 ? p || q : op === 2 ? p !== q : p === q;
}

/** the alpha test HSD sets for a material without a pixel-engine
 *  description: see-through ones that write depth drop what is fully clear,
 *  the rest keep everything. [comp0, ref0, op, comp1, ref1] */
export function defaultAlphaTest(renderMode: number): [number, number, number, number, number] {
  if (!(renderMode & RENDER.NO_ZUPDATE) && renderMode & RENDER.XLU) return [4, 0, 0, 4, 0];
  return [7, 0, 0, 7, 0];
}

// ---------------------------------------------------------------- fog

/** how much of the fog color a point at eye depth `z` takes (GX_FOG_*:
 *  0 none, 2 linear, 4 exp, 5 exp2, 6 reverse exp, 7 reverse exp2; the
 *  orthographic kinds as the perspective ones) */
export function fogAmount(type: number, start: number, end: number, z: number): number {
  const t = type & 7;
  if (t === 0 || end === start) return 0;
  const f = Math.max((z - start) / (end - start), 0);
  switch (t) {
    case 2: return clamp01(f);
    case 4: return clamp01(1 - Math.pow(2, -8 * f));
    case 5: return clamp01(1 - Math.pow(2, -8 * f * f));
    case 6: return clamp01(Math.pow(2, -8 * (1 - f)));
    case 7: return clamp01(Math.pow(2, -8 * (1 - f) * (1 - f)));
    default: return 0;
  }
}

// ---------------------------------------------------------------- textures

/** a GX texture format's block size (width, height, bytes) */
export function blockOf(format: number): [number, number, number] {
  switch (format) {
    case 0: case 8: return [8, 8, 32]; // I4, C4
    case 1: case 2: case 9: return [8, 4, 32]; // I8, IA4, C8
    case 3: case 4: case 5: case 10: return [4, 4, 32]; // IA8, RGB565, RGB5A3, C14X2
    case 6: return [4, 4, 64]; // RGBA8
    case 14: return [8, 8, 32]; // CMPR
    default: return [4, 4, 32];
  }
}

/** a mip-mapped image's levels: size and where each starts after the first
 *  (each level is whole blocks, one after the other) */
export function mipLevels(width: number, height: number, format: number, maxLod: number): { w: number; h: number; at: number }[] {
  const [bw, bh, bytes] = blockOf(format);
  const out: { w: number; h: number; at: number }[] = [];
  let w = width, h = height, at = 0;
  for (let lv = 0; lv <= Math.max(0, Math.floor(maxLod)); lv++) {
    out.push({ w, h, at });
    at += Math.ceil(w / bw) * Math.ceil(h / bh) * bytes;
    if (w === 1 && h === 1) break;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return out;
}

/** the minification filter HSD sets: the texture's LOD one (GX_NEAR ..
 *  GX_LIN_MIP_LIN; LIN_MIP_LIN without an LOD description), trilinear turned
 *  bilinear for color-indexed images, the mip part dropped without levels */
export function minFilter(lodFilter: number | null, mipmap: boolean, format: number): number {
  let f = lodFilter ?? 5;
  if ((format === 8 || format === 9 || format === 10) && f === 5) f = 3;
  if (!mipmap) f &= 1;
  return f;
}

/** a scalar the texture environment takes as a constant (a texture's
 *  blending, HSD_TE_X F32): as the TEV's registers hold it, 255 times the
 *  value cut to a whole number and kept to 0..255 (HSD_TExpSetReg) */
export function tevScalar(v: number): number {
  return Math.min(255, Math.max(0, Math.trunc(255 * Math.fround(v)))) / 255;
}

/** HSD's texture matrix (MakeTextureMtx: scale by repeat over scale, turn
 *  by the rotation, move by minus the translation) as three rows of four */
export function textureMatrix(tr: number[], sc: number[], rot: number[], repS: number, repT: number, wrapT: number): number[] {
  const su = Math.abs(sc[0]) < 1e-10 ? 0 : (repS || 1) / sc[0];
  const sv = Math.abs(sc[1]) < 1e-10 ? 0 : (repT || 1) / sc[1];
  const sz = sc[2] ?? 1;
  const tx = -tr[0], ty = -(tr[1] + (wrapT === 2 && sv ? 1 / sv : 0)), tz = tr[2] ?? 0;
  // HSD_MkRotationMtx: Rz(-rz) Ry(ry) Rx(rx), from the TObj's rotation
  const [rx, ry, rz] = [rot[0] ?? 0, rot[1] ?? 0, -(rot[2] ?? 0)];
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz_ = Math.sin(rz);
  const R = [
    [cy * cz, sx * sy * cz - cx * sz_, cx * sy * cz + sx * sz_],
    [cy * sz_, sx * sy * sz_ + cx * cz, cx * sy * sz_ - sx * cz],
    [-sy, sx * cy, cx * cy],
  ];
  const S = [su, sv, sz], T = [tx, ty, tz];
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    const row = R[r].map((v) => v * S[r]);
    out.push(row[0], row[1], row[2], row[0] * T[0] + row[1] * T[1] + row[2] * T[2]);
  }
  return out;
}

/** GX fog as a stage sets it: its kind (GX_FOG_*), where it starts and ends
 *  (eye depth) and its color */
export interface Fog { type: number; start: number; end: number; color: [number, number, number] }
