/* 3D replay viewer: a shield's tilt.
 *
 * Holding a shield, a fighter leans it toward the control stick. The game
 * does not play the Guard animation through; its frames are the shield
 * tilted each way (frame 10 + the tilt's angle in degrees), and each frame
 * of GuardOn, Guard and a powershield it eases the tilt's angle and how far
 * it leans toward the stick's (ftCo_80091BC4: by ftCommonData 0x44C of the
 * way), from straight (angle 0, none) as the shield comes up. The pose is
 * the fighter's guard pose leaned that far toward the Guard animation at
 * that angle (ftCo_80091E78). This works the ease out from the replay's
 * sticks, from the frame the shield came up.
 */

/** the shield's states: coming up, held, struck, a powershield */
const SHIELD = new Set([178, 179, 181, 182]);
/** the ones that ease the tilt (their Anim callbacks call ftCo_80091E78) */
const EASING = new Set([178, 179, 182]);

export interface GuardFrame { state: number; facing: number; x: number; y: number }

/** the tilt on the last of `frames` (oldest first, the shield's run up to
 *  now): the Guard animation's frame for it, and how far the pose leans
 *  toward it (0..1); null outside a shield */
export function guardTilt(frames: GuardFrame[], ease: number): { frame: number; amount: number } | null {
  if (!frames.length || !SHIELD.has(frames[frames.length - 1].state)) return null;
  let deg = 0, mag = 0, prev = -1;
  for (const f of frames) {
    if (!SHIELD.has(f.state)) { prev = f.state; deg = 0; mag = 0; continue; }
    // (a shield coming up starts straight: ftCo_Guard.c, GuardOn's entry)
    if (f.state === 178 && prev !== 178) { deg = 0; mag = 0; }
    prev = f.state;
    if (!EASING.has(f.state)) continue;
    let stick = (Math.atan2(f.y, f.x * (f.facing < 0 ? -1 : 1)) * 180) / Math.PI;
    if (stick < 0) stick += 360;
    stick = Math.min(359, Math.max(0, stick));
    let d = stick - deg;
    if (d > 180) d -= 360;
    else if (d < -180) d += 360;
    deg += d * ease;
    if (deg > 360) deg -= 360;
    else if (deg < 0) deg += 360;
    mag += ease * (Math.min(1, Math.hypot(f.x, f.y)) - mag);
  }
  return { frame: 10 + deg, amount: mag };
}
