/**
 * The frame of an animation to show for a replay's action-state frame
 * counter. The game loops a looping animation itself (a Fall's counter never
 * passes its length: it starts over), and holds a held one on its last frame
 * (a DamageFlyN's counter sits at 29 for the whole flight). So the counter is
 * the frame, and past the end it is the end - never wrapped back to the
 * start, which showed a launched Falco in the first, upright frame of his
 * tumble pose, as if he stood in midair.
 */
export function animTime(counter: number, frames: number): number {
  const t = Math.max(0, counter);
  return frames > 0 ? Math.min(t, frames) : t;
}
