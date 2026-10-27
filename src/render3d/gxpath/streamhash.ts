/* For the checks: the hash the simulator's native recorder prints for each frame (MSL_GX_RECORD_OUT=hash, src/gx/msl_gx.c: "GXHASH <n>
 * <fnv1a64>"), over the same bytes: the frame's FIFO bytes, then each memory block in the recorder's order as its address, size and type
 * (three little-endian words) and its bytes. FNV-1a 64 in two 32-bit halves (the prime is 2^40 + 0x1b3). Not used in play.
 */
import type { GxCore } from "./core";

class Fnv64 {
  hi = 0xcbf29ce4;
  lo = 0x84222325;
  bytes(d: Uint8Array): void {
    let hi = this.hi, lo = this.lo;
    for (let i = 0; i < d.length; i++) {
      const x = (lo ^ d[i]) >>> 0;
      const p = x * 0x1b3; // < 2^41: exact
      const plo = p % 4294967296;
      hi = (hi * 0x1b3 + (p - plo) / 4294967296 + ((x << 8) >>> 0)) % 4294967296;
      lo = plo;
    }
    this.hi = hi; this.lo = lo;
  }
  word(v: number): void { this.bytes(new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24])); }
  hex(): string { return (this.hi >>> 0).toString(16).padStart(8, "0") + (this.lo >>> 0).toString(16).padStart(8, "0"); }
}

/** the native recorder's GXHASH of the core's last step */
export function frameHash(core: GxCore): string {
  const m = core.mod, h = new Fnv64();
  h.bytes(core.stream());
  const n = m._msl_gxw_region_count();
  for (let i = 0; i < n; i++) {
    const size = m._msl_gxw_region_size(i), p = m._msl_gxw_region_ptr(i);
    h.word(m._msl_gxw_region_addr(i)); h.word(size); h.word(m._msl_gxw_region_type(i));
    h.bytes(m.HEAPU8.subarray(p, p + size));
  }
  return h.hex();
}
