/* 3D replay viewer: which of its wait animations a fighter
 * standing still plays, read from the Melee decompilation (ftwaitanim.c);
 * this is our own writing of it.
 *
 * Wait (action state 14) starts on the state's own animation (Wait1). Each
 * time an animation of it ends the game picks the next from the fighter's
 * list (ftData+0x24: subaction and weight in percent, -1 ending it) at random
 * by the weights, and the picks are drawn again while they come out the
 * animation just played, unless that was Wait1 (subaction 2, or 31): so
 * Wait2 and the rest never run twice in a row, and a fighter with two always
 * goes back to Wait1 after its Wait2 (ftCo_8008A7A8). The state does not
 * change; the animation starts over, which the replay's frame counter shows.
 *
 * The replay does not say which was picked. A finished one is told by its
 * length, where the fighter's waits are of different lengths; one still
 * running when the fighter moves off has run at least as far as the counter
 * got; what is left after those is the game's random number, and a stand-in
 * by the weights decides it.
 */

export const WAIT = 14;
/** the waits that may follow themselves (ftwaitanim.c inlineA0) */
const REPEATS = new Set([2, 31]);

export interface WaitAnim { sub: number; weight: number; frames: number }

export interface WaitFrame { actionStateId: number; actionStateFrameCounter: number; isDead?: boolean }

/** the subaction a fighter plays on each frame (by the replay's frame
 *  index), -1 where it is not in Wait or plays the state's own; `own` the
 *  state's own subaction, `seed` the stand-in's */
export function waitSubactions(at: (i: number) => WaitFrame | undefined, n: number, waits: readonly WaitAnim[],
                               own: number, seed: number): Int16Array {
  const out = new Int16Array(n).fill(-1);
  if (waits.length < 2) return out;
  const isWait = (s: WaitFrame | undefined) => !!s && !s.isDead && s.actionStateId === WAIT;
  for (let i = 0; i < n;) {
    if (!isWait(at(i))) { i++; continue; }
    // one stretch of Wait, and its animations: a new one where the counter starts over
    let end = i;
    while (end + 1 < n && isWait(at(end + 1))) end++;
    const starts: number[] = [i];
    for (let g = i + 1; g <= end; g++) {
      if (at(g)!.actionStateFrameCounter < at(g - 1)!.actionStateFrameCounter) starts.push(g);
    }
    let prev = own;
    starts.forEach((s, k) => {
      const last = k + 1 < starts.length ? starts[k + 1] - 1 : end;
      let sub = own;
      if (k > 0) {
        let cands = waits.filter((w) => REPEATS.has(prev) || w.sub !== prev);
        const ran = at(last)!.actionStateFrameCounter + 1;
        const finished = k + 1 < starts.length;
        const fit = cands.filter((w) => finished ? Math.abs(w.frames - ran) < 1.5 : w.frames >= ran - 0.5);
        if (fit.length) cands = fit;
        sub = cands.length === 1 ? cands[0].sub : pick(cands, seed + s);
      }
      if (sub !== own) out.fill(sub, s, last + 1);
      prev = sub;
    });
    i = end + 1;
  }
  return out;
}

function pick(cands: readonly WaitAnim[], seed: number): number {
  const total = cands.reduce((t, w) => t + Math.max(0, w.weight), 0);
  if (total <= 0) return cands[0].sub;
  let r = ((Math.imul(seed + 1, 2654435761) >>> 0) % 1000) / 1000 * total;
  for (const w of cands) {
    r -= Math.max(0, w.weight);
    if (r < 0) return w.sub;
  }
  return cands[cands.length - 1].sub;
}
