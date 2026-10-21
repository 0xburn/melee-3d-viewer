// The start-up work: the first bytes of a .slp name the stage and the players (prefetch.ts), and the
// browser cache (gamecache.ts) answers as if empty where there is no storage.

import test from "node:test";
import assert from "node:assert/strict";
import { replayHead } from "../src/render3d/prefetch.ts";
import { cacheGet, cachePut, sha256 } from "../src/render3d/gamecache.ts";

/** the start of a replay: the UBJSON prefix, the payload sizes and a Game Start event */
function slp(stage: number, ports: ({ ext: number; type: number; costume: number } | null)[]): ArrayBuffer {
  const prefix = [0x7b, 0x55, 0x03, 0x72, 0x61, 0x77, 0x5b, 0x24, 0x55, 0x23, 0x6c, 0, 0, 0, 0];
  const sizes = [0x35, 7, 0x35, 0, 0, 0x36, 0x01, 0x40];
  const start = new Uint8Array(0x141);
  start[0] = 0x36;
  new DataView(start.buffer).setUint16(0x13, stage);
  ports.forEach((p, i) => {
    const b = 0x65 + 0x24 * i;
    start[b] = p?.ext ?? 0;
    start[b + 1] = p?.type ?? 3;
    start[b + 3] = p?.costume ?? 0;
  });
  return Uint8Array.from([...prefix, ...sizes, ...start]).buffer;
}

test("a Game Start event names the stage, the fighters and the costumes", () => {
  const h = replayHead(slp(31, [{ ext: 25, type: 0, costume: 2 }, null, null, { ext: 14, type: 1, costume: 3 }]));
  assert.deepEqual(h, { stageId: 31, players: [{ internal: [25], costume: 2 }, { internal: [10, 11], costume: 3 }] });
});

test("bytes that are not a replay's start are no head", () => {
  assert.equal(replayHead(new ArrayBuffer(100)), null);
  assert.equal(replayHead(slp(8, []).slice(0, 60)), null);
});

test("without storage the cache answers as if empty", async () => {
  assert.equal(await cacheGet("x"), undefined);
  assert.equal(await cachePut("x", 1), false);
});

test("a SHA-256 of bytes", async () => {
  assert.equal(await sha256(new TextEncoder().encode("abc").buffer), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
