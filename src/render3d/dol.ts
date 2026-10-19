/* 3D replay viewer: what the player reads from the game's executable.
 *
 * Two things the player needs live in the executable (Start.dol / main.dol)
 * rather than in the disc's .dat files:
 *
 *  - the action table: which animation each action state plays, the anim_id
 *    column of the game's motion-state tables (the common one, then each
 *    fighter's own);
 *  - the text font Pokemon Stadium's big screen writes with (HSD_SisLib):
 *    its tables, glyphs, the players' colors and the characters' names, in
 *    the layout sistext.ts's parseSisCommon reads ("SIS1" + ...).
 *
 * Both are read from your own copy of the game at runtime, by the addresses
 * below (Melee NTSC 1.02, GALE01 revision 2). Nothing from the executable is
 * bundled or kept.
 */
import type { MotionTable } from "./fighter";

/** each motion-state table's address and state count: the common table, then each fighter's */
const DOL_TABLES: Record<string, [number, number]> = {
  common: [0x803c2800, 341],
  ftCa: [0x803c72b8, 23], ftCl: [0x803d0fa0, 21], ftDk: [0x803cb838, 46], ftDr: [0x803d1498, 10],
  ftFc: [0x803d1848, 35], ftFe: [0x803d2e80, 32], ftFx: [0x803c7788, 35], ftGn: [0x803d29f8, 23],
  ftGw: [0x803d23e8, 40], ftKb: [0x803c8368, 203], ftKp: [0x803cedc0, 23], ftLg: [0x803d0628, 18],
  ftLk: [0x803c7e18, 21], ftMr: [0x803c7120, 10], ftMs: [0x803cf420, 32], ftMt: [0x803d0b00, 20],
  ftNn: [0x803cd838, 26], ftNs: [0x803cc650, 36], ftPc: [0x803d1ea8, 26], ftPe: [0x803cccb8, 30],
  ftPk: [0x803cdd78, 26], ftPp: [0x803cd2d0, 26], ftPr: [0x803cfef0, 32], ftSk: [0x803cc060, 24],
  ftSs: [0x803ce2d0, 18], ftYs: [0x803ce6d0, 28], ftZd: [0x803cfa58, 18],
};
/** anim_id, flags, move id, then five callbacks */
const MOTION_STATE_SIZE = 0x20;

/** the text font's four tables: the Shift-JIS pairs, each one's code, each glyph's trims, the glyphs */
const TEXT_FONT: [number, number][] = [
  [0x8040c8c0, 0x240], [0x8040c680, 0x240], [0x8040cb00, 0x240], [0x8040cd40, 0x23e00],
];
/** the US character names, Shift-JIS: 32 pointers */
const CHARACTER_NAMES: [number, number] = [0x803d4fdc, 32];
/** the players' colors, nine RGBA */
const PLAYER_COLORS: [number, number] = [0x803b7864, 0x24];

interface Section { off: number; addr: number; size: number }

function sections(dol: Uint8Array): Section[] {
  if (dol.length < 0x100) throw new Error("no executable to read");
  const v = new DataView(dol.buffer, dol.byteOffset, dol.byteLength);
  const out: Section[] = [];
  for (let i = 0; i < 18; i++) {
    const size = v.getUint32(144 + 4 * i);
    if (size) out.push({ off: v.getUint32(4 * i), addr: v.getUint32(72 + 4 * i), size });
  }
  return out;
}

function reader(dol: Uint8Array) {
  const secs = sections(dol);
  return (va: number, n: number): Uint8Array => {
    for (const s of secs) {
      if (s.addr <= va && va + n <= s.addr + s.size) {
        const at = s.off + va - s.addr;
        if (at + n <= dol.length) return dol.subarray(at, at + n);
      }
    }
    throw new Error(`not Melee 1.02 (NTSC): nothing at 0x${va.toString(16).toUpperCase()}`);
  };
}

/** the action table out of the executable; an Error when it is not NTSC 1.02's */
export function motionTableFromDol(buf: ArrayBuffer): MotionTable {
  const dol = new Uint8Array(buf);
  const read = reader(dol);
  const column = ([va, count]: [number, number]) => {
    const b = read(va, count * MOTION_STATE_SIZE);
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return Array.from({ length: count }, (_, i) => v.getInt32(i * MOTION_STATE_SIZE));
  };
  const common = column(DOL_TABLES.common);
  // the first two states (dead, and the entry) play no animation: -1 in the
  // NTSC 1.02 executable; anything else there is another version of the game
  if (common[0] !== -1 || common[1] !== -1) throw new Error("not Melee 1.02 (NTSC): its tables are elsewhere");
  const chars: Record<string, (number | null)[]> = {};
  for (const k of Object.keys(DOL_TABLES).sort()) if (k !== "common") chars[k] = column(DOL_TABLES[k]);
  return { common, chars };
}

/** the text font out of the executable, as parseSisCommon takes it; an Error when it is not NTSC 1.02's */
export function textFontFromDol(buf: ArrayBuffer): ArrayBuffer {
  const dol = new Uint8Array(buf);
  const read = reader(dol);
  const tables = TEXT_FONT.map(([va, n]) => read(va, n));
  // (the first pair is the full-width space, coded 0x20E3, in the 1.02 executable)
  if (tables[0][0] !== 0x81 || tables[0][1] !== 0x40 || tables[1][0] !== 0x20 || tables[1][1] !== 0xe3) {
    throw new Error("not Melee 1.02 (NTSC): its text tables are elsewhere");
  }
  const names: number[] = [];
  const [va, count] = CHARACTER_NAMES;
  for (let k = 0; k < count; k++) {
    const pb = read(va + 4 * k, 4);
    const p = new DataView(pb.buffer, pb.byteOffset, 4).getUint32(0);
    let s: Uint8Array = p ? read(p, 64) : new Uint8Array(0);
    const end = s.indexOf(0);
    s = end >= 0 ? s.subarray(0, end) : new Uint8Array(0);
    names.push(s.length, ...s);
  }
  const parts = [new TextEncoder().encode("SIS1"), ...tables, read(...PLAYER_COLORS), Uint8Array.from(names)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out.buffer;
}
