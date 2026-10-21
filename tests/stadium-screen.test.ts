// gr/stadium.ts: Pokemon Stadium's screen text as the game draws it - a quad a glyph into the screen's picture every
// frame, the text the stage's code wrote last (it writes in some modes only, and the mode that ends writes on its
// last frame), the match's modes keeping it in a picture of its own.

import test from "node:test";
import assert from "node:assert/strict";
import { StadiumScreen, type LetterBatch, type LetterRenderer } from "../src/render3d/gr/stadium.ts";
import type { Lettering, SisFont, SisGlyph } from "../src/render3d/sistext.ts";

// (the screen makes a canvas; these checks have no page)
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }),
};

/** a screen with the modes given as [game frame, mode], as a viewer track has them */
function screen(modes: [number, number][]) {
  const tr = { has: (k: string) => k === "stadscreen", changes: () => modes.map(([f, m]) => [f, m, -1]) };
  return new StadiumScreen({ scale: 1 } as never, { frames: [], settings: { playerSettings: [] } } as never, tr as never);
}
type Internals = { lastText(frame: number): { mode: number; frame: number } | null; lettersOf(g: SisGlyph[], L: Lettering): { data: Float32Array; batches: LetterBatch[] } | null;
                   letters: { data: Float32Array; batches: LetterBatch[] } | null; mode: number };

const MODES: [number, number][] = [[-123, 10], [-39, 11], [0, 1], [601, 8], [1501, 7], [2550, 1], [3152, 8]];

test("the text on a frame is what the stage's code wrote last", () => {
  const s = screen(MODES) as unknown as Internals;
  // (a game frame f is the replay's index f + 123)
  assert.deepEqual(s.lastText(10), { mode: 10, frame: 10 });
  assert.deepEqual(s.lastText(100), { mode: 11, frame: 100 });
  assert.deepEqual(s.lastText(123 + 300), { mode: 1, frame: 423 });
  // the close-up (mode 8) writes none: the information page as of the frame mode 1 ended, whatever frame this is
  assert.deepEqual(s.lastText(123 + 601), { mode: 1, frame: 123 + 601 });
  assert.deepEqual(s.lastText(123 + 1000), { mode: 1, frame: 123 + 601 });
  assert.deepEqual(s.lastText(123 + 2000), { mode: 1, frame: 123 + 601 });
  // mode 1 again writes its own
  assert.deepEqual(s.lastText(123 + 2600), { mode: 1, frame: 123 + 2600 });
  assert.deepEqual(s.lastText(123 + 3200), { mode: 1, frame: 123 + 3152 });
});

const font = (n: number): SisFont => ({ images: new Uint8Array(512 * n), kern: new Uint8Array(2 * n) });

test("a glyph is a quad of the font's picture in the screen's pixels, y down, in its color; a run of one font is a batch", () => {
  const s = screen(MODES) as unknown as Internals;
  const a = font(4), b = font(4);
  const L = { file: { font: b, pages: [] }, common: { font: a } } as unknown as Lettering;
  const glyphs: SisGlyph[] = [
    { font: a, index: 2, color: [255, 0, 128], x: 10, y: 12, w: 20, h: 20 },
    { font: a, index: 3, color: [255, 255, 255], x: 30, y: 12, w: 20, h: 20 },
    { font: b, index: 1, color: [0, 0, 0], x: 50, y: 40, w: 10, h: 20 },
  ];
  const out = s.lettersOf(glyphs, L)!;
  assert.equal(out.batches.length, 2);
  assert.deepEqual(out.batches.map((x) => x.count), [2, 1]);
  assert.deepEqual(out.batches.map((x) => x.first), [0, 2]);
  assert.ok(out.batches[0].sprite.key.startsWith("screen-font"));
  assert.notEqual(out.batches[0].sprite.key, out.batches[1].sprite.key);
  assert.ok(out.batches.every((x) => x.nozcomp && !x.zwrite));
  assert.equal(out.data.length, 3 * 4 * 17);
  // (the first quad: corners bottom left, top left, top right, bottom right; the bottom has the larger y)
  const v = (q: number, k: number) => Array.from(out.data.subarray((q * 4 + k) * 17, (q * 4 + k + 1) * 17));
  assert.deepEqual([v(0, 0)[0], v(0, 0)[1], v(0, 1)[1], v(0, 2)[0]], [10, 32, 12, 30]);
  assert.ok(v(0, 0)[4] > v(0, 1)[4]);                      // (the bottom reads the glyph's lower texels)
  assert.deepEqual(v(0, 0).slice(5, 9).map((x) => Math.round(x * 255)), [255, 0, 128, 255]);   // (primary color, opaque)
  assert.equal(v(0, 0)[16], 1);                            // (textured)
});

test("the lettering is drawn into the screen's picture every frame, into one of its own while the match is shown", () => {
  const s = screen(MODES) as unknown as Internals;
  const calls: string[] = [];
  const live = { name: "live" }, own = { name: "own" };
  const r: LetterRenderer = {
    liveTarget: () => live,
    target: () => { calls.push("target"); return own; },
    overlay: (_vp, _view, target, clear, mirrored) => { calls.push(`overlay ${(target as { name: string }).name} ${clear} ${mirrored}`); },
    drawParticles: (_d, batches) => { calls.push(`particles ${batches.length}`); },
    endOverlay: () => { calls.push("end"); },
  };
  s.letters = { data: new Float32Array(68), batches: [{ sprite: { key: "screen-font:common", w: 1, h: 1, rgba: new Uint8Array(4) }, additive: false, near: false, zwrite: false, nozcomp: true, first: 0, count: 1 }] };
  s.mode = 1;
  (s as unknown as StadiumScreen).drawLetters(r, {});
  assert.deepEqual(calls, ["overlay live 0,0,0,1 true", "particles 1", "end"]);
  calls.length = 0;
  s.mode = 8;
  (s as unknown as StadiumScreen).drawLetters(r, {});
  (s as unknown as StadiumScreen).drawLetters(r, {});
  assert.deepEqual(calls, ["target", "overlay own 0,0,0,1 true", "particles 1", "end", "overlay own 0,0,0,1 true", "particles 1", "end"]);
  // (nothing before the stage has written any)
  calls.length = 0;
  s.letters = null;
  (s as unknown as StadiumScreen).drawLetters(r, {});
  assert.deepEqual(calls, []);
});
