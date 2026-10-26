/* GX renderer: a FIFO recording (.dff), and main memory as the recording holds it.
 *
 * A .dff is what Dolphin's FIFO recorder writes (FifoDataFile, file version 4): a header, the graphics registers as
 * they stood when the recording began (BP 256 words, CP 256, XF memory 4096 and XF registers 96, texture memory
 * 1 MiB), then per frame the command bytes the game sent to the graphics processor and the memory those commands
 * read (texture images, vertex arrays, XF data loaded by index, TMEM loads), each at the place in the bytes where
 * it was read. The header and the tables are little endian; the command bytes and the memory are the console's
 * (big endian). The format is the GX command stream this renderer draws: a stream the simulator writes is the same
 * bytes (see gpu.ts, GxFrame).
 */

export const MEM_SIZE = 0x01800000; // 24 MiB of main memory (MEM1)
export const BLOCK_SHIFT = 10;      // memory is versioned by 1 KiB blocks

/** one frame of commands and the memory writes that go with them, by position in the command bytes */
export interface GxFrame {
  fifo: Uint8Array;
  /** [position, address, bytes, type]: the bytes were in memory at `address` once the command at `position` starts */
  updates: GxUpdate[];
}

export interface GxUpdate { pos: number; addr: number; data: Uint8Array; type: number }

/** the register state a processor starts from (the fields of a Dff that GxGpu's constructor reads) */
export interface GxInitial {
  bp: Uint32Array;
  cp: Uint32Array;
  xfMem: Uint32Array;
  xfRegs: Uint32Array;
  texMem: Uint8Array;
}

export interface Dff extends GxInitial {
  version: number;
  frames: GxFrame[];
}

const FILE_ID = 0x0d01f1f0;

/** a .dff's contents */
export function parseDff(data: Uint8Array): Dff {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 128) throw new Error("too short for a FIFO recording");
  if (dv.getUint32(0, true) !== FILE_ID) throw new Error("not a FIFO recording");
  const version = dv.getUint32(4, true);
  const u64 = (o: number) => Number(dv.getBigUint64(o, true));
  const bpOff = u64(12), bpSize = dv.getUint32(20, true);
  const cpOff = u64(24), cpSize = dv.getUint32(32, true);
  const xfOff = u64(36), xfSize = dv.getUint32(44, true);
  const xfrOff = u64(48), xfrSize = dv.getUint32(56, true);
  const flOff = u64(60), frameCount = dv.getUint32(68, true);
  let texOff = u64(76), texSize = dv.getUint32(84, true);
  if (version < 4) texOff = texSize = 0;
  const words = (off: number, n: number) => {
    const out = new Uint32Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getUint32(off + i * 4, true);
    return out;
  };
  const frames: GxFrame[] = [];
  for (let i = 0; i < frameCount; i++) {
    const at = flOff + i * 64;
    const fOff = u64(at), fSize = dv.getUint32(at + 8, true);
    const uOff = u64(at + 20), uCount = dv.getUint32(at + 28, true);
    const updates: GxUpdate[] = [];
    for (let k = 0; k < uCount; k++) {
      const ua = uOff + k * 24;
      const dOff = u64(ua + 8), dSize = dv.getUint32(ua + 16, true);
      updates.push({ pos: dv.getUint32(ua, true), addr: dv.getUint32(ua + 4, true), data: data.subarray(dOff, dOff + dSize), type: dv.getUint8(ua + 20) });
    }
    updates.sort((a, b) => a.pos - b.pos);
    frames.push({ fifo: data.subarray(fOff, fOff + fSize), updates });
  }
  return {
    version, bp: words(bpOff, bpSize), cp: words(cpOff, cpSize), xfMem: words(xfOff, xfSize), xfRegs: words(xfrOff, xfrSize),
    texMem: texSize ? data.slice(texOff, texOff + texSize) : new Uint8Array(0), frames,
  };
}

/** main memory: 24 MiB, versioned by 1 KiB blocks so a texture cache can tell when its source changed */
export class Memory {
  readonly data = new Uint8Array(MEM_SIZE);
  /** a view of `data` for reading numbers */
  readonly view = new DataView(this.data.buffer);
  readonly gen = new Uint32Array(MEM_SIZE >> BLOCK_SHIFT);
  private counter = 0;
  /** called with (address, length) after every change, for a host that mirrors memory (the GPU's copy) */
  onTouch: ((addr: number, n: number) => void) | null = null;
  /** called with (address, length) just before a write lands (a host that has work queued on the old bytes finishes it) */
  beforeWrite: ((addr: number, n: number) => void) | null = null;

  write(addr: number, bytes: Uint8Array): void {
    const a = addr & 0x01ffffff;
    if (a + bytes.length > MEM_SIZE) return;
    this.beforeWrite?.(a, bytes.length);
    this.data.set(bytes, a);
    this.touch(a, bytes.length);
  }

  /** note a change made straight in `data` */
  touch(a: number, n: number): void {
    const c = ++this.counter;
    const last = (a + n - 1) >> BLOCK_SHIFT;
    for (let b = a >> BLOCK_SHIFT; b <= last && b < this.gen.length; b++) this.gen[b] = c;
    this.onTouch?.(a, n);
  }

  /** the newest change in [addr, addr + n) */
  version(addr: number, n: number): number {
    const a = addr & 0x01ffffff;
    let v = 0;
    const last = Math.min((a + Math.max(n, 1) - 1) >> BLOCK_SHIFT, this.gen.length - 1);
    for (let b = a >> BLOCK_SHIFT; b <= last; b++) if (this.gen[b] > v) v = this.gen[b];
    return v;
  }

  /** bytes [addr, addr + n) (a view; short reads past the end are clipped) */
  read(addr: number, n: number): Uint8Array {
    const a = addr & 0x01ffffff;
    return this.data.subarray(a, Math.min(a + n, MEM_SIZE));
  }
}
