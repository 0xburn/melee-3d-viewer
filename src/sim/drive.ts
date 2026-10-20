/* Playing a tape through the simulator, a chunk of frames at a time, and
 * sending its track as it goes (the worker's loop, kept apart from the
 * worker so a test can run it against a fake module).
 *
 * A drive is one play of the whole replay with one choice of UCF switches
 * and arithmetic (tape.ts driveOrder). Each frame's output is checked against
 * the replay (compare.ts); at the first frame that differs the drive stops,
 * and the track holds up to there. Then the next choice is tried from the
 * start, its lines kept back until it goes further than the one before; only
 * then does it take over (a "restart" and everything it has). So the page
 * only ever gets the track of the drive that holds furthest, and never loses
 * what it has.
 */
import { differs } from "./compare";
import type { FromWorker } from "./protocol";
import { driveOrder, type DriveOptions, type Tape } from "./tape";
import { STREAM_FRAME } from "./wire";

/** one match in the simulator (engine.ts SimViewer, or a test's fake) */
export interface DriveViewer {
  step(frame: Uint8Array): void;
  trackText(): string;
  output(): DataView;
  destroy(): void;
}

export interface DriveHost {
  /** a fresh match for these options (throws: this choice cannot be played here) */
  open(tape: Tape, options: DriveOptions): Promise<DriveViewer>;
  post(m: FromWorker): void;
  /** the page asked to stop */
  stopped(): boolean;
  /** let the worker's messages in between chunks */
  pause(): Promise<void>;
  now(): number;
}

/** lines as chunk text: the arrays joined by commas */
export const chunkText = (lines: string) => lines.trim().replace(/\s*\n\s*/g, ",");

export async function runDrives(tape: Tape, host: DriveHost, maxDrives: number, chunkMs: number) {
  const started = host.now();
  const frame = new Uint8Array(STREAM_FRAME.size);
  // the drive whose track the page has, and how far it holds
  let leader = -1, leaderUntil = tape.firstFrame, drives = 0;
  const choices = driveOrder(tape, maxDrives);
  for (let d = 0; d < choices.length; d++) {
    let viewer: DriveViewer;
    host.post({ type: "status", state: "starting", drive: d });
    try {
      viewer = await host.open(tape, choices[d]);
    } catch (e) {
      // (a build without split arithmetic refuses that choice: the next one)
      host.post({ type: "status", state: "starting", drive: d, detail: String((e as Error)?.message ?? e) });
      if (leader < 0 && d === choices.length - 1) host.post({ type: "error", reason: String((e as Error)?.message ?? e) });
      continue;
    }
    drives++;
    host.post({ type: "status", state: "running", drive: d });
    let leading = leader < 0;
    if (leading) leader = d;
    let held = viewer.trackText(); // the match's setup lines
    let kept = "";
    let i = 0, until = tape.firstFrame;
    let diverged: { frame: number; lane: string } | null = null;
    try {
      while (i < tape.count && !diverged) {
        const t0 = host.now(), from = i;
        while (i < tape.count && host.now() - t0 < chunkMs) {
          tape.frame(i, frame);
          viewer.step(frame);
          const text = viewer.trackText();
          // (row 0 is the warm-up the validator does not compare)
          if (i > 0) {
            const lane = differs(viewer.output(), tape.expected(i));
            if (lane) { diverged = { frame: tape.gameFrame(i), lane }; break; }
          }
          held += text;
          i++;
          until = tape.gameFrame(i);
        }
        const rate = ((i - from) * 1000) / Math.max(1, host.now() - t0);
        if (!leading && until > leaderUntil) {
          // (this drive goes further than the page's: it takes over, with all it kept back)
          host.post({ type: "restart", drive: d });
          leading = true;
          leader = d;
          held = kept + held;
          kept = "";
        }
        if (leading) {
          host.post({ type: "chunk", drive: d, until, text: chunkText(held), rate });
          leaderUntil = until;
        } else {
          kept += held;
        }
        held = "";
        if (host.stopped()) return;
        await host.pause();
        if (host.stopped()) return;
      }
    } finally {
      viewer.destroy();
    }
    if (!diverged) {
      host.post({ type: "done", drive: leader, until: leaderUntil, exact: true, seconds: (host.now() - started) / 1000, drives });
      return;
    }
    host.post({ type: "diverged", drive: d, frame: diverged.frame, lane: diverged.lane });
  }
  host.post({ type: "done", drive: leader, until: leaderUntil, exact: false, seconds: (host.now() - started) / 1000, drives });
}
