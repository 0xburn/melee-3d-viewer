/* where each player's HUD sits along the bottom of the picture.
 *
 * The game puts a player's stocks, percent and name in the slot of their
 * port: a game on ports 1 and 2 has both on the left half, one on 2 and 3 in
 * the middle. Here any two-player game is drawn as if the
 * players were on ports 1 and 4 - the lower port in the far-left slot, the
 * other in the far-right one, the open space between them. Only the place
 * moves: each keeps their own port's color and number everywhere. Three or
 * four players keep their own slots. Both HUDs read it: the Simple view's
 * (PlayerHUD.tsx) and the 3D and Console views' (render3d/hud.ts); the
 * controller overlays sit beside those two outer slots (Controllers.tsx).
 */
import type { GameSettings } from "./types";

/** the HUD slot (0-3, left to right) of a player, by their port's index */
export function hudSlot(settings: Pick<GameSettings, "playerSettings">, playerIndex: number): number {
  const ports = settings.playerSettings.filter(Boolean).map((p) => p.playerIndex).sort((a, b) => a - b);
  if (ports.length !== 2 || !ports.includes(playerIndex)) return playerIndex;
  return playerIndex === ports[0] ? 0 : 3;
}

/** whether the HUD draws two players in the outer slots (hudSlot) */
export function outerSlots(settings: Pick<GameSettings, "playerSettings">): boolean {
  return settings.playerSettings.filter(Boolean).length === 2;
}
