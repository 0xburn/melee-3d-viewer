/* 3D replay viewer: the game's printf.
 *
 * Slippi's name plates hand the display name to the game's text routine as a printf format
 * (HSD_SisLib_803A6B98 calls its C library's vsnprintf with the name as the format and a va_list over whatever
 * its caller left in the argument registers and on the stack). This is that library's formatter as the executable
 * has it (Metrowerks' __pformatter and the routines under it): the specification parser (flags, width, precision,
 * sizes), the integer and floating point converters and the way an unknown specification ends the formatting.
 * The arguments are a `VaList`: r3 to r10 and f1 to f8 as saved, then the caller's stack from its first slot, taken
 * the way the executable's __va_arg takes them (two registers from an even one for 64 bits, 8 byte slots for
 * doubles).
 */

/** a byte of the game's memory (0 where it is not known) */
export type MemoryReader = (address: number) => number;

/** the arguments of a variadic call as __va_arg walks them */
export class VaList {
  /** next general register (r3 is 0; the formatter starts at 2: r3 and r4 are the text and the format) */
  gpr = 2;
  /** next floating point register (f1 is 0; f1 and f2 are the text's own x and y) */
  fpr = 2;
  private overflow = 0;
  constructor(readonly regs: ArrayLike<number>, readonly floats: ArrayLike<number>, readonly stack: ArrayLike<number>) {}
  private word(at: number): number {
    const k = Math.floor(at / 4);
    return (k >= 0 && k < this.stack.length ? this.stack[k] : 0) >>> 0;
  }
  /** an int (32 bits) */
  int(): number {
    if (this.gpr < 8) return (this.regs[this.gpr++] ?? 0) >>> 0;
    const v = this.word(this.overflow);
    this.overflow += 4;
    return v;
  }
  /** a long long: an even register and the next, or 8 aligned bytes of the stack */
  longLong(): bigint {
    let g = this.gpr;
    if (g < 7) {
      if (g & 1) g++;
      this.gpr = g + 2;
      return (BigInt(this.regs[g] >>> 0) << 32n) | BigInt(this.regs[g + 1] >>> 0);
    }
    this.gpr = 8;
    this.overflow = (this.overflow + 7) & ~7;
    const hi = this.word(this.overflow), lo = this.word(this.overflow + 4);
    this.overflow += 8;
    return (BigInt(hi) << 32n) | BigInt(lo);
  }
  /** a double: the next saved float register, then 8 aligned bytes of the stack */
  double(): number {
    const view = new DataView(new ArrayBuffer(8));
    if (this.fpr < 8) {
      view.setFloat64(0, this.floats[this.fpr++] ?? 0);
    } else {
      this.overflow = (this.overflow + 7) & ~7;
      view.setUint32(0, this.word(this.overflow));
      view.setUint32(4, this.word(this.overflow + 4));
      this.overflow += 8;
    }
    return view.getFloat64(0);
  }
}

const enum Just { Left = 0, Right = 1, Zero = 2 }

/** the parsed specification (parse_format): justification, sign option (1 always, 2 space), precision given, '#', size
 *  (1 hh, 2 h, 3 l, 4 ll, 5 L, 6 wide), conversion character (0xff: not a specification), width and precision */
interface Spec {
  just: Just; sign: number; precGiven: boolean; alt: boolean; size: number; conv: number; width: number; prec: number;
}

const INVALID = 0xff;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const s32 = (v: number) => v | 0;

/** parse_format (0x803252e4): `i` is the percent sign; returns the specification and the index after it */
function parseFormat(fmt: Uint8Array, i: number, va: VaList): { spec: Spec; next: number } {
  const at = (j: number) => (j < fmt.length ? fmt[j] : 0);
  const s: Spec = { just: Just.Right, sign: 0, precGiven: false, alt: false, size: 0, conv: 0, width: 0, prec: 0 };
  if (at(i + 1) === 0x25) { s.conv = 0x25; return { spec: s, next: i + 2 }; }
  let j = i + 1, c = at(j);
  for (;;) {
    if (c === 0x2d) s.just = Just.Left;
    else if (c === 0x2b) s.sign = 1;
    else if (c === 0x20) { if (s.sign !== 1) s.sign = 2; }
    else if (c === 0x23) s.alt = true;
    else if (c === 0x30) { if (s.just !== Just.Left) s.just = Just.Zero; }
    else break;
    c = at(++j);
  }
  if (c === 0x2a) {
    const w = s32(va.int());
    s.width = w;
    if (w < 0) { s.just = Just.Left; s.width = -w; }
    c = at(++j);
  } else {
    while (isDigit(c)) { s.width = s.width * 10 + c - 0x30; c = at(++j); }
  }
  if (s.width > 0x1fd) { s.conv = INVALID; return { spec: s, next: j + 1 }; }
  if (c === 0x2e) {
    s.precGiven = true;
    c = at(++j);
    if (c === 0x2a) {
      const p = s32(va.int());
      s.prec = p;
      if (p < 0) s.precGiven = false;
      c = at(++j);
    } else {
      while (isDigit(c)) { s.prec = s.prec * 10 + c - 0x30; c = at(++j); }
    }
  }
  let sized = true;
  if (c === 0x68) { s.size = 2; if (at(j + 1) === 0x68) { s.size = 1; j++; } }
  else if (c === 0x6c) { s.size = 3; if (at(j + 1) === 0x6c) { s.size = 4; j++; } }
  else if (c === 0x4c) s.size = 5;
  else sized = false;
  if (sized) c = at(++j);
  s.conv = c;
  let bad = false;
  switch (c) {
    case 0x64: case 0x69: case 0x6f: case 0x75: case 0x78: case 0x58:
      if (s.size === 5) bad = true;
      else if (!s.precGiven) s.prec = 1;
      else if (s.just === Just.Zero) s.just = Just.Right;
      break;
    case 0x66:
      if (s.size === 2 || s.size === 4) bad = true;
      else if (!s.precGiven) s.prec = 6;
      break;
    case 0x45: case 0x47: case 0x65: case 0x67:
      if ((c === 0x47 || c === 0x67) && s.prec === 0) s.prec = 1;
      if (s.size === 2 || s.size === 4 || s.size === 1) bad = true;
      else if (!s.precGiven) s.prec = 6;
      break;
    case 0x70: s.conv = 0x78; s.alt = true; s.size = 3; s.prec = 8; break;
    case 0x63:
      if (s.size === 3) s.size = 6;
      else if (s.precGiven || s.size !== 0) bad = true;
      break;
    case 0x73:
      if (s.size === 3) s.size = 6;
      else if (s.size !== 0) bad = true;
      break;
    case 0x6e:
      if (s.size === 5) bad = true;
      break;
    default: bad = true;
  }
  if (bad) s.conv = INVALID;
  return { spec: s, next: j + 1 };
}

const bytesOf = (s: string) => Array.from(s, (ch) => ch.charCodeAt(0));

/** long2str / longlong2str (0x803250c0, 0x80324de0): an integer's digits with the flags; null when it runs too long */
function integerText(value: bigint, s: Spec): number[] | null {
  const conv = s.conv;
  const signed = conv === 0x64 || conv === 0x69;
  let sign = s.sign, prec = s.prec;
  if (value === 0n && prec === 0 && !(s.alt && conv === 0x6f)) return [];
  let minus = false;
  let base = 16n;
  if (signed) { base = 10n; if (value < 0n) { value = -value; minus = true; } }
  else if (conv === 0x6f) { base = 8n; sign = 0; }
  else if (conv === 0x75) { base = 10n; sign = 0; }
  else sign = 0;
  const out: number[] = [];
  let u = value;
  do {
    const d = Number(u % base);
    u /= base;
    out.push(d < 10 ? d + 0x30 : conv === 0x78 ? d + 0x57 : d + 0x37);
  } while (u !== 0n);
  out.reverse();
  if (base === 8n && s.alt && out[0] !== 0x30) out.unshift(0x30);
  if (s.just === Just.Zero) {
    prec = s.width;
    if (minus || sign) prec--;
    if (base === 16n && s.alt) prec -= 2;
  }
  if (out.length + Math.max(prec - out.length, 0) > 0x1fd) return null;
  while (out.length < prec) out.unshift(0x30);
  if (base === 16n && s.alt) out.unshift(0x30, conv);
  if (minus) out.unshift(0x2d);
  else if (sign === 1) out.unshift(0x2b);
  else if (sign === 2) out.unshift(0x20);
  return out;
}

// ---------------------------------------------------------------- floating point

/** the digits of a double to 32 significant digits (the executable's __num2dec asked for 32): [sign, digits, exponent
 *  of the last digit]; 'I' infinity, 'N' not a number, '0' zero */
function numToDecimal(x: number): [boolean, string, number] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0), lo = view.getUint32(4);
  const neg = (hi >>> 31) === 1;
  const e = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (e === 0x7ff) return [neg, m === 0n ? "I" : "N", 0];
  let exp2: number;
  if (e === 0) { exp2 = -1074; if (m === 0n) return [neg, "0", 0]; }
  else { m |= 1n << 52n; exp2 = e - 1075; }
  let digits: string, exp10 = 0;
  if (exp2 >= 0) digits = (m << BigInt(exp2)).toString();
  else { digits = (m * 5n ** BigInt(-exp2)).toString(); exp10 = exp2; }
  if (digits.length > 32) {
    // (round to 32 digits, half to even: the digits are exact)
    const cut = digits.length - 32;
    const kept = digits.slice(0, 32), rest = digits.slice(32);
    let up = false;
    const first = rest.charCodeAt(0) - 0x30;
    if (first > 5) up = true;
    else if (first === 5) up = /[1-9]/.test(rest.slice(1)) || (kept.charCodeAt(31) & 1) === 1;
    let n = BigInt(kept) + (up ? 1n : 0n);
    digits = n.toString();
    exp10 += cut + (digits.length - 32);
    if (digits.length > 32) digits = digits.slice(0, 32);
  }
  return [neg, digits, exp10];
}

/** round_decimal (0x80324cac): keep n digits of a digit string with the exponent of its first digit, half to even */
function roundDecimal(digits: string, e10: number, n: number): [string, number] {
  if (n < 0) return ["0", 0];
  if (n >= digits.length) return [digits, e10];
  const c = digits.charCodeAt(n) - 0x30;
  let up: boolean;
  if (c !== 5) up = c > 5;
  else if (/[1-9]/.test(digits.slice(n + 1))) up = true;
  else up = n > 0 && (digits.charCodeAt(n - 1) & 1) === 1;
  const kept = digits.slice(0, n).split("");
  if (up) {
    let i = n - 1;
    for (; i >= 0; i--) {
      if (kept[i] === "9") continue;
      kept[i] = String.fromCharCode(kept[i].charCodeAt(0) + 1);
      kept.length = i + 1;
      break;
    }
    if (i < 0) return ["1", e10 + 1];
  }
  return kept.length ? [kept.join(""), e10] : ["0", 0];
}

/** float2str (0x80324674): e, E, f, g and G; null when it runs too long */
function floatText(x: number, s: Spec): number[] | null {
  let prec = s.prec, conv = s.conv;
  if (prec > 0x1fd) return null;
  const [neg, d0, exp0] = numToDecimal(x);
  if (d0 === "I") return bytesOf(neg ? "-Inf" : "Inf");
  if (d0 === "N") return bytesOf("NaN");
  let digits = d0, e10: number;
  if (digits[0] === "0") { digits = "0"; e10 = 0; }
  else {
    let exp = exp0;
    while (digits.length > 1 && digits.endsWith("0")) { digits = digits.slice(0, -1); exp++; }
    e10 = exp + digits.length - 1;
  }
  const sign = neg ? "-" : s.sign === 1 ? "+" : s.sign === 2 ? " " : "";
  let useE = conv === 0x65 || conv === 0x45;
  if (conv === 0x67 || conv === 0x47) {
    if (digits.length > prec) [digits, e10] = roundDecimal(digits, e10, prec);
    if (e10 < -4 || e10 >= prec) {
      useE = true;
      prec = s.alt ? prec - 1 : digits.length - 1;
      conv = conv === 0x67 ? 0x65 : 0x45;
    } else {
      prec = s.alt ? prec - (e10 + 1) : Math.max(digits.length - (e10 + 1), 0);
      conv = 0x66;
    }
  }
  if (useE) {
    if (digits.length > prec + 1) [digits, e10] = roundDecimal(digits, e10, prec + 1);
    if (digits.length < prec + 1) digits += "0".repeat(prec + 1 - digits.length);
    const exp = (e10 >= 0 ? "+" : "-") + String(Math.abs(e10)).padStart(2, "0");
    const mant = digits[0] + (prec > 0 || s.alt ? "." + digits.slice(1) : "");
    return bytesOf(sign + mant + String.fromCharCode(conv) + exp);
  }
  let frac = Math.max(digits.length - e10 - 1, 0);
  if (frac > prec) {
    [digits, e10] = roundDecimal(digits, e10, digits.length - (frac - prec));
    frac = Math.max(digits.length - e10 - 1, 0);
  }
  const ints = e10 + 1 > 0 ? e10 + 1 : 0;
  let ip: string, fp: string;
  if (digits === "0") { ip = "0"; fp = ""; }
  else if (ints) { ip = digits.slice(0, ints).padEnd(ints, "0"); fp = digits.slice(ints); }
  else { ip = "0"; fp = "0".repeat(-e10 - 1) + digits; }
  fp = fp.padEnd(prec, "0");
  if (ip.length + fp.length > 0x1fd) return null;
  return bytesOf(sign + ip + (prec > 0 || s.alt ? "." + fp : ""));
}

// ---------------------------------------------------------------- the formatter

function cString(mem: MemoryReader, at: number, limit = 4096): number[] {
  const out: number[] = [];
  while (out.length < limit) { const b = mem(at + out.length); if (b === 0) break; out.push(b); }
  return out;
}

/** __pformatter (0x80324044) over the format's bytes (up to its first zero): the formatted bytes, embedded zeros kept. A
 *  specification that is not one the library knows ends the formatting: the rest of the format from its percent sign
 *  is written as it stands. */
export function vsprintf(format: ArrayLike<number>, va: VaList, mem: MemoryReader = () => 0): Uint8Array {
  let end = 0;
  while (end < format.length && format[end] !== 0) end++;
  const fmt = new Uint8Array(end);
  for (let k = 0; k < end; k++) fmt[k] = format[k];
  const out: number[] = [];
  let i = 0;
  while (i < end) {
    const j = fmt.indexOf(0x25, i);
    if (j < 0) { for (let k = i; k < end; k++) out.push(fmt[k]); break; }
    for (let k = i; k < j; k++) out.push(fmt[k]);
    const { spec: s, next } = parseFormat(fmt, j, va);
    const conv = s.conv;
    let text: number[] | null = null;
    if (conv === 0x64 || conv === 0x69 || conv === 0x6f || conv === 0x75 || conv === 0x78 || conv === 0x58) {
      const unsigned = conv !== 0x64 && conv !== 0x69;
      if (s.size === 4) {
        const v = va.longLong();
        text = integerText(unsigned ? v : BigInt.asIntN(64, v), s);
      } else {
        let v = va.int();
        if (s.size === 2) v = unsigned ? v & 0xffff : (v << 16) >> 16;
        else if (s.size === 1) v = unsigned ? v & 0xff : (v << 24) >> 24;
        text = integerText(BigInt(unsigned ? v >>> 0 : v | 0), s);
      }
    } else if (conv === 0x65 || conv === 0x45 || conv === 0x66 || conv === 0x67 || conv === 0x47) {
      text = floatText(va.double(), s);
    } else if (conv === 0x73) {
      const p = va.int();
      let body: number[];
      if (s.size === 6) {
        // (a wide string, converted by wcstombs: each 16-bit unit's low byte, up to one that is zero)
        const raw: number[] = [];
        for (let k = 0; p && k < 0x200; k++) {
          const lo = mem(p + 2 * k + 1);
          if (lo === 0) break;
          raw.push(lo);
        }
        body = s.alt ? raw.slice(1, 1 + (raw[0] ?? 0)) : raw;
      } else body = p === 0 ? [] : s.alt ? Array.from({ length: mem(p) }, (_, k) => mem(p + 1 + k)) : cString(mem, p);
      if (s.precGiven && body.length > s.prec) body = body.slice(0, s.prec);
      text = body;
    } else if (conv === 0x6e) {
      va.int();
      i = next;
      continue;
    } else if (conv === 0x63) {
      text = [va.int() & 0xff];
    } else if (conv === 0x25) {
      text = [0x25];
    }
    if (text === null) {
      // (not a specification it knows, or one that runs too long: the rest as written)
      for (let k = j; k < end; k++) out.push(fmt[k]);
      break;
    }
    const pad = Math.max(s.width - text.length, 0);
    if (s.just !== Just.Left) {
      const fill = s.just === Just.Zero ? 0x30 : 0x20;
      if ((text[0] === 0x2b || text[0] === 0x2d) && fill === 0x30) { out.push(text[0]); text = text.slice(1); }
      for (let k = 0; k < pad; k++) out.push(fill);
      out.push(...text);
    } else {
      out.push(...text);
      for (let k = 0; k < pad; k++) out.push(0x20);
    }
    i = next;
  }
  return Uint8Array.from(out);
}
