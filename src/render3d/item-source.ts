import type { ItemUpdate, ReplayData } from '../common/types';

interface Source { character: number; costume: number }
const sources = new WeakMap<ReplayData, Map<number, Source>>();
/** Ownership can change on reflection/pickup. The article remains the one
 * loaded by its creator, even when its new owner has different articles.
 * Save the first recorded fighter identity, not just a port which can later
 * transform. Build once from history so backward seeking cannot change it. */
export function itemSource(data: ReplayData, item: ItemUpdate): Source | null {
  let bySpawn = sources.get(data);
  if (!bySpawn) {
    bySpawn = new Map();
    for (const frame of data.frames) for (const q of frame?.items ?? []) {
      if (bySpawn.has(q.spawnId)) continue;
      const player = frame.players[q.owner];
      if (!player) continue;
      bySpawn.set(q.spawnId, {character: player.state.internalCharacterId,
        costume: data.settings.playerSettings[q.owner]?.costumeIndex ?? 0});
    }
    sources.set(data, bySpawn);
  }
  return bySpawn.get(item.spawnId) ?? null;
}
