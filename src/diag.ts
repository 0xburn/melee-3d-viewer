/* Diagnostics hooks the viewer calls as it loads, warms up and plays.
 *
 * They do nothing here: nothing is measured, kept or sent anywhere. A host
 * that wants load and warm-up times can fill these in.
 */

type View = "simple" | "3d" | "console";

/** the replay is playing (or not) */
export function diagRunning(_on: boolean) {}

/** which view is drawing */
export function diagView(_v: View, _small: boolean) {}

/** a replay starts loading */
export function diagLoading() {}

/** the replay is in: the game's characters and stage */
export function diagLoaded(_c: number[], _s: number | null) {}

/** the 3D player's warm-up is done */
export function diagWarmed(_since?: number) {}
