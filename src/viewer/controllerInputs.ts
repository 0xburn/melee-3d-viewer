/* what a player held on their controller at a frame, for the
 * controller overlay (components/viewer/Controllers.tsx).
 *
 * Everything comes from the replay's pre-frame events, as the parser keeps
 * them (PlayerInputs): the sticks as the game read them (-1 to 1), each
 * trigger's analog value as pressed (0 to 1) and the game's one analog
 * trigger value, and the buttons as pressed. A frame is the replay's index
 * (replayStore.frame), the same index on a ghost's replay - a simulated branch
 * of a moment shares the real game's frames up to the takeover. Nana's
 * inputs are left out: the player only holds Popo's controller.
 */
import type { PlayerInputs, PlayerSettings, ReplayData } from "../common/types";

/** whose controllers to show (?controllers= or the controllers message) */
export type OverlayShow = "off" | "both" | "you" | "opponent" | "left" | "right";
export const isOverlayShow = (v: unknown): v is OverlayShow =>
  v === "off" || v === "both" || v === "you" || v === "opponent" || v === "left" || v === "right";

/** the ports (indexes) the choice shows in this game. Left is the lowest
 *  port, right the highest; you, the port the page says is you (`you`: the
 *  ?you= parameter or the controllers message), and the opponent, the others. In a game
 *  you are not in, you or the opponent shows both. */
export function overlayPorts(players: Pick<PlayerSettings, "playerIndex">[], show: OverlayShow,
                             you: number | null | undefined): number[] {
  const ports = players.map((p) => p.playerIndex).sort((a, b) => a - b);
  if (!ports.length || show === "off") return [];
  if (show === "left") return [ports[0]];
  if (show === "right") return [ports[ports.length - 1]];
  const mine = you != null && ports.includes(you);
  if (show === "you" && mine) return [you!];
  if (show === "opponent" && mine) return ports.filter((p) => p !== you);
  return ports;
}

export interface Pad {
  /** the main stick and the C-stick, -1 to 1 (up is +y) */
  x: number;
  y: number;
  cx: number;
  cy: number;
  /** L and R as pressed, 0 to 1, and their clicks */
  l: number;
  r: number;
  lDigital: boolean;
  rDigital: boolean;
  /** the game's one analog trigger value, 0 to 1 */
  trigger: number;
  a: boolean;
  b: boolean;
  xb: boolean;
  yb: boolean;
  z: boolean;
  start: boolean;
  dUp: boolean;
  dDown: boolean;
  dLeft: boolean;
  dRight: boolean;
}

/** a frame's inputs as a Pad */
export function padOf(inputs: PlayerInputs): Pad {
  const p = inputs.physical, q = inputs.processed;
  return {
    x: q.joystickX, y: q.joystickY, cx: q.cStickX, cy: q.cStickY,
    l: p.lTriggerAnalog, r: p.rTriggerAnalog, lDigital: p.lTriggerDigital, rDigital: p.rTriggerDigital,
    trigger: q.anyTrigger,
    a: p.a, b: p.b, xb: p.x, yb: p.y, z: p.z, start: p.start,
    dUp: p.dPadUp, dDown: p.dPadDown, dLeft: p.dPadLeft, dRight: p.dPadRight,
  };
}

/** a player's inputs at a frame (a replay index), or null where the replay
 *  has none (a ghost's branch past its end, or written without pre-frames:
 *  the overlay then shows the real player only) */
export function padAt(replay: ReplayData, frame: number, playerIndex: number): Pad | null {
  const inputs = replay.frames[frame]?.players[playerIndex]?.inputs;
  return inputs ? padOf(inputs) : null;
}

/** the sticks over the last `n` frames before `frame`, newest first, not
 *  reaching back before `from` (a loop's start): the overlay's fading trail */
export function trailAt(replay: ReplayData, frame: number, playerIndex: number, n: number, from = 0):
    { main: [number, number][]; c: [number, number][] } {
  const main: [number, number][] = [], c: [number, number][] = [];
  for (let f = frame - 1; f >= Math.max(0, from) && f >= frame - n; f--) {
    const q = replay.frames[f]?.players[playerIndex]?.inputs?.processed;
    if (!q) break;
    main.push([q.joystickX, q.joystickY]);
    c.push([q.cStickX, q.cStickY]);
  }
  return { main, c };
}
