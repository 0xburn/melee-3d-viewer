// The page's idle time, and the warm-up's watch for a step that never ends.
//
// A player's longer loading steps run in the page's idle time, so the page and
// another player on it keep moving. On a busy page (another player playing,
// drawing every frame) there may be no idle time at all: the browser then calls
// back by the timeout with none left. Each such call still gets a short slice,
// so a busy page's player loads, slower, rather than one item a timeout.

/** the most it waits for idle time (ms) */
const IDLE_WAIT = 250;
/** the time a call that came by the timeout gets (ms) */
export const BUSY_SLICE = 4;

/** run f in the page's next idle time (requestIdleCallback; soon anyway), told how many ms it has left */
export function idle(f: (left: () => number) => void): { cancel(): void } {
  const now = () => performance.now();
  // (read off the page each call: not every browser has them, nor the tests)
  const page = globalThis as unknown as {
    requestIdleCallback?: (f: (d: { didTimeout: boolean; timeRemaining(): number }) => void, o: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  const ask = page.requestIdleCallback, cancel = page.cancelIdleCallback;
  if (typeof ask === "function" && typeof cancel === "function") {
    const id = ask.call(globalThis, (d) => {
      if (!d.didTimeout) { f(() => d.timeRemaining()); return; }
      const t0 = now();
      f(() => Math.max(d.timeRemaining(), BUSY_SLICE - (now() - t0)));
    }, { timeout: IDLE_WAIT });
    return { cancel: () => cancel.call(globalThis, id) };
  }
  const t0 = now();
  const id = setTimeout(() => f(() => 6 - (now() - t0)), 0);
  return { cancel: () => clearTimeout(id) };
}

/** whether loading has stopped moving: told now and then what it is at (any
 *  text that changes as it gets on) and whether the time counts (not while it
 *  may not load, or cannot be seen), it says stuck once the text has stayed
 *  the same for limit ms of counted time */
export class Stall {
  private at = "";
  private since = 0;
  private counted = 0;
  private counting = false;
  constructor(private readonly limit: number) {}
  /** stuck, as of this check (the time since the last check counts when it did then) */
  check(now: number, at: string, counts: boolean): boolean {
    if (this.counting) this.counted += now - this.since;
    this.since = now;
    this.counting = counts;
    if (at !== this.at) { this.at = at; this.counted = 0; return false; }
    return this.counted >= this.limit;
  }
}
