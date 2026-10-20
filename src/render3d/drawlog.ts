/* The 3D replay viewer: a log of every draw the renderer makes, in the
 * GameCube's own terms, to set beside the game's graphics commands as a
 * Dolphin FIFO recording holds them (decoded draw for draw by a separate
 * tool). Each mismatch between the two is then an exact difference: this
 * mesh's blend, that light's color, a texture the game samples and the
 * viewer does not.
 *
 * Debug only, and off unless asked for: nothing here runs, and the renderer
 * has no line of it, until attachDrawLog() wraps one renderer's draw
 * methods on that instance; detach() puts them back. Normal use never
 * attaches it (only an explicit call through the viewer's debug handle).
 *
 * What a draw says (a frame's records, in draw order), in the fields the
 * decoder writes for the game's:
 *
 *   kind      "mesh" (a model's mesh), "particles", "trail", "sphere";
 *             "depth" and "ghost" are the viewer's own passes, never the game's
 *   obj       the mesh's key (its model's tag, joint, mesh), joint, pass
 *   prims     [type, vertices, hash] per primitive of the mesh's display
 *             list, hashed over its bytes in the file (opcode, count, vertex
 *             data) as the game sends them; geo: over all of them
 *   mtx       { slot: 3 x 4 rows }: view times the mesh's matrix per slot
 *   proj      GX's six projection numbers (from the GL matrix) and its kind
 *   cull z blend cmask alpha_test fog lights   as the GL state was at the draw
 *   tex       per sampler: texture map, identity (gxHash of the image's
 *             bytes in its file), format, size, wrap, filters, LOD bias,
 *             palette identity, texture matrix
 *   shade     the material as the viewer compiled it (gx.ts compileMaterial)
 *   probe     the shading as a function: final color and alpha (0..255) for
 *             each of probes()' fixed inputs, through gx.ts evalMaterial,
 *             the model of the fragment shader
 */
import type { Archive, Image, PObj, Tlut } from "./hsd";
import type { Drawable, Skeleton, TexState } from "./skeleton";
import type { Renderer } from "./renderer";
import type { Fog, MatProgram } from "./gx";
import { RENDER, blockOf, evalMaterial, tevDescStep, textureMatrix } from "./gx";
import { SHADOW_SIZE } from "./shadow";
import type { Lighting } from "./lightset";
import type { Tint } from "./fx/colanim";
import { Mat, invert, mul } from "./math";

// ---------------------------------------------------------------- shared with the decoder

/** two 32-bit FNV-1a hashes (two bases) as 16 hex digits: the identity of a
 *  primitive or an image, the same on both sides */
export function gxHash(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5, h2 = 0x9747b28c;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ bytes[i], 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export interface Probe { t: number[][]; s: number[][]; v: number[][] }

/** the probe's fixed inputs: per probe, texels t[0..7], light sums s[0..1]
 *  and vertex colors v[0..1] (rgba, multiples of 1/255), from one LCG */
export function probes(count = 6): Probe[] {
  let x = 0x2545f491;
  const out: Probe[] = [];
  for (let p = 0; p < count; p++) {
    const q: number[][] = [];
    for (let k = 0; k < 12; k++) {
      const c: number[] = [];
      for (let i = 0; i < 4; i++) {
        x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
        c.push(((x >>> 8) % 256) / 255);
      }
      q.push(c);
    }
    out.push({ t: q.slice(0, 8), s: q.slice(8, 10), v: q.slice(10, 12) });
  }
  return out;
}

const PRIM = ["quads", "quads2", "tris", "strip", "fan", "lines", "linestrip", "points"];
const COMP = [1, 1, 2, 2, 4];
const COLOR = [2, 3, 4, 2, 3, 4];

/** a vertex's bytes in a mesh's display list (HSD's attribute list) */
export function vertexSize(p: PObj): number {
  let n = 0;
  for (const t of p.attrs) {
    if (t.type === 2) { n += 1; continue; }
    if (t.type === 3) { n += 2; continue; }
    if (t.type !== 1) continue;
    const a = t.attr;
    if (a <= 8) n += 1;
    else if (a === 9) n += COMP[t.compType] * (t.cnt === 0 ? 2 : 3);
    else if (a === 10) n += COMP[t.compType] * 3;
    else if (a === 25) n += COMP[t.compType] * 9;
    else if (a === 11 || a === 12) n += COLOR[t.compType] ?? 4;
    else if (a >= 13 && a <= 20) n += COMP[t.compType] * (t.cnt === 0 ? 1 : 2);
  }
  return n;
}

/** a display list's primitives: [type, vertices, hash of its bytes] */
export function dlPrims(a: Archive, p: PObj): [string, number, string][] {
  const out: [string, number, string][] = [];
  const u8 = a.u8, vs = vertexSize(p);
  const end = Math.min(p.dlOff + p.dlSize, u8.length);
  let o = p.dlOff;
  while (o < end) {
    const op = u8[o];
    if (op === 0) { o++; continue; }
    if ((op & 0xc0) !== 0x80 || o + 3 > end) break;
    const count = (u8[o + 1] << 8) | u8[o + 2];
    const stop = o + 3 + count * vs;
    if (stop > end) break;
    out.push([PRIM[(op >> 3) & 7], count, gxHash(u8.subarray(o, stop))]);
    o = stop;
  }
  return out;
}

/** a mesh's identity: gxHash over its primitives' hashes, joined (the decoder's geo_hash) */
export function geoHash(prims: [string, number, string][]): string {
  return gxHash(new TextEncoder().encode(prims.map((x) => x[2]).join("")));
}

const TLUT_ENTRIES: Record<number, number> = { 8: 16, 9: 256, 10: 16384 };

/** an image's identity: its first level's bytes in its file */
export function imageId(a: Archive, img: Image): string | null {
  const [bw, bh, bb] = blockOf(img.format);
  const size = Math.ceil(img.width / bw) * Math.ceil(img.height / bh) * bb;
  if (img.dataOff + size > a.u8.length) return null;
  return gxHash(a.u8.subarray(img.dataOff, img.dataOff + size));
}

/** a palette's identity: as many entries as the game loads (whole 16s) and the format reads */
export function tlutId(a: Archive, t: Tlut, format: number): string | null {
  const need = TLUT_ENTRIES[format] ?? 256;
  const n = Math.min(Math.ceil(t.count / 16) * 16, need) * 2;
  if (t.dataOff + n > a.u8.length) return null;
  return gxHash(a.u8.subarray(t.dataOff, t.dataOff + n));
}

// ---------------------------------------------------------------- GL state in GX's names

const GL_COMPARE: Record<number, string> = {
  0x200: "never", 0x201: "less", 0x202: "equal", 0x203: "lequal", 0x204: "greater", 0x205: "nequal", 0x206: "gequal", 0x207: "always",
};
const GL_SRC: Record<number, string> = {
  0: "zero", 1: "one", 0x306: "dstclr", 0x307: "invdstclr", 0x302: "srcalpha", 0x303: "invsrcalpha", 0x304: "dstalpha", 0x305: "invdstalpha",
};
const GL_DST: Record<number, string> = {
  0: "zero", 1: "one", 0x300: "srcclr", 0x301: "invsrcclr", 0x302: "srcalpha", 0x303: "invsrcalpha", 0x304: "dstalpha", 0x305: "invdstalpha",
};
const COMPARE = ["never", "less", "equal", "lequal", "greater", "nequal", "gequal", "always"];
const ALPHA_OP = ["and", "or", "xor", "xnor"];
const WRAP = ["clamp", "repeat", "mirror"];
const MIN = ["near", "linear", "near_mip_near", "linear_mip_near", "near_mip_linear", "linear_mip_linear"];
const FOG_TYPE: Record<number, string> = { 0: "none", 2: "linear", 4: "exp", 5: "exp2", 6: "revexp", 7: "revexp2" };
const TEXGEN = ["uv0", "uv1", "reflection", "highlight", "mirror"];

/** a number kept to 6 significant digits (the logs compare with tolerances) */
export function rnd(x: number, digits = 6): number {
  if (x === 0 || !Number.isFinite(x)) return 0;
  return Number(x.toPrecision(digits));
}

/** GX's projection numbers from a GL projection (column major): GX keeps
 *  depth in [-1, 0] where GL has [-1, 1], so its third row is half of GL's
 *  third minus its fourth */
export function gxProjection(p: ArrayLike<number>): (number | string)[] {
  const persp = p[11] === -1;
  const z0 = (p[10] - p[11]) / 2, z1 = (p[14] - p[15]) / 2;
  const nums = persp ? [p[0], p[8], p[5], p[9], z0, z1] : [p[0], p[12], p[5], p[13], z0, z1];
  return [...nums.map((v) => rnd(v)), persp ? "persp" : "ortho"];
}

/** rows 0..2 of a column-major 4 x 4 */
function rows3(m: ArrayLike<number>, o = 0): number[][] {
  return [0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => rnd(m[o + c * 4 + r])));
}

// ---------------------------------------------------------------- the renderer, as the log reads it

/** what of the renderer the log reads (its own fields: the log has no line in it) */
interface Inner {
  gl: WebGL2RenderingContext;
  draws: number;
  cs: { cull: number; blend: number; src: number; dst: number; eq: number; dmask: number; dfunc: number; cmask: number };
  camView: Mat; camVP: Mat; shiftView: Mat; shiftVP: Mat; shifted: boolean;
  mirrored: boolean;
  lighting: Lighting | null;
  overlayVP: Mat | null; viewProj: Mat;
  shadowMaps: { mtx: Mat }[];
  staticsOf(s: Drawable["state"]): { p: MatProgram; I: Int32Array; F: Float32Array };
}

/** the renderer's fields and methods the log reads or wraps (a test checks they are still there) */
export const RENDERER_NAMES = ["draws", "cs", "camView", "camVP", "shiftView", "shiftVP", "shifted", "mirrored", "lighting",
                               "overlayVP", "viewProj", "shadowMaps", "staticsOf", "begin", "setFog", "setTint", "beginShadow",
                               "endShadow", "drawOne",
                               "drawGeometry", "drawParticles", "drawTrail", "drawSphere"] as const;

export interface FrameLog { frame: number | string | null; draws: Record<string, unknown>[] }

export class DrawLog {
  frames: FrameLog[] = [];
  label: number | string | null = null;
  /** at most this many frames are kept (the oldest go) */
  limit = 600;
  private cur: FrameLog | null = null;
  private fog: Fog | null = null;
  /** the fighter's color animation the draws are made with (setTint) */
  private tint: Tint | null = null;
  /** a shadow being made: the stage's shadow intensity it is drawn in (beginShadow), else null */
  private cast: number | null = null;
  private inputs = probes();
  private prims = new WeakMap<PObj, [string, number, string][]>();
  private images = new WeakMap<Image, string | null>();
  private restore: (() => void) | null = null;

  constructor(private r: Renderer) {}

  private get inner(): Inner { return this.r as unknown as Inner; }

  /** wrap the renderer's draw methods on this instance */
  attach() {
    if (this.restore) return;
    const r = this.r as unknown as Record<string, (...a: unknown[]) => unknown>;
    const saved: [string, unknown][] = [];
    const wrap = (name: string, after: (args: unknown[], drew: boolean) => void) => {
      const own = Object.prototype.hasOwnProperty.call(r, name) ? r[name] : undefined;
      const orig = r[name];
      saved.push([name, own]);
      const log = this;
      r[name] = function (this: unknown, ...args: unknown[]) {
        const before = log.inner.draws;
        const out = orig.apply(this, args);
        try { after(args, log.inner.draws > before); } catch (e) { log.note(String(e)); }
        return out;
      };
    };
    wrap("begin", () => this.newFrame());
    wrap("setFog", (a) => { this.fog = (a[0] as Fog | null) ?? null; });
    wrap("setTint", (a) => { this.tint = (a[0] as Tint | null) ?? null; });
    wrap("beginShadow", (a) => { this.cast = a[3] as number; });  // (the stage's intensity, 0..255)
    wrap("endShadow", () => { this.cast = null; });
    wrap("drawOne", (a, drew) => { if (drew) this.mesh(a[0] as Drawable, a[1] !== null, a[2] as Skeleton | null); });
    wrap("drawGeometry", (a, drew) => { if (drew) this.add({ kind: "depth", obj: (a[0] as Drawable).key }); });
    wrap("drawParticles", (a) => this.particles(a[0] as Float32Array, a[1] as Batch[]));
    // (the trail and the sphere set GL themselves: their state is drawTrail's and drawSphere's own)
    wrap("drawTrail", (a, drew) => {
      if (drew) this.add({ kind: "trail", verts: (a[0] as Float32Array).length / 7, z: { test: true, func: "lequal", write: false },
                           blend: { on: true, src: "srcalpha", dst: "invsrcalpha", sub: false, logic: null } });
    });
    wrap("drawSphere", (a) => this.add({ kind: "sphere", center: (a[0] as number[]).map((v) => rnd(v)), radius: rnd(a[1] as number),
                                          color: (a[2] as number[]).map((v) => rnd(v)), alpha: rnd(a[3] as number) }));
    this.restore = () => {
      for (const [name, own] of saved) {
        if (own === undefined) delete r[name];
        else r[name] = own as (...a: unknown[]) => unknown;
      }
    };
  }

  detach() {
    this.restore?.();
    this.restore = null;
  }

  get attached(): boolean { return this.restore !== null; }

  /** the frames logged since the last take, and a fresh start */
  take(): FrameLog[] {
    const out = this.frames;
    this.frames = [];
    this.cur = null;
    return out;
  }

  private note(msg: string) {
    this.add({ kind: "error", msg });
  }

  private newFrame() {
    this.cur = { frame: this.label, draws: [] };
    this.frames.push(this.cur);
    if (this.frames.length > this.limit) this.frames.shift();
  }

  private add(rec: Record<string, unknown>) {
    if (!this.cur) this.newFrame();
    rec.i = this.cur!.draws.length;
    this.cur!.draws.push(rec);
  }

  /** the camera of the draw being made: view and GX projection */
  private camera(): { view: Mat; proj: (number | string)[] } {
    const s = this.inner;
    const view = s.shifted ? s.shiftView : s.camView, vp = s.shifted ? s.shiftVP : s.camVP;
    const proj = mul(new Float32Array(16), vp, invert(new Float32Array(16), view));
    return { view, proj: gxProjection(proj) };
  }

  /** the pixel engine as GL has it now */
  private pe(): Record<string, unknown> {
    const s = this.inner, c = s.cs, gl = s.gl;
    const blendOn = c.blend === 1;
    return {
      z: { test: true, func: GL_COMPARE[c.dfunc] ?? String(c.dfunc), write: c.dmask === 1 },
      blend: { on: blendOn, src: blendOn ? GL_SRC[c.src] ?? String(c.src) : null, dst: blendOn ? GL_DST[c.dst] ?? String(c.dst) : null,
               sub: blendOn && c.eq === gl.FUNC_REVERSE_SUBTRACT, logic: null },
      cmask: { color: c.cmask !== 0, alpha: c.cmask !== 0 },
    };
  }

  private mesh(d: Drawable, ghost: boolean, sk: Skeleton | null) {
    const s = this.inner;
    const st = s.staticsOf(d.state), p = st.p;
    const { view, proj } = this.camera();
    let prims = this.prims.get(d.pobj);
    if (!prims) this.prims.set(d.pobj, (prims = dlPrims(d.archive, d.pobj)));
    const mtx: Record<string, number[][]> = {};
    const m = new Float32Array(16);
    for (let k = 0; k < d.nMats; k++) {
      mul(m, view, d.mats.subarray(k * 16, k * 16 + 16) as Mat);
      mtx[String(k)] = rows3(m);
    }
    const cull = d.pobj.flags & 0xc000;
    let cullName = cull === 0 ? "none" : cull === 0x8000 ? "back" : cull === 0x4000 ? "front" : "all";
    if (s.mirrored && (cullName === "back" || cullName === "front")) cullName = cullName === "back" ? "front" : "back";
    const I = st.I, F = st.F;
    const rec: Record<string, unknown> = {
      kind: ghost ? "ghost" : "mesh",
      obj: d.key, group: d.group?.tag ?? null, joint: d.jobj.index, pass: d.translucent ? "xlu" : "opa",
      prims, geo: geoHash(prims), indexed: true,
      verts: prims.reduce((n, x) => n + x[1], 0),
      mtx, proj, cull: cullName, ...this.pe(),
      alpha_test: [COMPARE[I[3] & 7], rnd(F[20]), ALPHA_OP[(I[3] >> 6) & 3], COMPARE[(I[3] >> 3) & 7], rnd(F[21])],
      fog: this.fogRec(),
      lights: this.lightsRec(view),
      tex: p.textures.map((ti, n) => this.texRec(d.archive, d.state.tex[ti], p.texGen[n])),
      shade: { channel: p.channel, vertexBase: p.vertexBase, lit: p.lit, specular: p.specular, bump: p.bump,
               stages: p.stages.map((x) => ({ tex: d.state.tex[p.textures[x.tex]]?.tobj.id ?? null, colorMap: x.colorMap,
                                              alphaMap: x.alphaMap, phase: x.phase })),
               diffuse: Array.from(d.state.override ?? d.state.diffuse).map((v) => rnd(v)), alpha: rnd(d.state.alpha),
               ambient: Array.from(d.state.ambient).map((v) => rnd(v)), spec: Array.from(d.state.specular).map((v) => rnd(v)) },
      probe: this.probe(d, p),
    };
    // (a shadow being made: the mesh in one flat gray, no texture, no depth, color only: HSD_ShadowStartRender)
    if (this.cast !== null) {
      const g = this.cast, gray = g / 255;
      Object.assign(rec, { kind: "mesh", tex: [], fog: null, lights: [], alpha_test: ["always", 0, "and", "always", 0],
                           z: { test: false, func: "always", write: false }, cmask: { color: true, alpha: false },
                           blend: { on: false, src: null, dst: null, sub: false, logic: null },
                           shade: { channel: 0, vertexBase: false, lit: false, specular: false, bump: -1, stages: [],
                                    diffuse: [gray, gray, gray, 1], alpha: 1, ambient: [0, 0, 0, 1], spec: [0, 0, 0, 1] },
                           probe: this.inputs.map(() => [g, g, g, 255]), shadow: "cast" });
      this.add(rec);
      return;
    }
    // (a material that takes the fighters' shadows: each one a texture after its own, sampled where the point
    // falls through the shadow's matrix, its color times the texel)
    const nShadow = d.state.mobj.renderMode & RENDER.SHADOW ? s.shadowMaps.length : 0;
    for (let k = 0; k < nShadow; k++) {
      const m = s.shadowMaps[k].mtx;
      (rec.tex as Record<string, unknown>[]).push({
        map: p.textures.length + k, id: "efb:shadow", format: 0, w: SHADOW_SIZE, h: SHADOW_SIZE, wrap: ["clamp", "clamp"],
        mag: "near", min: "linear", lod_bias: 0, texgen: "shadow",
        mtx: [0, 1].map((r) => [m[r], m[4 + r], m[8 + r], m[12 + r]].map((v) => rnd(v))) });
    }
    if (nShadow && Array.isArray(rec.probe)) {
      rec.probe = (rec.probe as number[][]).map((v, n) => {
        const out = v.slice();
        for (let k = 0; k < nShadow; k++) {
          const tx = this.inputs[n].t[(p.textures.length + k) & 7];
          for (let i = 0; i < 3; i++) out[i] = Math.round(Math.min(Math.max(out[i] / 255 * tx[i], 0), 1) * 255);
        }
        return out;
      });
    }
    // (a fighter's color animation: its color is in the probe, blended over last as the shader does)
    const t = this.tint;
    if (t && (t.color || t.light)) {
      rec.tint = { color: t.color ? t.color.map((v) => rnd(v)) : null,
                   light: t.light ? { rgb: t.light.rgb.map((v) => rnd(v)), a: rnd(t.light.a), adds: t.light.adds } : null };
    }
    if (sk && (sk as unknown as { pointSize?: number }).pointSize) rec.point = (sk as unknown as { pointSize: number }).pointSize;
    this.add(rec);
  }

  private fogRec(): Record<string, unknown> | null {
    const f = this.fog;
    if (!f || !(f.type & 7)) return null;
    return { type: FOG_TYPE[f.type & 7] ?? String(f.type & 7), ortho: ((f.type >> 3) & 1) === 1, start: rnd(f.start), end: rnd(f.end),
             color: f.color.map((v) => Math.round(v * 255)) };
  }

  private lightsRec(view: Mat): Record<string, unknown>[] {
    const l = this.inner.lighting;
    if (!l) return [];
    const out: Record<string, unknown>[] = [];
    for (let k = 0; k < l.n; k++) {
      const P = l.pos.subarray(k * 4, k * 4 + 4), X = l.axis.subarray(k * 4, k * 4 + 4);
      const w = P[3];
      // (in view space, as the game loads its lights)
      const at = [0, 1, 2].map((r) => view[r] * P[0] + view[4 + r] * P[1] + view[8 + r] * P[2] + view[12 + r] * w);
      const ax = [0, 1, 2].map((r) => view[r] * X[0] + view[4 + r] * X[1] + view[8 + r] * X[2]);
      const flags = l.attnA[k * 4 + 3];
      out.push({ k, at: at.map((v) => rnd(v)), infinite: w === 0, axis: ax.map((v) => rnd(v)),
                 color: Array.from(l.color.subarray(k * 4, k * 4 + 4)).map((v) => Math.round(v * 255)),
                 cosatt: Array.from(l.attnA.subarray(k * 4, k * 4 + 3)).map((v) => rnd(v)),
                 distatt: Array.from(l.attnK.subarray(k * 4, k * 4 + 3)).map((v) => rnd(v)),
                 diffuse: (flags & 1) !== 0, specular: (flags & 2) !== 0 });
    }
    return out;
  }

  private texRec(a: Archive, t: TexState | undefined, gen: number): Record<string, unknown> {
    if (!t) return { id: null };
    const o = t.tobj;
    let id = this.images.get(t.image);
    if (id === undefined) this.images.set(t.image, (id = gen === 4 ? "mirror" : imageId(a, t.image)));
    const m = textureMatrix([t.translate[0], t.translate[1], o.translate[2]], [t.scale[0], t.scale[1], o.scale[2]],
                            [t.rotX, t.rotY, t.rotate], o.repeatS, o.repeatT, o.wrapT);
    const rec: Record<string, unknown> = {
      map: o.id, id, format: t.image.format, w: t.image.width, h: t.image.height,
      wrap: [WRAP[o.wrapS] ?? String(o.wrapS), WRAP[o.wrapT] ?? String(o.wrapT)],
      mag: o.magFilt ? "linear" : "near", min: o.lod ? MIN[o.lod.minFilt] ?? String(o.lod.minFilt) : null,
      lod_bias: o.lod ? rnd(o.lod.bias) : 0, texgen: TEXGEN[gen] ?? String(gen),
      mtx: [m.slice(0, 4), m.slice(4, 8)].map((r) => r.map((v) => rnd(v))), blending: rnd(t.blending),
    };
    if (t.tlut) rec.tlut = tlutId(a, t.tlut, t.image.format);
    return rec;
  }

  /** the material's output for each probe input, through evalMaterial */
  private probe(d: Drawable, p: MatProgram): number[][] | null {
    const s = d.state, l = this.inner.lighting;
    if (p.bump >= 0) return null;                     // (an emboss needs the shifted texel: not probed)
    const amb = l?.ambient ?? [0, 0, 0];
    const anyDiffuse = !!l && Array.from({ length: l.n }, (_, k) => (l.attnA[k * 4 + 3] & 1) !== 0).some(Boolean);
    const anySpec = !!l && Array.from({ length: l.n }, (_, k) => (l.attnA[k * 4 + 3] & 2) !== 0).some(Boolean);
    const c01 = (v: number) => Math.min(Math.max(v, 0), 1);
    return this.inputs.map((q) => {
      const texels = p.textures.map((ti) => {
        const t = s.tex[ti];
        const raw = q.t[t.tobj.id & 7];
        const tv = t.tobj.tev, c = t.tevColors;
        if (!tv) return raw;
        const k = c ? Array.from(c.subarray(0, 4)) : [0, 0, 0, 0], t0 = c ? Array.from(c.subarray(4, 8)) : [0, 0, 0, 0];
        const t1 = c ? Array.from(c.subarray(8, 12)) : [0, 0, 0, 0];
        return tevDescStep(tv, k, t0, t1, raw);
      });
      const lit = [0, 1, 2].map((i) => c01(amb[i] * s.ambient[i] + (anyDiffuse ? q.s[0][i] : 0)));
      const ras0 = p.channel === 1 ? q.v[0] : p.channel === 2 ? [...lit, 1] : [1, 1, 1, 1];
      const ras1 = [0, 1, 2].map((i) => c01(anySpec ? q.s[1][i] : 0)).concat([1]);
      const dif = s.override ?? s.diffuse;
      const out = evalMaterial(p, {
        diffuse: [dif[0], dif[1], dif[2]], alpha: s.alpha, specular: [s.specular[0], s.specular[1], s.specular[2]],
        ras0, ras1, texels, blend: p.textures.map((ti) => s.tex[ti].blending),
      });
      const tc = this.tint?.color;
      if (tc && tc[3] > 0) for (let i = 0; i < 3; i++) out[i] = c01(out[i]) * (1 - tc[3]) + tc[i] * tc[3];
      return out.map((v) => Math.round(c01(v) * 255));
    });
  }

  private particles(data: Float32Array, batches: Batch[]) {
    const s = this.inner;
    const vp = s.overlayVP ?? s.viewProj;
    for (const b of batches) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let q = b.first; q < b.first + b.count; q++) {
        for (let v = 0; v < 4; v++) {
          const o = (q * 4 + v) * 17, X = data[o], Y = data[o + 1], Z = data[o + 2];
          const w = vp[3] * X + vp[7] * Y + vp[11] * Z + vp[15];
          if (w <= 1e-9) continue;
          const sx = ((vp[0] * X + vp[4] * Y + vp[8] * Z + vp[12]) / w * 0.5 + 0.5) * 640;
          const sy = (0.5 - (vp[1] * X + vp[5] * Y + vp[9] * Z + vp[13]) / w * 0.5) * 480;
          x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
        }
      }
      this.add({
        kind: "particles", quads: b.count, sprite: b.sprite ? { key: b.sprite.key, w: b.sprite.w, h: b.sprite.h } : null,
        blend: { on: true, src: "srcalpha", dst: b.additive ? "one" : "invsrcalpha", sub: false, logic: null },
        z: { test: true, func: b.nozcomp ? "always" : "lequal", write: b.zwrite }, near: b.near,
        overlay: s.overlayVP !== null,
        bbox: Number.isFinite(x0) ? [x0, y0, x1, y1].map((v) => Math.round(v * 10) / 10) : null,
      });
    }
  }
}

interface Batch { sprite: { key: string; w: number; h: number } | null; additive: boolean; near: boolean; zwrite: boolean;
                  nozcomp: boolean; first: number; count: number }

// ---------------------------------------------------------------- the debug handle's entry

const logs = new WeakMap<Renderer, DrawLog>();

/** the debug handle's command: { start } attaches, { label } names the frames
 *  drawn next, { take } hands over the frames logged, { stop } detaches */
export function drawLogCommand(r: Renderer | null | undefined,
                               cmd: { start?: boolean; label?: number | string | null; take?: boolean; stop?: boolean; limit?: number }) {
  if (!r) return null;
  let log = logs.get(r);
  if (!log) logs.set(r, (log = new DrawLog(r)));
  if (cmd.limit) log.limit = cmd.limit;
  if (cmd.start) log.attach();
  if (cmd.label !== undefined) log.label = cmd.label;
  const out = cmd.take ? log.take() : null;
  if (cmd.stop) log.detach();
  return out ?? { attached: log.attached, frames: log.frames.length };
}
