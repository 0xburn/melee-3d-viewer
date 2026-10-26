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

const none = (): Attr => ({ kind: 0, fmt: 0, n: 0, frac: 0, size: 0, elem: 0 });

function attr(kind: number, fmt: number, n: number, frac: number): Attr {
  if (kind === 0) return none();
  const elem = COMP_SIZE[Math.min(fmt, 4)] * n;
  return { kind, fmt, n, frac, size: kind === 1 ? elem : kind === 2 ? 1 : 2, elem };
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
    const at: Attr = ck ? { kind: ck, fmt: cf, n: 4, frac: 0, size: ck === 1 ? COLOR_SIZE[Math.min(cf, 5)] : ck === 2 ? 1 : 2, elem: COLOR_SIZE[Math.min(cf, 5)] } : none();
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

  constructor(public layout: VertexLayout, private defaultPmtx: number, private defaultTmtx: number[]) {
    this.grow(1024);
  }

  private grow(cap: number): void {
    const g = <T extends Float32Array | Uint8Array>(old: T, per: number, ctor: { new (n: number): T }): T => {
      const t = new ctor(cap * per);
      t.set(old);
      return t;
    };
    this.pos = g(this.pos, 3, Float32Array);
    this.pmtx = g(this.pmtx, 1, Float32Array);
    if (this.layout.nrm.kind) this.nrm = g(this.nrm, 3, Float32Array);
    if (this.layout.nrm.kind && this.layout.nbt) { this.nrm1 = g(this.nrm1, 3, Float32Array); this.nrm2 = g(this.nrm2, 3, Float32Array); }
    for (let i = 0; i < 2; i++) if (this.layout.col[i].kind) this.col[i] = g(this.col[i], 4, Uint8Array);
    for (let t = 0; t < 8; t++) {
      if (this.layout.tex[t].kind) this.tex[t] = g(this.tex[t] ?? new Float32Array(0), 2, Float32Array);
      if (this.layout.texMtx[t]) this.tmtx[t] = g(this.tmtx[t] ?? new Float32Array(0), 1, Float32Array);
    }
    this.cap = cap;
  }

  /** room for at least n vertices */
  ensure(n: number): void { if (n > this.cap) this.grow(n); }

  /** decode `count` vertices from `data` at `at`; array reads go through `read(addr, n)` */
  add(data: Uint8Array, at: number, count: number, cp: Uint32Array, read: (addr: number, n: number) => Uint8Array): void {
    const L = this.layout;
    if (this.n + count > this.cap) this.grow(Math.max(this.cap * 2, this.n + count));
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let v = 0; v < count; v++) {
      const i = this.n++;
      let off = at + v * L.size;
      if (L.posMtx) this.pmtx[i] = data[off++] & 0x3f; else this.pmtx[i] = this.defaultPmtx;
      for (let t = 0; t < 8; t++) if (L.texMtx[t]) this.tmtx[t][i] = data[off++] & 0x3f;
      // a component list from the stream or from an array
      const fetch = (a: Attr, arr: number): [DataView, number] => {
        if (a.kind === 1) return [dv, off];
        const idx = a.kind === 2 ? data[off] : dv.getUint16(off);
        const stride = cp[0xb0 + arr];
        const base = cp[0xa0 + arr] & 0x03ffffff;
        const bytes = read(base + idx * stride, a.elem);
        const copy = new Uint8Array(a.elem);
        copy.set(bytes);
        return [new DataView(copy.buffer), 0];
      };
      const comp = (d: DataView, o: number, fmt: number, frac: number): number => {
        switch (fmt) {
          case 0: return d.getUint8(o) / (1 << frac);
          case 1: return d.getInt8(o) / (1 << frac);
          case 2: return d.getUint16(o) / (1 << frac);
          case 3: return d.getInt16(o) / (1 << frac);
          default: return d.getFloat32(o);
        }
      };
      if (L.pos.kind) {
        const [d, o] = fetch(L.pos, ARRAY_POS);
        const cs = COMP_SIZE[Math.min(L.pos.fmt, 4)];
        this.pos[i * 3] = comp(d, o, L.pos.fmt, L.pos.frac);
        this.pos[i * 3 + 1] = comp(d, o + cs, L.pos.fmt, L.pos.frac);
        this.pos[i * 3 + 2] = L.pos.n === 3 ? comp(d, o + 2 * cs, L.pos.fmt, L.pos.frac) : 0;
        off += L.pos.size;
      }
      if (L.nrm.kind) {
        const cs = COMP_SIZE[Math.min(L.nrm.fmt, 4)];
        const outs = [this.nrm, this.nrm1, this.nrm2];
        if (L.nbt && L.nrmIndex3 && L.nrm.kind !== 1) {
          // three indices, one for each of the normal, the tangent and the binormal, each into the normal array
          const isz = L.nrm.kind === 2 ? 1 : 2;
          for (let q = 0; q < 3; q++) {
            const idx = isz === 1 ? data[off + q] : dv.getUint16(off + 2 * q);
            const bytes = read((cp[0xa0 + ARRAY_NRM] & 0x03ffffff) + idx * cp[0xb0 + ARRAY_NRM], 3 * cs);
            const copy = new Uint8Array(3 * cs);
            copy.set(bytes);
            const d = new DataView(copy.buffer);
            for (let k = 0; k < 3; k++) outs[q][i * 3 + k] = comp(d, k * cs, L.nrm.fmt, L.nrm.frac);
          }
        } else {
          const [d, o] = fetch(L.nrm, ARRAY_NRM);
          for (let q = 0; q < (L.nbt ? 3 : 1); q++) for (let k = 0; k < 3; k++) outs[q][i * 3 + k] = comp(d, o + (q * 3 + k) * cs, L.nrm.fmt, L.nrm.frac);
        }
        off += L.nrm.size;
      }
      for (let c = 0; c < 2; c++) {
        const a = L.col[c];
        if (!a.kind) continue;
        const [d, o] = fetch(a, ARRAY_COL0 + c);
        const out = this.col[c], k = i * 4;
        switch (a.fmt) {
          case 0: { const v16 = d.getUint16(o); out[k] = (v16 >> 11 << 3) | (v16 >> 13); out[k + 1] = ((v16 >> 5) & 63) << 2 | ((v16 >> 9) & 3); out[k + 2] = (v16 & 31) << 3 | ((v16 >> 2) & 7); out[k + 3] = 255; break; }
          case 1: out[k] = d.getUint8(o); out[k + 1] = d.getUint8(o + 1); out[k + 2] = d.getUint8(o + 2); out[k + 3] = 255; break;
          case 2: out[k] = d.getUint8(o); out[k + 1] = d.getUint8(o + 1); out[k + 2] = d.getUint8(o + 2); out[k + 3] = 255; break;
          case 3: { const v16 = d.getUint16(o); out[k] = ((v16 >> 12) & 15) * 17; out[k + 1] = ((v16 >> 8) & 15) * 17; out[k + 2] = ((v16 >> 4) & 15) * 17; out[k + 3] = (v16 & 15) * 17; break; }
          case 4: { const v24 = (d.getUint8(o) << 16) | (d.getUint8(o + 1) << 8) | d.getUint8(o + 2);
            const e = (x: number) => (x << 2) | (x >> 4);
            out[k] = e((v24 >> 18) & 63); out[k + 1] = e((v24 >> 12) & 63); out[k + 2] = e((v24 >> 6) & 63); out[k + 3] = e(v24 & 63); break; }
          default: out[k] = d.getUint8(o); out[k + 1] = d.getUint8(o + 1); out[k + 2] = d.getUint8(o + 2); out[k + 3] = d.getUint8(o + 3);
        }
        off += a.size;
      }
      for (let t = 0; t < 8; t++) {
        const a = L.tex[t];
        if (!a.kind) continue;
        const [d, o] = fetch(a, ARRAY_TEX0 + t);
        const cs = COMP_SIZE[Math.min(a.fmt, 4)];
        this.tex[t][i * 2] = comp(d, o, a.fmt, a.frac);
        this.tex[t][i * 2 + 1] = a.n === 2 ? comp(d, o + cs, a.fmt, a.frac) : 0;
        off += a.size;
      }
    }
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
