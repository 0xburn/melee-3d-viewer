/* What a replay needs from the game's files, read from the first bytes of the
 * .slp itself (its Game Start event: the stage and, for each port, the
 * character and costume), so the files can be asked for while the rest of the
 * replay is still being read. Only those first bytes are looked at.
 */

/** the fighters of a character as the game numbers them inside: an external
 *  (character select) id -> internal ids (the Ice Climbers are two) */
const INTERNAL: Record<number, number[]> = {
  0: [2], 1: [3], 2: [1], 3: [24], 4: [4], 5: [5], 6: [6], 7: [17], 8: [0], 9: [18], 10: [16], 11: [8], 12: [9],
  13: [12], 14: [10, 11], 15: [15], 16: [13], 17: [14], 18: [19], 19: [7], 20: [22], 21: [20], 22: [21], 23: [26],
  24: [23], 25: [25],
};

export interface ReplayHead {
  /** the stage, by the game's external id (what STAGES is keyed by) */
  stageId: number;
  /** each player in the game: the fighters (internal ids) and the costume */
  players: { internal: number[]; costume: number }[];
}

/** the stage and players out of the first bytes of a .slp (at least ~1 KB of them); null when they are not a replay's */
export function replayHead(buf: ArrayBuffer): ReplayHead | null {
  const u = new Uint8Array(buf), v = new DataView(buf);
  // ({U\x03raw[$U#l <length>, then the events: the payload sizes (0x35), then Game Start (0x36))
  const prefix = [0x7b, 0x55, 0x03, 0x72, 0x61, 0x77, 0x5b, 0x24, 0x55, 0x23, 0x6c];
  let at = prefix.length + 4;
  if (u.length < at + 2 || prefix.some((b, i) => u[i] !== b)) return null;
  if (u[at] !== 0x35) return null;
  const sizes = new Map<number, number>();
  const tableEnd = at + 2 + (u[at + 1] - 1);
  for (let p = at + 2; p + 3 <= tableEnd; p += 3) sizes.set(u[p], v.getUint16(p + 1));
  at += 1 + u[at + 1];
  const size = sizes.get(0x36);
  if (u[at] !== 0x36 || size === undefined || size < 0x65 + 4 * 0x24 || at + 1 + size > u.length) return null;
  // (offsets from the first byte after the command byte, as the Slippi spec gives them)
  const p0 = at + 1;
  const stageId = v.getUint16(p0 + 0x13 - 1 + 0);
  const players: ReplayHead["players"] = [];
  for (let i = 0; i < 4; i++) {
    const base = p0 + 0x65 - 1 + 0x24 * i;
    const external = u[base], type = u[base + 1], costume = u[base + 3];
    // (type 3: no player in this port)
    if (type === 3) continue;
    const internal = INTERNAL[external];
    if (internal) players.push({ internal, costume });
  }
  return { stageId, players };
}
