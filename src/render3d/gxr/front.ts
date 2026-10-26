/* GX renderer: the front half of one draw, shared by the main thread and the worker threads (frontpool.ts): the vertices of a draw
 * (decoded floats) to the words of its triangles in the queue the pixel pass reads. Nothing here touches memory, GPU state or the
 * recorder's registers except what it is handed, so the same code gives the same words wherever it runs. */
import { bitsOf } from "./f32";
import { planeCount, setupCtx, setupTriInto, TS } from "./setup";
import { bits } from "./state";
import type { VertexData } from "./vertex";
import { assemble, clipLine, cullClipInto, lineTriangles, Pool, poly, polyState, transformVertices, V_STRIDE, xfDraw } from "./xform";

/** texels (4 words) of a triangle's header in the queue */
export const HEADER_TEXELS = 5;

/** a run of words that grows */
export class Growable {
  words = new Uint32Array(4096 * 16);
  ints = new Int32Array(this.words.buffer);
  floats = new Float32Array(this.words.buffer);
  n = 0;
  ensure(extra: number): void {
    if (this.n + extra <= this.words.length) return;
    let cap = this.words.length;
    while (cap < this.n + extra) cap *= 2;
    const w = new Uint32Array(cap);
    w.set(this.words.subarray(0, this.n));
    this.words = w; this.ints = new Int32Array(w.buffer); this.floats = new Float32Array(w.buffer);
  }
}

/** what the front half reads of the registers */
export interface FrontRegs { bp: Uint32Array; xf: Uint32Array }

/** the header words of the triangle set up last (TS), at word o of the queue */
function writeHeader(q: Growable, o: number, st: number): void {
  const I = q.ints, U = q.words;
  I[o] = TS.minx; I[o + 1] = TS.maxx; I[o + 2] = TS.miny; I[o + 3] = TS.maxy;
  I[o + 4] = TS.DX12; I[o + 5] = TS.DY12; I[o + 6] = TS.DX23; I[o + 7] = TS.DY23;
  I[o + 8] = TS.DX31; I[o + 9] = TS.DY31; I[o + 10] = TS.C1; I[o + 11] = TS.C2;
  I[o + 12] = TS.C3; I[o + 13] = TS.xi; I[o + 14] = TS.yi; U[o + 15] = bitsOf(TS.ox);
  U[o + 16] = bitsOf(TS.oy); U[o + 17] = st; U[o + 18] = TS.np; U[o + 19] = 0;
}

export class FrontCtx {
  pool = new Pool();
  private trip: number[] = [];
  private need = new Uint8Array(4096);
  private lineIdx: number[] = [];

  /** the triangles of a draw, appended to `q` (header, then planes). `prims` are the run's primitives (type, base, count). */
  run(regs: FrontRegs, vd: VertexData, prims: { type: number; base: number; count: number }[], st: number, q: Growable): void {
    const pool = this.pool;
    pool.clear();
    const x = xfDraw(regs as never, vd);
    const trip = this.trip;
    trip.length = 0;
    for (let i = 0; i < prims.length; i++) assemble(prims[i].type, prims[i].count, prims[i].base, trip);
    // only the vertices a triangle uses are transformed (a run also holds points, which draw nothing)
    if (this.need.length < vd.n) this.need = new Uint8Array(Math.max(vd.n, this.need.length * 2));
    const need = this.need;
    need.fill(0, 0, vd.n);
    for (let i = 0; i < trip.length; i++) need[trip[i]] = 1;
    const lineIdx = this.lineIdx;
    lineIdx.length = 0;
    for (let i = 0; i < prims.length; i++) {
      const p = prims[i];
      if (p.type === 5) for (let k = 0; k + 1 < p.count; k += 2) lineIdx.push(p.base + k, p.base + k + 1);
      else if (p.type === 6) for (let k = 0; k + 1 < p.count; k++) lineIdx.push(p.base + k, p.base + k + 1);
    }
    for (let i = 0; i < lineIdx.length; i++) need[lineIdx[i]] = 1;
    const base = transformVertices(x, regs as never, vd, pool, need);
    const sc = setupCtx(regs.bp);
    const cull = bits(regs.bp[0], 14, 2);
    const mark = pool.n;
    const nPlanes = planeCount(sc);
    const words = (HEADER_TEXELS + nPlanes) * 4;
    for (let i = 0; i + 2 < trip.length; i += 3) {
      pool.n = mark;
      if (!cullClipInto(pool, cull, base + trip[i] * V_STRIDE, base + trip[i + 1] * V_STRIDE, base + trip[i + 2] * V_STRIDE)) continue;
      const n = polyState.n;
      for (let k = 1; k + 1 < n; k++) {
        q.ensure(words);
        const o = q.n;
        if (!setupTriInto(pool, x, sc, poly[0], poly[k], poly[k + 1], q.floats, o + HEADER_TEXELS * 4, null, 4)) continue;
        writeHeader(q, o, st);
        q.n += words;
      }
    }
    // lines (unverified by the recorded windows): clipped, then two triangles of the line width each
    if (lineIdx.length) {
      const size = bits(regs.bp[0x22], 0, 8);
      for (let i = 0; i + 1 < lineIdx.length; i += 2) {
        pool.n = mark;
        const cl = clipLine(pool, base + lineIdx[i] * V_STRIDE, base + lineIdx[i + 1] * V_STRIDE);
        if (!cl) continue;
        const pieces: { scr: Float64Array; v: [number, number, number] }[] = [];
        lineTriangles(pool, x, cl[0], cl[1], size, pieces);
        for (const pc of pieces) {
          q.ensure(words);
          const o = q.n;
          if (!setupTriInto(pool, x, sc, pc.v[0], pc.v[1], pc.v[2], q.floats, o + HEADER_TEXELS * 4, pc.scr, 4)) continue;
          writeHeader(q, o, st);
          q.n += words;
        }
      }
    }
  }
}

/** whether a draw can run on another thread: z freeze reads the depth plane of the triangle before it, and lines are rare enough not to bother */
export function needsMainThread(bp: Uint32Array, prims: { type: number }[]): boolean {
  if (bits(bp[0], 19, 1) === 1) return true;
  for (const p of prims) if (p.type === 5 || p.type === 6) return true;
  return false;
}
