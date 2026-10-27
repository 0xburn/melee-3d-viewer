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

/** the first lane that differs ("pos_x:0", "follower.action_id:1", "item.vel_x:2"), or null when the frame is the recording's */
export function frameDiff(out: DataView, rec: RecordedRow): string | null {
  const f32 = (o: number) => out.getFloat32(o, true), u16 = (o: number) => out.getUint16(o, true), u8 = (o: number) => out.getUint8(o);
  const fighter = (lane: number, want: RecordedFighter, pre: string, at: { x: number; y: number; percent: number; shield: number; action: number; stocks: number; facing: number }) => {
    if (f32(at.x + 4 * lane) !== want.x) return `${pre}pos_x:${lane}`;
    if (f32(at.y + 4 * lane) !== want.y) return `${pre}pos_y:${lane}`;
    if (f32(at.percent + 4 * lane) !== want.percent) return `${pre}percent:${lane}`;
    if (f32(at.shield + 4 * lane) !== want.shield) return `${pre}shield_hp:${lane}`;
    if (u16(at.action + 2 * lane) !== want.action) return `${pre}action_id:${lane}`;
    if (u8(at.stocks + lane) !== want.stocks) return `${pre}stocks:${lane}`;
    if (u8(at.facing + lane) !== want.facing) return `${pre}facing:${lane}`;
    return null;
  };
  const leaderAt = { x: O.pos_x, y: O.pos_y, percent: O.percent, shield: O.shield, action: O.action, stocks: O.stocks, facing: O.facing };
  const followerAt = { x: O.f_pos_x, y: O.f_pos_y, percent: O.f_percent, shield: O.f_shield, action: O.f_action, stocks: O.f_stocks, facing: O.f_facing };
  for (let lane = 0; lane < rec.players.length; lane++) {
    const p = rec.players[lane];
    if (!p.leader) continue;
    const bad = fighter(lane, p.leader, "", leaderAt);
    if (bad) return bad;
    if (!p.hasFollower) continue;
    if ((u8(O.f_present + lane) !== 0) !== (p.follower !== null)) return `follower.present:${lane}`;
    if (!p.follower) continue;
    const fb = fighter(lane, p.follower, "follower.", followerAt);
    if (fb) return fb;
  }
  if (!rec.items) return null;
  if (u8(O.item_count) !== rec.items.length) return "item.count";
  for (let slot = 0; slot < rec.items.length; slot++) {
    const w = rec.items[slot], b = O.items + ITEM * slot;
    const got = {
      state: u8(b + 1), owner: out.getInt8(b + 2), mask: u8(b + 3), type: u16(b + 4), instance: u16(b + 6), damage: u16(b + 12),
      spawn: out.getUint32(b + 16, true), direction: f32(b + 20), velX: f32(b + 24), velY: f32(b + 28), x: f32(b + 32), y: f32(b + 36), timer: f32(b + 40),
    };
    // (ITEM_COMPARED, in its order)
    if (got.type !== w.type) return `item.type:${slot}`;
    if (got.state !== w.state) return `item.state:${slot}`;
    if (w.owner !== null && got.owner !== w.owner) return `item.owner:${slot}`;
    if (got.direction !== w.direction) return `item.direction:${slot}`;
    if (got.velX !== w.velX) return `item.vel_x:${slot}`;
    if (got.velY !== w.velY) return `item.vel_y:${slot}`;
    if (got.x !== w.x) return `item.pos_x:${slot}`;
    if (got.y !== w.y) return `item.pos_y:${slot}`;
    if (got.damage !== w.damage) return `item.damage:${slot}`;
    if (got.timer !== w.timer) return `item.timer:${slot}`;
    if (got.spawn !== w.spawnId) return `item.spawn_id:${slot}`;
    if (rec.withInstance && w.instanceId !== null && got.instance !== w.instanceId) return `item.instance_id:${slot}`;
    if (w.misc) for (let k = 0; k < 4; k++) if ((got.mask >> k) & 1 && u8(b + 8 + k) !== w.misc[k]) return `item.misc${k}:${slot}`;
  }
  return null;
}
