/* The simulator's graphics build takes a replay the way its replay driver does (tools/replay/replay_drive.c: a TapeConfig and a
 * TapeFrame for each frame). The viewer's own tape (src/sim/tape.ts) is written in the simulator's wire rows (MslCoreMatchConfig,
 * MslCoreStreamFrame); this turns those into the driver's, field for field, so one reading of the .slp serves both.
 *
 *   TapeConfig   77 bytes   packed, little-endian (config_from_tape maps it to the match's config)
 *   TapeFrame   120 bytes   frame seed, the first fighter's seed, stage events, four players' inputs (fill_input, fill_events)
 */
import {
  ARITHMETIC_LEGACY_FNMSUBS, ARITHMETIC_SPLIT_FMA, CONFIG, CONFIG_PLAYER, INPUT_PLAYER, offsetOf, readField, STAGE_EVENTS,
  STREAM_FRAME,
} from "../../sim/wire";
import type { DriveOptions, Tape } from "../../sim/tape";

export const TAPE_CONFIG_SIZE = 77;
export const TAPE_FRAME_SIZE = 120;
const TAPE_MAGIC = 0x314c534d;
const TAPE_INPUT_SIZE = 25;

/** the driver's TapeConfig for a wire config (CONFIG.size bytes), the replay's frame count and what the tape adds (Tape.gx) */
export function tapeConfigOf(config: Uint8Array, frameCount: number, gx: { patches: number; levels: number[]; stadium: number }): Uint8Array {
  const out = new Uint8Array(TAPE_CONFIG_SIZE);
  const o = new DataView(out.buffer), c = new DataView(config.buffer, config.byteOffset, config.byteLength);
  const f = (name: string) => readField(c, CONFIG, name);
  o.setUint32(0, TAPE_MAGIC, true);
  o.setInt32(4, f("stage_id"), true);
  o.setInt32(8, f("frame_id"), true);
  o.setUint32(12, f("frame_pre_random_seed"), true);
  o.setUint32(16, f("initial_random_seed"), true);
  o.setFloat32(20, f("match_damage_ratio"), true);
  const arithmetic = f("arithmetic_flags");
  const bytes = [
    // (friendly_fire: the driver's tape always carries 0, replay_drive.py build_tape; the gate and the fit play with that)
    f("num_players"), f("is_teams"), 0, f("stock_count"),
    arithmetic & ARITHMETIC_LEGACY_FNMSUBS ? 1 : 0, // online_fnmsubs_zero
    f("brawl_offscreen_damage"), f("freeze_dead_up_fall_physics"), f("whispy_dead_fighter_fix"),
    f("ucf_cardinals_1_0_enabled"), f("ucf_shield_sdi_enabled"), f("ucf_sdi_enabled"),
    f("ucf_shield_drop_extended_enabled"), f("ucf_shield_drop_084_enabled"),
    f("stage_event_streams"),
    gx.stadium, // stadium_transformations (MSL_STADIUM_*)
    gx.patches,
    arithmetic & ARITHMETIC_SPLIT_FMA ? 1 : 0, // jit_arithmetic: MSL_JIT_NO_HOST_FMA
  ];
  bytes.forEach((v, i) => o.setUint8(24 + i, v));
  const players = offsetOf(CONFIG, "players");
  for (let p = 0; p < 4; p++) {
    const b = players + CONFIG_PLAYER.size * p, d = 41 + 8 * p;
    for (let k = 0; k < 7; k++) o.setUint8(d + k, c.getUint8(b + k));
    if (p < gx.levels.length) o.setUint8(d + 6, gx.levels[p]);
  }
  o.setUint32(73, frameCount, true);
  return out;
}

/** a processed stick byte as the float the driver turns back into it (processed_stick_i8 truncates value * 80) */
const stickFloat = (n: number) => (n >= 80 ? 1 : n <= -80 ? -1 : n === 0 ? 0 : Math.fround((n + (n > 0 ? 0.5 : -0.5)) / 80));

/** the driver's TapeFrame for a wire stream frame (STREAM_FRAME.size bytes), written into out (TAPE_FRAME_SIZE bytes) */
export function tapeFrameOf(frame: Uint8Array, out: Uint8Array): void {
  out.fill(0, 0, TAPE_FRAME_SIZE);
  const o = new DataView(out.buffer, out.byteOffset, out.byteLength), c = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const se = offsetOf(STREAM_FRAME, "stage_events");
  const ev = (name: string, i = 0) => readField(c, STAGE_EVENTS, name, i, se);
  o.setUint32(0, c.getUint32(0, true), true);
  o.setUint32(4, ev("fighter_pre_random_seed"), true);
  o.setUint8(8, ev("fighter_pre_random_seed_valid"));
  o.setUint8(9, ev("fod_platform_mask"));
  o.setUint8(10, ev("dreamland_whispy_valid"));
  o.setUint8(11, ev("dreamland_whispy_direction"));
  o.setFloat32(12, ev("fod_platform_height", 0), true);
  o.setFloat32(16, ev("fod_platform_height", 1), true);
  const input = offsetOf(STREAM_FRAME, "input");
  for (let p = 0; p < 4; p++) {
    const b = input + INPUT_PLAYER.size * p, d = 20 + TAPE_INPUT_SIZE * p;
    const r = (name: string) => readField(c, INPUT_PLAYER, name, 0, b);
    o.setUint16(d, r("buttons"), true);
    o.setInt8(d + 2, r("main_x")); o.setInt8(d + 3, r("main_y")); o.setInt8(d + 4, r("c_x")); o.setInt8(d + 5, r("c_y"));
    o.setUint8(d + 6, r("l")); o.setUint8(d + 7, r("r"));
    o.setUint8(d + 8, r("nml_valid"));
    o.setFloat32(d + 9, stickFloat(r("nml_main_x")), true); o.setFloat32(d + 13, stickFloat(r("nml_main_y")), true);
    o.setFloat32(d + 17, stickFloat(r("nml_c_x")), true); o.setFloat32(d + 21, stickFloat(r("nml_c_y")), true);
  }
}

/** The whole tape the native driver reads (replay_drive.py build_tape, byte for byte): the config for a drive choice, every row
 *  (tape.ts gxFrame: the recorded stick floats; rawC is the fit's raw C-stick choice for a recording without raw bytes) and the
 *  trailers (name tags, display names, the starting timer), which the viewer build's HUD reads. */
export function nativeTape(tape: Tape, drive: DriveOptions, rawC?: ([Int16Array, Int16Array] | null)[]): Uint8Array {
  const trailer = tape.gxTrailer();
  const out = new Uint8Array(TAPE_CONFIG_SIZE + tape.count * TAPE_FRAME_SIZE + trailer.length);
  out.set(tapeConfigOf(tape.config(drive), tape.count, tape.gx));
  for (let i = 0; i < tape.count; i++) tape.gxFrame(i, out.subarray(TAPE_CONFIG_SIZE + i * TAPE_FRAME_SIZE, TAPE_CONFIG_SIZE + (i + 1) * TAPE_FRAME_SIZE), rawC);
  out.set(trailer, TAPE_CONFIG_SIZE + tape.count * TAPE_FRAME_SIZE);
  return out;
}

/** row i of a whole tape (a view) */
export const nativeRow = (whole: Uint8Array, i: number) => whole.subarray(TAPE_CONFIG_SIZE + i * TAPE_FRAME_SIZE, TAPE_CONFIG_SIZE + (i + 1) * TAPE_FRAME_SIZE);
