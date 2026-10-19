/* 3D replay viewer: the game's own effect art.
 *
 * Read at runtime from your game files, like the fighters and stages:
 *  - EfCoData.dat, the common effects: its particle bank, textures and
 *    effect models (fx/bank.ts) - the dust, sparks, puffs and flashes
 *    fx/world.ts runs from the fighters' move scripts and the hits.
 *  - EfFxData.dat, Fox's and Falco's effects: the reflector's three models
 *    (the hexagon while it is up, the flash as it comes out, the flash of a
 *    reflect), with their own animations; and, like the other fighters'
 *    own effect files (EfCaData, EfGnData, EfMsData...), read when a replay
 *    has that fighter (or the track's pieces name the file), its own effects.
 *  - PlCo.dat, what every fighter shares: the angel platform and its
 *    animation, which joint of each fighter is which of its named parts
 *    (the reflector hangs from the hip; scripts name parts), and the
 *    players' shield colors.
 * Each file is optional: whatever cannot be read is left out, and the rest
 * of the picture is unaffected.
 */
import { Archive, parseArchive, ptr } from "./hsd";
import { Prop, effectOverAll } from "./prop";
import { EffectBank } from "./fx/bank";
import { ColAnimTables, colAnimTables } from "./fx/colanim";
import { setPartSkips } from "./parts";
import { HIT_FEEL, HitFeel, readHitFeel } from "./hitlag";
import { INV_TIMES, InvTimes, readInvTimes } from "./fx/invincible";
import { readSmokeTimes, SMOKE_TIMES, SmokeTimes } from "./fx/launchsmoke";

/** an effect file's model number `i` (its EF_EffectDesc) as a prop */
function effectModel(a: Archive, table: number, i: number, tag: string): { prop: Prop; life: number } | null {
  const e = table + 8 + i * 0x14;
  const joint = ptr(a, e + 4);
  if (joint === null) return null;
  const prop = new Prop(a, joint, ptr(a, e + 8), ptr(a, e + 12), `${tag}:${i}`, false, true), life = a.data.getFloat32(e);
  if (effectOverAll(life)) prop.zAlways();
  return { prop, life };
}

export class EffectKit {
  /** EfCoData: the common effects */
  bank: EffectBank | null = null;
  /** every effect file read, by the game's number for it (0: EfCoData) */
  banks = new Map<number, EffectBank>();
  /** the reflector: the hexagon (loops), the start flash, the reflect flash */
  reflector: { loop: Prop; start: Prop; hit: Prop } | null = null;
  platform: Prop | null = null;
  /** the stand a fighter enters the match on (PlCo's entry 16) */
  entryStand: Prop | null = null;
  /** the entry's timings (ftCommonData): its rise's and its fall's frames,
   *  and the share of its height a fighter starts at */
  entry = { rise: 30, fall: 30, from: 0.01 };
  /** internal character id -> part -> joint (255: none) */
  private parts: Uint8Array[] = [];
  /** the players' colors as the game tints shields with (by port) */
  shieldColors: [number, number, number][] = [];
  /** the shield's size curve (ftCommonData): full health, smallest share,
   *  share at the lightest press, share at the hardest */
  shieldCurve: [number, number, number, number] | null = null;
  /** a KO blast's size, and the players' second colors for it */
  koScale = 0.8;
  /** a shield's tilt: the share of the way it eases toward the stick each frame */
  guardEase = 0;
  /** a fall's lean (ftCommonData +0x444, +0x448: ftCo_Fall_Anim_Inner): the
   *  share of its top drift speed a fighter drifts at before it leans, and how
   *  much of the way the lean eases each frame; null until read */
  fallLean: { dead: number; ease: number } | null = null;
  koColors: [number, number, number][] = [];
  /** the fighters' color animations (PlCo.dat) */
  colAnims: ColAnimTables | null = null;
  /** what a hit does to the picture: its shake, a charge's, the camera's quake (hitlag.ts) */
  hitFeel: HitFeel = HIT_FEEL;
  /** how long each occasion's timed invincibility lasts (fx/invincible.ts) */
  invTimes: InvTimes = INV_TIMES;
  /** a launched fighter's smoke: its spacing by speed (fx/launchsmoke.ts) */
  smokeTimes: SmokeTimes = SMOKE_TIMES;
  /** the frames past a shield's coming up that it powershields (ftCommonData +0x2B4: fx/contact.ts) */
  powershieldWindow = 3;

  common(buf: ArrayBuffer) {
    this.bank = new EffectBank(buf, "effCommonDataTable", 0);
    this.banks.set(0, this.bank);
  }

  /** a fighter's own effect file, as the game numbers it */
  fighter(file: number, table: string, buf: ArrayBuffer) {
    this.banks.set(file, new EffectBank(buf, table, file));
  }

  fox(buf: ArrayBuffer) {
    const a = parseArchive(buf);
    const t = a.publics.get("effFoxDataTable");
    if (t === undefined) return;
    // the game's effect ids 3000-3002 (efSync 1160-1162)
    const loop = effectModel(a, t, 0, "effx"), start = effectModel(a, t, 1, "effx"), hit = effectModel(a, t, 2, "effx");
    if (loop && start && hit) this.reflector = { loop: loop.prop, start: start.prop, hit: hit.prop };
  }

  shared(buf: ArrayBuffer) {
    const a = parseArchive(buf);
    const d = a.data;
    const t = a.publics.get("ftLoadCommonData");
    if (t === undefined) return;
    // entry 8: the angel platform's joint and its animation
    const plat = ptr(a, t + 8 * 4);
    const pj = plat === null ? null : ptr(a, plat);
    if (plat !== null && pj !== null) this.platform = new Prop(a, pj, ptr(a, plat + 4), null, "plco:rebirth");
    // entry 16: the stand a fighter enters the match on (ftCo_800C6408)
    const stand = ptr(a, t + 16 * 4);
    if (stand !== null) {
      try { this.entryStand = new Prop(a, stand, null, null, "plco:entry", true); } catch { this.entryStand = null; }
    }
    // entry 4: per fighter {joint_to_part, part_to_joint, count}
    const parts = ptr(a, t + 4 * 4);
    for (let k = 0; parts !== null && k < 33; k++) {
      const pt = ptr(a, parts + k * 4);
      const toJoint = pt === null ? null : ptr(a, pt + 4);
      const n = pt === null ? 0 : Math.min(128, d.getUint32(pt + 8));
      this.parts[k] = toJoint === null ? new Uint8Array(0) : a.u8.slice(toJoint, toJoint + Math.max(n, 80));
    }
    // entry 5: per fighter, the parts its model leaves out (each {part, its
    // parent part, ...}: ftParts_8007506C) - Kirby's copies' extra joints
    // and Link's; the game's part numbers skip past them
    const skips = ptr(a, t + 5 * 4);
    const table: Record<number, number[]> = {};
    for (let k = 0; skips !== null && k < 33; k++) {
      const e = ptr(a, skips + k * 4);
      const list = e === null ? null : ptr(a, e);
      const n = e === null ? 0 : d.getInt32(e + 4);
      if (list === null || n <= 0 || n > 64) continue;
      table[k] = Array.from({ length: n }, (_, i) => d.getUint8(list + i * 4));
    }
    setPartSkips(table);
    // entry 0: the fighters' common numbers; the shield's size curve: full
    // health (0x260), the smallest share (0x264), and the share at the
    // lightest and hardest press (0x2D4, 0x2D8)
    const cd = ptr(a, t);
    if (cd !== null) this.shieldCurve = [0x260, 0x264, 0x2d4, 0x2d8].map((o) => d.getFloat32(cd + o)) as [number, number, number, number];
    // a KO blast's size (0x4F4)
    if (cd !== null) this.koScale = d.getFloat32(cd + 0x4f4);
    // how much of the way a shield's tilt eases toward the stick each frame (0x44C: guard.ts)
    if (cd !== null) this.guardEase = d.getFloat32(cd + 0x44c);
    // a fall's lean: its dead zone and its ease (0x444, 0x448)
    if (cd !== null) {
      const dead = d.getFloat32(cd + 0x444), ease = d.getFloat32(cd + 0x448);
      if (dead >= 0 && dead < 1 && ease > 0 && ease <= 1) this.fallLean = { dead, ease };
    }
    // a powershield's window past the shield's first frame (0x2B4: fx/contact.ts)
    if (cd !== null) {
      const w = d.getFloat32(cd + 0x2b4);
      if (w >= 0 && w < 60) this.powershieldWindow = w;
    }
    // the entry: the frames of its rise and of its fall (0x6BC, 0x6C0), and
    // the share of its height a fighter starts it at (0x6C4)
    if (cd !== null) {
      const rise = d.getInt32(cd + 0x6bc), fall = d.getInt32(cd + 0x6c0), from = d.getFloat32(cd + 0x6c4);
      if (rise > 0 && rise < 600 && fall > 0 && fall < 600) this.entry = { rise, fall, from };
    }
    // entry 19: the players' second colors (a KO blast's, with entry 18's)
    const cols2 = ptr(a, t + 19 * 4);
    for (let i = 0; cols2 !== null && i < 4; i++) {
      this.koColors.push([d.getUint8(cols2 + i * 4) / 255, d.getUint8(cols2 + i * 4 + 1) / 255, d.getUint8(cols2 + i * 4 + 2) / 255]);
    }
    // entries 6 and 7: the color animations (fx/colanim.ts)
    this.colAnims = colAnimTables(a, t, ptr);
    // entries 9 and 11 and ftCommonData's numbers: a hit's shake, a charge's (hitlag.ts)
    this.hitFeel = readHitFeel(a, t);
    // ftCommonData's timed invincibility counts (fx/invincible.ts)
    this.invTimes = readInvTimes(a, t);
    this.smokeTimes = readSmokeTimes(a, t);
    // entry 18: the shield colors, four bytes each (by the player's slot)
    const cols = ptr(a, t + 18 * 4);
    for (let i = 0; cols !== null && i < 4; i++) {
      this.shieldColors.push([d.getUint8(cols + i * 4) / 255, d.getUint8(cols + i * 4 + 1) / 255, d.getUint8(cols + i * 4 + 2) / 255]);
    }
  }

  /** the joint a fighter's named part is (a script's "common" bones), or -1 */
  partToJoint(internalId: number, part: number): number {
    const p = this.parts[internalId];
    const j = p && part < p.length ? p[part] : 255;
    return j === 255 ? -1 : j;
  }

  /** a fighter's hip joint (the reflector's anchor), or -1 */
  hipOf(internalId: number): number {
    return this.partToJoint(internalId, 4);
  }
}
