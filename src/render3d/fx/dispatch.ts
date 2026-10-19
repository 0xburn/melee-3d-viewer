/* 3D replay viewer: what each of the game's effect ids spawns -
 * one of the effect models, or a particle generator, and how it is placed
 * (where, facing which way, turned to the floor, scaled). The ids and what
 * they mean were read from the Melee decompilation's effect dispatch
 * (efasync.c, efsync.c, efalt.c) for the ids the fighters' move scripts,
 * landings, hits and special moves use; the tables below are ours, and the
 * models and generators themselves are read from your effect files. */

/** a common effect model: `m` its index in EfCoData's model table (two:
 *  one of them at random, the first 1 in 8) */
export interface ModelSpawn { m: number | [number, number]; attach?: boolean; face?: boolean; rotZ?: "arg" | "rand"; scale?: "damage" | "arg" }
/** a particle generator: `g` its index in EfCoData's particle bank */
export interface GenSpawn { g: number; attach?: boolean; face?: 1 | -1; rotZ?: "arg"; srtRotY?: number; scale?: "arg" | "fighter";
                           /** frames it makes particles for, when its effect is given a lifetime (EF_Effect.lifetime) */
                           life?: number;
                           /** made at the call's place under the joint it goes with, not the
                            *  joint itself (efLib_CreateGenerator_AppSRT_SetPos: a script's offset) */
                           pos?: boolean }
/** pieces flung out: `count` of the two models (half and half at random), each turned at random and
 *  thrown 2 a frame a random way, falling 0.1 a frame faster each frame, for `life` frames (efsync.c 0x4CF,
 *  efLib_Cb_SetOffset_FromParams), at the call's scale */
export interface PiecesSpawn { pieces: [number, number]; count: number; life: number }
export type Spawn = ModelSpawn | GenSpawn | PiecesSpawn | { all: Spawn[] };

const M = (m: number, o: Omit<ModelSpawn, "m"> = {}): Spawn => ({ m, ...o });
const G = (g: number, o: Omit<GenSpawn, "g"> = {}): Spawn => ({ g, ...o });

export const SPAWNS: Record<number, Spawn> = {
  // hits: the spark (1 in 8 the other one), sized by the damage
  0x3e8: { m: [9, 10], scale: "damage" },
  0x3e9: G(0x0c),                       // electric
  0x3ea: G(0x14),                       // fire
  0x3eb: M(7),
  0x3ec: M(8, { rotZ: "rand" }),        // slash
  0x3ed: { all: [G(0x50), G(0x54, { face: 1, srtRotY: 0 })] },
  0x3ee: M(0x27, { rotZ: "rand" }),
  0x3ef: G(0x42, { face: -1 }),
  0x3f0: G(0x42, { face: 1 }),
  0x3f1: G(0x14b, { face: -1 }),
  0x3f2: G(0x14b, { face: 1 }),
  0x3f3: G(0x0b),                       // an impact puff
  0x3f4: G(0x48),
  0x3f5: M(0x10, { face: true }),
  0x3f6: M(0x11),
  0x3f7: M(0x12, { face: true, rotZ: "arg" }),
  0x3f8: M(0x13, { face: true, rotZ: "arg" }),
  0x3f9: M(0x14, { face: true, rotZ: "arg" }),
  0x3fa: M(0x15),
  0x3fb: M(0x16),
  0x3fc: M(0x17),
  0x3fd: M(3, { face: true, rotZ: "arg" }),
  0x3fe: G(0x107, { face: 1 }),         // footsteps
  0x3ff: M(5, { face: true, rotZ: "arg" }), // a dash's dust
  0x400: G(0x5a, { face: -1 }),
  0x401: G(0x5a, { face: 1 }),          // turning, braking
  0x402: G(0x59, { attach: true }),     // a jump
  0x403: G(0x5e, { attach: true }),     // a jump in the air
  0x404: M(0x18, { rotZ: "arg" }),      // a landing
  0x405: G(0x2c),
  0x406: M(4, { rotZ: "arg" }),         // a hard landing
  0x407: G(0x3c),                       // a spot dodge, a landing's puff
  0x408: G(0x3e, { rotZ: "arg" }),
  0x409: G(0xe2, { attach: true }),
  0x40c: G(0x19),
  0x40d: G(0x19, { scale: "fighter" }),
  0x40e: G(0x43),
  0x40f: G(0xe3),
  0x410: G(0x22a),
  0x411: G(0x4b),
  0x412: G(0x13, { attach: true }),
  0x413: G(0x37, { attach: true }),
  0x414: G(0xe1, { attach: true }),
  0x416: G(0x196),
  0x41c: G(0x5d),                       // a hit on a shield
  0x4c3: G(0x24c),                      // a Thunder striking Pikachu
  0x4cf: { pieces: [0x1e, 0x1f], count: 12, life: 50 }, // an egg's shell breaking: twelve pieces flung out
  0x41d: M(0x0f),
  0x41f: G(0x5c),
  0x420: G(0x159),
  0x421: G(0x3f),
  0x422: G(0x5b, { attach: true }),
  0x423: M(1, { attach: true, rotZ: "arg" }),
  0x424: M(2, { attach: true, rotZ: "arg" }),
  0x425: G(0x7e),
  0x426: G(0x7f),
  0x42d: G(0x121),
  0x42e: G(0x13c, { face: 1 }),
  0x42f: M(0x20, { face: true }),
  0x430: G(0x140, { face: 1 }),
  0x431: M(0x21, { face: true }),
  0x434: G(0x14d),
  0x43a: G(0x193),
  0x43b: G(0x192),
  0x43c: G(0x1a0),
  0x43d: G(0x1af, { attach: true }),
  0x43e: M(0x24, { attach: true, scale: "arg" }), // a fighter entering the match (ftCo_800C6408): on its TopN, at its size
  0x441: G(0x1fb),
  0x442: G(0x1dc),
  0x444: G(0x1ff),
  0x445: G(0x209),
  // the Falcon and Warlock Punches' gathering streaks, on the joint, for 22
  // frames (efasync.c: efLib_CreateGenerator_AppSRT_SetPos 0x1B, lifetime 0x16)
  0x446: G(0x1b, { attach: true, life: 22, pos: true }),
  // more of the move scripts' (ftCo_8009F834, efasync.c, efsync.c): the
  // stars of one dizzy and waking from it (on the joint, at its ftData
  // attribute +0x168's size), the Ice Climbers' Belay start, Mewtwo's
  // shadows and sparkles, Peach's Toad's and Zelda's up smash's
  0x428: G(0xca, { attach: true, scale: "arg" }),
  0x429: G(0xce, { attach: true, scale: "arg" }),
  0x42a: G(0xcf, { attach: true, scale: "arg" }),
  0x44b: G(0x237),
  // the Screw Attack item's spin, on the fighter, at its size (efasync.c 0x438, ftData +0x144)
  0x438: M(0x22, { attach: true, face: true, scale: "arg" }),
  0x4e3: G(0x18a),
  0x4e4: G(0x194),
  0x4e5: G(0x17d, { attach: true }),
  0x4e6: G(0x17e, { attach: true }),
  0x4d1: G(0x64, { attach: true }),
  0x502: G(0x1a6, { attach: true }),
  0x49e: G(0x206),                      // Kirby bumping into a wall or the ceiling
};

/** the shield bubble: models 0xB-0xE by the shield's state (1047-1050) */
export const SHIELD_MODEL = 0x0b;

/** the spawn for an id: the table, or a common generator by its own number
 *  (ids under 0x250, which the game hands straight to the particle bank) */
export function spawnFor(id: number): Spawn | null {
  if (SPAWNS[id]) return SPAWNS[id];
  if (id >= 0 && id < 0x250) return { g: id };
  return null;
}

/** The game's effect files by the number its effect ids carry (an id's
 *  thousands: 3004 is model 4 of file 3), for the ones the fighters' own
 *  moves use, and which of them each fighter loads (internal id -> file). */
export const EFFECT_FILES: Record<number, { name: string; table: string }> = {
  0: { name: "EfCoData.dat", table: "effCommonDataTable" },
  1: { name: "EfMrData.dat", table: "effMarioDataTable" },
  2: { name: "EfSsData.dat", table: "effSamusDataTable" },
  3: { name: "EfFxData.dat", table: "effFoxDataTable" },
  4: { name: "EfCaData.dat", table: "effCaptainDataTable" },
  6: { name: "EfLkData.dat", table: "effLinkDataTable" },
  10: { name: "EfNsData.dat", table: "effNessDataTable" },
  12: { name: "EfKpData.dat", table: "effKoopaDataTable" },
  13: { name: "EfMtData.dat", table: "effMewtwoDataTable" },
  7: { name: "EfPkData.dat", table: "effPikachuDataTable" },
  8: { name: "EfDkData.dat", table: "effDonkeyDataTable" },
  9: { name: "EfYsData.dat", table: "effYoshiDataTable" },
  11: { name: "EfPrData.dat", table: "effPurinDataTable" },
  14: { name: "EfIcData.dat", table: "effIceclimberDataTable" },
  15: { name: "EfPeData.dat", table: "effPeachDataTable" },
  16: { name: "EfMsData.dat", table: "effMarsDataTable" },
  17: { name: "EfZdData.dat", table: "effZeldaDataTable" },
  18: { name: "EfLgData.dat", table: "effLuigiDataTable" },
  19: { name: "EfGnData.dat", table: "effGanonDataTable" },
  49: { name: "EfFeData.dat", table: "effEmblemDataTable" },
  // Kirby's own, and his copies' (each copy's effects in a file of its own)
  5: { name: "EfKbData.dat", table: "effKirbyDataTable" },
  20: { name: "EfKbMs.dat", table: "effKirbyMarsDataTable" },
  21: { name: "EfKbZd.dat", table: "effKirbyZeldaDataTable" },
  32: { name: "EfKbMr.dat", table: "effKirbyMarioDataTable" },
  33: { name: "EfKbFx.dat", table: "effKirbyFoxDataTable" },
  34: { name: "EfKbSs.dat", table: "effKirbySamusDataTable" },
  36: { name: "EfKbPk.dat", table: "effKirbyPikachuDataTable" },
  37: { name: "EfKbLg.dat", table: "effKirbyLuigiDataTable" },
  38: { name: "EfKbCa.dat", table: "effKirbyCaptainDataTable" },
  39: { name: "EfKbDk.dat", table: "effKirbyDonkeyDataTable" },
  41: { name: "EfKbKp.dat", table: "effKirbyKoopaDataTable" },
  46: { name: "EfKbIc.dat", table: "effKirbyIceDataTable" },
  47: { name: "EfKbGn.dat", table: "effKirbyGanonDataTable" },
  48: { name: "EfKbFe.dat", table: "effKirbyEmblemDataTable" },
};
/** Kirby's effect files: his own and his copies' (efasync.c) */
export const KIRBY_EFFECT_FILES = [5, 20, 21, 32, 33, 34, 36, 37, 38, 39, 41, 46, 47, 48];
/** the effect files a fighter loads (internal id -> files) */
export function effectFilesOf(internalId: number): number[] {
  if (internalId === 4) return KIRBY_EFFECT_FILES;
  const n = FIGHTER_EFFECT_FILE[internalId];
  return n === undefined ? [] : [n];
}
export const FIGHTER_EFFECT_FILE: Record<number, number> = {
  1: 3, 22: 3,   // Fox, Falco
  13: 2,         // Samus
  9: 15,         // Peach
  15: 11,        // Jigglypuff
  12: 7, 23: 7,  // Pikachu, Pichu (Pikachu's file has Pichu's too: efsync.c 0x4C4)
  3: 8,          // Donkey Kong
  14: 9,         // Yoshi
  0: 1, 21: 1,   // Mario, Dr. Mario (Mario's file)
  17: 18,        // Luigi
  10: 14, 11: 14, // the Ice Climbers
  2: 4,          // Captain Falcon
  18: 16,        // Marth
  7: 17, 19: 17, // Sheik, Zelda
  25: 19,        // Ganondorf
  26: 49,        // Roy
  6: 6, 20: 6,   // Link, Young Link (Link's file)
  8: 10,         // Ness
  5: 12,         // Bowser
  16: 13,        // Mewtwo
};
