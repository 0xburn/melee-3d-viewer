/* A replay as the simulator takes it: the match config, the input before the
 * first frame, and one stream row per finalized frame (wire.ts), read from
 * the .slp's own event stream.
 *
 * This follows melee-sim-light's replay validator (tools/validation/native.c:
 * parse_start, parse_metadata, build_finalized_rows, build_input,
 * build_match_config, the stream writer) and its admission helpers
 * (tools/validation/admission.py: gecko_codes, slippi_patches), so the
 * simulator is fed what its own validation feeds it. The UCF switches come
 * from the replay's gecko code list, the way the fork's replay driver reads
 * them (recorded_profile).
 *
 * Each row also keeps what the replay says the frame ended with (expected):
 * the divergence check (compare.ts) holds the simulator's output against it.
 */
import {
  ARITHMETIC_LEGACY_FNMSUBS, ARITHMETIC_SPLIT_FMA, CONFIG, CONFIG_PLAYER, CPU_INPUT, INPUT_PLAYER, INPUT_SIZE,
  NML_C_VALID, NML_MAIN_VALID, offsetOf, PATCH_FD_BACKGROUND_FROZEN, RowWriter, STAGE_EVENTS, STREAM_FRAME,
} from "./wire";

export const FIRST_FRAME = -123;
/** the stages the simulator plays (Fountain, Stadium, Yoshi's Story, Dream Land, Battlefield, Final Destination) */
export const SIM_STAGES = new Set([2, 3, 8, 28, 31, 32]);

/** which UCF injections the game ran (MslCoreMatchConfig's ucf_* switches) */
export interface UcfProfile {
  name: string;
  cardinals10: boolean; shieldSdi: boolean; sdi: boolean; shieldDropExtended: boolean; shieldDrop084: boolean;
}
export const UCF_PROFILES: Record<string, UcfProfile> = {
  ucf10: { name: "ucf10", cardinals10: true, shieldSdi: true, sdi: true, shieldDropExtended: true, shieldDrop084: true },
  ucf084: { name: "ucf084", cardinals10: false, shieldSdi: false, sdi: false, shieldDropExtended: true, shieldDrop084: true },
  ucf08: { name: "ucf08", cardinals10: false, shieldSdi: false, sdi: false, shieldDropExtended: false, shieldDrop084: false },
};

/** how one drive plays the replay: its UCF switches and its arithmetic */
export interface DriveOptions { ucf: UcfProfile; splitFma: boolean }

/** what the replay says a player's fighter ended a frame with */
export interface Expected { x: number; y: number; action: number; percent: number; stocks: number }

export interface Tape {
  /** game frame of row 0 (the simulator's warm-up row) */
  firstFrame: number;
  /** rows that can be played (the replay's finalized frames, stopping at a gap) */
  count: number;
  numPlayers: number;
  /** the UCF profile the replay's code list says, or null when it has no list */
  recordedUcf: UcfProfile | null;
  /** the 64-byte config for these options (camera_mode's track bit is msl_viewer_create's to set) */
  config(options: DriveOptions): Uint8Array;
  /** the input before the first frame (row 0's) */
  previous(): Uint8Array;
  /** row i's stream frame, written into `out` (STREAM_FRAME.size bytes) */
  frame(i: number, out: Uint8Array): void;
  /** what the replay says row i ended with, per player slot (null: no row for that player) */
  expected(i: number): (Expected | null)[];
  /** the game frame of row i */
  gameFrame(i: number): number;
}

/** a replay the simulator does not play, and why (the tape is not made) */
export class Unsupported extends Error {}

/** float32 math as the C code does it */
const f = Math.fround;

/** native.c processed_stick_i8: the post-clamp axis as the signed byte it was */
export function processedStick(v: number): number {
  if (v <= -1) return -80;
  if (v >= 1) return 80;
  return Math.trunc(f(f(v) * 80));
}

/** native.c trigger_u8: lrintf(value * 140), ties to even */
export function triggerByte(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 1) return 140;
  const x = f(f(v) * 140);
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** the gecko codes in a replay's code list, by address (admission.py gecko_codes) */
export function geckoCodes(list: Uint8Array): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  const v = new DataView(list.buffer, list.byteOffset, list.byteLength);
  let o = 0;
  while (o + 8 <= list.length) {
    const address = v.getUint32(o), value = v.getUint32(o + 4);
    const kind = (address >>> 24) & 0xfe;
    const size = kind === 0xc0 || kind === 0xc2 ? 8 + 8 * value : kind === 8 ? 16 : kind === 6 ? 8 + Math.ceil(value / 8) * 8 : 8;
    if (o + size > list.length) break;
    out.set(address >>> 0, list.subarray(o, o + size));
    o += size;
  }
  return out;
}

// the UCF injections by address (the fork's tools/replay/replay_drive.py UCF_CODES)
const UCF_CARDINALS = 0xc206b460, UCF_SHIELD_SDI = 0xc2093294, UCF_SDI = 0xc208e54c, UCF_SD_EXTENDED = 0xc209a0b8;
const UCF_SHIELD_DROP = 0xc20998a4, UCF_084_SHIELD_DROP_SIZE = 208;

/** the UCF profile a code list says the game ran (replay_drive.py recorded_profile) */
export function recordedUcf(codes: Map<number, Uint8Array>): UcfProfile {
  const drop = codes.get(UCF_SHIELD_DROP);
  return {
    name: "recorded",
    cardinals10: codes.has(UCF_CARDINALS), shieldSdi: codes.has(UCF_SHIELD_SDI), sdi: codes.has(UCF_SDI),
    shieldDropExtended: codes.has(UCF_SD_EXTENDED), shieldDrop084: drop !== undefined && drop.length === UCF_084_SHIELD_DROP_SIZE,
  };
}

/** Slippi's "Frozen All" nop over Final Destination's background (admission.py slippi_patches) */
function patchesOf(codes: Map<number, Uint8Array>): number {
  const c = codes.get(0x0421aae4);
  return c && c.length >= 8 && c[4] === 0x60 && c[5] === 0 && c[6] === 0 && c[7] === 0 ? PATCH_FD_BACKGROUND_FROZEN : 0;
}

/** whether a Stadium game ran frozen (admission.py stadium_is_frozen) */
function stadiumFrozen(isFrozenPs: boolean, codes: Map<number, Uint8Array>): boolean {
  if (isFrozenPs) return true;
  const p = codes.get(0xc21d4578);
  if (!p || p.length !== 32) return false;
  const body = [0xff, 0xe0, 0x08, 0x90, 0x3d, 0x80, 0x80, 0x1d, 0x61, 0x8c, 0x4f, 0xd8, 0x7d, 0x89, 0x03, 0xa6, 0x4e, 0x80, 0x04, 0x20];
  for (let i = 0; i < body.length; i++) if (p[8 + i] !== body[i]) return false;
  const last = new DataView(p.buffer, p.byteOffset + 28, 4).getUint32(0);
  return ((last & 0xfc000003) >>> 0) === 0x48000000;
}

/** offsets of one frame's events, by player slot, in the replay's bytes (-1: none) */
interface FrameRow {
  seed: number;
  pre: Int32Array; post: Int32Array;
  fod: number[]; // offsets of 0x3F events
  whispy: number;  // offset of the last 0x40 event, -1 none
}

/**
 * Read a replay (the UBJSON's `raw` bytes and `metadata`) into a tape.
 * Throws Unsupported with the reason when the simulator does not play it.
 */
export function readTape(raw: Uint8Array, metadata: { playedOn?: string } | undefined): Tape {
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (v.getUint8(0) !== 0x35) throw new Unsupported("not a replay's event stream");
  const sizes = new Map<number, number>();
  const listSize = v.getUint8(1);
  for (let i = 2; i < listSize + 1; i += 3) sizes.set(v.getUint8(i), v.getUint16(i + 1));
  sizes.set(0x35, listSize);
  const startAt = listSize + 1;
  if (v.getUint8(startAt) !== 0x36) throw new Unsupported("no game start");
  const startSize = sizes.get(0x36) ?? 0;
  const has = (cmd: number, field: number) => field < (sizes.get(cmd) ?? 0) + 1;
  const g = (o: number) => startAt + o;

  // ---- game start (parse_start)
  const version = [1, 2, 3].map((k) => v.getUint8(g(k)));
  const atLeast = (a: number, b: number, c: number) =>
    version[0] !== a ? version[0] > a : version[1] !== b ? version[1] > b : version[2] >= c;
  if (!atLeast(3, 0, 0)) throw new Unsupported("replay older than Slippi 3.0");
  const stage = v.getUint16(g(0x13));
  if (!SIM_STAGES.has(stage)) throw new Unsupported(`stage ${stage} is not one the simulator plays`);
  const isTeams = v.getUint8(g(0xd)) !== 0;
  const friendlyFire = (v.getUint8(g(0x6)) & 1) !== 0;
  const damageRatio = v.getFloat32(g(0x35));
  const initialSeed = v.getUint32(g(0x13d));
  const isPal = startSize >= 0x1a1 && v.getUint8(g(0x1a1)) !== 0;
  if (isPal) throw new Unsupported("PAL game");
  const frozenPs = startSize >= 0x1a2 && v.getUint8(g(0x1a2)) !== 0;
  const sceneMajor = startSize >= 0x1a4 ? v.getUint8(g(0x1a4)) : -1;
  const slots: { port: number; stocks: number; costume: number; handicap: number; team: number; cpu: number }[] = [];
  for (let i = 0; i < 4; i++) {
    const b = 0x65 + 0x24 * i, type = v.getUint8(g(b + 1));
    if (type !== 0 && type !== 1) continue;
    const cpu = type === 1 ? v.getUint8(g(0x74 + 0x24 * i)) : 0;
    if (type === 1 && (cpu < 1 || cpu > 9)) throw new Unsupported("a CPU without a level");
    slots.push({
      port: i + 1, stocks: v.getUint8(g(b + 2)), costume: v.getUint8(g(b + 3)), handicap: v.getUint8(g(0x6d + 0x24 * i)),
      team: isTeams ? v.getUint8(g(0x6e + 0x24 * i)) : 0, cpu,
    });
  }
  if (slots.length !== 2 && slots.length !== 4) throw new Unsupported(`${slots.length} players (the simulator plays two or four)`);
  if (slots.length === 4 && isTeams && !friendlyFire) throw new Unsupported("four-player teams without Team Attack");
  const slotOfPort = new Map(slots.map((s, i) => [s.port - 1, i]));

  // ---- the event stream: each frame's last pass (build_finalized_rows)
  const rows = new Map<number, FrameRow>();
  const geckoParts: Uint8Array[] = [];
  const row = (frame: number) => {
    let r = rows.get(frame);
    if (!r) rows.set(frame, (r = { seed: 0, pre: new Int32Array(4).fill(-1), post: new Int32Array(4).fill(-1), fod: [], whispy: -1 }));
    return r;
  };
  let sawFrameStart = false, minFrame = Infinity, maxFrame = -Infinity;
  let o = startAt + startSize + 1;
  while (o < raw.length) {
    const cmd = v.getUint8(o), size = sizes.get(cmd);
    if (size === undefined) throw new Unsupported(`unknown event 0x${cmd.toString(16)}`);
    switch (cmd) {
      case 0x3a: { // frame start: a frame played again (a rollback) starts over
        const fr = v.getInt32(o + 1);
        const r = row(fr);
        r.seed = v.getUint32(o + 5);
        r.fod = []; r.whispy = -1;
        sawFrameStart = true;
        if (fr < minFrame) minFrame = fr;
        if (fr > maxFrame) maxFrame = fr;
        break;
      }
      case 0x37: case 0x38: {
        if (v.getUint8(o + 6) !== 0) break; // a follower (Nana): her rows are not inputs
        const slot = slotOfPort.get(v.getUint8(o + 5));
        if (slot === undefined) break;
        const r = row(v.getInt32(o + 1));
        (cmd === 0x37 ? r.pre : r.post)[slot] = o;
        break;
      }
      case 0x3f: if (has(0x3f, 6)) row(v.getInt32(o + 1)).fod.push(o); break;
      case 0x40: if (has(0x40, 5)) row(v.getInt32(o + 1)).whispy = o; break;
      case 0x3d: geckoParts.push(raw.subarray(o + 1, o + 1 + size)); break;
      case 0x10:
        if (size >= 0x203 && v.getUint8(o + 0x203) === 0x3d) {
          const used = Math.min(512, v.getUint16(o + 0x201));
          geckoParts.push(raw.subarray(o + 1, o + 1 + used));
        }
        break;
    }
    o += size + 1;
  }
  if (!sawFrameStart) throw new Unsupported("replay without frame start events");
  if (minFrame !== FIRST_FRAME) throw new Unsupported("replay does not start at the match's start");

  const gecko = new Uint8Array(geckoParts.reduce((n, p) => n + p.length, 0));
  { let at = 0; for (const p of geckoParts) { gecko.set(p, at); at += p.length; } }
  const codes = geckoCodes(gecko);
  if (stage === 3 && !stadiumFrozen(frozenPs, codes)) throw new Unsupported("Pokemon Stadium with its transformations on");

  // the rows that can be played: contiguous frames with every active player's
  // pre and post rows (an eliminated doubles player's last row is carried)
  const order: FrameRow[] = [];
  const preOf: Int32Array[] = [], postOf: Int32Array[] = [], present: Uint8Array[] = [];
  const carried = new Int32Array(slots.length).fill(-1), carriedPost = new Int32Array(slots.length).fill(-1);
  for (let fr = minFrame; fr <= maxFrame; fr++) {
    const r = rows.get(fr);
    if (!r) break;
    const pre = new Int32Array(slots.length), post = new Int32Array(slots.length), here = new Uint8Array(slots.length);
    let ok = true;
    for (let s = 0; s < slots.length; s++) {
      if (r.pre[s] >= 0 && r.post[s] >= 0) {
        carried[s] = r.pre[s]; carriedPost[s] = r.post[s];
        pre[s] = r.pre[s]; post[s] = r.post[s]; here[s] = 1;
      } else if (carriedPost[s] >= 0 && v.getUint8(carriedPost[s] + 0x21) === 0) {
        pre[s] = carried[s]; post[s] = carriedPost[s]; here[s] = 0;
      } else { ok = false; break; }
    }
    if (!ok) break;
    order.push(r); preOf.push(pre); postOf.push(post); present.push(here);
  }
  if (order.length < 2) throw new Unsupported("replay has fewer than two whole frames");

  // the character each slot starts as, and its facing (build_match_config)
  const chars = slots.map((_, s) => v.getUint8(postOf[0][s] + 0x7));
  for (const c of chars) if (c > 26 || c === 11) throw new Unsupported(`internal character ${c}`);

  // ---- the platform's patches (parse_start, parse_metadata)
  const playedOn = metadata?.playedOn ?? "";
  let fnmsubsZero = sceneMajor === 8, dolphinPatches = sceneMajor === 8;
  if (playedOn === "dolphin" || playedOn === "mainline dolphin") dolphinPatches = true;
  if (playedOn === "mainline dolphin") fnmsubsZero = false;
  const recorded = codes.size ? recordedUcf(codes) : null;
  // (Slippi 3.18 on records Fountain's platforms and Whispy's direction: the streams are present)
  const streams = atLeast(3, 18, 0) ? 3 : 0;
  const hasRawY = has(0x37, 0x40), hasRawC = has(0x37, 0x42);

  const writeInput = (out: RowWriter, base: number, i: number) => {
    for (let s = 0; s < slots.length; s++) {
      const p = preOf[i][s], b = base + INPUT_PLAYER.size * s;
      const at = (k: number) => v.getFloat32(p + k);
      out.set(INPUT_PLAYER, "buttons", v.getUint16(p + 0x31), 0, b);
      out.set(INPUT_PLAYER, "main_x", v.getInt8(p + 0x3b), 0, b);
      out.set(INPUT_PLAYER, "main_y", hasRawY ? v.getInt8(p + 0x40) : processedStick(at(0x1d)), 0, b);
      out.set(INPUT_PLAYER, "c_x", hasRawC ? v.getInt8(p + 0x41) : processedStick(at(0x21)), 0, b);
      out.set(INPUT_PLAYER, "c_y", hasRawC ? v.getInt8(p + 0x42) : processedStick(at(0x25)), 0, b);
      out.set(INPUT_PLAYER, "nml_main_x", processedStick(at(0x19)), 0, b);
      out.set(INPUT_PLAYER, "nml_main_y", processedStick(at(0x1d)), 0, b);
      out.set(INPUT_PLAYER, "nml_c_x", processedStick(at(0x21)), 0, b);
      out.set(INPUT_PLAYER, "nml_c_y", processedStick(at(0x25)), 0, b);
      out.set(INPUT_PLAYER, "nml_valid", NML_MAIN_VALID | NML_C_VALID, 0, b);
      out.set(INPUT_PLAYER, "l", triggerByte(at(0x33)), 0, b);
      out.set(INPUT_PLAYER, "r", triggerByte(at(0x37)), 0, b);
    }
  };

  return {
    firstFrame: minFrame,
    count: order.length,
    numPlayers: slots.length,
    recordedUcf: recorded,
    gameFrame: (i) => minFrame + i,
    config({ ucf, splitFma }) {
      const bytes = new Uint8Array(CONFIG.size), w = new RowWriter(bytes);
      w.set(CONFIG, "stage_id", stage);
      w.set(CONFIG, "frame_id", minFrame - 1);
      w.set(CONFIG, "frame_pre_random_seed", order[0].seed);
      w.set(CONFIG, "initial_random_seed", initialSeed);
      w.set(CONFIG, "match_damage_ratio", damageRatio);
      w.set(CONFIG, "num_players", slots.length);
      w.set(CONFIG, "is_teams", isTeams ? 1 : 0);
      w.set(CONFIG, "friendly_fire", friendlyFire ? 1 : 0);
      w.set(CONFIG, "stock_count", Math.max(1, ...slots.map((s) => s.stocks)));
      w.set(CONFIG, "arithmetic_flags", (fnmsubsZero ? ARITHMETIC_LEGACY_FNMSUBS : 0) | (splitFma ? ARITHMETIC_SPLIT_FMA : 0));
      w.set(CONFIG, "brawl_offscreen_damage", dolphinPatches ? 1 : 0);
      w.set(CONFIG, "freeze_dead_up_fall_physics", dolphinPatches ? 1 : 0);
      w.set(CONFIG, "whispy_dead_fighter_fix", dolphinPatches ? 1 : 0);
      w.set(CONFIG, "ucf_cardinals_1_0_enabled", ucf.cardinals10 ? 1 : 0);
      w.set(CONFIG, "ucf_shield_sdi_enabled", ucf.shieldSdi ? 1 : 0);
      w.set(CONFIG, "ucf_sdi_enabled", ucf.sdi ? 1 : 0);
      w.set(CONFIG, "ucf_shield_drop_extended_enabled", ucf.shieldDropExtended ? 1 : 0);
      w.set(CONFIG, "ucf_shield_drop_084_enabled", ucf.shieldDrop084 ? 1 : 0);
      w.set(CONFIG, "stage_event_streams", streams);
      w.set(CONFIG, "slippi_patches", patchesOf(codes));
      const players = offsetOf(CONFIG, "players");
      slots.forEach((s, i) => {
        const b = players + CONFIG_PLAYER.size * i;
        const facing = v.getFloat32(postOf[0][i] + 0x12) > 0 ? 1 : 0;
        w.set(CONFIG_PLAYER, "char_id", chars[i], 0, b);
        w.set(CONFIG_PLAYER, "team_id", s.team, 0, b);
        w.set(CONFIG_PLAYER, "facing_and_port", (s.port << 1) | facing, 0, b);
        w.set(CONFIG_PLAYER, "costume_id", s.costume, 0, b);
        w.set(CONFIG_PLAYER, "handicap", s.handicap, 0, b);
        w.set(CONFIG_PLAYER, "cpu_level", s.cpu, 0, b);
      });
      return bytes;
    },
    previous() {
      const bytes = new Uint8Array(INPUT_SIZE);
      writeInput(new RowWriter(bytes), 0, 0);
      return bytes;
    },
    frame(i, out) {
      out.fill(0, 0, STREAM_FRAME.size);
      const w = new RowWriter(out), r = order[i];
      w.set(STREAM_FRAME, "frame_pre_random_seed", r.seed);
      writeInput(w, offsetOf(STREAM_FRAME, "input"), i);
      const se = offsetOf(STREAM_FRAME, "stage_events");
      let seedSlot = present[i].indexOf(1);
      if (seedSlot < 0) seedSlot = 0;
      w.set(STAGE_EVENTS, "fighter_pre_random_seed", v.getUint32(preOf[i][seedSlot] + 0x7), 0, se);
      w.set(STAGE_EVENTS, "fighter_pre_random_seed_valid", 1, 0, se);
      const cpuAt = se + offsetOf(STAGE_EVENTS, "cpu_inputs");
      slots.forEach((s, k) => {
        if (!s.cpu || !present[i][k]) return;
        const p = preOf[i][k], b = cpuAt + CPU_INPUT.size * (s.port - 1);
        w.set(CPU_INPUT, "main_x", v.getFloat32(p + 0x19), 0, b);
        w.set(CPU_INPUT, "main_y", v.getFloat32(p + 0x1d), 0, b);
        w.set(CPU_INPUT, "c_x", v.getFloat32(p + 0x21), 0, b);
        w.set(CPU_INPUT, "c_y", v.getFloat32(p + 0x25), 0, b);
        w.set(CPU_INPUT, "trigger", v.getFloat32(p + 0x29), 0, b);
        w.set(CPU_INPUT, "buttons", v.getUint32(p + 0x2d), 0, b);
        w.set(CPU_INPUT, "random_seed", v.getUint32(p + 0x7), 0, b);
        w.set(CPU_INPUT, "valid", 1, 0, b);
      });
      let mask = 0;
      for (const e of r.fod) {
        const platform = v.getUint8(e + 5);
        if (platform < 2) { w.set(STAGE_EVENTS, "fod_platform_height", v.getFloat32(e + 6), platform, se); mask |= 1 << platform; }
      }
      w.set(STAGE_EVENTS, "fod_platform_mask", mask, 0, se);
      if (r.whispy >= 0) {
        w.set(STAGE_EVENTS, "dreamland_whispy_direction", v.getUint8(r.whispy + 5), 0, se);
        w.set(STAGE_EVENTS, "dreamland_whispy_valid", 1, 0, se);
      }
    },
    expected(i) {
      return slots.map((_, s) => {
        if (!present[i][s]) return null;
        const p = postOf[i][s];
        return { x: v.getFloat32(p + 0xa), y: v.getFloat32(p + 0xe), action: v.getUint16(p + 0x8),
                 percent: v.getFloat32(p + 0x16), stocks: v.getUint8(p + 0x21) };
      });
    },
  };
}

/** the drives to try for a tape, best first: the replay's own UCF switches
 *  (or all on, the validator's default, without a code list), then the same
 *  with split fused arithmetic, then the older UCF releases */
export function driveOrder(tape: Tape, maxDrives: number): DriveOptions[] {
  const first = tape.recordedUcf ?? UCF_PROFILES.ucf10;
  const out: DriveOptions[] = [{ ucf: first, splitFma: false }, { ucf: first, splitFma: true }];
  const same = (a: UcfProfile, b: UcfProfile) =>
    a.cardinals10 === b.cardinals10 && a.shieldSdi === b.shieldSdi && a.sdi === b.sdi &&
    a.shieldDropExtended === b.shieldDropExtended && a.shieldDrop084 === b.shieldDrop084;
  for (const p of Object.values(UCF_PROFILES)) if (!same(p, first)) out.push({ ucf: p, splitFma: false });
  return out.slice(0, Math.max(1, maxDrives));
}

