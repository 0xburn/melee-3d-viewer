/* 3D replay viewer: one of the game's effect files, read.
 *
 * An effect file (EfCoData.dat, EfFxData.dat, ...) holds a data table: its
 * particle bank (the generators, each with its emission shape and the small
 * command script every particle it emits runs), its texture bank (the
 * particles' images, in groups), and its effect models (EF_EffectDesc: a
 * lifetime and a joint tree with its animations). Layouts as the game's
 * HSD_PSCmdList, HSD_PSTexGroup and EF_EffectDesc; nothing here is copied
 * from the game, it is all read from your file at runtime.
 */
import { Archive, Image, decodeImage, parseArchive, ptr } from "../hsd";
import { Prop, effectOverAll } from "../prop";

/** a particle texture decoded (RGBA8), and where its bytes are in the file (the draw log's identity of it) */
export interface Sprite { key: string; w: number; h: number; rgba: Uint8Array; src?: { archive: Archive; image: Image } }

/** a generator's description (HSD_PSCmdList) */
export interface CmdList {
  type: number;
  texGroup: number;
  genLife: number;
  life: number;
  kind: number;
  grav: number;
  fric: number;
  vx: number;
  vy: number;
  vz: number;
  radius: number;
  angle: number;
  random: number;
  size: number;
  param1: number;
  param2: number;
  param3: number;
  /** the particles' command script */
  cmd: Uint8Array;
}

export interface TexGroup {
  width: number;
  height: number;
  /** RGBA8 per image, decoded on first use */
  images: (Uint8Array | null)[];
  offsets: number[];
  fmt: number;
  tlutFmt: number;
  palOffsets: number[];
  /** each image as a particle's sprite, once asked for (EffectBank.image) */
  sprites?: Sprite[];
}

export interface ModelDesc {
  life: number;
  joint: number;
  animJoint: number | null;
  matAnimJoint: number | null;
}

/** a particle generator an effect model's animation starts */
/** (every: the animation's length when it loops, its particles started again each time round; else 0) */
export interface PtclKey { joint: number; time: number; bank: number; gen: number; every: number }

/** the KEY entries (op 6) of an FObj stream: each one's frame and its value
 *  as the integer the game reads from it */
export function keyEvents(bytes: Uint8Array, frac: number, start: number): { time: number; value: number }[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  const vlq = () => {
    let r = 0, s = 0, b = 0x80;
    while (b & 0x80 && i < bytes.byteLength) { b = v.getUint8(i++); r |= (b & 0x7f) << s; s += 7; }
    return r;
  };
  const size = [4, 2, 2, 1, 1][frac >> 5] ?? 1;
  const out: { time: number; value: number }[] = [];
  let time = start;
  while (i < bytes.byteLength) {
    const head = vlq();
    const op = head & 15, n = (head >> 4) + 1;
    for (let k = 0; k < n && i < bytes.byteLength; k++) {
      if (op === 5) { i += size; continue; } // a slope: no wait follows
      let value = 0;
      if (op >= 1 && op <= 4 || op === 6) {
        if (size === 4) value = v.getUint32(i, true);
        else if (size === 2) value = v.getUint16(i, true);
        else value = v.getUint8(i);
        i += size;
        if (op === 4) i += size; // its slope
      }
      if (op === 6) out.push({ time, value });
      time += vlq();
    }
  }
  return out;
}

/** whether this is a file already read (an Archive), rather than its bytes */
export function isArchive(x: ArrayBuffer | Archive): x is Archive {
  return typeof x === "object" && x !== null && "publics" in x && "data" in x;
}

export class EffectBank {
  archive: Archive;
  cmds: (CmdList | null)[] = [];
  texGroups: (TexGroup | null)[] = [];
  models: ModelDesc[] = [];
  private props = new Map<number, Prop[]>();
  private texBank: number | null;

  /** `symbol` names the file's data table; or, for a stage file (already
   *  read), "map_ptcl": its particle bank and textures stand on their own
   *  (map_ptcl, map_texg), with no effect models */
  constructor(buf: ArrayBuffer | Archive, symbol: string, public id: number) {
    // (told apart by what it has, not by instanceof: the page's players share
    // the game files' bytes, and bytes fetched in another player's frame are
    // another realm's ArrayBuffer - a second player on the page lost every effect)
    const a = (this.archive = isArchive(buf) ? buf : parseArchive(buf));
    const d = a.data;
    if (symbol === "map_ptcl") {
      const cmdBank = a.publics.get("map_ptcl") ?? null, texBank = (this.texBank = a.publics.get("map_texg") ?? null);
      if (cmdBank === null) throw new Error("no map_ptcl");
      this.readCmds(cmdBank);
      if (texBank !== null) this.readTexGroups(texBank);
      return;
    }
    const t = a.publics.get(symbol);
    if (t === undefined) throw new Error(`no ${symbol}`);
    const cmdBank = ptr(a, t), texBank = (this.texBank = ptr(a, t + 4));
    if (cmdBank !== null) this.readCmds(cmdBank);
    if (texBank !== null) this.readTexGroups(texBank);
    // the models: EF_EffectDesc[] from table + 8, while they point at joints
    for (let i = 0; i < 400; i++) {
      const e = t + 8 + i * 0x14;
      if (e + 0x14 > d.byteLength) break;
      const joint = ptr(a, e + 4);
      if (joint === null) {
        // a table can have holes; stop at the first run of empties
        if (i > 0 && ptr(a, e + 4 + 0x14) === null && ptr(a, e + 4 + 0x28) === null) break;
        this.models.push({ life: 0, joint: -1, animJoint: null, matAnimJoint: null });
        continue;
      }
      this.models.push({ life: d.getFloat32(e), joint, animJoint: ptr(a, e + 8), matAnimJoint: ptr(a, e + 12) });
    }
  }

  private readCmds(P: number) {
    const a = this.archive, d = a.data;
    const version = d.getUint16(P);
    let count: number, first: number, base = 0;
    if (version === 0) { count = d.getUint32(P + 4); first = P + 8; }
    else if (version >= 0x40 && version <= 0x43) {
      base = d.getUint32(P + 4);
      count = d.getUint32(P + 8);
      first = P + 12;
    } else return;
    for (let i = 0; i < base; i++) this.cmds.push(null);
    for (let i = 0; i < count && i < 4096; i++) {
      const off = d.getUint32(first + i * 4);
      if (!off) { this.cmds.push(null); continue; }
      const C = P + off;
      if (C + 0x3c > d.byteLength) { this.cmds.push(null); continue; }
      const f = (o: number) => d.getFloat32(C + o);
      // the script runs until an end command; its length is not stored, so
      // it is given everything up to the next command list (or the table)
      this.cmds.push({
        type: d.getUint16(C), texGroup: d.getUint16(C + 2), genLife: d.getUint16(C + 4), life: d.getUint16(C + 6),
        kind: (d.getUint32(C + 8) & 0xf1ffffff) | 0x08000000,
        grav: f(0xc), fric: f(0x10), vx: f(0x14), vy: f(0x18), vz: f(0x1c), radius: f(0x20), angle: f(0x24),
        random: f(0x28), size: f(0x2c), param1: f(0x30), param2: f(0x34), param3: f(0x38),
        cmd: a.u8.subarray(C + 0x3c, Math.min(a.u8.length, C + 0x3c + 2048)),
      });
    }
  }

  private readTexGroups(T: number) {
    const d = this.archive.data;
    const n = d.getUint32(T);
    for (let g = 0; g < n && g < 512; g++) {
      const go = d.getUint32(T + 4 + g * 4);
      if (!go) { this.texGroups.push(null); continue; }
      const G = T + go;
      const num = d.getUint32(G), fmt = d.getUint32(G + 4), tlutFmt = d.getUint32(G + 8);
      const width = d.getUint32(G + 12), height = d.getUint32(G + 16);
      if (num > 256 || width > 1024 || height > 1024) { this.texGroups.push(null); continue; }
      const offsets: number[] = [], palOffsets: number[] = [];
      for (let i = 0; i < num; i++) offsets.push(T + d.getUint32(G + 0x18 + i * 4));
      if (fmt === 8 || fmt === 9 || fmt === 10) for (let i = 0; i < num; i++) palOffsets.push(T + d.getUint32(G + 0x18 + num * 4 + i * 4));
      this.texGroups.push({ width, height, images: offsets.map(() => null), offsets, fmt, tlutFmt, palOffsets });
    }
  }

  /** a particle texture as RGBA8, decoded once */
  image(group: number, pose: number): Sprite | null {
    const tg = this.texGroups[group];
    if (!tg || !tg.offsets.length) return null;
    const i = Math.min(pose, tg.offsets.length - 1);
    let px = tg.images[i];
    if (!px) {
      const off = tg.offsets[i];
      const img: Image = { offset: off, dataOff: off, width: tg.width, height: tg.height, format: tg.fmt };
      const tlut = tg.palOffsets.length
        ? { offset: tg.palOffsets[i], dataOff: tg.palOffsets[i], format: tg.tlutFmt, count: tg.fmt === 8 ? 16 : 256 }
        : null;
      try { px = decodeImage(this.archive, img, tlut); } catch { px = new Uint8Array(tg.width * tg.height * 4); }
      tg.images[i] = px;
    }
    // (the same object each time: the particles' batches compare them)
    const made = (tg.sprites ??= [])[i];
    if (made && made.rgba === px) return made;
    // (`src`: where its bytes are in the file, for the draw log's identity of it)
    return (tg.sprites[i] = { key: `bank${this.id}:${group}:${i}`, w: tg.width, h: tg.height, rgba: px,
                              src: { archive: this.archive, image: { offset: tg.offsets[i], dataOff: tg.offsets[i], width: tg.width,
                                                                     height: tg.height, format: tg.fmt } } });
  }

  private ptcl = new Map<number, PtclKey[]>();

  /** the particles an effect model's animation starts: its joint tracks of
   *  type 0x28, whose keys each start a generator on that joint (HSD's
   *  dptcl callback: bank in the low 6 bits, generator above) */
  ptclKeys(index: number): PtclKey[] {
    let out = this.ptcl.get(index);
    if (out) return out;
    out = [];
    const m = this.models[index];
    if (m && m.animJoint !== null) out = animPtclKeys(this.archive, m.animJoint, true);
    out.sort((x, y) => x.time - y.time);
    this.ptcl.set(index, out);
    return out;
  }

  /** an effect model to pose (several can be on screen at once: a pool) */
  prop(index: number, slot: number, blend: boolean): Prop | null {
    const m = this.models[index];
    if (!m || m.joint < 0) return null;
    let pool = this.props.get(index);
    if (!pool) this.props.set(index, (pool = []));
    while (pool.length <= slot) {
      try {
        const p = new Prop(this.archive, m.joint, m.animJoint, m.matAnimJoint, `efbank${this.id}:${index}:${pool.length}`, false, blend);
        if (effectOverAll(m.life)) p.zAlways();
        pool.push(p);
      } catch {
        return null;
      }
    }
    return pool[slot];
  }
}

/** the particles a model's animation starts (its joint tracks of type 0x28,
 *  whose keys each start a generator on that joint: HSD's dptcl callback,
 *  the bank in the low 6 bits, the generator above), from its animation
 *  joint tree; a looping animation starts them again each time round.
 *  `late`: a track's start frame as the game's interpreter takes it
 *  (HSD_FObjReqAnim sets the track's clock to it and HSD_FObjInterpretAnim
 *  does nothing while the clock is below 0) - a track that starts at -2 has
 *  its first key two steps after the animation's first, one that starts ahead
 *  has its earlier keys on the first step. Without it, the start added as it
 *  is (an item's or a fighter's own reading) */
export function animPtclKeys(a: Archive, animJoint: number | null, late = false): PtclKey[] {
  const out: PtclKey[] = [];
  if (animJoint === null) return out;
  const d = a.data;
  let joint = 0;
  const walk = (o: number | null) => {
    for (; o !== null; o = ptr(a, o + 0x04)) {
      const j = joint++;
      const aobj = ptr(a, o + 0x08);
      if (aobj !== null) {
        const end = d.getFloat32(aobj + 0x04), loop = (d.getUint32(aobj) & (1 << 29)) !== 0;
        for (let f = ptr(a, aobj + 0x08); f !== null; f = ptr(a, f)) {
          if (d.getUint8(f + 0x0c) !== 0x28) continue;
          const len = d.getUint32(f + 0x04), start = d.getFloat32(f + 0x08), fv = d.getUint8(f + 0x0d);
          const dat = d.getUint32(f + 0x10);
          for (const k of keyEvents(a.u8.subarray(dat, dat + len), fv, late ? -start : start)) {
            out.push({ joint: j, time: late ? Math.max(0, k.time) : k.time, bank: k.value & 0x3f, gen: (k.value >>> 6) & 0xffffff,
                       every: loop && end >= 1 ? Math.round(end) : 0 });
          }
        }
      }
      walk(ptr(a, o));
    }
  };
  try { walk(animJoint); } catch { out.length = 0; }
  out.sort((x, y) => x.time - y.time);
  return out;
}
