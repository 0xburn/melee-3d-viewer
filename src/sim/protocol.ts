/* The messages between the page (feed.ts) and the simulator's worker
 * (sim.worker.ts). One worker plays one replay; the page ends it with "stop"
 * or by terminating it.
 *
 * Frames are game frames (-123 first). `until` is the first game frame the
 * track does not hold for yet: every line of a frame before it is in.
 * Chunk text is the track's JSON arrays joined by commas (no brackets):
 * the page reads a chunk with one JSON.parse("[" + text + "]").
 */

/** where the worker reads the game files from: the folder URL, or the File objects a folder picker gave */
export type GameFilesFrom = { kind: "url"; base: string } | { kind: "files"; list: File[] };

export type ToWorker =
  | {
      type: "start";
      /** the simulator's ES module (absolute URL) and its .wasm */
      module: string; wasm: string;
      /** the list of game files the simulator reads (a JSON array of names), or null: work it out */
      filesList: string | null;
      files: GameFilesFrom;
      /** the .slp's bytes */
      replay: ArrayBuffer;
      /** at most this many drives (UCF and arithmetic choices) */
      maxDrives: number;
      /** about how long each chunk of frames runs before it is sent (ms) */
      chunkMs: number;
    }
  | { type: "stop" };

export type FromWorker =
  | { type: "status"; state: "loading" | "reading files" | "starting" | "running"; drive?: number; detail?: string }
  /** the tape is read: its rows and their first game frame */
  | { type: "tape"; frames: number; firstFrame: number }
  /** more of the leading drive's track */
  | { type: "chunk"; drive: number; until: number; text: string; rate: number }
  /** a later drive went further than the one before: the chunks from here on are its, from its first frame */
  | { type: "restart"; drive: number }
  /** a drive's game parted from the replay at this frame (lane: the first that differed) */
  | { type: "diverged"; drive: number; frame: number; lane: string }
  /** all drives are over: the leading drive's track holds up to `until` (exact: the whole replay) */
  | { type: "done"; drive: number; until: number; exact: boolean; seconds: number; drives: number }
  /** the simulator cannot play this replay here (unsupported replay, missing file, no module) */
  | { type: "error"; reason: string };
