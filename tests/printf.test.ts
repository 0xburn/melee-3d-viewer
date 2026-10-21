// msl.ts: the game's printf (the executable's formatter, checked against 2.5 thousand formats run through a port of
// the same code and, in the name plates' tests, against the game's own draws).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { VaList, vsprintf } from "../src/render3d/msl.ts";

const fixtures = JSON.parse(fs.readFileSync(new URL("./printf-fixtures.json", import.meta.url), "utf8")) as {
  regs: number[]; floats: number[]; stack: number[]; strings: Record<string, string>; cases: [string, string][];
};
const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const strings = Object.entries(fixtures.strings).map(([a, h]) => [Number(a), hex(h)] as const);
const mem = (a: number) => {
  for (const [base, s] of strings) if (a >= base && a <= base + s.length) return a - base < s.length ? s[a - base] : 0;
  return 0;
};
const run = (fmt: Uint8Array) => vsprintf(fmt, new VaList(fixtures.regs, fixtures.floats, fixtures.stack), mem);
const text = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const out = (s: string) => String.fromCharCode(...run(text(s)));

// (one conversion at a time, each from the first argument's place)
const one = (f: string) => out(f);
test("integers: width, precision, flags and sizes as the library has them", () => {
  assert.equal(one("%d"), "16");
  assert.equal(one("%5d"), "   16");
  assert.equal(one("%-5d|"), "16   |");
  assert.equal(one("%05d"), "00016");
  assert.equal(one("%+d"), "+16");
  assert.equal(one("% d"), " 16");
  assert.equal(one("%x"), "10");
  assert.equal(one("%X"), "10");
  assert.equal(one("%#x"), "0x10");
  assert.equal(one("%#X"), "0X10");
  assert.equal(one("%o"), "20");
  assert.equal(one("%#o"), "020");
  assert.equal(one("%u"), "16");
  assert.equal(one("%d%d"), "16" + String(0x2000));
  // (its zero with an alternate form still has its prefix, and a zero with a precision of zero has no digits)
  const zeros = (f: string) => String.fromCharCode(...vsprintf(text(f), new VaList([0, 0, 0, 0, 0, 0, 0, 0], [], [])));
  assert.equal(zeros("%#x"), "0x0");
  assert.equal(zeros("%.0d|"), "|");
  assert.equal(zeros("%#.0o"), "0");
  assert.equal(one("%hd"), "16");
  assert.equal(one("%p"), "0x00000010");
});

test("percent signs: %% is one, a specification the library does not know ends the formatting and the rest stands", () => {
  assert.equal(one("100%%"), "100%");
  assert.equal(one("50%"), "50%");
  assert.equal(one("%y%d"), "%y%d");
  assert.equal(one("%jd|"), "%jd|");
  assert.equal(one("%Ld"), "%Ld");
  assert.equal(one("a%5%b"), "a%5%b");
  assert.equal(one("%510d"), "%510d");
});

test("floating point and strings come from the float registers and the memory the arguments point at", () => {
  // (f1 and f2 are the text's own; the first conversion reads f3)
  assert.equal(one("%f"), "1.500000");
  assert.equal(one("%G%g"), "1.5640");
  assert.equal(one("%e"), "1.500000e+00");
  assert.equal(one("%d%s"), "16Hello, world");
  assert.equal(one("%d%d%.3s|"), "16" + String(0x2000) + "-5|".slice(0, 0) + "|");
});

test("the formatter agrees with the library's code over 2.5 thousand formats", () => {
  let bad = 0;
  for (const [f, o] of fixtures.cases) {
    const got = Array.from(run(hex(f)), (b) => b.toString(16).padStart(2, "0")).join("");
    if (got !== o) {
      if (bad++ < 5) console.log("differs:", String.fromCharCode(...hex(f)), "->", String.fromCharCode(...hex(o)), "vs", String.fromCharCode(...hex(got)));
    }
  }
  assert.equal(bad, 0);
});
