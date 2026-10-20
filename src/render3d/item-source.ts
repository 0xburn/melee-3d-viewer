/* 3D replay viewer: whose model a fighter's item is.
 *
 * An item's owner can change (a projectile reflected, an item picked up),
 * but its model is still the one its maker loaded: a reflected missile is
 * still Samus's, even in front of a fighter whose articles are different. So
 * the item's maker is the fighter that first owned it, character and costume
 * (not just the port: Zelda and Sheik change character on the same one),
 * worked out once from the replay's first frame on, the same however the
 * player seeks.
 */
import type { ItemUpdate, ReplayData } from "../common/types";

/** the fighter an item's model comes from */
interface Source { character: number; costume: number }

const sources = new WeakMap<ReplayData, Map<number, Source>>();

function firstOwners(data: ReplayData): Map<number, Source> {
  const out = new Map<number, Source>();
  for (const frame of data.frames) {
    for (const q of frame?.items ?? []) {
      if (out.has(q.spawnId)) continue;
      const player = frame.players[q.owner];
      if (!player) continue;
      out.set(q.spawnId, {
        character: player.state.internalCharacterId,
        costume: data.settings.playerSettings[q.owner]?.costumeIndex ?? 0,
      });
    }
  }
  return out;
}

/** the fighter that made an item, or null for one no fighter owned */
export function itemSource(data: ReplayData, item: ItemUpdate): Source | null {
  let bySpawn = sources.get(data);
  if (!bySpawn) {
    bySpawn = firstOwners(data);
    sources.set(data, bySpawn);
  }
  return bySpawn.get(item.spawnId) ?? null;
}
