/* where each player's HUD sits along the bottom of the picture.
 *
 * The game puts a player's stocks, percent and name in the slot of their
 * port: a game on ports 1 and 2 has both on the left half, one on 2 and 3 in
 * the middle. The HUD Slots option picks between that and the viewer's own
 * layout, its default:
 * - "outer": any two-player game is drawn as if the players were on ports 1
 *   and 4 - the lower port in the far-left slot, the other in the far-right
 *   one, the open space between them. Only the place moves: each keeps their
 *   own port's color and number everywhere. Three or four players keep their
 *   own slots.
 * - "game": as in the game, every player in their port's slot.
 * All three views read it: the Simple view's HUD (PlayerHUD.tsx), the 3D and
 * Console views' (render3d/hud.ts: the game's own places for the match, its
 * stock bursts where the game made them), and the controller overlays that
 * sit beside or over those slots (Controllers.tsx).
 */
import type { GameSettings } from "./types";

export type HudSlots = "outer" | "game";

export function isHudSlots(v: unknown): v is HudSlots {
  return v === "outer" || v === "game";
}

// (?hudslots=game in the player's URL starts with the game's layout; the page's {type: "hudslots"} changes it)
const fromUrl = typeof location !== "undefined" ? new URLSearchParams(location.search).get("hudslots") : null;
let mode: HudSlots = isHudSlots(fromUrl) ? fromUrl : "outer";
const followers: ((m: HudSlots) => void)[] = [];
/** the HUD Slots option as the player has it now */
export function hudSlotsMode(): HudSlots { return mode; }
/** the option changed (the page's message): the HUDs follow on the spot */
export function setHudSlotsMode(m: HudSlots) {
  if (m === mode) return;
  mode = m;
  for (const f of followers) f(m);
}
/** `f` with every change from now on (the Simple view's HUD and the overlays: state/hudSlotsStore.ts) */
export function onHudSlots(f: (m: HudSlots) => void) { followers.push(f); }

/** the HUD slot (0-3, left to right) of a player, by their port's index */
export function hudSlot(settings: Pick<GameSettings, "playerSettings">, playerIndex: number,
                        mode: HudSlots = hudSlotsMode()): number {
  if (mode === "game") return playerIndex;
  const ports = settings.playerSettings.filter(Boolean).map((p) => p.playerIndex).sort((a, b) => a - b);
  if (ports.length !== 2 || !ports.includes(playerIndex)) return playerIndex;
  return playerIndex === ports[0] ? 0 : 3;
}

/** whether the HUD draws two players in the outer slots (hudSlot) */
export function outerSlots(settings: Pick<GameSettings, "playerSettings">, mode: HudSlots = hudSlotsMode()): boolean {
  return mode === "outer" && settings.playerSettings.filter(Boolean).length === 2;
}
