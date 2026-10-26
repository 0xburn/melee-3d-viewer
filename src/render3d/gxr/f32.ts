/* GX renderer: 32-bit float helpers. The raster spec's formulas round every operation to binary32; in JavaScript a
 * double holds a float exactly, and rounding the result of one + - * / or a square root to a float with Math.fround gives
 * the correctly rounded float result (a double has more than twice the bits). So `f(a * b)` is one float multiplication. */

export const f = Math.fround;

const dv = new DataView(new ArrayBuffer(8));

/** the IEEE bit pattern of a float */
export function bitsOf(x: number): number { dv.setFloat32(0, x); return dv.getUint32(0); }
/** the float with a bit pattern */
export function fromBits(b: number): number { dv.setUint32(0, b >>> 0); return dv.getFloat32(0); }

/** the spec's trunc: toward zero, and -2^31 when the magnitude reaches 2^31 or the value is not a number */
export function trunc32(x: number): number {
  if (!(x > -2147483648 && x < 2147483648)) return -2147483648;
  return Math.trunc(x) | 0;
}

/** float(n) of an integer */
export const flt = (n: number): number => f(n);

/** binary32 square root */
export const fsqrt = (x: number): number => f(Math.sqrt(x));

/** a float from the 24-bit-ish register bits as the spec builds them (an int pattern) */
export const ONE_MINUS_EPS = f(1 - f(1e-7));
