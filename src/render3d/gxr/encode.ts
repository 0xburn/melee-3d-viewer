/* GX renderer: a writer of GX command streams, for tests and tools: the bytes the SDK's GXSetXxx and GXBegin calls put in the
 * write-gather pipe (BP 0x61, CP 0x08, XF 0x10, draws 0x80..0xB8), big endian. The same format the renderer reads (gpu.ts). */

export class FifoWriter {
  private out: number[] = [];

  private u32(v: number): void { this.out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); }
  private u16(v: number): void { this.out.push((v >>> 8) & 255, v & 255); }

  /** a BP register write (addr 0..255, 24-bit value) */
  bp(addr: number, value: number): this { this.out.push(0x61); this.u32(((addr << 24) | (value & 0xffffff)) >>> 0); return this; }
  /** BP write with a mask (BP 0xFE first) */
  bpMasked(addr: number, value: number, mask: number): this { this.bp(0xfe, mask); return this.bp(addr, value); }
  cp(addr: number, value: number): this { this.out.push(0x08, addr & 255); this.u32(value >>> 0); return this; }
  /** XF load of 32-bit words at `addr` */
  xf(addr: number, words: ArrayLike<number>): this {
    this.out.push(0x10); this.u32((((words.length - 1) << 16) | addr) >>> 0);
    for (let i = 0; i < words.length; i++) this.u32(words[i] >>> 0);
    return this;
  }
  xfFloats(addr: number, vals: ArrayLike<number>): this {
    const dv = new DataView(new ArrayBuffer(4));
    return this.xf(addr, Array.from(vals, (f) => { dv.setFloat32(0, f); return dv.getUint32(0); }));
  }
  /** a draw command: opcode (0x80 | prim << 3 | vat) and the vertices' bytes */
  draw(prim: number, vat: number, count: number, vertexBytes: ArrayLike<number>): this {
    this.out.push(0x80 | (prim << 3) | vat); this.u16(count);
    for (let i = 0; i < vertexBytes.length; i++) this.out.push(vertexBytes[i] & 255);
    return this;
  }
  bytes(): Uint8Array { return Uint8Array.from(this.out); }
}

const f32bytes = (f: number): number[] => { const dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, f); return [dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)]; };

/** Vertices of direct float positions (x y z) with a 4-byte color after each (CP's VCD: position and color 0 direct; VAT 0:
 *  3 floats, RGBA8888), as a draw's bytes */
export function colorVertices(v: { x: number; y: number; z: number; rgba: number[] }[]): number[] {
  const out: number[] = [];
  for (const p of v) out.push(...f32bytes(p.x), ...f32bytes(p.y), ...f32bytes(p.z), ...p.rgba);
  return out;
}

/** The register state of a plain screen-space scene: an orthographic projection of 640 x 480, the identity position matrix,
 *  the viewport over the EFB, vertex colors straight to the screen through one TEV stage, no depth test. Tests then change what
 *  they are about. */
export function basicScene(w = new FifoWriter()): FifoWriter {
  const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  w.xfFloats(0, ident);
  // the projection (orthographic): x' = 2 / 640 x - 1, y' = -2 / 480 y + 1, z' = -1 / 1000 z - 1 ... as GXSetProjection writes
  w.xfFloats(0x1020, [2 / 640, -1, -2 / 480, 1, -1 / 1000, -1]);
  w.xf(0x1026, [1]);
  // the viewport: 640 x 480 from the top left (the origin is plus 342)
  w.xfFloats(0x101a, [320, -240, 16777215, 320 + 342, 240 + 342, 16777215]);
  // vertex format: position (direct, 3 floats) and color 0 (direct RGBA8888)
  w.cp(0x50, (1 << 9) | (1 << 13));
  w.cp(0x60, 0);
  w.cp(0x70, 1 | (4 << 1) | (5 << 14) | (1 << 13));
  // one color channel: color 0 from the vertex, not lit
  w.xf(0x1009, [1]);
  w.xf(0x100e, [1]); w.xf(0x1010, [1]);
  // one TEV stage: the color channel straight out (d = ras)
  w.bp(0x00, (1 << 4) | (0 << 10));
  w.bp(0x28, 0);  // stage 0: map 0, coord 0, no texture, raster channel color 0
  w.bp(0xc0, (10 << 0) | (1 << 19));   // color d = RASC, clamp
  w.bp(0xc1, (5 << 4) | (1 << 19));    // alpha d = RASA, clamp
  // depth and blending off, the whole EFB scissored in
  w.bp(0x40, 0x00);
  w.bp(0x41, (1 << 3) | (1 << 4));
  w.bp(0x59, 171 | (171 << 10));
  w.bp(0x20, (342 << 12) | 342); w.bp(0x21, ((342 + 639) << 12) | (342 + 479));
  w.bp(0x43, 0);
  // swap table 0 is the identity (red, green, blue, alpha)
  w.bp(0xf6, 0 | (1 << 2)).bp(0xf7, 2 | (3 << 2));
  w.bp(0xf3, (7 << 16) | (7 << 19));
  return w;
}
