// plates.ts: Slippi's name plates lettered with the game's own font - the name through the string routine's
// table, the kerned and centered line, the quads' size, the plate's width. The tests marked withGameFiles read
// the font out of your game's executable (tests/game-files.ts).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { glyphAtlas, nameBytes, plateFontFromDol, plateText, type PlateFont } from "../src/render3d/plates.ts";
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
  return { common, pairs: new Map([[0x3042, 0x829f]]), atlas: null };
}

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);

test("a name's quads: 1.000 by 1.035 units, a glyph's pen advancing by (34 - right - next left) / 32", () => {
  // 'a' trims 3 and 6, 'b' 4 and 2
  const t = plateText(tiny({ 1: [3, 6], 2: [4, 2] }), "ab");
  assert.equal(t.count, 2);
  for (let k = 0; k < 2; k++) {
    near(t.quads[k * 8 + 2] - t.quads[k * 8], 1);
    near(t.quads[k * 8 + 1] - t.quads[k * 8 + 3], 1.035);
  }
  // (the lefts: a step of the left trims at the quad's height factor, the pen at the width factor)
  near(t.quads[8] - t.quads[0], (34 - 6 - 4) / 32 - (4 - 3) * 0.035 / 32, 1e-6);
  // the line is centered: its pen width (32 per glyph less each one's trims less two) about 0, the first glyph's
  // left that far less its trim's step
  const pen = (32 - (3 + 6 - 2)) + (32 - (4 + 2 - 2));
  near(t.quads[0], -pen / 2 / 32 - (3 - 1) * 1.035 / 32);
});

test("a name's bytes: ASCII as it is, another character by the font's Shift-JIS pair, what the font lacks left out", () => {
  const font = tiny({});
  assert.deepEqual([...nameBytes("Ab c", font)], [0x41, 0x62, 0x20, 0x63]);
  // (a character the font has a pair for becomes the pair; one it has none of is left out)
  assert.deepEqual([...nameBytes("あx亜", font)], [0x82, 0x9f, 0x78]);
  assert.equal(plateText(font, "").count, 0);
});

test("the plate's width follows the name's glyphs: (20 - left trim) summed, held to 60..144, times 0.0146", () => {
  const f = tiny({ 1: [10, 1] });
  // five 'a's: 5 x 10 = 50, under the minimum
  near(plateText(f, "aaaaa").width, 60 * 0.0146);
  // ten: 100
  near(plateText(f, "aaaaaaaaaa").width, 100 * 0.0146);
  // twenty: 200, over the cap
  near(plateText(f, "aaaaaaaaaaaaaaaaaaaa").width, 144 * 0.0146);
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

test("the game's font and layout put 'Diamond Player' where the game's quads are", withGameFiles, () => {
  const font = plateFontFromDol(executable())!;
  assert.ok(font);
  assert.equal(plateFontFromDol(executable()) === font, false); // (a copy of the file is a new font: kept by the buffer)
  const t = plateText(font, "Diamond Player");
  assert.equal(t.count, 14);
  for (let k = 0; k < 14; k++) near(t.quads[k * 8], DIAMOND_LEFTS[k], 2e-5);
  // (the plate for a name this long is the cap)
  near(t.width, 144 * 0.0146);
  assert.ok(font.pairs.size >= 280);
});
