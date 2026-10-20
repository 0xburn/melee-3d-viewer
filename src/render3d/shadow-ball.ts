export const isShadowBall = (type: number) => type === 0x70 || type === 0x90;

/** itmewtwoshadowball.c replaces the grandchild scale after animation.
 * Recorded charge is available for held and launched balls, including Kirby.
 * State 9 is a separate projectile with no scale callback. */
export function shadowBallScale(state: number, charge: number, maximum: number,
                                low: number, high: number): number | null {
  if (!(maximum > 0) || state < 0 || state > 8 || !Number.isFinite(charge)) return null;
  return low + (high - low) * Math.max(0, Math.min(1, charge / maximum));
}
