/* Playback "original" of a recording without raw C-stick bytes (Slippi before 3.17): the raw bytes the original game had are the
 * simulator's to decide, against the recorded positions (melee-sim-light replay_drive.drive_fitted). The module holds the planner
 * (msl_gxw_cfit_*, tools/replay/cstick_fit.c: the same candidates, order and limits as the python); the page only runs the drives it
 * asks for, the simulator alone over the whole tape with playback "original", and reports each drive's first difference from the
 * recording (framediff.ts, replay_drive.py frame_diff's definition). Nothing of the rule is in this file.
 */
import type { DriveOptions, Tape } from "../../sim/tape";
import { GxCore, type GxCoreFactory } from "./core";
import { frameDiff } from "./framediff";
import { nativeRow, nativeTape } from "./tapebridge";

export type RawC = ([Int16Array, Int16Array] | null)[];

export interface FitOptions {
  factory: GxCoreFactory;
  coreOptions?: Record<string, unknown>;
  files: { names: string[]; files: Map<string, Uint8Array> | Iterable<[string, Uint8Array]> };
  tape: Tape;
  drive: DriveOptions;
  onProgress?: (text: string) => void;
  /** a pause to the event loop between slices of a drive (the page stays alive) */
  pause?: () => Promise<void>;
}

/** the fitted raw C-stick bytes per slot, and how many drives and kept trials it took; null when the recording has raw bytes */
export async function fitCstick(o: FitOptions): Promise<{ rawC: RawC; drives: number; flips: number } | null> {
  const { tape } = o;
  if (!tape.rawCAbsent) return null;
  const make: GxCoreFactory = (opt) => o.factory({ ...opt, ...o.coreOptions });
  const files = o.files.files instanceof Map ? o.files.files : new Map(o.files.files);
  const planner = await GxCore.create(make, []);
  const m = planner.mod, count = tape.count, lanes = tape.numPlayers;
  if (m._msl_gxw_cfit_new(lanes, count) !== 0) throw new Error("msl_gxw_cfit_new: no memory");
  for (let s = 0; s < lanes; s++) {
    const { x, y } = tape.cstick(s);
    const px = m._malloc(count * 4), py = m._malloc(count * 4);
    try {
      new Float32Array(m.HEAPU8.buffer, px, count).set(x);
      new Float32Array(m.HEAPU8.buffer, py, count).set(y);
      m._msl_gxw_cfit_lane(s, px, py);
    } finally { m._free(px); m._free(py); }
  }
  const load = (): RawC => Array.from({ length: lanes }, (_, s) => {
    const raw = (axis: number) => { const p = m._msl_gxw_cfit_raw(s, axis); return new Int16Array(m.HEAPU8.buffer.slice(p, p + count * 2)); };
    return [raw(0), raw(1)] as [Int16Array, Int16Array];
  });
  const pause = o.pause ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  let drives = 0;
  // one whole drive, the simulator alone, playback original: the first row whose output is not the recording's (-1 none)
  const drive = async (rawC: RawC): Promise<number> => {
    drives++;
    o.onProgress?.(`working out the C-stick of this replay (simulation ${drives})`);
    const whole = nativeTape(tape, o.drive, rawC);
    const core = await GxCore.create(make, files);
    try {
      core.openMatch(whole, [...files.keys()], "original");
      let t0 = performance.now();
      for (let i = 0; i < count; i++) {
        core.step(nativeRow(whole, i));
        if (frameDiff(core.outRow(), tape.recorded(i))) return i;
        if (performance.now() - t0 > 12) { await pause(); t0 = performance.now(); }
      }
      return -1;
    } finally {
      core.destroy();
    }
  };
  let rawC = load();
  let first = await drive(rawC);
  while (m._msl_gxw_cfit_next(first)) {
    rawC = load();
    const moved = await drive(rawC);
    m._msl_gxw_cfit_result(moved);
    first = m._msl_gxw_cfit_first();
  }
  rawC = load();
  const flips = m._msl_gxw_cfit_flips();
  planner.destroy();
  return { rawC, drives, flips };
}
