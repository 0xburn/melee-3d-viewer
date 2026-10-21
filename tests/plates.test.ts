// plates.ts: Slippi's name plates lettered with the game's own font - the name through the string routine's
// table, the kerned and centered line, the quads' size, the plate's width. The tests marked withGameFiles read
// the font out of your game's executable (tests/game-files.ts).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { glyphAtlas, nameBytes, plateFontFromDol, plateText, plateTexts, rawBytes, runPlates, type PlateFont } from "../src/render3d/plates.ts";
import { ascii, sisBody, sisString } from "../src/render3d/sistext.ts";
import { vsprintf, VaList } from "../src/render3d/msl.ts";
import { gameFiles, withGameFiles } from "./game-files.ts";

/** a font of 287 blank glyphs with the trims given, and the full-width Latin pairs 'a' (glyph 1) to 'z' (glyph 26) */
function tiny(trims: Record<number, [number, number]>): PlateFont {
  const kern = new Uint8Array(0x240).fill(1);
  for (const [g, [l, r]] of Object.entries(trims)) { kern[+g * 2] = l; kern[+g * 2 + 1] = r; }
  const sjis = new Uint8Array(0x240), codes = new Uint8Array(0x240);
  for (let k = 0; k < 26; k++) {
    sjis.set([0x82, 0x81 + k], (k + 1) * 2);
    codes.set([0x20, k + 1], (k + 1) * 2);
  }
  const common = { font: { images: new Uint8Array(287 * 512), kern }, sjis, codes, colors: [], names: [] };
  return { common, atlas: null };
}

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);

test("a name's quads: the text's scale is 1.035, a glyph's pen advancing by that times (34 - right - next left) / 32", () => {
  // 'a' trims 3 and 6, 'b' 4 and 2
  const t = plateText(tiny({ 1: [3, 6], 2: [4, 2] }), "ab");
  assert.equal(t.count, 2);
  for (let k = 0; k < 2; k++) {
    near(t.quads[k * 8 + 2] - t.quads[k * 8], 1.035);
    near(t.quads[k * 8 + 1] - t.quads[k * 8 + 3], 1.035);
  }
  // (a glyph is drawn its left trim less one, times the scale, left of its pen: the lefts step by (34 - right - next left))
  near(t.quads[8] - t.quads[0], 1.035 * (34 - 6 - 4) / 32);
  // the line is centered: its pen width about 0, the first glyph's left that far less its trim's step
  const pen = 1.035 * ((32 - (3 + 6 - 2)) + (32 - (4 + 2 - 2)));
  near(t.quads[0], -pen / 2 / 32 - 1.035 * (3 - 1) / 32);
});

test("a line wider than 288 text pixels is squeezed to it (the glyphs too), a narrower one is not", () => {
  // twelve 'a's of 32 pixels a glyph less their trims (1, 1): 12 x 32 x 1.035 = 397 text pixels
  const t = plateText(tiny({}), "aaaaaaaaaaaa");
  const fit = 288 / (12 * 32 * 1.035);
  near(t.quads[2] - t.quads[0], 1.035 * fit);
  // (the twelve fill the 9 units)
  near(t.quads[11 * 8 + 2] - t.quads[0], 9);
  const one = plateText(tiny({}), "aa");
  near(one.quads[2] - one.quads[0], 1.035);
});

test("a name's bytes: ASCII as it is, any other character by its Shift-JIS code (a half-width kana one byte), what Shift-JIS lacks left out", () => {
  assert.deepEqual([...nameBytes("Ab c")], [0x41, 0x62, 0x20, 0x63]);
  // (a pair the font has, a pair it has no glyph for, a half-width kana, an emoji)
  assert.deepEqual([...nameBytes("あx亜ｱ\u{1F600}")], [0x82, 0xa0, 0x78, 0x88, 0x9f, 0xb1]);
  assert.equal(plateText(tiny({}), "").count, 0);
});

test("a name's bytes as the replay holds them: up to the first zero, 31 at most", () => {
  assert.deepEqual([...rawBytes("Hi\x81I\0junk")], [0x48, 0x69, 0x81, 0x49]);
  assert.equal(rawBytes("a".repeat(40)).length, 31);
  // (the replay's bytes are what the game was given: a full-width "!" is a glyph, a plain "!" takes the next byte)
  const f = tiny({});
  assert.equal(plateText(f, "a!", Uint8Array.from([0x61, 0x81, 0x49])).count, 1);
  assert.equal(plateText(f, "a!b").count, 1);
});

test("the formatter: the name is a printf format whose first argument is 16", () => {
  const f = (s: string) => String.fromCharCode(...vsprintf(ascii(s), new VaList([0, 0, 16], [], [])));
  assert.equal(f("Mango"), "Mango");
  assert.equal(f("%d"), "16");
  assert.equal(f("%x"), "10");
  assert.equal(f("%5d"), "   16");
  assert.equal(f("%-4dA"), "16  A");
  assert.equal(f("%04d"), "0016");
  assert.equal(f("N%%"), "N%");
  assert.equal(f("N%dN"), "N16N");
  assert.equal(f("%sN"), "N");
  assert.equal(f("A%"), "A%");
  assert.equal(f("%yz"), "%yz");
});

test("the conversions after the first read what the caller left: registers, the text's address, the stack", () => {
  const tiny0 = tiny({}).common;
  const run = (name: string, k = 0) => runPlates(tiny0, [ascii("x"), ascii(name)].slice(1 - Math.min(k, 1)), [0, 1].slice(1 - Math.min(k, 1)), 32).at(-1)!;
  const text = (r: { printed: Uint8Array }) => String.fromCharCode(...r.printed);
  // (the first plate: r5 16, the text 0x80bd91d0 + 0x0, r7 0x804ce380, r8 0x804d0000, r9 0x50, r10 8, then the stack)
  assert.equal(text(run("%d,%d,%d,%d,%d,%d,%d")), "16,-2135060016,-2142444672,-2142437376,80,8,1127219200");
  // (the second plate's: the text 0x170 on, r9 1, r10 the first plate's ops end)
  const second = text(run("%d,%d,%d,%d,%d", 1)).split(",");
  assert.equal(second[1], String(0x80bd9340 - 2 ** 32));
  assert.equal(second[4], "1");
});

test("the string routine: a digit narrows like a space, a lone lead byte takes the next byte and, at the end, reads on past it", () => {
  const c = tiny({}).common;
  const narrow = [0x0a, 0xf4, 0, 0, 0];
  const has = (ops: number[]) => ops.some((_, k) => narrow.every((v, j) => ops[k + j] === v));
  assert.ok(has(sisString(ascii("1"), 0, 0, [255, 255, 255], null, c)));
  assert.ok(!has(sisString(ascii("a"), 0, 0, [255, 255, 255], null, c)));
  const glyphs = (ops: number[]) => ops.filter((_, k) => ops[k - 1] === 0x20);
  // "a!b": the '!' takes the 'b' for its second byte, so only the 'a' is drawn
  assert.deepEqual(glyphs(sisString(ascii("a!b"), 0, 0, [255, 255, 255], null, c)), [1]);
  // "b?" ends in a lead byte: its second byte is the terminator, and the routine goes on to what the buffer held
  const past = new Uint8Array(40);
  past[3] = 0x61; // an 'a' (glyph 1) three bytes in
  assert.deepEqual(glyphs(sisString(ascii("b?"), 0, 0, [255, 255, 255], null, c, past)), [2, 1]);
  assert.deepEqual(glyphs(sisString(ascii("b?"), 0, 0, [255, 255, 255], null, c)), [2]);
  // (the ops are written over the string when they run longer than the 128 bytes before it, and a digit's byte is read again after its narrowing op)
  const eleven = sisBody(Uint8Array.from([...ascii("12345678901"), 0]), c);
  assert.equal(eleven.filter((v, k) => v === 0x0a && eleven[k + 1] === 0xf4).length, 1);
});

test("the plate's width follows the name's glyphs: (20 - left trim) summed, held to 60..144, times 0.0146", () => {
  const f = tiny({ 1: [10, 1] });
  // five 'a's: 5 x 10 = 50, under the minimum
  near(plateText(f, "aaaaa").width, 60 * 0.0146);
  // ten: 100
  near(plateText(f, "aaaaaaaaaa").width, 100 * 0.0146);
  // twenty: 200, over the cap
  near(plateText(f, "aaaaaaaaaaaaaaaaaaaa").width, 144 * 0.0146);
  // (the edges the game's draws show: 60 is the minimum itself, 61 is 61 times the slope, 144 and 145 the cap)
  near(plateText(f, "aaaaaa").width, 60 * 0.0146);
  const g = tiny({ 1: [10, 1], 2: [19, 1] });
  near(plateText(g, "aaaaaab").width, 61 * 0.0146);
  const h = tiny({ 1: [10, 1], 2: [16, 1] });
  near(plateText(h, "aaaaaaaaaaaaaab").width, 144 * 0.0146);   // 140 + 4
  near(plateText(h, "aaaaaaaaaaaaaaa").width, 144 * 0.0146);   // 150
  near(plateText(h, "aaaaaaaaaaaaab").width, 134 * 0.0146);    // 130 + 4
});

test("the atlas holds every glyph in a cell with its edge repeated, rows top down", () => {
  const f = tiny({});
  f.common.font.images[512 + 0] = 0xf0; // glyph 1: its first row's first texel full, second empty
  const a = glyphAtlas(f);
  assert.equal(glyphAtlas(f), a);
  const { w, h, rgba } = a.sprite;
  assert.equal(rgba.length, w * h * 4);
  // glyph 1 is the second cell: its first texel is 1 in and 1 down from the cell's corner
  const cell = 34, x = cell + 1, y = 1;
  assert.equal(rgba[(y * w + x) * 4 + 3], 255);
  assert.equal(rgba[(y * w + x + 1) * 4 + 3], 0);
  // (the edge repeated)
  assert.equal(rgba[(0 * w + x) * 4 + 3], 255);
  assert.equal(rgba[(y * w + cell) * 4 + 3], 255);
  near(a.uv[4], (cell + 1) / w);
  near(a.uv[6], (cell + 33) / w);
  near(a.uv[7] - a.uv[5], 32 / h);
});

// "Diamond Player" in Slippi's playback: the lefts of the game's 14 glyph quads (a capture's draws, HUD units),
// from the middle of the line
const DIAMOND_LEFTS = [-24.82938, -24.17859, -23.64406, -22.79375, -21.95656, -21.30031, -20.64406, -20.02016, -19.39297,
                       -18.83703, -18.36281, -17.67422, -17.01906, -16.45984].map((x) => x + 20.2);

function executable(): ArrayBuffer {
  const b = fs.readFileSync(path.join(gameFiles!, fs.existsSync(path.join(gameFiles!, "Start.dol")) ? "Start.dol" : "main.dol"));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

// "Platinum Player" and "Master Player" in the same captures: the lefts of the game's glyph quads in screen pixels
// (to 0.1) of the 640 wide picture, the line's middle at -20.2 and -6.2 units; the first is squeezed to the box
// (0.983 a glyph wide), the second runs on at 1.035
const PLATINUM_PX = [50.6, 56.5, 61.6, 68.2, 73.2, 78.9, 85.9, 95.3, 103.8, 110.5, 116.4, 121.5, 128.8, 135.8, 141.7];
const MASTER_PX = [207.6, 216.7, 223.7, 230.4, 236.7, 243.0, 249.0, 256.0, 262.3, 267.5, 275.2, 282.6, 288.9];
// (the HUD camera: 41.539 degrees over, aspect 1.217, 64 away)
const HALF = 64 * Math.tan(41.539 * Math.PI / 360) * 1.217;
const px = (x: number) => 320 + x / HALF * 320;

test("the game's font and layout put 'Diamond Player' where the game's quads are", withGameFiles, () => {
  const font = plateFontFromDol(executable())!;
  assert.ok(font);
  const t = plateText(font, "Diamond Player");
  assert.equal(t.count, 14);
  for (let k = 0; k < 14; k++) near(t.quads[k * 8], DIAMOND_LEFTS[k], 2e-5);
  // (a name this long is exactly the box's 288 pixels, its glyphs 1.000 wide, and the plate for it the cap)
  near(t.quads[2] - t.quads[0], 1);
  near(t.width, 144 * 0.0146);
});

test("the game's font squeezes 'Platinum Player' to the box and lets 'Master Player' run on, as its quads do", withGameFiles, () => {
  const font = plateFontFromDol(executable())!;
  const p = plateText(font, "Platinum Player"), m = plateText(font, "Master Player");
  assert.equal(p.count, 15);
  assert.equal(m.count, 13);
  for (let k = 0; k < 15; k++) near(px(-20.2 + p.quads[k * 8]), PLATINUM_PX[k], 0.1);
  for (let k = 0; k < 13; k++) near(px(-6.2 + m.quads[k * 8]), MASTER_PX[k], 0.1);
  near(p.quads[2] - p.quads[0], 288 / 293);
  near(m.quads[2] - m.quads[0], 1.035, 1e-6);
});

// Games' plates as the game drew them (plates-fixtures.json: captures of copies of public replays with only the display
// names changed, on every port and in the stages measured): per game its stage, ports, names (hex), the glyph the
// game drew for each quad of each plate (its 32 by 32 quad's picture through the font's hash), and each plate's x scale
// in its draw. `stale` are the heap words the game's frame held that no replay can tell (see StaleWords), from the
// captures that have a trace of them; the others use the defaults.
interface GameFixture { id: string; stage: number; ports: number[]; names: string[]; stale: Record<string, number>[] | null; glyphs: number[][]; scales: number[] }
const FIXTURES = JSON.parse(fs.readFileSync(new URL("./plates-fixtures.json", import.meta.url), "utf8")) as GameFixture[];

function glyphIndexes(font: PlateFont, t: { quads: Float32Array; count: number }): number[] {
  const { w, h } = glyphAtlas(font).sprite;
  const seq: number[] = [];
  for (let k = 0; k < t.count; k++) {
    const col = Math.round(t.quads[k * 8 + 4] * w - 1) / 34, row = Math.round(t.quads[k * 8 + 5] * h - 1) / 34;
    seq.push(Math.round(row) * 17 + Math.round(col));
  }
  return seq;
}

test("the game's plates for every captured game: the same glyphs and the same plate width on every port", withGameFiles, () => {
  const font = plateFontFromDol(executable())!;
  let plates = 0;
  for (const g of FIXTURES) {
    const names = g.names.map((hex) => Uint8Array.from(hex.match(/../g)!.map((x) => parseInt(x, 16))));
    const made = plateTexts(font, names.map((raw, k) => ({ port: g.ports[k], name: "", raw })), g.stage, g.stale ?? undefined);
    made.forEach((t, k) => {
      assert.deepEqual(glyphIndexes(font, t), g.glyphs[k], `${g.id}: glyphs of plate ${k} (${g.names[k]})`);
      near(t.width, g.scales[k], 6e-5);
      plates++;
    });
  }
  assert.ok(plates > 400);
});
