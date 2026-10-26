/* GX renderer: 32-bit floating point in whole numbers, for the pixel shader (GLSL ES 3.00).
 *
 * The raster spec rounds every float operation to binary32, in the order written, without fusing a multiply and an add. A GPU's own
 * float arithmetic may fuse them, and its division and square root are not required to round correctly, so the shader does these
 * operations in 32-bit unsigned integers on the IEEE bit patterns: a float is a `uint`. Results are correctly rounded (ties to even);
 * numbers below the smallest normal number are flushed to zero (the spec: "treat denormals as zero"); infinities and not-a-numbers are
 * carried through the way IEEE has them.
 */
export const SOFT_FLOAT_GLSL = /* glsl */ `
const uint F_NAN = 0x7fc00000u;
const uint F_ONE = 0x3f800000u;
const uint F_INF = 0x7f800000u;

// pack a rounded result: sign, biased exponent e, 24-bit mantissa m (bit 23 set), guard bit and sticky
uint f_pack(uint s, int e, uint m, uint guard, bool sticky) {
  if (guard == 1u && (sticky || (m & 1u) == 1u)) {
    m += 1u;
    if (m == 0x1000000u) { m = 0x800000u; e += 1; }
  }
  if (e >= 255) return (s << 31) | F_INF;
  if (e <= 0) return s << 31;
  return (s << 31) | (uint(e) << 23) | (m & 0x7fffffu);
}

// index of the highest set bit (GLSL ES 3.00 has no findMSB)
int f_msb(uint m) {
  int r = 0;
  if (m >= 0x10000u) { m >>= 16; r += 16; }
  if (m >= 0x100u) { m >>= 8; r += 8; }
  if (m >= 0x10u) { m >>= 4; r += 4; }
  if (m >= 4u) { m >>= 2; r += 2; }
  if (m >= 2u) { r += 1; }
  return r;
}

uint f_neg(uint a) { return a ^ 0x80000000u; }
uint f_abs(uint a) { return a & 0x7fffffffu; }
bool f_isnan(uint a) { return (a & 0x7fffffffu) > F_INF; }

uint f_add(uint a, uint b) {
  uint aa = a & 0x7fffffffu, ab = b & 0x7fffffffu;
  if (aa > F_INF || ab > F_INF) return F_NAN;
  bool ia = aa == F_INF, ib = ab == F_INF;
  if (ia || ib) {
    if (ia && ib && ((a ^ b) >> 31) == 1u) return F_NAN;
    return ia ? a : b;
  }
  if ((aa >> 23) == 0u) { a &= 0x80000000u; aa = 0u; }
  if ((ab >> 23) == 0u) { b &= 0x80000000u; ab = 0u; }
  if (aa == 0u && ab == 0u) return a & b & 0x80000000u;
  if (aa == 0u) return b;
  if (ab == 0u) return a;
  if (aa < ab) { uint t = a; a = b; b = t; t = aa; aa = ab; ab = t; }
  uint sa = a >> 31, sb = b >> 31;
  int ea = int(aa >> 23), eb = int(ab >> 23);
  uint ma = ((aa & 0x7fffffu) | 0x800000u) << 3;
  uint mb = ((ab & 0x7fffffu) | 0x800000u) << 3;
  int d = ea - eb;
  if (d > 0) {
    if (d >= 28) mb = 1u;
    else {
      uint lost = mb & ((1u << uint(d)) - 1u);
      mb = (mb >> uint(d)) | (lost != 0u ? 1u : 0u);
    }
  }
  uint m = (sa == sb) ? ma + mb : ma - mb;
  if (m == 0u) return 0u;
  int e = ea;
  if (m >= 0x8000000u) { m = (m >> 1) | (m & 1u); e += 1; }
  else {
    int sh = 26 - f_msb(m);
    if (sh > 0) { m <<= uint(sh); e -= sh; }
  }
  return f_pack(sa, e, m >> 3, (m >> 2) & 1u, (m & 3u) != 0u);
}

uint f_sub(uint a, uint b) { return f_add(a, f_neg(b)); }

uint f_mul(uint a, uint b) {
  uint s = (a ^ b) >> 31;
  uint aa = a & 0x7fffffffu, ab = b & 0x7fffffffu;
  if (aa > F_INF || ab > F_INF) return F_NAN;
  bool za = (aa >> 23) == 0u, zb = (ab >> 23) == 0u;
  bool ia = aa == F_INF, ib = ab == F_INF;
  if ((ia && zb) || (ib && za)) return F_NAN;
  if (ia || ib) return (s << 31) | F_INF;
  if (za || zb) return s << 31;
  int e = int(aa >> 23) + int(ab >> 23) - 127;
  uint ma = (aa & 0x7fffffu) | 0x800000u, mb = (ab & 0x7fffffu) | 0x800000u;
  uint ah = ma >> 12, al = ma & 0xfffu, bh = mb >> 12, bl = mb & 0xfffu;
  uint ll = al * bl, mid = al * bh + ah * bl, hh = ah * bh;
  uint lo = ll + ((mid & 0xfffu) << 12);
  uint hi = hh + (mid >> 12) + (lo >> 24);
  lo &= 0xffffffu;
  // the 48-bit product is hi * 2^24 + lo
  if (hi >= 0x800000u) {
    return f_pack(s, e + 1, hi, lo >> 23, (lo & 0x7fffffu) != 0u);
  }
  return f_pack(s, e, (hi << 1) | (lo >> 23), (lo >> 22) & 1u, (lo & 0x3fffffu) != 0u);
}

uint f_div(uint a, uint b) {
  uint s = (a ^ b) >> 31;
  uint aa = a & 0x7fffffffu, ab = b & 0x7fffffffu;
  if (aa > F_INF || ab > F_INF) return F_NAN;
  bool za = (aa >> 23) == 0u, zb = (ab >> 23) == 0u;
  bool ia = aa == F_INF, ib = ab == F_INF;
  if ((ia && ib) || (za && zb)) return F_NAN;
  if (ia || zb) return (s << 31) | F_INF;
  if (ib || za) return s << 31;
  int e = int(aa >> 23) - int(ab >> 23) + 127;
  uint ma = (aa & 0x7fffffu) | 0x800000u, mb = (ab & 0x7fffffu) | 0x800000u;
  uint r = ma;
  if (r < mb) { r <<= 1; e -= 1; }
  uint q = 0u;
  for (int i = 0; i < 25; i++) {
    q <<= 1;
    if (r >= mb) { r -= mb; q |= 1u; }
    r <<= 1;
  }
  return f_pack(s, e, q >> 1, q & 1u, r != 0u);
}

// float(n) for |n| < 2^24
uint f_from_int(int n) {
  if (n == 0) return 0u;
  uint s = n < 0 ? 1u : 0u;
  uint m = uint(n < 0 ? -n : n);
  int msb = f_msb(m);
  return (s << 31) | (uint(msb + 127) << 23) | ((m << uint(23 - msb)) & 0x7fffffu);
}

// the spec's trunc: toward zero; -2^31 when |x| >= 2^31 or not a number
int f_trunc(uint a) {
  int e = int((a >> 23) & 255u) - 127;
  if (e < 0) return 0;
  if (e >= 31) return -2147483647 - 1;
  uint m = (a & 0x7fffffu) | 0x800000u;
  uint v = e >= 23 ? (m << uint(e - 23)) : (m >> uint(23 - e));
  return (a >> 31) == 1u ? -int(v) : int(v);
}

// ordered key: integers compare like the floats (zeros equal); callers check for not-a-number
uint f_key(uint a) {
  if ((a << 1) == 0u) return 0x80000000u;
  return (a >> 31) == 1u ? ~a : (a | 0x80000000u);
}
bool f_lt(uint a, uint b) { return !f_isnan(a) && !f_isnan(b) && f_key(a) < f_key(b); }
bool f_gt(uint a, uint b) { return f_lt(b, a); }
bool f_le(uint a, uint b) { return !f_isnan(a) && !f_isnan(b) && f_key(a) <= f_key(b); }
bool f_ge(uint a, uint b) { return f_le(b, a); }
bool f_eq(uint a, uint b) { return !f_isnan(a) && !f_isnan(b) && f_key(a) == f_key(b); }
bool f_iszero(uint a) { return (a << 1) == 0u; }
`;
