/* GX renderer: the vertices a draw command carries.
 *
 * The command processor reads a draw's vertices as the vertex descriptor (CP 0x50 and 0x60: which attributes are
 * sent and whether direct, or by an 8 or 16-bit index into an array in memory) and the vertex attribute table (CP
 * 0x70 + n, 0x80 + n, 0x90 + n: each attribute's component count, format and fixed-point shift) say. One vertex is,
 * in this order: the position matrix index, the texture matrix indices (8), the position, the normal, color 0 and 1
 * and the texture coordinates 0 to 7. This file decodes them to floats (the transform unit works on floats); the
 * colors stay bytes (the channels work on them).
 */
import { bits } from "./state";

export const COMP_SIZE = [1, 1, 2, 2, 4];
const COLOR_SIZE = [2, 3, 4, 2, 3, 4];
/** array numbers (CP 0xA0 + n bases, 0xB0 + n strides) of the attributes */
const ARRAY_POS = 0, ARRAY_NRM = 1, ARRAY_COL0 = 2, ARRAY_TEX0 = 4;

export interface Attr {
  /** 0 absent, 1 direct, 2 8-bit index, 3 16-bit index */
  kind: number;
  /** component format 0 u8, 1 s8, 2 u16, 3 s16, 4 f32 (colors: the color format) */
  fmt: number;
  /** components (position 2 or 3, normal 3 or 9, texcoord 1 or 2) */
  n: number;
  frac: number;
  /** 2^-frac: what an integer component is multiplied with */
  scale: number;
  /** bytes it takes in the command stream */
  size: number;
  /** bytes one element takes in its array */
  elem: number;
}

export interface VertexLayout {
  vat: number;
  size: number;
  posMtx: boolean;
  texMtx: boolean[];
  pos: Attr;
  nrm: Attr;
  nbt: boolean;
  nrmIndex3: boolean;
  col: Attr[];
  tex: Attr[];
  /** a key that tells layouts apart (for programs) */
  key: string;
}

const none = (): Attr => ({ kind: 0, fmt: 0, n: 0, frac: 0, scale: 1, size: 0, elem: 0 });

function attr(kind: number, fmt: number, n: number, frac: number): Attr {
  if (kind === 0) return none();
  const elem = COMP_SIZE[Math.min(fmt, 4)] * n;
  return { kind, fmt, n, frac, scale: 1 / (1 << frac), size: kind === 1 ? elem : kind === 2 ? 1 : 2, elem };
}

/** the layout of vertices sent with vertex attribute table entry `vat` */
export function vertexLayout(cp: Uint32Array, vat: number): VertexLayout {
  const lo = cp[0x50], hi = cp[0x60];
  const a = cp[0x70 + vat], b = cp[0x80 + vat], c = cp[0x90 + vat];
  let size = 0;
  const posMtx = (lo & 1) !== 0;
  if (posMtx) size += 1;
  const texMtx: boolean[] = [];
  for (let t = 0; t < 8; t++) { texMtx.push((lo & (1 << (t + 1))) !== 0); if (texMtx[t]) size += 1; }
  const pos = attr(bits(lo, 9, 2), bits(a, 1, 3), bits(a, 0, 1) ? 3 : 2, bits(a, 4, 5));
  size += pos.size;
  const nbt = bits(a, 9, 1) === 1;
  const nfmt = bits(a, 10, 3);
  const nk = bits(lo, 11, 2);
  const nrmIndex3 = nbt && bits(a, 31, 1) === 1;
  let nrm = none();
  if (nk) {
    nrm = attr(nk, nfmt, nbt ? 9 : 3, nfmt === 1 ? 6 : nfmt === 3 ? 14 : 0);
    if (nk === 1) nrm.size = COMP_SIZE[Math.min(nfmt, 4)] * (nbt ? 9 : 3);
    else nrm.size = (nk === 2 ? 1 : 2) * (nrmIndex3 ? 3 : 1);
    nrm.elem = COMP_SIZE[Math.min(nfmt, 4)] * (nbt ? 9 : 3);
    // an indexed NBT normal with one index holds all nine numbers in its element; with three, each is a 3-vector
    if (nrmIndex3) nrm.elem = COMP_SIZE[Math.min(nfmt, 4)] * 3;
  }
  size += nrm.size;
  const col: Attr[] = [];
  for (const [kshift, fshift] of [[13, 14], [15, 18]]) {
    const ck = bits(lo, kshift, 2);
    const cf = bits(a, fshift, 3);
    const at: Attr = ck ? { kind: ck, fmt: cf, n: 4, frac: 0, scale: 1, size: ck === 1 ? COLOR_SIZE[Math.min(cf, 5)] : ck === 2 ? 1 : 2, elem: COLOR_SIZE[Math.min(cf, 5)] } : none();
    col.push(at);
    size += at.size;
  }
  const tf = [
    [bits(a, 21, 1), bits(a, 22, 3), bits(a, 25, 5)], [bits(b, 0, 1), bits(b, 1, 3), bits(b, 4, 5)],
    [bits(b, 9, 1), bits(b, 10, 3), bits(b, 13, 5)], [bits(b, 18, 1), bits(b, 19, 3), bits(b, 22, 5)],
    [bits(b, 27, 1), bits(b, 28, 3), bits(c, 0, 5)], [bits(c, 5, 1), bits(c, 6, 3), bits(c, 9, 5)],
    [bits(c, 14, 1), bits(c, 15, 3), bits(c, 18, 5)], [bits(c, 23, 1), bits(c, 24, 3), bits(c, 27, 5)],
  ];
  const tex: Attr[] = [];
  for (let t = 0; t < 8; t++) {
    const at = attr(bits(hi, 2 * t, 2), tf[t][1], tf[t][0] ? 2 : 1, tf[t][2]);
    tex.push(at);
    size += at.size;
  }
  const key = [posMtx ? "M" : "", texMtx.map((x) => (x ? 1 : 0)).join(""), pos.kind, nrm.kind, nbt ? "n" : "", col[0].kind, col[1].kind,
    tex.map((x) => x.kind).join("")].join("");
  return { vat, size, posMtx, texMtx, pos, nrm, nbt, nrmIndex3, col, tex, key };
}

/** the vertices of a run of draw commands, decoded */
export class VertexData {
  n = 0;
  private cap = 0;
  pos = new Float32Array(0);
  pmtx = new Float32Array(0);
  nrm = new Float32Array(0);
  /** the second and third normals of an NBT vertex (the tangent and the binormal that XF's emboss and its binormal texgen sources use) */
  nrm1 = new Float32Array(0);
  nrm2 = new Float32Array(0);
  col: [Uint8Array, Uint8Array] = [new Uint8Array(0), new Uint8Array(0)];
  tex: Float32Array[] = [];
  tmtx: Float32Array[] = [];

  constructor(public layout: VertexLayout, private defaultPmtx = 0, private defaultTmtx: number[] = []) {
    this.grow(1024);
  }

  private grow(cap: number): void {
    const g = <T extends Float32Array | Uint8Array>(old: T, per: number, ctor: { new (n: number): T }): T => {
      const t = new ctor(cap * per);
      t.set(old);
      return t;
    };
    // every array is kept whatever the layout: one VertexData serves all runs
    this.pos = g(this.pos, 3, Float32Array);
    this.pmtx = g(this.pmtx, 1, Float32Array);
    this.nrm = g(this.nrm, 3, Float32Array);
    this.nrm1 = g(this.nrm1, 3, Float32Array);
    this.nrm2 = g(this.nrm2, 3, Float32Array);
    for (let i = 0; i < 2; i++) this.col[i] = g(this.col[i], 4, Uint8Array);
    for (let t = 0; t < 8; t++) {
      this.tex[t] = g(this.tex[t] ?? new Float32Array(0), 2, Float32Array);
      this.tmtx[t] = g(this.tmtx[t] ?? new Float32Array(0), 1, Float32Array);
    }
    this.cap = cap;
  }

  /** start over for a run of vertices of layout `layout` (the buffers are kept) */
  setup(layout: VertexLayout, defaultPmtx: number, defaultTmtx: number[]): void {
    this.layout = layout;
    this.n = 0;
    this.defaultPmtx = defaultPmtx;
    this.defaultTmtx = defaultTmtx;
  }

  /** room for at least n vertices */
  ensure(n: number): void { if (n > this.cap) this.grow(n); }

  /** decode `count` vertices from `data` at `at`; indexed attributes read main memory `mem` (24 MiB, `mdv` a view of it) */
  add(data: Uint8Array, at: number, count: number, cp: Uint32Array, mem: Uint8Array, mdv: DataView): void {
    const L = this.layout;
    if (this.n + count > this.cap) this.grow(Math.max(this.cap * 2, this.n + count));
    if (this.dvData !== data.buffer) { this.dvData = data.buffer; this.dv = new DataView(data.buffer); }
    const dv = this.dv!;
    const dvBase = data.byteOffset;
    const memSize = mem.length;
    const pos = L.pos, nrm = L.nrm;
    for (let v = 0; v < count; v++) {
      const i = this.n++;
      let off = dvBase + at + v * L.size;
      if (L.posMtx) this.pmtx[i] = data[off - dvBase] & 0x3f; else this.pmtx[i] = this.defaultPmtx;
      if (L.posMtx) off++;
      for (let t = 0; t < 8; t++) if (L.texMtx[t]) { this.tmtx[t][i] = dv.getUint8(off) & 0x3f; off++; }
      if (pos.kind) {
        let d = dv, o = off;
        if (pos.kind !== 1) {
          const idx = pos.kind === 2 ? dv.getUint8(off) : dv.getUint16(off);
          const a = ((cp[0xa0 + ARRAY_POS] & 0x03ffffff) + idx * cp[0xb0 + ARRAY_POS]) & 0x01ffffff;
          if (a + pos.elem <= memSize) { d = mdv; o = a; } else { d = this.zero(mem, a, pos.elem); o = 0; }
        }
        const cs = COMP_SIZE[pos.fmt < 4 ? pos.fmt : 4], sc = pos.scale;
        this.pos[i * 3] = rd(d, o, pos.fmt, sc);
        this.pos[i * 3 + 1] = rd(d, o + cs, pos.fmt, sc);
        this.pos[i * 3 + 2] = pos.n === 3 ? rd(d, o + 2 * cs, pos.fmt, sc) : 0;
        off += pos.size;
      }
      if (nrm.kind) {
        const cs = COMP_SIZE[nrm.fmt < 4 ? nrm.fmt : 4], sc = nrm.scale;
        if (L.nbt && L.nrmIndex3 && nrm.kind !== 1) {
          // three indices, one for each of the normal, the tangent and the binormal, each into the normal array
          for (let q = 0; q < 3; q++) {
            const idx = nrm.kind === 2 ? dv.getUint8(off + q) : dv.getUint16(off + 2 * q);
            const a = ((cp[0xa0 + ARRAY_NRM] & 0x03ffffff) + idx * cp[0xb0 + ARRAY_NRM]) & 0x01ffffff;
            let d = mdv, o = a;
            if (a + 3 * cs > memSize) { d = this.zero(mem, a, 3 * cs); o = 0; }
            const out = q === 0 ? this.nrm : q === 1 ? this.nrm1 : this.nrm2;
            for (let k = 0; k < 3; k++) out[i * 3 + k] = rd(d, o + k * cs, nrm.fmt, sc);
          }
        } else {
          let d = dv, o = off;
          if (nrm.kind !== 1) {
            const idx = nrm.kind === 2 ? dv.getUint8(off) : dv.getUint16(off);
            const a = ((cp[0xa0 + ARRAY_NRM] & 0x03ffffff) + idx * cp[0xb0 + ARRAY_NRM]) & 0x01ffffff;
            if (a + nrm.elem <= memSize) { d = mdv; o = a; } else { d = this.zero(mem, a, nrm.elem); o = 0; }
          }
          for (let k = 0; k < 3; k++) this.nrm[i * 3 + k] = rd(d, o + k * cs, nrm.fmt, sc);
          if (L.nbt) for (let k = 0; k < 3; k++) { this.nrm1[i * 3 + k] = rd(d, o + (3 + k) * cs, nrm.fmt, sc); this.nrm2[i * 3 + k] = rd(d, o + (6 + k) * cs, nrm.fmt, sc); }
        }
        off += nrm.size;
      }
      for (let c = 0; c < 2; c++) {
        const a = L.col[c];
        if (!a.kind) continue;
        let d = dv, o = off;
        if (a.kind !== 1) {
          const idx = a.kind === 2 ? dv.getUint8(off) : dv.getUint16(off);
          const ad = ((cp[0xa0 + ARRAY_COL0 + c] & 0x03ffffff) + idx * cp[0xb0 + ARRAY_COL0 + c]) & 0x01ffffff;
          if (ad + a.elem <= memSize) { d = mdv; o = ad; } else { d = this.zero(mem, ad, a.elem); o = 0; }
        }
        const out = this.col[c], k = i * 4;
        switch (a.fmt) {
          case 0: { const v16 = d.getUint16(o); out[k] = (v16 >> 11 << 3) | (v16 >> 13); out[k + 1] = ((v16 >> 5) & 63) << 2 | ((v16 >> 9) & 3); out[k + 2] = (v16 & 31) << 3 | ((v16 >> 2) & 7); out[k + 3] = 255; break; }
          case 1: out[k] = d.getUint8(o); out[k + 1] = d.getUint8(o + 1); out[k + 2] = d.getUint8(o + 2); out[k + 3] = 255; break;
          case 2: out[k] = d.getUint8(o); out[k + 1] = d.getUint8(o + 1); out[k + 2] = d.getUint8(o + 2); out[k + 3] = 255; break;
          case 3: { const v16 = d.getUint16(o); out[k] = ((v16 >> 12) & 15) * 17; out[k + 1] = ((v16 >> 8) & 15) * 17; out[k + 2] = ((v16 >> 4) & 15) * 17; out[k + 3] = (v16 & 15) * 17; break; }
          case 4: { const v24 = (d.getUint8(o) << 16) | (d.getUint8(o + 1) << 8) | d.getUint8(o + 2);
            out[k] = ((v24 >> 18) & 63) << 2 | ((v24 >> 18) & 63) >> 4; out[k + 1] = ((v24 >> 12) & 63) << 2 | ((v24 >> 12) & 63) >> 4;
            out[k + 2] = ((v24 >> 6) & 63) << 2 | ((v24 >> 6) & 63) >> 4; out[k + 3] = (v24 & 63) << 2 | (v24 & 63) >> 4; break; }
          default: out[k] = d.getUint8(o); out[k + 1] = d.getUint8(o + 1); out[k + 2] = d.getUint8(o + 2); out[k + 3] = d.getUint8(o + 3);
        }
        off += a.size;
      }
      for (let t = 0; t < 8; t++) {
        const a = L.tex[t];
        if (!a.kind) continue;
        let d = dv, o = off;
        if (a.kind !== 1) {
          const idx = a.kind === 2 ? dv.getUint8(off) : dv.getUint16(off);
          const ad = ((cp[0xa0 + ARRAY_TEX0 + t] & 0x03ffffff) + idx * cp[0xb0 + ARRAY_TEX0 + t]) & 0x01ffffff;
          if (ad + a.elem <= memSize) { d = mdv; o = ad; } else { d = this.zero(mem, ad, a.elem); o = 0; }
        }
        const cs = COMP_SIZE[a.fmt < 4 ? a.fmt : 4];
        const out = this.tex[t];
        out[i * 2] = rd(d, o, a.fmt, a.scale);
        out[i * 2 + 1] = a.n === 2 ? rd(d, o + cs, a.fmt, a.scale) : 0;
        off += a.size;
      }
    }
  }

  private dvData: ArrayBufferLike | null = null;
  private dv: DataView | null = null;
  private zbuf = new Uint8Array(64);
  private zdv = new DataView(this.zbuf.buffer);
  /** bytes of memory from a, zero past the end, in a small view (reads off the end of main memory) */
  private zero(mem: Uint8Array, a: number, n: number): DataView {
    this.zbuf.fill(0);
    for (let k = 0; k < n && a + k < mem.length; k++) this.zbuf[k] = mem[a + k];
    return this.zdv;
  }
}

/** a component: u8, s8, u16, s16 scaled by 2^-frac (scale), or a float */
function rd(d: DataView, o: number, fmt: number, scale: number): number {
  switch (fmt) {
    case 0: return d.getUint8(o) * scale;
    case 1: return d.getInt8(o) * scale;
    case 2: return d.getUint16(o) * scale;
    case 3: return d.getInt16(o) * scale;
    default: return d.getFloat32(o);
  }
}

/** triangle indices (into a run's vertices) for a primitive of `count` vertices starting at vertex `base`;
 *  `type` is the opcode's primitive field: 0 quads, 1 quads (alternate), 2 triangles, 3 strip, 4 fan */
export function triangulate(type: number, count: number, base: number, out: number[]): void {
  switch (type) {
    case 0: case 1:
      for (let i = 0; i + 3 < count; i += 4) {
        out.push(base + i, base + i + 1, base + i + 2, base + i, base + i + 2, base + i + 3);
      }
      break;
    case 2:
      for (let i = 0; i + 2 < count; i += 3) out.push(base + i, base + i + 1, base + i + 2);
      break;
    case 3:
      for (let i = 0; i + 2 < count; i++) {
        if (i & 1) out.push(base + i + 1, base + i, base + i + 2);
        else out.push(base + i, base + i + 1, base + i + 2);
      }
      break;
    case 4:
      for (let i = 1; i + 1 < count; i++) out.push(base, base + i, base + i + 1);
      break;
  }
}
