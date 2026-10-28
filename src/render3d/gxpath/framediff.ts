/* Whether a simulated frame is the recording's, the replay driver's way (melee-sim-light tools/replay/replay_drive.py frame_diff): both
 * players' fighters (place, percent, shield, action, stocks, facing), Nana where a port has her, and every item, each compared exactly
 * (float32 against float32, no tolerance), rows the recording has only. The simulated side is the driver's own output row
 * (msl_gxw_out_row: replay_drive.c fill_output's OutFrame, items packed, the misc bytes masked to the ones that are gameplay state).
 * The C-stick fit (cfit.ts) takes its first difference from here, so it decides the way the python fit does.
 */
import type { RecordedFighter, RecordedRow } from "../../sim/tape";

/** OutFrame (replay_drive.c; replay_drive.py OUT_FMT "<iI16f4H4h4H4H32B12BB3x2H4H16f" + 15 items "BBbBHH4BHHI6f") */
const O = {
  pos_x: 8, pos_y: 24, percent: 40, shield: 56, action: 72, stocks: 104, facing: 108,
  f_present: 136, f_facing: 140, f_stocks: 144, item_count: 148, f_action: 156, f_pos_x: 164, f_pos_y: 180, f_percent: 196, f_shield: 212,
  items: 228,
};
const ITEM = 44;
export const OUT_ROW_SIZE = O.items + 15 * ITEM;

/** one difference: the lane's name as replay_drive.py frame_diff names it ("pos_x", "follower.pos_y", "item.vel_x", ...), the player (or item slot,
 *  -1 for item.count), the simulated and the recorded value */
export interface Diff { name: string; lane: number; sim: number; rec: number }

/** every difference of the frame, in frame_diff's order (empty: the frame is the recording's) */
export function frameDiffs(out: DataView, rec: RecordedRow): Diff[] {
  const f32 = (o: number) => out.getFloat32(o, true), u16 = (o: number) => out.getUint16(o, true), u8 = (o: number) => out.getUint8(o);
  const bad: Diff[] = [];
  const fighter = (lane: number, want: RecordedFighter, pre: string, at: Record<"x" | "y" | "percent" | "shield" | "action" | "stocks" | "facing", number>) => {
    const got: [string, number, number][] = [
      ["pos_x", f32(at.x + 4 * lane), want.x], ["pos_y", f32(at.y + 4 * lane), want.y], ["percent", f32(at.percent + 4 * lane), want.percent],
      ["shield_hp", f32(at.shield + 4 * lane), want.shield], ["action_id", u16(at.action + 2 * lane), want.action],
      ["stocks", u8(at.stocks + lane), want.stocks], ["facing", u8(at.facing + lane), want.facing],
    ];
    for (const [name, sim, r] of got) if (sim !== r) bad.push({ name: pre + name, lane, sim, rec: r });
  };
  const leaderAt = { x: O.pos_x, y: O.pos_y, percent: O.percent, shield: O.shield, action: O.action, stocks: O.stocks, facing: O.facing };
  const followerAt = { x: O.f_pos_x, y: O.f_pos_y, percent: O.f_percent, shield: O.f_shield, action: O.f_action, stocks: O.f_stocks, facing: O.f_facing };
  for (let lane = 0; lane < rec.players.length; lane++) {
    const p = rec.players[lane];
    if (!p.leader) continue;
    fighter(lane, p.leader, "", leaderAt);
    if (!p.hasFollower) continue;
    const present = u8(O.f_present + lane) !== 0;
    if (present !== (p.follower !== null)) { bad.push({ name: "follower.present", lane, sim: present ? 1 : 0, rec: p.follower ? 1 : 0 }); continue; }
    if (p.follower) fighter(lane, p.follower, "follower.", followerAt);
  }
  if (!rec.items) return bad;
  if (u8(O.item_count) !== rec.items.length) { bad.push({ name: "item.count", lane: -1, sim: u8(O.item_count), rec: rec.items.length }); return bad; }
  for (let slot = 0; slot < rec.items.length; slot++) {
    const w = rec.items[slot], b = O.items + ITEM * slot;
    // (ITEM_COMPARED, in its order; a lane the recording lacks is not compared)
    const got: [string, number, number | null][] = [
      ["type", u16(b + 4), w.type], ["state", u8(b + 1), w.state], ["owner", out.getInt8(b + 2), w.owner], ["direction", f32(b + 20), w.direction],
      ["vel_x", f32(b + 24), w.velX], ["vel_y", f32(b + 28), w.velY], ["pos_x", f32(b + 32), w.x], ["pos_y", f32(b + 36), w.y],
      ["damage", u16(b + 12), w.damage], ["timer", f32(b + 40), w.timer], ["spawn_id", out.getUint32(b + 16, true), w.spawnId],
    ];
    for (const [name, sim, r] of got) if (r !== null && sim !== r) bad.push({ name: "item." + name, lane: slot, sim, rec: r });
    if (rec.withInstance && w.instanceId !== null && u16(b + 6) !== w.instanceId) bad.push({ name: "item.instance_id", lane: slot, sim: u16(b + 6), rec: w.instanceId });
    const mask = u8(b + 3);
    if (w.misc) for (let k = 0; k < 4; k++) if ((mask >> k) & 1 && u8(b + 8 + k) !== w.misc[k]) bad.push({ name: `item.misc${k}`, lane: slot, sim: u8(b + 8 + k), rec: w.misc[k] });
  }
  return bad;
}

/** the first lane that differs ("pos_x:0", "follower.action_id:1", "item.vel_x:2"), or null when the frame is the recording's */
export function frameDiff(out: DataView, rec: RecordedRow): string | null {
  const d = frameDiffs(out, rec)[0];
  return d ? `${d.name}:${d.lane}` : null;
}

/** replay_drive.py RESYNC_NEAR (replay_drive.c RESYNC_MOST): the most a position may be off and still be put back from the recording */
export const RESYNC_NEAR = 1e-3;
const NEAR_FIELDS = new Set(["pos_x", "pos_y", "follower.pos_x", "follower.pos_y", "item.pos_x", "item.pos_y", "item.vel_x", "item.vel_y"]);

/** replay_drive.py positions_near_only: the frame differs, and only in positions (and item velocities) within RESYNC_NEAR of the
 *  recording's, which a resynced drive puts back */
export function positionsNearOnly(diffs: Diff[]): boolean {
  return diffs.length > 0 && diffs.every((d) => NEAR_FIELDS.has(d.name) && Math.abs(d.sim - d.rec) <= RESYNC_NEAR);
}