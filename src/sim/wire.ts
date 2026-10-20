/* The simulator's wire rows (melee-sim-light src/runtime/wire.h), as the
 * viewer writes and reads them: packed, little-endian, wasm32.
 *
 *   MslCoreMatchConfig   64 bytes   the match (msl_viewer_create)
 *   MslCoreInput         52 bytes   four players' controllers
 *   MslCoreStreamFrame  188 bytes   one frame's seed, inputs and stage events (msl_viewer_step)
 *   MslCoreCompare                  the step's output (msl_viewer_output): only the
 *                                   lanes the divergence check reads are named here
 *
 * The layouts are written out field by field, in wire.h's order, so a field
 * added there is added here in the same place. The build checks them against
 * the C compiler's offsetof (BUILD.md, "Layout check").
 */

type Kind = "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "f32" | "pad";
const WIDTH: Record<Kind, number> = { u8: 1, i8: 1, pad: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4 };

/** field name -> [offset, kind, count] */
export type Layout = { size: number; at: Record<string, [number, Kind, number]> };

function layout(fields: [string, Kind, number?][]): Layout {
  const at: Layout["at"] = {};
  let o = 0;
  for (const [name, kind, count = 1] of fields) {
    at[name] = [o, kind, count];
    o += WIDTH[kind] * count;
  }
  return { size: o, at };
}

export const MAX_PLAYERS = 4;
export const MAX_ITEMS = 15;
export const ITEM_SIZE = 48;
const P = MAX_PLAYERS;

export const INPUT_PLAYER = layout([
  ["buttons", "u16"], ["main_x", "i8"], ["main_y", "i8"], ["c_x", "i8"], ["c_y", "i8"], ["l", "u8"], ["r", "u8"],
  ["nml_main_x", "i8"], ["nml_main_y", "i8"], ["nml_c_x", "i8"], ["nml_c_y", "i8"], ["nml_valid", "u8"],
]);
export const INPUT_SIZE = INPUT_PLAYER.size * P;

export const CPU_INPUT = layout([
  ["main_x", "f32"], ["main_y", "f32"], ["c_x", "f32"], ["c_y", "f32"], ["trigger", "f32"],
  ["buttons", "u32"], ["random_seed", "u32"], ["valid", "u8"],
]);

export const STAGE_EVENTS = layout([
  ["fod_platform_height", "f32", 2], ["fighter_pre_random_seed", "u32"], ["fod_platform_mask", "u8"],
  ["dreamland_whispy_valid", "u8"], ["dreamland_whispy_direction", "u8"], ["fighter_pre_random_seed_valid", "u8"],
  ["cpu_inputs", "pad", CPU_INPUT.size * P],
]);

export const STREAM_FRAME = layout([
  ["frame_pre_random_seed", "u32"], ["input", "pad", INPUT_SIZE], ["stage_events", "pad", STAGE_EVENTS.size],
]);

export const CONFIG_PLAYER = layout([
  ["char_id", "u8"], ["team_id", "u8"], ["facing_and_port", "u8"], ["costume_id", "u8"], ["handicap", "u8"],
  ["start_percent", "u8"], ["cpu_level", "u8"],
]);

export const CONFIG = layout([
  ["stage_id", "u32"], ["frame_id", "i32"], ["frame_pre_random_seed", "u32"], ["initial_random_seed", "u32"],
  ["match_damage_ratio", "f32"], ["num_players", "u8"], ["is_teams", "u8"], ["friendly_fire", "u8"],
  ["stock_count", "u8"], ["camera_mode", "u8"], ["arithmetic_flags", "u8"], ["brawl_offscreen_damage", "u8"],
  ["freeze_dead_up_fall_physics", "u8"], ["ucf_cardinals_1_0_enabled", "u8"], ["ucf_shield_sdi_enabled", "u8"],
  ["ucf_sdi_enabled", "u8"], ["ucf_shield_drop_extended_enabled", "u8"], ["ucf_shield_drop_084_enabled", "u8"],
  ["stage_event_streams", "u8"], ["whispy_dead_fighter_fix", "u8"], ["slippi_patches", "u8"],
  ["players", "pad", CONFIG_PLAYER.size * P],
]);

/** MslCoreCompare, up to the lanes after the leaders' (the rest is followers and items) */
export const COMPARE = layout([
  ["frame_id", "i32"], ["frame_pre_random_seed", "u32"], ["stage_id", "u32"], ["num_players", "u8"],
  ["is_teams", "u8"], ["_pad0", "pad", 2], ["team_id", "u8", P], ["char_id", "u8", P],
  ["pos_x", "f32", P], ["pos_y", "f32", P], ["speed_air_x_self", "f32", P], ["speed_ground_x_self", "f32", P],
  ["speed_y_self", "f32", P], ["speed_x_attack", "f32", P], ["speed_y_attack", "f32", P],
  ["facing", "u8", P], ["on_ground", "u8", P], ["is_dead", "u8", P], ["_pad1", "pad", 1],
  ["action_id", "u16", P], ["action_frame", "i16", P], ["jumps_left", "u8", P], ["stocks", "u8", P],
  ["percent", "f32", P],
]);

/** MslCoreMatchConfig.arithmetic_flags (MSL_ARITHMETIC_*) */
export const ARITHMETIC_LEGACY_FNMSUBS = 1 << 0;
export const ARITHMETIC_SPLIT_FMA = 1 << 1;
/** MslCoreMatchConfig.slippi_patches (MSL_PATCH_*) */
export const PATCH_FD_BACKGROUND_FROZEN = 1 << 0;
/** MslCoreInputPlayer.nml_valid */
export const NML_MAIN_VALID = 1 << 0;
export const NML_C_VALID = 1 << 1;

/** writes one row's fields by name (little-endian, as the wire is) */
export class RowWriter {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array, readonly base = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  set(l: Layout, name: string, value: number, index = 0, base = this.base) {
    const f = l.at[name];
    if (!f) throw new Error(`no field ${name}`);
    const [o, kind] = f;
    const at = base + o + WIDTH[kind] * index;
    const v = this.view;
    switch (kind) {
      case "u8": v.setUint8(at, value); break;
      case "i8": v.setInt8(at, value); break;
      case "u16": v.setUint16(at, value, true); break;
      case "i16": v.setInt16(at, value, true); break;
      case "u32": v.setUint32(at, value >>> 0, true); break;
      case "i32": v.setInt32(at, value, true); break;
      case "f32": v.setFloat32(at, value, true); break;
      default: throw new Error(`${name} is not a number field`);
    }
  }
}

/** reads one lane of a row by name */
export function readField(view: DataView, l: Layout, name: string, index = 0, base = 0): number {
  const [o, kind] = l.at[name];
  const at = base + o + WIDTH[kind] * index;
  switch (kind) {
    case "u8": return view.getUint8(at);
    case "i8": return view.getInt8(at);
    case "u16": return view.getUint16(at, true);
    case "i16": return view.getInt16(at, true);
    case "u32": return view.getUint32(at, true);
    case "i32": return view.getInt32(at, true);
    case "f32": return view.getFloat32(at, true);
    default: throw new Error(`${name} is not a number field`);
  }
}

/** the offset of a field (a sub-row's start) in a layout */
export const offsetOf = (l: Layout, name: string) => l.at[name][0];
