/* 3D replay viewer: a fighter's timed invincibility, and its blink.
 *
 * Besides what a move's script says of its body (intangible frames of a roll,
 * of a ledge grab), the game gives a fighter invincibility for a number of
 * frames on some occasions, whatever it does meanwhile: two timers
 * (fighter.c x1990 intangible, x1994 invincible), each set to the larger of
 * what it holds and what is asked (ftColl_8007B760, ftColl_8007B7A4), counted
 * down a frame at a time as the fighter's animation runs (Fighter_procAnim).
 * While either runs, the fighter blinks: color animation 9, started with the
 * timer and started again whenever something above it ends (ftcolanim.c),
 * reset the frame the last timer runs out. The occasions, from the Melee
 * decompilation, each read from the replay's states:
 *   - leaving the angel platform (ft_0D4D.c, ftCommonData +0x5D8): the first
 *     frame out of Rebirth or RebirthWait;
 *   - catching the ledge (ftCo_CliffWait.c, +0x49C): CliffWait's first frame;
 *   - a throw (ftCo_Throw.c ftCo_800DD398, +0x348): the thrower, from the
 *     throw's first frame;
 *   - a wall tech or a wall jump (ftCo_PassiveWall.c ftCo_800C1E64, +0x764):
 *     PassiveWall's first frame, PassiveWallJump's when it is not the tech's
 *     own jump (that one goes on with the tech's timer);
 *   - bouncing off a wall or the ceiling in tumble, or a wall while down
 *     (ftCo_FlyReflect.c, ftCo_800C7CA0.c, +0x1B8).
 * A timer asked on frame F has the fighter invincible, and blinking, from F
 * to F + n - 1: the count the game sets there is not counted down until the
 * next frame's animation (asked in a state's input, collision or animation
 * callback alike, all after or in the animation step past its countdown). A
 * KO or a new stock clears both (Fighter_Spawn). The replay's own hurtbox
 * state says whether the fighter is untouchable at all (Slippi records the
 * largest of the script's state and the timers': ftColl_8007B868), so a frame
 * it calls vulnerable has neither timer running.
 */
import type { PlayerState } from "../../common/types";
import { Archive, ptr } from "../hsd";

/** how long each occasion's timer is set to (ftCommonData) */
export interface InvTimes { rebirth: number; ledge: number; thrower: number; wallTech: number; bounce: number }

/** as PlCo.dat has them (a file that cannot be read leaves these) */
export const INV_TIMES: InvTimes = { rebirth: 120, ledge: 30, thrower: 8, wallTech: 14, bounce: 15 };

/** the counts from PlCo.dat's ftLoadCommonData (`table`: its address) */
export function readInvTimes(a: Archive, table: number): InvTimes {
  const cd = ptr(a, table);
  if (cd === null) return INV_TIMES;
  const n = (o: number) => (cd + o + 4 <= a.data.byteLength ? a.data.getInt32(cd + o) : -1);
  const out: InvTimes = { rebirth: n(0x5d8), ledge: n(0x49c), thrower: n(0x348), wallTech: n(0x764), bounce: n(0x1b8) };
  // (a file whose numbers are not sane leaves the game's)
  return Object.values(out).every((v) => v > 0 && v < 1000) ? out : INV_TIMES;
}

// the common states these look at
const REBIRTH = 12, REBIRTH_WAIT = 13;
const CLIFF_WAIT = 253;
const THROW_F = 219, THROW_LW = 222;
const PASSIVE_WALL = 202, PASSIVE_WALL_JUMP = 203;
const FLY_REFLECT_WALL = 247, FLY_REFLECT_CEIL = 248, DOWN_REFLECT = 335;
const isThrow = (s: number) => s >= THROW_F && s <= THROW_LW;
const gone = (s: PlayerState) => s.isDead || s.actionStateId <= 11;

/** the timer a fighter's change of state from `prev` to `st` asks for on
 *  this frame (its length in frames), or 0 */
export function invincibilityAsked(prev: PlayerState | undefined, st: PlayerState | undefined, t: InvTimes = INV_TIMES): number {
  if (!prev || !st || gone(st) || gone(prev)) return 0;
  const s = st.actionStateId, p = prev.actionStateId;
  if (s === p) return 0;
  if ((p === REBIRTH || p === REBIRTH_WAIT) && s !== REBIRTH && s !== REBIRTH_WAIT) return t.rebirth;
  if (s === CLIFF_WAIT) return t.ledge;
  if (isThrow(s) && !isThrow(p)) return t.thrower;
  if (s === PASSIVE_WALL || (s === PASSIVE_WALL_JUMP && p !== PASSIVE_WALL)) return t.wallTech;
  if (s === FLY_REFLECT_WALL || s === FLY_REFLECT_CEIL || s === DOWN_REFLECT) return t.bounce;
  return 0;
}

/** whether a fighter's timed invincibility runs on frame `f` (so it blinks):
 *  `stateAt(g)` its state on frame g */
export function timedInvincible(stateAt: (g: number) => PlayerState | undefined, f: number, t: InvTimes = INV_TIMES): boolean {
  const now = stateAt(f);
  if (!now || gone(now) || now.hurtboxCollisionState === "vulnerable") return false;
  const longest = Math.max(t.rebirth, t.ledge, t.thrower, t.wallTech, t.bounce);
  for (let g = f; g > 0 && f - g < longest; g--) {
    const st = stateAt(g), prev = stateAt(g - 1);
    // (a KO or a new stock clears the timers; before the replay, none)
    if (!st || gone(st)) return false;
    if (f - g < invincibilityAsked(prev, st, t)) return true;
  }
  return false;
}
