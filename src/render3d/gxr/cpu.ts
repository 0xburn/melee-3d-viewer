/* GX renderer: the whole pipeline on the CPU (transform, clip, setup, pixel stage, copies) as one GxBackend. It is the
 * reference implementation of GX-RASTER-SPEC: slow, plain, exact. The WebGL renderer (gl.ts) shares its front half (xform.ts,
 * setup.ts) and replaces the pixel stage. */
import { Memory } from "./dff";
import { clearRect, copyParams, encodeCopy } from "./copy";
import { DrawPixels, Efb, Env, EFB_H, EFB_W, PixState, readColor } from "./raster";
import { setupCtx, setupTri } from "./setup";
import { bits, GxRegs } from "./state";
import { VertexData } from "./vertex";
import { assemble, cullClip, Pool, transformVertices, xfDraw } from "./xform";
import type { GxBackend } from "./gpu";

/** the pixel state of the registers now */
export function snapshot(regs: GxRegs): PixState {
  const bp = new Uint32Array(regs.bp);
  for (let i = 0; i < 8; i++) bp[0xe0 + i] = regs.tevBank[0][i];
  const fl = new Float32Array(regs.xf.buffer, regs.xf.byteOffset, regs.xf.length);
  const texProj: boolean[] = [];
  for (let n = 0; n < 8; n++) texProj.push(bits(regs.xf[0x1040 + n], 1, 1) === 1);
  return { bp, kc: new Uint32Array(regs.tevBank[1]), texProj, wd: fl[0x101a] };
}

export class CpuBackend implements GxBackend {
  readonly efb = new Efb();
  readonly pool = new Pool();
  /** draws are skipped until this is set (the reference draws nothing in the first frame) */
  drawing = false;
  onPicture: ((rgba: Uint8Array, frame: number) => void) | null = null;
  pictures = 0;
  tris = 0;

  constructor(private env: () => Env) {}

  draw(regs: GxRegs, mem: Memory, vd: VertexData, tris: number[], lines: number[], points: number[], prims: { type: number; base: number; count: number }[]): void {
    if (!this.drawing) return;
    const pool = this.pool;
    pool.clear();
    const x = xfDraw(regs, vd);
    const base = transformVertices(x, regs, vd, pool);
    const sc = setupCtx(regs.bp);
    const st = snapshot(regs);
    const dp = new DrawPixels(st, this.env());
    const cull = bits(regs.bp[0], 14, 2);
    const trip: number[] = [];
    for (const p of prims) assemble(p.type, p.count, p.base, trip);
    const mark = pool.n;
    for (let i = 0; i + 2 < trip.length; i += 3) {
      pool.n = mark;
      const poly = cullClip(pool, cull, base + trip[i] * 48, base + trip[i + 1] * 48, base + trip[i + 2] * 48);
      if (!poly) continue;
      for (let k = 1; k + 1 < poly.length; k++) {
        const t = setupTri(pool, x, sc, 0, poly[0], poly[k], poly[k + 1]);
        if (!t) continue;
        this.tris++;
        dp.draw(this.efb, t);
      }
    }
  }

  copy(regs: GxRegs, mem: Memory, value: number): { toXfb: boolean; rect: number[]; clear: boolean } {
    const p = copyParams(regs.bp);
    p.pixFmt = bits(regs.bp[0x43], 0, 3);
    if (p.toScreen) {
      if (this.onPicture) {
        const out = new Uint8Array(EFB_W * 480 * 4);
        const px = [0, 0, 0, 0];
        for (let i = 0; i < EFB_W * 480; i++) {
          readColor(this.efb.color[i], p.pixFmt, px);
          out[i * 4] = px[0]; out[i * 4 + 1] = px[1]; out[i * 4 + 2] = px[2]; out[i * 4 + 3] = px[3];
        }
        this.onPicture(out, this.pictures);
      }
      this.pictures++;
    } else {
      encodeCopy(this.efb, p, mem.data);
      mem.touch(p.dest & 0x1ffffff, 0x100000);
    }
    return { toXfb: p.toScreen, rect: [p.x0, p.y0, p.wm + 1, p.hm + 1], clear: p.clear };
  }

  copyClear(regs: GxRegs): void {
    clearRect(this.efb, regs.bp, copyParams(regs.bp));
  }
}
