/* A checking mode of the page (?harness=<window names>), for the pixel checks: each named window of the spec harness (a replay's name and a
 * capture frame; its map file gives the tape rows) is played from the first row with its five rows drawn, and the pictures are posted as
 * <name>/efb_00000k.raw (width, height, 28 as little-endian words, then RGBA rows from the top) to /save/. Not used in play.
 */
import type { GxSession } from "./session";

export async function runHarness(s: GxSession, names: string[], replayOf: (win: string) => boolean): Promise<string> {
  let report = "";
  for (const win of names) {
    if (!replayOf(win)) continue;
    const map = await (await fetch(`/map/${win}.json`)).json();
    const rows: number[] = map.swaps.slice(1, 6).map((x: number) => x + 123);
    await s.start();
    s.setPictures(true);
    const got = new Map<number, Uint8Array>();
    s.onPicture = (rgba, row) => { if (rows.includes(row)) got.set(row, rgba.slice()); };
    const last = rows[rows.length - 1];
    while (s.index <= last) {
      const t = performance.now();
      while (performance.now() - t < 12 && s.index <= last) s.step(s.index >= rows[0] - 1);
      await new Promise((r) => setTimeout(r, 0));
    }
    for (let k = 0; k < 5; k++) {
      const f = new Uint8Array(12 + 640 * 480 * 4);
      const dv = new DataView(f.buffer);
      dv.setUint32(0, 640, true); dv.setUint32(4, 480, true); dv.setUint32(8, 28, true);
      const px = got.get(rows[k]);
      if (px && k > 0) f.set(px, 12);
      await fetch(`/save/${win}/efb_00000${k}.raw`, { method: "POST", body: f });
    }
    report += `${win}: rows ${rows.join(",")} pictures ${got.size}; `;
  }
  return report;
}
