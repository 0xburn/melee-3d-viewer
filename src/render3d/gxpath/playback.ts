/* Playback controls over a GxSession: play, pause, speed, frame step, seek. The game runs at 60 frames a second; a tick (one
 * display frame of the page) steps as many rows as the time asks for and shows the last. A seek behind the match starts it again
 * and plays forward, a slice of a tick at a time so the page stays alive; a seek ahead plays forward the same way.
 */
import type { GxSession } from "./session";

export interface PlaybackHooks {
  /** a new picture is ready (rgba: the renderer's buffer, copy to keep) and the row it is */
  onPicture(rgba: Uint8Array, row: number): void;
  /** the state changed: playing, speed, row, seeking, the end */
  onState(): void;
  onError(e: unknown): void;
  /** the game parted from the replay and the other settings are being tried (text), or that is over (null) */
  onRetry?(text: string | null): void;
}

/** the speeds offered (1 is the game's) */
export const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8];

export class GxPlayback {
  playing = false;
  speed = 1;
  ended = false;
  /** the row a seek is going to (null: not seeking) */
  seeking: number | null = null;
  private acc = 0;
  private last = 0;
  private busy = false;
  private raf = 0;
  private restarting = false;

  constructor(readonly session: GxSession, private hooks: PlaybackHooks, private clock = () => performance.now()) {
    session.onPicture = (rgba, row) => hooks.onPicture(rgba, row);
  }

  get row(): number { return this.session.shown; }

  play(): void { if (this.ended) { void this.seek(0).then(() => this.play()); return; } this.playing = true; this.acc = 0; this.last = this.clock(); this.hooks.onState(); this.kick(); }
  pause(): void { this.playing = false; this.hooks.onState(); }
  toggle(): void { this.playing ? this.pause() : this.play(); }
  setSpeed(s: number): void { this.speed = s; this.hooks.onState(); }

  /** one row forward (paused) */
  stepForward(): void {
    this.pause();
    this.session.step(true);
    this.hooks.onState();
  }

  /** one row back: the match starts again and plays to the row before */
  stepBack(): Promise<void> { this.pause(); return this.seek(Math.max(0, this.session.shown - 1)); }

  /** show row `row` (0 = the first), by playing forward; resolves when it is shown */
  seek(row: number): Promise<void> {
    this.seeking = Math.max(0, Math.min(row, this.session.frameCount - 1));
    this.ended = false;
    this.hooks.onState();
    return new Promise((resolve) => { this.seekDone.push(resolve); this.kick(); });
  }
  private seekDone: (() => void)[] = [];

  /** a tick of the page's clock; call from requestAnimationFrame (or `run()` below) */
  tick(): void {
    if (this.busy || this.restarting) return;
    this.busy = true;
    try {
      if (this.seeking !== null) {
        const s = this.session;
        if (s.needsRestart(this.seeking)) {
          this.restarting = true;
          void s.start().then(() => { this.restarting = false; this.kick(); }, (e) => { this.restarting = false; this.hooks.onError(e); });
          return;
        }
        if (s.seekStep(this.seeking)) {
          this.seeking = null;
          const done = this.seekDone; this.seekDone = [];
          this.hooks.onState();
          done.forEach((f) => f());
        }
        return;
      }
      if (!this.playing) return;
      const now = this.clock();
      this.acc += Math.min(100, now - this.last) * 0.06 * this.speed;
      this.last = now;
      let n = Math.floor(this.acc);
      if (n < 1) return;
      this.acc -= n;
      const s = this.session, t0 = now;
      while (n > 0) {
        if (s.index >= s.frameCount) { this.ended = true; this.playing = false; this.hooks.onState(); break; }
        s.step(n === 1);
        n--;
        if (this.clock() - t0 > 14 && n > 0) { this.acc += n; break; }
      }
      this.hooks.onState();
      if (s.wantsRetry) this.retry();
    } catch (e) {
      this.playing = false;
      this.hooks.onError(e);
    } finally {
      this.busy = false;
    }
  }

  /** the game parted from the replay: try the other drive choices with playback held, then go on from where it was */
  private retry(): void {
    const s = this.session, row = Math.max(0, s.shown), wasPlaying = this.playing;
    this.playing = false;
    this.restarting = true;
    this.hooks.onState();
    void s.retryDrives((text) => this.hooks.onRetry?.(text)).then(async (switched) => {
      this.hooks.onRetry?.(null);
      this.restarting = false;
      if (switched) { this.seeking = row; }
      this.playing = wasPlaying;
      this.last = this.clock();
      this.hooks.onState();
      this.kick();
    }, (e) => { this.restarting = false; this.hooks.onRetry?.(null); this.hooks.onError(e); });
  }

  private kick(): void { if (!this.raf && typeof requestAnimationFrame === "function") this.loop(); }
  private loop = (): void => {
    this.tick();
    this.raf = this.playing || this.seeking !== null || this.restarting ? requestAnimationFrame(this.loop) : 0;
  };
  /** start the page's loop (call once; it keeps going while something is playing or seeking) */
  run(): void { this.kick(); }
  /** the loop must run again after play/pause/seek set something */
  poke(): void { this.kick(); }
}
