/* A replay played through the game's own draw path: the simulator's graphics build steps the match and runs the game's display pass
 * (core.ts), and the GX renderer (gxr/) draws the stream it hands back. This holds the two together and keeps their order:
 * row i of the tape is stepped, its stream and new memory go to the renderer, and the picture that frame copies to the screen is
 * the frame shown. Seeking back starts the match again (the simulator has no way back) and plays forward without drawing.
 *
 * The renderer is anything with gxr's GxBackend (the CPU reference, the WebGL one); see INTERFACE.md for what is asked of it.
 */
import { GxGpu } from "../gxr/gpu";
import type { Dff, GxFrame } from "../gxr/dff";
import type { GxBackend } from "../gxr/gpu";
import { differs } from "../../sim/compare";
import { driveOrder, type DriveOptions, type Tape } from "../../sim/tape";
import { fitCstick, type RawC } from "./cfit";
import { GxCore, type GxCoreFactory, type PlaybackMode } from "./core";
import { nativeRow, nativeTape } from "./tapebridge";

/** what the session needs of a renderer (CpuBackend, GxGl) */
export interface SessionBackend extends GxBackend {
  /** draws are skipped while this is false (registers and memory stay exact) */
  drawing: boolean;
  /** the frame is only played through: no draws, no copies of the frame buffer */
  fastForward?: boolean;
  /** the picture the game copies to the screen: 640 x 480 RGBA, and its number */
  onPicture: ((rgba: Uint8Array, index: number) => void) | null;
  /** the number of pictures the game has copied to the screen so far */
  pictures: number;
  /** (GxGl) memory the renderer mirrors, before the first frame; and the shaders for the features a stream may need */
  prepareMemory?(mem: unknown, regs: unknown): void;
  /** (GxGl) draw the last picture into the renderer's own canvas, no read-back */
  present?(): void;
  /** back to the state before any frame (GxGl has it) */
  reset?(): void;
  stats?: { cpuMs: number; flushMs: number };
}

export interface GameFiles { names: string[]; files: Map<string, Uint8Array> }

/** where the frame's time went, ms (the last frame and the means since the match opened) */
export interface FrameTimes { step: number; handoff: number; render: number }

export interface SessionOptions {
  factory: GxCoreFactory;
  /** the module's own options (locateFile, instantiateWasm) */
  coreOptions?: Record<string, unknown>;
  files: GameFiles;
  tape: Tape;
  drive?: DriveOptions;
  /** how the replay is played back (core.ts PlaybackMode; default slippi): fixed for the session, a change is a new session */
  playback?: PlaybackMode;
  /** what the page is doing before the match can start (the C-stick fit of playback original), or null when that is over */
  onProgress?: (text: string | null) => void;
  /** at most this many drive choices are tried when the game parts from the replay (default 3, as the track simulator) */
  maxDrives?: number;
  /** a renderer, made with the way to the GPU's memory it reads (the CPU reference needs it); the same one is used for every restart
   *  when it has reset(), else this is called again */
  makeBackend: (env: () => { mem: Uint8Array; tmem: Uint8Array; tluts: Map<number, Uint8Array> }) => SessionBackend | Promise<SessionBackend>;
}

export class GxSession {
  /** tape rows stepped so far (the frame shown is index - 1) */
  index = 0;
  /** the first row the simulator's game parted from the replay's, and the lane */
  diverged: { row: number; frame: number; lane: string } | null = null;
  /** pictures are read back from the renderer (the CPU reference always; WebGL only for a display that needs the pixels, such as the CRT pass: a read-back waits for the GPU) */
  wantPictures = true;
  /** called with each picture the game copies to the screen (rgba is the renderer's own buffer: copy to keep) */
  onPicture: ((rgba: Uint8Array, row: number) => void) | null = null;
  times: FrameTimes = { step: 0, handoff: 0, render: 0 };
  /** sums over every frame stepped since the match opened */
  totals = { frames: 0, step: 0, handoff: 0, render: 0, streamBytes: 0, regionBytes: 0, maxStep: 0, maxFrame: 0 };
  /** which of the tape's drive choices (UCF switches, arithmetic: tape.ts driveOrder) the match plays, and how far each held */
  driveIndex = 0;
  drivesTried: { index: number; row: number }[] = [];
  private retried = false;
  private core: GxCore | null = null;
  private gpu: GxGpu | null = null;
  private backend: SessionBackend | null = null;
  /** the whole tape the match plays (tapebridge.ts nativeTape), and the C-stick fit made for each drive choice (playback original) */
  private whole: Uint8Array | null = null;
  private fits = new Map<number, RawC | null>();
  /** (playback original) drives and kept trials the C-stick fit took, for the drive choice playing */
  fitStats: { drives: number; flips: number } | null = null;
  private picturedRow = -1;
  private closed = false;
  private firstStepped = false;

  constructor(private o: SessionOptions) {}

  get frameCount(): number { return this.o.tape.count; }
  get tape(): Tape { return this.o.tape; }
  get playback(): PlaybackMode { return this.o.playback ?? "slippi"; }
  get core_(): GxCore | null { return this.core; }

  /** the match from its first row (a fresh instance of the module; the renderer back to its start) */
  async start(): Promise<void> {
    const { tape, files } = this.o;
    this.core?.destroy();
    this.core = null;
    const core = await GxCore.create((opt) => this.o.factory({ ...opt, ...this.o.coreOptions }), files.files);
    if (this.closed) { core.destroy(); return; }
    const whole = await this.tapeFor(this.driveIndex);
    if (this.closed) { core.destroy(); return; }
    this.whole = whole;
    core.openMatch(whole, files.names, this.playback);
    this.core = core;
    if (this.backend?.reset) this.backend.reset();
    else this.backend = await this.o.makeBackend(() => {
      const g = this.gpu!;
      return { mem: g.mem.data, tmem: g.regs.tmem, tluts: g.regs.tluts as unknown as Map<number, Uint8Array> };
    });
    const backend = this.backend;
    backend.drawing = false;
    backend.onPicture = this.wantPictures ? (rgba) => { this.onPicture?.(rgba, this.index - 1); } : null;
    // (the register files the stream starts from are taken when the first frame is stepped: row 0 is stepped here and fed first)
    core.step(nativeRow(whole, 0));
    this.firstStepped = true;
    this.gpu = new GxGpu(backend, core.initial() as unknown as Dff);
    backend.prepareMemory?.(this.gpu.mem, this.gpu.regs);
    this.index = 0;
    this.diverged = null;
    this.picturedRow = -1;
    this.totals = { frames: 0, step: 0, handoff: 0, render: 0, streamBytes: 0, regionBytes: 0, maxStep: 0, maxFrame: 0 };
  }

  /** step the next row; draw it (or only keep the renderer's registers and memory exact) */
  step(draw: boolean): boolean {
    const core = this.core, gpu = this.gpu;
    if (!core || !gpu || this.index >= this.frameCount) return false;
    const i = this.index;
    const t0 = performance.now();
    if (i === 0 && this.firstStepped) this.firstStepped = false;
    else core.step(nativeRow(this.whole!, i));
    const t1 = performance.now();
    this.index = i + 1;
    if (i > 0 && !this.diverged) {
      const lane = differs(core.output(), this.o.tape.expected(i));
      if (lane) this.diverged = { row: i, frame: this.o.tape.gameFrame(i), lane };
    }
    const frame: GxFrame = { fifo: core.stream(), updates: core.updates() };
    const t2 = performance.now();
    // (frame 0 sets the registers up and draws nothing, as the reference player's first frame)
    // (frame 0 sets the registers up and draws nothing; a frame only played through for a seek is fast-forwarded: no draws, no copies)
    this.backend!.drawing = i > 0;
    this.backend!.fastForward = !draw;
    const before = this.backend!.pictures;
    gpu.runFrame(frame);
    if (this.backend!.pictures > before) this.picturedRow = i;
    const t3 = performance.now();
    this.times = { step: t1 - t0, handoff: t2 - t1, render: t3 - t2 };
    const T = this.totals;
    T.frames++; T.step += t1 - t0; T.handoff += t2 - t1; T.render += t3 - t2;
    T.streamBytes += frame.fifo.length;
    for (const u of frame.updates) T.regionBytes += u.data.length;
    if (t1 - t0 > T.maxStep) T.maxStep = t1 - t0;
    if (t3 - t0 > T.maxFrame) T.maxFrame = t3 - t0;
    return true;
  }

  /** read pictures back (or not) from now on: the backend's onPicture is set or cleared at once */
  setPictures(on: boolean): void {
    this.wantPictures = on;
    if (this.backend) this.backend.onPicture = on ? (rgba) => { this.onPicture?.(rgba, this.index - 1); } : null;
  }

  /** Draw the first few rows once, hidden, and start the match again: the JavaScript engine and the renderer's caches are warm before the first row shown */
  async warmup(rows = 4): Promise<void> {
    await this.start();
    const was = this.wantPictures;
    this.setPictures(false);
    for (let i = 0; i < rows && this.index < this.frameCount; i++) { this.step(true); await new Promise((r) => setTimeout(r, 0)); }
    this.setPictures(was);
    await this.start();
  }

  /** the row whose picture the screen shows now (-1: none yet) */
  get shown(): number { return this.picturedRow; }

  /**
   * Show row `row`: forward from where the match is (rows in between are stepped and not drawn, the last `tail` drawn), or from the
   * start when it is behind. `budgetMs` bounds one call; it returns true when the row is reached.
   */
  seekStep(row: number, budgetMs = 8, tail = 2): boolean {
    const end = Math.min(row, this.frameCount - 1);
    const t0 = performance.now();
    while (this.index <= end) {
      this.step(this.index > end - tail);
      if (performance.now() - t0 > budgetMs && this.index <= end) return false;
    }
    return true;
  }

  /** true when `row` is behind the match: the caller must start() again first */
  needsRestart(row: number): boolean {
    return row < this.index - 1 || !this.core;
  }

  /** the whole tape of drive choice d: its config, every row, the trailers; in playback original, for a recording without raw C-stick
   *  bytes, the raw bytes the simulator's fit chooses for that choice (cfit.ts; made once per choice) */
  private async tapeFor(d: number): Promise<Uint8Array> {
    const { tape } = this.o;
    const drive = this.o.drive ?? driveOrder(tape, this.o.maxDrives ?? 3)[d] ?? driveOrder(tape, 1)[0];
    if (this.playback !== "original" || !tape.rawCAbsent) return nativeTape(tape, drive);
    if (!this.fits.has(d)) {
      const fit = await fitCstick({
        factory: this.o.factory, coreOptions: this.o.coreOptions, files: this.o.files, tape, drive,
        onProgress: (text) => this.o.onProgress?.(text),
      });
      this.o.onProgress?.(null);
      this.fits.set(d, fit?.rawC ?? null);
      if (d === this.driveIndex) this.fitStats = fit ? { drives: fit.drives, flips: fit.flips } : null;
    }
    return nativeTape(tape, drive, this.fits.get(d) ?? undefined);
  }

  /** the whole tape the match plays now (the checks compare it with the native driver's) */
  get wholeTape(): Uint8Array | null { return this.whole; }

  /** bytes the simulator's memory holds */
  get memoryBytes(): number { return this.core?.memoryBytes ?? 0; }

  close(): void {
    this.closed = true;
    this.core?.destroy();
    this.core = null;
    this.gpu = null;
  }

  /** the game parted from the replay and the other drive choices have not been tried */
  get wantsRetry(): boolean { return this.diverged !== null && !this.retried && (this.o.maxDrives ?? 3) > 1 && !this.o.drive; }

  /**
   * The game parted from the replay at `diverged.row` with this drive choice. Play the others from the start, the simulator alone (one
   * instance at a time, sliced so the page stays alive), and keep the choice that goes furthest (src/sim/drive.ts does the same for the
   * track). Resolves true when another choice held longer and the match is now on it, started again from the first row (the caller seeks back).
   */
  async retryDrives(onProgress?: (text: string) => void, now = () => performance.now(), pause = () => new Promise<void>((r) => setTimeout(r, 0))): Promise<boolean> {
    this.retried = true;
    const { tape, files } = this.o;
    const choices = driveOrder(tape, this.o.maxDrives ?? 3);
    this.drivesTried = [{ index: this.driveIndex, row: this.diverged?.row ?? tape.count }];
    let best = this.drivesTried[0];
    for (let d = 0; d < choices.length && best.row < tape.count; d++) {
      if (d === this.driveIndex) continue;
      onProgress?.(`the game parts from the replay at frame ${this.diverged?.frame}: trying setting ${d + 1} of ${choices.length}`);
      const core = await GxCore.create((opt) => this.o.factory({ ...opt, ...this.o.coreOptions }), files.files);
      let reached = tape.count;
      try {
        const whole = await this.tapeFor(d);
        core.openMatch(whole, files.names, this.playback);
        let i = 0, t0 = now();
        for (; i < tape.count; i++) {
          core.step(nativeRow(whole, i));
          if (i > 0 && differs(core.output(), tape.expected(i))) { reached = i; break; }
          if (now() - t0 > 12) { await pause(); t0 = now(); if (this.closed) return false; }
        }
      } catch {
        reached = 0; // (a build that cannot play this choice)
      } finally {
        core.destroy();
      }
      this.drivesTried.push({ index: d, row: reached });
      if (reached > best.row) best = this.drivesTried[this.drivesTried.length - 1];
    }
    if (best.index === this.driveIndex) return false;
    this.driveIndex = best.index;
    await this.start();
    return true;
  }
}
