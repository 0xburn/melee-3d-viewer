/* 3D replay viewer: the puffs of smoke a launched fighter leaves.
 *
 * A hit that sends a fighter flying leaves a trail of smoke puffs (common
 * effect 0x408) along the way it flies, spaced by how fast it goes. The game
 * (ftCo_Damage.c): as the hit lands it sets a countdown from the knockback's
 * speed (ftCo_Damage_SetMv8FromKbThreshold: ftCommonData +0x568..+0x578 the
 * speeds, +0x57C..+0x588 the frame counts; too slow: none) and, when there
 * is one, makes it 1 - the first puff comes at once. Each frame of a flying
 * state's animation (DamageFly, DamageFlyRoll, and a bounce off a wall or the
 * ceiling, which runs the same: ftCo_FlyReflect.c) counts it down; at 0 a puff
 * goes at the fighter's TopN, turned along the knockback's way, and the count
 * starts again from the speed then. The animation does not run in hitlag.
 *
 * The replay has the knockback's speed on every frame (its attack-based speed),
 * so the trail is worked out from it; a viewer track's own puffs take its
 * place when there is one.
 */
import type { PlayerState } from "../../common/types";
import { Archive, ptr } from "../hsd";

/** the knockback speeds that set the puffs' spacing, and the spacings (frames) */
export interface SmokeTimes { speeds: [number, number, number, number, number]; counts: [number, number, number, number];
                             /** how much knockback's speed falls each frame in the air (+0x204) */
                             decay: number }

/** as PlCo.dat has them (a file that cannot be read leaves these) */
export const SMOKE_TIMES: SmokeTimes = { speeds: [4, 6, 7, 8, 10], counts: [4, 3, 2, 1], decay: 0.051 };

/** the counts from PlCo.dat's ftCommonData (`table`: its address) */
export function readSmokeTimes(a: Archive, table: number): SmokeTimes {
  const cd = ptr(a, table);
  if (cd === null || cd + 0x58c > a.data.byteLength) return SMOKE_TIMES;
  const d = a.data;
  const speeds = [0x568, 0x56c, 0x570, 0x574, 0x578].map((o) => d.getFloat32(cd + o)) as SmokeTimes["speeds"];
  const counts = [0x57c, 0x580, 0x584, 0x588].map((o) => d.getInt32(cd + o)) as SmokeTimes["counts"];
  const decay = d.getFloat32(cd + 0x204);
  const sane = speeds.every((v, i) => v >= 0 && v < 100 && (i === 0 || v >= speeds[i - 1])) && counts.every((v) => v > 0 && v < 200) &&
    decay >= 0 && decay < 1;
  return sane ? { speeds, counts, decay } : SMOKE_TIMES;
}

/** the countdown a knockback this fast sets (0: too slow for any) */
export function smokeCount(speed: number, t: SmokeTimes): number {
  const [a, b, c, d, e] = t.speeds, [n0, n1, n2, n3] = t.counts;
  return speed < a ? 0 : speed < b ? n0 : speed < c ? n0 : speed < d ? n1 : speed < e ? n2 : n3;
}

// the states the countdown goes on in: flying from a hit, and its bounce off
// a wall or the ceiling (FlyReflectWall, FlyReflectCeil)
const FLYING = new Set([87, 88, 89, 90, 91, 247, 248]);
// the states a hit puts a fighter in (ftCo_Damage: Damage to DamageFlyRoll)
const HIT = (s: number) => s >= 75 && s <= 91;

/** each frame of a fighter's history (the replay's index) a puff goes on:
 *  its angle (radians), or NaN for none */
export function launchSmokes(at: (g: number) => PlayerState | null | undefined, frames: number, t: SmokeTimes): Float32Array {
  const out = new Float32Array(frames).fill(NaN);
  let count = 0;
  const speed = (p: PlayerState) => Math.hypot(p.attackBasedXSpeed ?? 0, p.attackBasedYSpeed ?? 0);
  for (let g = 1; g < frames; g++) {
    const st = at(g), was = at(g - 1);
    if (!st || !was) { count = 0; continue; }
    const s = st.actionStateId;
    // a hit this frame (landed after the frame's animation ran)
    const hit = HIT(s) && (was.actionStateId !== s || st.actionStateFrameCounter < was.actionStateFrameCounter) &&
      (st.hitlagRemaining ?? 0) > 0;
    // the frame's animation, in the state it began in, out of hitlag: the
    // count down (a tech, a KO, a new hit change the state after it ran)
    if (count > 0 && FLYING.has(was.actionStateId) && (hit || !((st.hitlagRemaining ?? 0) > 0)) && --count === 0) {
      // (the speed as the frame began: the frame before's, after its
      // physics - but out of hitlag, the knockback the hit set, which the
      // replay shows only from this frame on)
      // (and before this frame's physics took its fall off: ftCommon's knockback decay)
      const fresh = (was.hitlagRemaining ?? 0) > 0;
      const from = fresh ? st : was;
      const kx = from.attackBasedXSpeed ?? 0, ky = from.attackBasedYSpeed ?? 0;
      out[g] = Math.atan2(-kx, ky);
      const v = Math.hypot(kx, ky);
      count = smokeCount(fresh && v > 0 ? v + t.decay : v, t);
    }
    if (st.isDead || s <= 11) { count = 0; continue; }
    // a hit: the count from its knockback, the first puff at once
    if (hit) count = smokeCount(speed(st), t) > 0 ? 1 : 0;
  }
  return out;
}
