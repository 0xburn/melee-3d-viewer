/* When the page hands the player a newer viewer track while the simulator
 * runs ahead (feed.ts). Each hand-over is a new ViewerTrack, and the player
 * rebuilds what it made from the last one (its effects, its camera) much as
 * on a seek, so it is done seldom: once the track is well ahead of the
 * frame shown, and again only when the frame shown gets near its end.
 */

/** how far ahead of the frame shown a track must reach before it is handed over (frames: 5 s) */
export const LEAD = 300;
/** how near its end the frame shown may get before a longer one is handed over (frames: 3 s) */
export const LOW = 180;
/** a simulator this close to the end (seconds) is waited for: one hand-over instead of two */
export const FINISH_WAIT = 1;

export interface FeedState {
  /** the end of the track handed over last (first game frame it does not hold), or null: none yet */
  published: number | null;
  /** how far the simulator's track holds now */
  frontier: number;
  /** the game frame shown */
  playhead: number;
  /** the simulator has stopped (the end, or where its game parted from the replay) */
  done: boolean;
  /** frames a second it runs at, and frames it has left */
  rate: number;
  remaining: number;
}

export function shouldPublish(s: FeedState): boolean {
  if (s.published !== null && s.frontier <= s.published) return false;
  if (s.done) return true;
  const ahead = s.frontier >= s.playhead + LEAD;
  if (s.published === null) return ahead && !(s.rate > 0 && s.remaining / s.rate < FINISH_WAIT);
  return s.playhead >= s.published - LOW && ahead;
}
