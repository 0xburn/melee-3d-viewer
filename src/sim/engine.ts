/* The simulator's Wasm module, as the viewer drives it: melee-sim-light's
 * viewer API (api.h msl_viewer_*), built for the browser with the viewer
 * track compiled in (BUILD.md). Nothing here knows about replays: tape.ts
 * makes the rows, drive.ts plays them.
 *
 *   msl_viewer_create(data_root, config, 64, previous_input, 52, &viewer)
 *       loads the game data from data_root (the files written into the
 *       module's memory file system first), turns the track on, builds the match
 *   msl_viewer_step(viewer, frame, 188)      one MslCoreStreamFrame
 *   msl_viewer_track(viewer, &size)          the track lines since the last call
 *   msl_viewer_output(viewer, &size)         the step's MslCoreCompare
 *   msl_viewer_destroy(viewer)
 */
import { CONFIG, INPUT_SIZE, STREAM_FRAME } from "./wire";

/** the parts of the Emscripten module the viewer uses (EXPORTED_FUNCTIONS and
 *  EXPORTED_RUNTIME_METHODS in BUILD.md) */
export interface SimModule {
  HEAPU8: Uint8Array;
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    unlink(path: string): void;
  };
  _malloc(size: number): number;
  _free(ptr: number): void;
  _msl_viewer_create(root: number, config: number, configSize: number, previous: number, inputSize: number,
                     out: number): number;
  _msl_viewer_step(viewer: number, frame: number, frameSize: number): number;
  _msl_viewer_track(viewer: number, size: number): number;
  _msl_viewer_output(viewer: number, size: number): number;
  _msl_viewer_destroy(viewer: number): void;
}

/** the module's factory (the ES module's default export, -sMODULARIZE -sEXPORT_ES6) */
export type SimFactory = (options?: Record<string, unknown>) => Promise<SimModule>;

/** where the game files go in the module's file system */
export const DATA_ROOT = "/data/raw";

/** MslResult names (api.h), for messages */
const RESULTS: Record<number, string> = { 0: "ok", 1: "invalid argument", 2: "out of memory", 3: "invalid state" };

/** the game files written into the module, by their names on the disc */
export function writeGameFiles(mod: SimModule, files: Iterable<[string, Uint8Array]>): string[] {
  mod.FS.mkdirTree(DATA_ROOT);
  const names: string[] = [];
  for (const [name, bytes] of files) {
    mod.FS.writeFile(`${DATA_ROOT}/${name}`, bytes);
    names.push(name);
  }
  return names;
}

/** the files taken out again once the game data has read them (the core keeps its own copy) */
export function dropGameFiles(mod: SimModule, names: string[]) {
  for (const n of names) {
    try { mod.FS.unlink(`${DATA_ROOT}/${n}`); } catch { /* already gone */ }
  }
}

/** one match in the simulator, with its track on */
export class SimViewer {
  private handle = 0;
  private frameBuf = 0;
  private sizeOut = 0;
  private decoder = new TextDecoder();

  private constructor(private mod: SimModule) {}

  /** the match for this config and input before the first frame (both wire rows) */
  static create(mod: SimModule, config: Uint8Array, previous: Uint8Array, root = DATA_ROOT): SimViewer {
    if (config.length !== CONFIG.size || previous.length !== INPUT_SIZE) throw new Error("bad wire row sizes");
    const v = new SimViewer(mod);
    const rootBytes = new TextEncoder().encode(root + "\0");
    const rootPtr = mod._malloc(rootBytes.length), cfg = mod._malloc(config.length);
    const prev = mod._malloc(previous.length), out = mod._malloc(4);
    try {
      mod.HEAPU8.set(rootBytes, rootPtr);
      mod.HEAPU8.set(config, cfg);
      mod.HEAPU8.set(previous, prev);
      new DataView(mod.HEAPU8.buffer).setUint32(out, 0, true);
      const r = mod._msl_viewer_create(rootPtr, cfg, config.length, prev, previous.length, out);
      if (r !== 0) throw new Error(`msl_viewer_create: ${RESULTS[r] ?? r}`);
      // (the heap may have grown during create: a fresh view)
      v.handle = new DataView(mod.HEAPU8.buffer).getUint32(out, true);
    } finally {
      mod._free(rootPtr); mod._free(cfg); mod._free(prev); mod._free(out);
    }
    v.frameBuf = mod._malloc(STREAM_FRAME.size);
    v.sizeOut = mod._malloc(4);
    return v;
  }

  /** play one frame (a STREAM_FRAME.size row) */
  step(frame: Uint8Array) {
    this.mod.HEAPU8.set(frame.subarray(0, STREAM_FRAME.size), this.frameBuf);
    const r = this.mod._msl_viewer_step(this.handle, this.frameBuf, STREAM_FRAME.size);
    if (r !== 0) throw new Error(`msl_viewer_step: ${RESULTS[r] ?? r}`);
  }

  /** the track lines written since the last call (after create: the match's setup) */
  trackText(): string {
    const ptr = this.mod._msl_viewer_track(this.handle, this.sizeOut);
    const heap = this.mod.HEAPU8;
    const size = new DataView(heap.buffer).getUint32(this.sizeOut, true);
    return ptr && size ? this.decoder.decode(heap.subarray(ptr, ptr + size)) : "";
  }

  /** the last step's output row (MslCoreCompare), valid until the next step */
  output(): DataView {
    const ptr = this.mod._msl_viewer_output(this.handle, this.sizeOut);
    const heap = this.mod.HEAPU8;
    const size = new DataView(heap.buffer).getUint32(this.sizeOut, true);
    return new DataView(heap.buffer, ptr, size);
  }

  destroy() {
    if (this.handle) this.mod._msl_viewer_destroy(this.handle);
    if (this.frameBuf) this.mod._free(this.frameBuf);
    if (this.sizeOut) this.mod._free(this.sizeOut);
    this.handle = this.frameBuf = this.sizeOut = 0;
  }
}
