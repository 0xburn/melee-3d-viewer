/* 3D replay viewer: where a hit landed.
 *
 * A replay says that a fighter took damage and who hit them, not where. The
 * game puts its hit spark where the hitbox met the hurtbox (lbcollision.c:
 * the closest points of the hitbox's sweep and the hurtbox's capsule, then
 * the hurtbox's edge along the line between them). This does the same with
 * the attacker's hitboxes from its move script (fx/script.ts) on its joints,
 * swept from the frame before, against the victim's hurtboxes (its fighter
 * file) as it stood the frame before the hit; the spark is the game's own
 * by the hitbox's element, sized by the damage. A hit no hitbox of the move
 * explains (a projectile, an item, a throw) sparks between the nearest of
 * the attacker's items and the victim, or at the victim's middle. */
import type { ActorFrame, FxWorld } from "./world";
import { hitsAt } from "./script";
import type { PlayerState } from "../../common/types";
import { electricByHitlag, isThrown } from "../hitlag";

type V3 = [number, number, number];

const xf = (m: Float32Array, v: V3): V3 => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/** closest points of segments p0-p1 and q0-q1: [on p, on q] */
export function closest(p0: V3, p1: V3, q0: V3, q1: V3): [V3, V3] {
  const d1 = sub(p1, p0), d2 = sub(q1, q0), r = sub(p0, q0);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s = 0, t = 0;
  if (a < 1e-9 && e < 1e-9) return [p0, q0];
  if (a < 1e-9) t = clamp01(f / e);
  else {
    const c = dot(d1, r);
    if (e < 1e-9) s = clamp01(-c / a);
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-9 ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  return [lerp(p0, p1, s), lerp(q0, q1, t)];
}

// the game's spark for each hitbox element (ftcoll.c hit_effect_ids)
const ELEMENT_FX: Record<number, number> = { 0: 0x3e8, 1: 0x3ea, 2: 0x3e9, 3: 0x3ec, 5: 0x3ed, 9: 0x3e8, 10: 0x3e8 };
const SHIELD_HIT = 0x41c;
// A hit whose spark is the ring (0x3E8: normal, ground and cape hitboxes)
// makes the big impact burst instead when its knockback is 180 or more
// (ftcoll.c ftColl_80078538: ftCommonData 0x3F0). The replay has the
// knockback as its hitstun, (int)(knockback x 0.4) (ftCo_Damage.c,
// ftCommonData 0x154), held through the hitlag: 180 or more is 72 or more
const HEAVY_HIT = 0x3f3, HEAVY_HITSTUN = 72;

/** the spark of a hit on a fighter: its hitbox element's, the ring turned
 *  to the impact burst by a knockback of 180 or more (`hitstun` the replay's
 *  on the hit's frame, null when it is not in hitstun) */
export function hitSpark(element: number, hitstun: number | null): number {
  const fx = ELEMENT_FX[element] ?? 0x3e8;
  return fx === 0x3e8 && hitstun !== null && hitstun >= HEAVY_HITSTUN ? HEAVY_HIT : fx;
}
const GUARD = new Set([178, 179, 180, 181, 182]);
// a shield in its stun (GuardSetOff): struck; in its first frames
// (GuardReflect): a powershield, its flash and the fighter's color animation
const SHIELD_STUN = 181, POWERSHIELD = 182, POWERSHIELD_HIT = 27, POWERSHIELD_FLASH = 118;

export interface ContactInfo {
  /** the victim's frame before the hit, and the attacker's (their joints) */
  prevWorld: (key: string) => Float32Array | null;
  /** how far into its move a fighter is (its script's clock) */
  scriptTime: (key: string) => number | null;
  /** a fighter's items this frame (projectiles), by port: where each is, and
   *  the element of its hitbox (fighter.ts articleElement), when known */
  items: (port: number) => { pos: V3; element: number | null }[];
  /** where a fighter's middle is above its feet */
  middle: (char: number) => number;
  partToJoint: (char: number, part: number) => number;
  /** whether a fighter's shield struck this frame was a powershield (powershielded) */
  powershield?: (key: string) => boolean;
}

/** what the hits need of each fighter's frame before */
export interface Before { percent: number; state: number; hitlag: number }

/** the hits of this frame, sparked where they landed (with a viewer
 *  track's effect pieces, FxWorld.generic, the sparks are the track's: only
 *  the colors are started here) */
export function hitSparks(frame: number, actors: ActorFrame[], w: FxWorld, prev: Map<string, Before>,
                          info: ContactInfo) {
  for (const v of actors) {
    const before = prev.get(v.key);
    // a shield struck: the spark where the hit met the bubble (ftcoll.c:
    // 0x41C at the collision's point). It takes no percent, so it is told by
    // the shield going into its stun, or a new hitlag while in it
    if (before && v.st.actionStateId === SHIELD_STUN && !v.st.isDead &&
        (before.state !== SHIELD_STUN || (v.st.hitlagRemaining ?? 0) > before.hitlag)) {
      const at = shieldContact(v, actors, info);
      // (in the shield's first frames: a powershield, below)
      const power = info.powershield?.(v.key) ?? false;
      if (!w.generic) w.spawn(power ? POWERSHIELD_HIT : SHIELD_HIT, { pos: at, follow: null, facing: v.st.facingDirection || 1, angle: 0, damage: 0,
                                                     scale: 1, owner: null });
      if (power) w.colStart(v.key, POWERSHIELD_FLASH);
      continue;
    }
    // a hit in the shield's first frames (a powershield): its own flash where
    // it landed, and the fighter's white flash (ftcoll.c: effect 27, color
    // animation 118). Told by a new hitlag in that window
    if (before && v.st.actionStateId === POWERSHIELD && !v.st.isDead && (v.st.hitlagRemaining ?? 0) > before.hitlag) {
      const at = shieldContact(v, actors, info);
      if (!w.generic) w.spawn(POWERSHIELD_HIT, { pos: at, follow: null, facing: v.st.facingDirection || 1, angle: 0, damage: 0, scale: 1, owner: null });
      w.colStart(v.key, POWERSHIELD_FLASH);
      continue;
    }
    const dmg = before ? v.st.percent - before.percent : 0;
    if (!(dmg >= 0.5) || v.st.isDead) continue;
    const shielding = GUARD.has(v.st.actionStateId);
    const at = contact(v, actors, info) ?? fallback(v, info);
    // (whether it was electric the hit's hitlag says, when the hitbox found
    // may be another of the move's: ../hitlag.ts)
    const electric = before ? electricByHitlag(dmg, before.state === 39 || before.state === 40, v.st.hitlagRemaining) : null;
    if (electric === true) at.element = 2;
    else if (electric === false && at.element === 2) at.element = 0;
    const hitstun = v.st.isInHitstun === false ? null : v.st.hitstunRemaining ?? null;
    if (!w.generic) w.spawn(shielding ? SHIELD_HIT : hitSpark(at.element, hitstun), {
      pos: at.pos, follow: null, facing: v.st.facingDirection || 1, angle: 0, damage: dmg, scale: 1, owner: null,
    });
    // and the fighter's color for it (a shield takes the hit, not the fighter)
    // (the hitstun gives the knockback's level; one held in a grab has none,
    // the replay's field then being something else: level 0)
    const feel = hitColor(before, v.st, Number(v.key.split(":")[0]));
    if (!shielding && feel.colors) w.hit(v.key, at.element, v.st.isInHitstun === false ? 0 : v.st.hitstunRemaining || 0, feel.runOn,
                                          feel.full);
  }
}

/** Whether a shield struck on frame `f` was a powershield (the game's flash,
 *  ftcoll.c ftColl_80076CBC: x221C_b2). The window opens as the shield comes
 *  up by the button pressed that frame (GuardReflect, ftCo_80093A50: set
 *  with its count at +0x2B4, 3) and closes once the count, taken down a
 *  frame at a time by the state's animation callback, runs below 0: hits on
 *  its first four frames. A shield brought up by the trigger's light press
 *  (GuardOn) has none. `stateAt(g)` the fighter's state on frame g,
 *  `pressed(g)` whether it pressed L or R's button on frame g (the replay's
 *  inputs), `window` the count */
export function powershielded(stateAt: (g: number) => PlayerState | undefined, pressed: (g: number) => boolean, f: number,
                              window = 3): boolean {
  const prev = stateAt(f - 1);
  if (!prev) return false;
  // up and struck on the one frame: the replay never shows it up
  if (!GUARD.has(prev.actionStateId)) return pressed(f);
  if (prev.actionStateId !== POWERSHIELD) return false;
  let start = f - 1;
  while (start > 0 && f - start <= window + 1 && stateAt(start - 1)?.actionStateId === POWERSHIELD) start--;
  return f - start <= window;
}

/** Whether a hit starts the fighter's color for it, and whether that runs
 *  a step more on the hit's frame. The game starts it only for a hit with
 *  knockback (Fighter_procCollResolve: a hit without, a laser's, only takes
 *  the damage), and such a hit always has hitlag, which a replay records
 *  (Slippi 3.8 on): none recorded for a new hit, no color. A throw's
 *  release is the one knockback hit with none: the thrower's animation
 *  callback sends the one it holds flying (ftCo_800DD724), whose color then
 *  runs its own frame's step as well when its fighter comes after the
 *  thrower's in the game's order (a higher port: Fighter_procAnim runs port
 *  by port). `full`: the color is the knockback's top level whatever the
 *  knockback, as the game has it for a state it names (ftCo_8008DCE0 given a
 *  state: a fighter hit on the floor, DownDamage; one thrown down, sent off
 *  in DamageFlyTop, ftCo_800DE7C0) */
export function hitColor(before: Before | undefined, st: PlayerState, port: number): { colors: boolean; runOn: boolean; full: boolean } {
  // (one still held takes a throw's damage without its knockback: no color)
  const released = before !== undefined && isThrown(before.state) && !isThrown(st.actionStateId);
  const hitlag = st.hitlagRemaining;
  const recorded = hitlag !== undefined && hitlag !== null && !Number.isNaN(hitlag);
  if (!released && recorded && !(hitlag > 0)) return { colors: false, runOn: false, full: false };
  const full = DOWN_DAMAGE.has(st.actionStateId) || (before !== undefined && THROWN_DOWN.has(before.state));
  return { colors: true, runOn: released && st.lastHitBy >= 0 && st.lastHitBy < port, full };
}
// hit on the floor (DownDamageU, D); held for a down throw (ThrownLw, ThrownLwWomen)
const DOWN_DAMAGE = new Set([185, 193]), THROWN_DOWN = new Set([242, 243]);

/** a hitbox's sweep over a frame (from where it was to where it is) and its radius */
export interface Sweep { was: V3; now: V3; size: number }

/** which of a move's hitboxes (in their order) met a shield centered at `c`
 *  of radius `radius`, and at what point: the first whose sweep reaches the
 *  bubble, at the sweep's point nearest the middle; else the nearest of them
 *  (`reached` false). Null with none */
export function shieldHitPoint(sweeps: Sweep[], c: V3, radius: number): { p: V3; d: number; reached: boolean } | null {
  let best: { p: V3; d: number; reached: boolean } | null = null;
  for (const s of sweeps) {
    const seg = sub(s.now, s.was), len = dot(seg, seg);
    const p = len < 1e-9 ? s.now : lerp(s.was, s.now, clamp01(dot(sub(c, s.was), seg) / len));
    const d = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
    if (d <= radius + s.size) return { p, d, reached: true };
    if (!best || d < best.d) best = { p, d, reached: false };
  }
  return best;
}

/** where a hit met a shield: on the bubble' (centered on the fighter's shield
 *  joint, as big as its health and the fighter make it), toward the nearest
 *  of the other fighters' live hitboxes, or else their nearest item */
function shieldContact(v: ActorFrame, actors: ActorFrame[], info: ContactInfo): V3 {
  const f = v.fighter, j = f.shieldJoint;
  const c: V3 = j > 0 && (j + 1) * 16 <= v.world.length
    ? [v.world[j * 16 + 12], v.world[j * 16 + 13], v.world[j * 16 + 14]]
    : [v.st.xPosition, v.st.yPosition + info.middle(v.st.internalCharacterId), 0];
  const radius = f.modelScale * f.shieldSize * ((Math.max(0, v.st.shieldSize) / 60) * 0.85 + 0.15);
  let target: V3 | null = null, bd = Infinity, reached = false;
  for (const a of actors) {
    if (reached) break;
    if (a === v || a.key.split(":")[0] === v.key.split(":")[0]) continue;
    // (the hitboxes live now, the script run to the replay's counter: a
    // hitbox meets the shield on the frame it comes out - Sheik's forward
    // air's, made at its script's frame 5, hits on her move's 5th)
    const time = info.scriptTime(a.key);
    const script = a.fighter.scriptFor(a.st.actionStateId);
    const hits = time === null ? [] : [...hitsAt(script, time)].sort((x, y) => x.id - y.id);
    const prev = info.prevWorld(a.key) ?? a.world;
    // The game takes the attacker's hitboxes in their order and the first
    // whose sweep (from the frame before to now) reaches the bubble makes the
    // spark (ftcoll.c: the others of its group are then spent); its point
    // is the sweep's closest to the bubble's middle (lbColl_80006E58). One
    // none of them reaches (the replay's frame a step off): the nearest
    const sweeps: Sweep[] = [];
    for (const h of hits) {
      const joint = h.common ? info.partToJoint(a.st.internalCharacterId, h.bone) : h.bone;
      if (joint < 0 || (joint + 1) * 16 > a.world.length) continue;
      const now = xf(a.world.subarray(joint * 16, joint * 16 + 16), h.offset);
      const was = (joint + 1) * 16 <= prev.length ? xf(prev.subarray(joint * 16, joint * 16 + 16), h.offset) : now;
      sweeps.push({ was, now, size: h.ignoreScale ? h.size : h.size * a.fighter.modelScale });
    }
    const got = shieldHitPoint(sweeps, c, radius);
    if (got && (got.reached || got.d < bd)) { target = got.p; bd = got.d; reached = got.reached; }
  }
  if (!target) {
    for (const a of actors) {
      if (a === v) continue;
      for (const { pos: it } of info.items(Number(a.key.split(":")[0]))) {
        const d = Math.hypot(it[0] - c[0], it[1] - c[1]);
        if (d < bd) { bd = d; target = it; }
      }
    }
  }
  // The spark is where the hit met the bubble's surface: from its middle
  // toward the hitbox, a radius out, the hitbox inside the bubble or not
  // (lbColl_80006E58's contact point, which efSync_Spawn 1052 is given), at
  // that point's own depth. The bubble writes no depth and the particles are
  // drawn after it, so the spark shows over the bubble, and behind whatever
  // of the attacker is nearer the eye (Dolphin: a Fox's sleeve hides its
  // first white burst)
  if (!target) return c;
  const d = Math.hypot(target[0] - c[0], target[1] - c[1], target[2] - c[2]);
  return d < 1e-6 ? c : lerp(c, target, radius / d);
}

function fallback(v: ActorFrame, info: ContactInfo): { pos: V3; element: number } {
  const mid: V3 = [v.st.xPosition, v.st.yPosition + info.middle(v.st.internalCharacterId), 0];
  let best: V3 | null = null, bd = Infinity, element = 0;
  for (const it of info.items(v.st.lastHitBy)) {
    const d = Math.hypot(it.pos[0] - mid[0], it.pos[1] - mid[1]);
    if (d < bd && d < 25) { bd = d; best = it.pos; element = it.element ?? 0; }
  }
  // (the item's own hitbox's element: a fireball's fire, a Shadow Ball's darkness)
  return { pos: best ? lerp(mid, best, 0.5) : mid, element };
}

function contact(v: ActorFrame, actors: ActorFrame[], info: ContactInfo): { pos: V3; element: number } | null {
  const attacker = actors.find((a) => a.key === `${v.st.lastHitBy}:0`) ?? actors.find((a) => a.key.startsWith(`${v.st.lastHitBy}:`));
  if (!attacker || attacker === v) return null;
  const time = info.scriptTime(attacker.key);
  if (time === null) return null;
  const hits = hitsAt(attacker.fighter.scriptFor(attacker.st.actionStateId), time);
  if (!hits.length) return null;
  const aNow = attacker.world, aPrev = info.prevWorld(attacker.key) ?? aNow;
  const vPrev = info.prevWorld(v.key) ?? v.world;
  const scale = attacker.fighter.modelScale;
  let best: { pos: V3; element: number; overlap: number } | null = null;
  for (const h of hits) {
    const joint = h.common ? info.partToJoint(attacker.st.internalCharacterId, h.bone) : h.bone;
    if (joint < 0 || (joint + 1) * 16 > aNow.length) continue;
    const m1 = aNow.subarray(joint * 16, joint * 16 + 16), m0 = aPrev.subarray(joint * 16, joint * 16 + 16);
    const h1 = xf(m1, h.offset), h0 = m0.length === 16 ? xf(m0, h.offset) : h1;
    const hr = h.ignoreScale ? h.size : h.size * scale;
    for (const hb of v.fighter.hurtboxes) {
      if ((hb.joint + 1) * 16 > vPrev.length) continue;
      const m = vPrev.subarray(hb.joint * 16, hb.joint * 16 + 16);
      const a = xf(m, hb.a), b = xf(m, hb.b);
      // the bone's own scale scales the capsule's radius
      const bs = Math.hypot(m[0], m[1], m[2]);
      const rr = hb.radius * bs;
      const [pc, qc] = closest(h0, h1, a, b);
      const d = Math.hypot(pc[0] - qc[0], pc[1] - qc[1], pc[2] - qc[2]);
      const overlap = hr + rr - d;
      if (!best || overlap > best.overlap) {
        const pos = d < 1e-6 ? pc : lerp(qc, pc, Math.min(1, rr / d));
        best = { pos, element: h.element, overlap };
      }
    }
  }
  // a hitbox that was nowhere near: not this move after all (a projectile)
  if (!best || best.overlap < -6) return null;
  return { pos: best.pos, element: best.element };
}
