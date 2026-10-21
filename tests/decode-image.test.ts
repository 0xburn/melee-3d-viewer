// hsd.ts decodeImage: the faster decoder gives the old decoder's pixels, in every GX format, for sizes that are not whole
// blocks, palettes of each format with indexes past their end, and data that ends early (both stop alike).

import test from "node:test";
import assert from "node:assert/strict";
import { decodeImage, type Archive, type Image, type Tlut } from "../src/render3d/hsd.ts";
import { decodeImageReference } from "./decode-reference.ts";

let seed = 20261021;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

function archive(bytes: number): Archive {
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i++) u[i] = Math.floor(rnd() * 256);
  return { data: new DataView(u.buffer) } as unknown as Archive;
}

function run(a: Archive, img: Image, tlut: Tlut | null) {
  const one = (f: () => Uint8Array) => { try { return f(); } catch (e) { return String(e).slice(0, 30); } };
  return [one(() => decodeImage(a, img, tlut)), one(() => decodeImageReference(a, img, tlut))];
}

test("every GX format decodes as before", () => {
  const sizes = [[8, 8], [16, 16], [13, 7], [64, 32], [5, 21], [1, 1], [32, 8]];
  let n = 0;
  for (const f of [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 14]) {
    for (const [w, h] of sizes) {
      const a = archive(70000);
      for (const tlut of f >= 8 && f <= 10 ? [0, 1, 2].map((format) => ({ dataOff: 40000, count: 256, format }) as Tlut).concat([{ dataOff: 40000, count: 16, format: 2 } as Tlut, null as unknown as Tlut]) : [null]) {
        const [x, y] = run(a, { width: w, height: h, format: f, dataOff: 100 } as Image, tlut);
        assert.deepEqual(x instanceof Uint8Array ? Array.from(x) : x, y instanceof Uint8Array ? Array.from(y) : y, `format ${f} ${w}x${h}`);
        n++;
      }
    }
  }
  assert.ok(n > 100);
});

test("a palette on a picture that is not color-indexed changes nothing", () => {
  const a = archive(4000);
  const [x, y] = run(a, { width: 8, height: 8, format: 5, dataOff: 0 } as Image, { dataOff: 3000, count: 64, format: 1 } as Tlut);
  assert.deepEqual(Array.from(x as Uint8Array), Array.from(y as Uint8Array));
});

test("data that ends early stops the same way", () => {
  for (const f of [0, 3, 4, 5, 6, 9, 14]) {
    for (const size of [40, 100, 333, 1000]) {
      const a = archive(size);
      const [x, y] = run(a, { width: 32, height: 32, format: f, dataOff: 0 } as Image, f === 9 ? ({ dataOff: 0, count: 8, format: 2 } as Tlut) : null);
      assert.deepEqual(x instanceof Uint8Array ? Array.from(x) : x, y instanceof Uint8Array ? Array.from(y) : y, `format ${f} data ${size}`);
    }
  }
});

test("a format the GX does not have is an error", () => {
  const a = archive(100);
  assert.throws(() => decodeImage(a, { width: 8, height: 8, format: 7, dataOff: 0 } as Image, null));
});
