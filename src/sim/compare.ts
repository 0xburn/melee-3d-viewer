/* Whether the simulator's frame is the replay's: its output row
 * (MslCoreCompare, wire.ts) against what the replay says the frame ended with
 * (tape.ts expected).
 *
 * The track holds only while the simulator's game is the replay's. This
 * checks the lanes a viewer sees (each fighter's place, action, percent and
 * stocks), with the fork's replay driver's tolerance for places
 * (VIEWER_NEAR: a float's last bits do not part the games for a viewer). It
 * is not the validator's strict check: the first frame it fails on is where
 * the track stops.
 */
import { COMPARE, readField } from "./wire";
import type { Expected } from "./tape";

/** how far a place may be off and still be the replay's (replay_drive.py VIEWER_NEAR) */
export const NEAR = 1e-3;

/** the first lane that differs ("pos_x:0"), or null when the frame is the replay's */
export function differs(output: DataView, expected: (Expected | null)[]): string | null {
  for (let s = 0; s < expected.length; s++) {
    const e = expected[s];
    if (!e) continue;
    const x = readField(output, COMPARE, "pos_x", s), y = readField(output, COMPARE, "pos_y", s);
    if (!(Math.abs(x - e.x) <= NEAR)) return `pos_x:${s}`;
    if (!(Math.abs(y - e.y) <= NEAR)) return `pos_y:${s}`;
    if (readField(output, COMPARE, "action_id", s) !== e.action) return `action_id:${s}`;
    if (readField(output, COMPARE, "stocks", s) !== e.stocks) return `stocks:${s}`;
    if (readField(output, COMPARE, "percent", s) !== Math.fround(e.percent)) return `percent:${s}`;
  }
  return null;
}
