/* 3D replay viewer: Rollout's spin - Jigglypuff's and Kirby's
 * copy of it - read from the Melee decompilation (ftpurinspecialn.c,
 * ftkirbyspecialpurin.c); this is our own writing of it.
 *
 * The move's code turns the fighter's YRotN about its x axis by an angle it
 * keeps (ftPr_NormalizeAndSetRollAngle), from 0 as the move starts, a step
 * each frame of its animation callbacks:
 *  - charging (Loop, Full, and in the air): the charge grows from its first
 *    value by a step a frame up to its most, and the angle turns by the
 *    charge x the attribute's degrees, the way it faces as it began;
 *  - rolling (Release): the charge in degrees x 0.2 x the roll's factor; in
 *    the air x the air's factor as well;
 *  - turning (Turn): back the other way by 0.2 x the turn's factor (the air's
 *    factor too in the air, and bounced off a hit: Hit), and the way it goes
 *    turns over as the turn ends.
 * The replay has the states; the numbers are the fighter's attributes:
 * Jigglypuff's own (+0xA0 the charge's first value, +0xA4 its most, +0xA8
 * its step, +0xAC the degrees, +0x98 the roll's factor, +0x6C the turn's,
 * +0xBC the air's, +0xD4 what a wall leaves), Kirby's the same 0x280 further on.
 */

export const PUFF = 15;
/** the first of the move's 17 states: Jigglypuff's, Kirby's copy's */
export const ROLLOUT_FIRST: Record<number, number> = { 15: 346, 4: 475 };
/** where the numbers start in the fighter's attributes (ftData+4) */
export const ROLLOUT_ATTRS: Record<number, number> = { 15: 0, 4: 0x280 };

// the states, from the first: StartR, StartL, Loop, Full, Release, Turn, EndR, EndL, then the air's
// StartR, StartL, ChargeLoop, ChargeFull, ChargeRelease, StartTurn, EndR, EndL, and Hit
const LOOP = 2, FULL = 3, RELEASE = 4, TURN = 5, AIR_LOOP = 10, AIR_FULL = 11, AIR_RELEASE = 12, AIR_TURN = 13, HIT = 16;
const SPINNING = new Set([LOOP, FULL, RELEASE, TURN, AIR_LOOP, AIR_FULL, AIR_RELEASE, AIR_TURN, HIT]);
const COUNT = 17;

export interface RolloutAttrs { first: number; most: number; step: number; degrees: number; roll: number; turn: number; air: number; bounce: number }

/** the numbers, from the fighter's attributes (a float by offset) */
export function rolloutAttrs(attr: (o: number) => number, base: number): RolloutAttrs {
  return { first: attr(base + 0xa0), most: attr(base + 0xa4), step: attr(base + 0xa8), degrees: attr(base + 0xac),
           roll: attr(base + 0x98), turn: attr(base + 0x6c), air: attr(base + 0xbc), bounce: attr(base + 0xd4) };
}

/** the fighter on a frame: its state, the way it faces, and its own speed
 *  across (on the ground its ground speed) */
export interface RollFrame { actionStateId: number; facingDirection: number; speed: number }

const rad = (d: number) => (d * Math.PI) / 180;

/** YRotN's turn on frame `f` (the replay's index), or null out of the
 *  move's spinning states (then TopN faces as the replay says; in them it is
 *  turned to face right, and the roll's way is the move's own). `at(i)` the
 *  fighter on frame i.
 *  A frame's step is its first state's: the animation callbacks run before
 *  the input's and the physics' (Fighter_procAnim), which change the state
 *  on to the one the replay records. A bounce off a wall turns the roll
 *  round (the speed's way changes in Release, no turn between) and keeps
 *  the bounce's share of the charge. */
export function rolloutAngle(at: (i: number) => RollFrame | undefined, f: number, first: number, a: RolloutAttrs): number | null {
  const rel = (i: number) => { const s = at(i)?.actionStateId; return s === undefined || s < first || s >= first + COUNT ? -1 : s - first; };
  const now = rel(f);
  if (now < 0 || !SPINNING.has(now)) return null;
  // back to where the move began
  let start = f;
  while (start > 0 && f - start < 1200 && rel(start - 1) >= 0) start--;
  let dir = (at(start)?.facingDirection ?? 1) < 0 ? -1 : 1;
  let charge = a.first, angle = 0;
  for (let g = start + 1; g <= f; g++) {
    const s = rel(g - 1);
    if (s === LOOP || s === FULL || s === AIR_LOOP || s === AIR_FULL) {
      charge = Math.min(a.most, charge + a.step);
      angle += dir * charge * rad(a.degrees);
    } else if (s === RELEASE) angle += rad(charge) * 0.2 * a.roll * dir;
    else if (s === AIR_RELEASE) angle += 0.2 * a.roll * dir * rad(charge * a.air);
    else if (s === TURN) angle += 0.2 * a.turn * -dir;
    else if (s === AIR_TURN || s === HIT) angle += a.air * 0.2 * a.turn * -dir;
    const next = rel(g);
    // (the way it rolls turns over as a turn ends)
    if ((s === TURN || s === AIR_TURN) && next !== s) dir = -dir;
    // (a wall: rolling on the other way, slower)
    else if ((s === RELEASE || s === AIR_RELEASE) && (next === RELEASE || next === AIR_RELEASE)) {
      const v = at(g)?.speed ?? 0;
      if (v !== 0 && Math.sign(v) !== dir) { dir = -dir; charge = Math.max(0, charge * a.bounce); }
    }
  }
  angle %= Math.PI * 2;
  return angle < 0 ? angle + Math.PI * 2 : angle;
}
