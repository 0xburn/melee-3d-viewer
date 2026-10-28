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
  /** what the graphics build of the simulator reads beyond the wire config (render3d/gxpath/tapebridge.ts): the patch bits its
   *  admission derives from the code list (MSL_PATCH_*), and each slot's level byte (a human's, 1..9, for Nana's AI) */
  gx: { patches: number; levels: number[]; stadium: 0 | 1 | 2; ports: number[]; streams: number };
  /** (graphics build) the recording has no raw C-stick bytes (Slippi before 3.17): the tape header says so (MSL_PATCH_RAW_CSTICK_ABSENT) and
   *  the simulator owns the rule (playback slippi: as Slippi plays it; original: the fit, render3d/gxpath/cfit.ts) */
  rawCAbsent: boolean;
  /** (graphics build) a slot's recorded C-stick floats, one per row (0 on a row the slot has none): the fit's input */
  cstick(slot: number): { x: Float32Array; y: Float32Array };
  /** (graphics build) row i as the native driver's TapeFrame (120 bytes, replay_drive.py build_tape: recorded stick floats, a slot without
   *  a row all zero), into out; rawC[slot] = [x, y] replaces the raw C-stick bytes (the fit's choice) of a recording without them */
  gxFrame(i: number, out: Uint8Array, rawC?: ([Int16Array, Int16Array] | null)[]): void;
  /** (graphics build) what follows the tape's last frame: the name tags, the display names, the starting timer (build_tape's trailers) */
  gxTrailer(): Uint8Array;
  /** what the recording says row i ended with, every lane replay_drive.py frame_diff compares (render3d/gxpath/framediff.ts) */
  recorded(i: number): RecordedRow;
}

/** wire.h MslCoreMatchConfig.stage_event_streams bit 2 (the tape header's byte 37) */
export const STREAM_FRAME_START_SEEDS = 1 << 2;
/** wire.h MSL_PATCH_RAW_CSTICK_ABSENT (the tape header's slippi_patches byte) */
export const PATCH_RAW_CSTICK_ABSENT = 1 << 7;

/** one fighter's recorded post-frame lanes (replay_drive.py frame_diff) */
export interface RecordedFighter { x: number; y: number; percent: number; shield: number; action: number; stocks: number; facing: number }
/** one recorded item (Slippi's item event; a lane the recording's version lacks is null) */
export interface RecordedItem {
  type: number; state: number; owner: number | null; direction: number; velX: number; velY: number; x: number; y: number;
  damage: number; timer: number; spawnId: number; misc: number[] | null; instanceId: number | null;
}
export interface RecordedRow {
  /** per slot: the leader (null: no row), and whether the slot has a follower lane at all, and her row (null: absent) */
  players: { leader: RecordedFighter | null; hasFollower: boolean; follower: RecordedFighter | null }[];
  /** the row's items (at most 15), or null when the recording has no item events */
  items: RecordedItem[] | null;
  /** the item instance id is compared (Slippi 3.16 on) */
  withInstance: boolean;
}

/** the native driver's TapeFrame (replay_drive.c, replay_drive.py FRAME_FMT) */
export const GX_FRAME_SIZE = 120;
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

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

/**
 * The gameplay codes that came and went across Slippi versions, as the driver's CONFIG bytes. THE one rule, the
 * same as tools/replay/replay_drive.py code_flags (tests/code-flags-rule.test.ts holds the two equal against
 * the fork's tools/replay/code_flags_cases.json): a replay with a gecko list gets each flag from whether the
 * list carries that code (the game applies the list's codes); a replay without a list gets all three from
 * scene major 8, the online code set.
 */
export const CODE_FLAG_ADDRESSES = {
  brawl_offscreen_damage: 0xc206a880, freeze_dead_up_fall_physics: 0xc20d4c1c, whispy_dead_fighter_fix: 0xc208653c,
} as const;
export function codeFlags(codes: { has(address: number): boolean; size: number }, online: boolean): Record<keyof typeof CODE_FLAG_ADDRESSES, boolean> {
  const f = {} as Record<keyof typeof CODE_FLAG_ADDRESSES, boolean>;
  for (const name of Object.keys(CODE_FLAG_ADDRESSES) as (keyof typeof CODE_FLAG_ADDRESSES)[]) {
    f[name] = codes.size ? codes.has(CODE_FLAG_ADDRESSES[name]) : online;
  }
  return f;
}

/**
 * The host Dolphin's fnmsubs zero sign: the Slippi online code set (scene major 8) runs on Slippi's Dolphin; a
 * recording that names mainline Dolphin as where it was played keeps retail signs. THE one rule, the same as
 * replay_drive.py fnmsubs_zero and tools/validation/native.c parse_metadata (tests/code-flags-rule.test.ts).
 */
export function fnmsubsZeroOf(sceneMajor: number, playedOn: string): boolean {
  return sceneMajor === 8 && playedOn !== "mainline dolphin";
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

/** the patch bits melee-sim-light's admission derives from the code list (admission.py slippi_patches) */
export function simPatches(codes: Map<number, Uint8Array>): number {
  let patches = patchesOf(codes);
  if ([0xc208f090, 0xc20db880, 0xc20dbbd4].every((a) => codes.has(a))) patches |= 1 << 1;
  if (codes.size) {
    if (!codes.has(0xc216e510)) patches |= 1 << 2;
    if (codes.has(0xc206c5d8)) patches |= 1 << 3;
    if (!codes.has(0xc20908f4)) patches |= 1 << 4;
    if (!codes.has(0xc20c9a44)) patches |= 1 << 5;
    if (!codes.has(0xc20998a4)) patches |= 1 << 6;
  }
  return patches;
}

/** MslCoreMatchConfig.stadium_transformations (wire.h MSL_STADIUM_*): 0 frozen, 1 the preloading patch set, 2 Slippi Online 3.18's file load,
 *  or null for an unfrozen Stadium no deterministic patch set owns (admission.py stadium_transformations) */
export function stadiumKind(isFrozenPs: boolean, codes: Map<number, Uint8Array>): 0 | 1 | 2 | null {
  if (stadiumFrozen(isFrozenPs, codes)) return 0;
  const toggle = codes.get(0xc21d457c);
  if (toggle && toggle.length > 16 && toggle[16] !== 0) return 0;
  const preloaded = codes.has(0xc21d45ec), online = codes.has(0xc20165ac);
  return preloaded !== online ? (preloaded ? 1 : 2) : null;
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
  fpost: Int32Array; // the followers' (Nana) post rows, by slot (the frame's last pass)
  items: number[]; // offsets of the frame's 0x3B events (its last pass)
  fod: number[]; // offsets of 0x3F events
  whispy: number;  // offset of the last 0x40 event, -1 none
}

/** how a tape is read beyond the validator's way */
export interface TapeOptions {
  /** Pokemon Stadium with its transformations on is played (the graphics build of the simulator has them: MSL_STADIUM_*); without this
   *  such a replay is refused, as the track simulator cannot play it */
  stadiumTransformations?: boolean;
}

/**
 * Read a replay (the UBJSON's `raw` bytes and `metadata`) into a tape.
 * Throws Unsupported with the reason when the simulator does not play it.
 */
export function readTape(raw: Uint8Array, metadata: { playedOn?: string } | undefined, options: TapeOptions = {}): Tape {
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
    if (!r) rows.set(frame, (r = { seed: 0, pre: new Int32Array(4).fill(-1), post: new Int32Array(4).fill(-1), fpost: new Int32Array(4).fill(-1), items: [], fod: [], whispy: -1 }));
    return r;
  };
  let sawFrameStart = false, minFrame = Infinity, maxFrame = -Infinity;
  const hasFollower = [false, false, false, false];
  let o = startAt + startSize + 1;
  while (o < raw.length) {
    const cmd = v.getUint8(o), size = sizes.get(cmd);
    if (size === undefined) throw new Unsupported(`unknown event 0x${cmd.toString(16)}`);
    switch (cmd) {
      case 0x3a: { // frame start: a frame played again (a rollback) starts over
        const fr = v.getInt32(o + 1);
        const r = row(fr);
        r.seed = v.getUint32(o + 5);
        r.fod = []; r.whispy = -1; r.items = []; r.fpost.fill(-1);
        sawFrameStart = true;
        if (fr < minFrame) minFrame = fr;
        if (fr > maxFrame) maxFrame = fr;
        break;
      }
      case 0x37: case 0x38: {
        const slot = slotOfPort.get(v.getUint8(o + 5));
        if (slot === undefined) break;
        if (v.getUint8(o + 6) !== 0) { // a follower (Nana): her rows are not inputs, only compared
          if (cmd === 0x38) { row(v.getInt32(o + 1)).fpost[slot] = o; hasFollower[slot] = true; }
          break;
        }
        const r = row(v.getInt32(o + 1));
        (cmd === 0x37 ? r.pre : r.post)[slot] = o;
        break;
      }
      case 0x3b: row(v.getInt32(o + 1)).items.push(o); break;
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
  let stadium: 0 | 1 | 2 = 0;
  if (stage === 3) {
    const kind = stadiumKind(frozenPs, codes);
    if (kind === null) throw new Unsupported("Pokemon Stadium with its transformations on, in a version whose file loading is not deterministic");
    if (kind !== 0 && !options.stadiumTransformations) throw new Unsupported("Pokemon Stadium with its transformations on");
    stadium = kind;
  }

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
  const fnmsubsZero = fnmsubsZeroOf(sceneMajor, playedOn);
  const flags = codeFlags(codes, sceneMajor === 8);
  const recorded = codes.size ? recordedUcf(codes) : null;
  // (Slippi 3.18 on records Fountain's platforms and Whispy's direction: the streams are present)
  const streams = atLeast(3, 18, 0) ? 3 : 0;
  const hasRawY = has(0x37, 0x40), hasRawC = has(0x37, 0x42);
  // (the item event's lanes by Slippi version: misc from 3.2, owner from 3.6, instance id from 3.16; a lane the event is too short for is
  // not in the recording)
  const itemSize = sizes.get(0x3b) ?? 0;
  const itemMisc = itemSize >= 0x29, itemOwner = itemSize >= 0x2a, itemInstance = itemSize >= 0x2c;

  // (the graphics build's tape, replay_drive.py build_tape: a derived axis is the recorded float times 80 in float64, truncated and
  // clamped; for a recording without raw C-stick bytes this is reconstructed_cstick(GATE_EXACT), the fit's starting point, and the
  // simulator owns what is done with it)
  const derived = (axis: number) => Math.max(-80, Math.min(80, Math.trunc(axis * 80)));
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
    gx: {
      patches: simPatches(codes) | (hasRawC ? 0 : PATCH_RAW_CSTICK_ABSENT),
      stadium,
      // (each slot's controller port, 0 to 3)
      ports: slots.map((s) => s.port - 1),
      // (the tape header's stage_event_streams bits the graphics build reads beyond the wire config's: bit 2, the recording has Frame Start
      // events (Slippi 2.2 on; replay_drive.py build_tape "frame_start_seeds"), so its frame seeds are the real frame-start seeds and the
      // viewer build restores the RNG once at the frame start, not again at the fighters' point. The reader refuses a replay without them.)
      streams: sawFrameStart ? STREAM_FRAME_START_SEEDS : 0,
      // (a human with a level byte of 1..9 is MSL_CORE_HUMAN_LEVEL | level)
      levels: slots.map((s) => {
        if (s.cpu) return s.cpu;
        const level = startSize > 0x74 + 0x24 * (s.port - 1) ? v.getUint8(g(0x74 + 0x24 * (s.port - 1))) : 0;
        return level >= 1 && level <= 9 ? 0x80 | level : 0;
      }),
    },
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
      w.set(CONFIG, "brawl_offscreen_damage", flags.brawl_offscreen_damage ? 1 : 0);
      w.set(CONFIG, "freeze_dead_up_fall_physics", flags.freeze_dead_up_fall_physics ? 1 : 0);
      w.set(CONFIG, "whispy_dead_fighter_fix", flags.whispy_dead_fighter_fix ? 1 : 0);
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
    rawCAbsent: !hasRawC,
    cstick(s) {
      const x = new Float32Array(order.length), y = new Float32Array(order.length);
      for (let i = 0; i < order.length; i++) if (present[i][s]) { x[i] = v.getFloat32(preOf[i][s] + 0x21); y[i] = v.getFloat32(preOf[i][s] + 0x25); }
      return { x, y };
    },
    gxFrame(i, out, rawC) {
      out.fill(0, 0, GX_FRAME_SIZE);
      const o = new DataView(out.buffer, out.byteOffset, GX_FRAME_SIZE), r = order[i];
      let seedSlot = present[i].indexOf(1);
      if (seedSlot < 0) seedSlot = 0;
      o.setUint32(0, r.seed, true);
      o.setUint32(4, v.getUint32(preOf[i][seedSlot] + 0x7), true);
      o.setUint8(8, 1);
      let fodValid = 0;
      for (const e of r.fod) {
        if (v.getUint8(e + 5) === 0) { o.setFloat32(12, v.getFloat32(e + 6), true); fodValid |= 1; }
        else { o.setFloat32(16, v.getFloat32(e + 6), true); fodValid |= 2; }
      }
      o.setUint8(9, fodValid);
      if (r.whispy >= 0) { o.setUint8(10, 1); o.setUint8(11, v.getUint8(r.whispy + 5)); }
      for (let s = 0; s < slots.length; s++) {
        if (!present[i][s]) continue;
        const p = preOf[i][s], d = 20 + 25 * s, at = (k: number) => v.getFloat32(p + k);
        const fit = rawC?.[s] ?? null;
        o.setUint16(d, v.getUint16(p + 0x31), true);
        o.setInt8(d + 2, v.getInt8(p + 0x3b));
        // (main_y without the raw byte: build_tape multiplies the float32 column by 80 in float32, numpy's rule for an array times a
        // Python float, where reconstructed_cstick converts to float64 first)
        o.setInt8(d + 3, hasRawY ? v.getInt8(p + 0x40) : Math.max(-80, Math.min(80, Math.trunc(Math.fround(at(0x1d) * 80)))));
        o.setInt8(d + 4, hasRawC ? v.getInt8(p + 0x41) : fit ? fit[0][i] : derived(at(0x21)));
        o.setInt8(d + 5, hasRawC ? v.getInt8(p + 0x42) : fit ? fit[1][i] : derived(at(0x25)));
        o.setUint8(d + 6, triggerByte(at(0x33)));
        o.setUint8(d + 7, triggerByte(at(0x37)));
        o.setUint8(d + 8, 3);
        o.setFloat32(d + 9, at(0x19), true); o.setFloat32(d + 13, at(0x1d), true);
        o.setFloat32(d + 17, at(0x21), true); o.setFloat32(d + 21, at(0x25), true);
      }
    },
    gxTrailer() {
      const parts: number[] = [];
      const human = (s: { cpu: number }) => s.cpu === 0;
      // name tags: (slot id, 16 text bytes) per player and "NTG1" (replay_drive.py nametag_trailer), when a human shows one
      if (startSize >= 0x161 + 0x40) {
        const rows = slots.map((s) => {
          const port = s.port - 1, id = v.getUint8(g(0x65 + 0xa + 0x24 * port)), text = raw.subarray(g(0x161 + 0x10 * port), g(0x161 + 0x10 * port) + 16);
          return human(s) && id < 0x78 && text[0] !== 0 ? [id, ...text] : [0x78, ...new Array(16).fill(0)];
        });
        if (rows.some((x) => x[0] !== 0x78)) { while (rows.length < 4) rows.push([0x78, ...new Array(16).fill(0)]); for (const x of rows) parts.push(...x); parts.push(...ascii("NTG1")); }
      }
      // display names: 31 Shift JIS bytes per player and "DNM1" (displayname_trailer, Slippi 3.9 on)
      if (startSize >= 0x1a5 + 4 * 0x1f) {
        const rows = slots.map((s) => {
          const at = g(0x1a5 + 0x1f * (s.port - 1)), name = raw.subarray(at, at + 31);
          return human(s) && name[0] !== 0 ? [...name] : new Array(31).fill(0);
        });
        if (rows.some((x) => x[0] !== 0)) { while (rows.length < 4) rows.push(new Array(31).fill(0)); for (const x of rows) parts.push(...x); parts.push(...ascii("DNM1")); }
      }
      // the starting timer: u32 seconds (big-endian) and "RUL1" (timer_trailer), unless it is the usual 8:00
      const seconds = v.getUint32(g(0x15));
      if (seconds && seconds !== 480) { parts.push(seconds >>> 24, (seconds >>> 16) & 255, (seconds >>> 8) & 255, seconds & 255); parts.push(...ascii("RUL1")); }
      return new Uint8Array(parts);
    },
    recorded(i) {
      const fighter = (p: number): RecordedFighter => ({
        x: v.getFloat32(p + 0xa), y: v.getFloat32(p + 0xe), percent: v.getFloat32(p + 0x16), shield: v.getFloat32(p + 0x1a),
        action: v.getUint16(p + 0x8), stocks: v.getUint8(p + 0x21), facing: v.getFloat32(p + 0x12) > 0 ? 1 : 0,
      });
      const r = order[i];
      const items = r.items.slice(0, 15).map((e): RecordedItem => ({
        type: v.getUint16(e + 0x5), state: v.getUint8(e + 0x7), direction: v.getFloat32(e + 0x8),
        velX: v.getFloat32(e + 0xc), velY: v.getFloat32(e + 0x10), x: v.getFloat32(e + 0x14), y: v.getFloat32(e + 0x18),
        damage: v.getUint16(e + 0x1c), timer: v.getFloat32(e + 0x1e), spawnId: v.getUint32(e + 0x22),
        misc: itemMisc ? [0, 1, 2, 3].map((k) => v.getUint8(e + 0x26 + k)) : null,
        owner: itemOwner ? v.getInt8(e + 0x2a) : null,
        instanceId: itemInstance ? v.getUint16(e + 0x2b) : null,
      }));
      return {
        players: slots.map((_, s) => ({
          leader: present[i][s] ? fighter(postOf[i][s]) : null,
          hasFollower: hasFollower[s],
          follower: r.fpost[s] >= 0 ? fighter(r.fpost[s]) : null,
        })),
        items,
        withInstance: itemInstance && atLeast(3, 16, 0),
      };
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

