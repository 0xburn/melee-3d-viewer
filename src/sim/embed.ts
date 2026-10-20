/* The embed page's side of the simulator (embed.tsx): whether the page asked
 * for it, and starting or stopping it as replays load. The page is told how
 * it stands ({type: "sim", state, until, last, rate, firstFrameMs, firstTrackMs, reason}).
 */
import { simConfig, startSim, stopSim, type SimStatus } from "./feed";

let wanted = new URLSearchParams(location.search).get("sim") === "1" || simConfig.auto === true;
const tell = (s: SimStatus) => {
  if (window.parent !== window) window.parent.postMessage({ type: "sim", ...s }, "*");
};

/** a replay is loading from `url` (with the track the page gave, if any):
 *  the simulator makes one only when asked and when none was given */
export function simForReplay(url: string, trackUrl: string | null) {
  if (wanted && !trackUrl) startSim(url, tell);
  else { stopSim(); tell({ state: "off" }); }
}

/** {type: "sim", on}: turned on or off for the replay shown and the ones after
 *  (`reload` hands the player its track source again) */
export function simAsked(on: boolean, url: string | null, trackUrl: string | null, reload: () => void) {
  if (on === wanted) return;
  wanted = on;
  if (url === null) return;
  simForReplay(url, trackUrl);
  reload();
}
