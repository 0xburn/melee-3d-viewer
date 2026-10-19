/* 3D replay viewer: the effects drawn outside the effect world -
 * the shield's bubble and Fox's and Falco's reflector - placed from a
 * viewer track's pieces ("fxp", track.ts) when it has them.
 *
 * Their models are drawn by the player's own code (Viewer3D drawShield,
 * drawReflector): the bubble's size follows the shield's health and how
 * hard it is held, its color the port's, which the replay says. Which model
 * is up and from when is the game's to say: each spawn the track has makes
 * one (efasync.c 0x417-0x41A, efalt.c 0x488-0x48A), and a fighter's
 * effects all end together when its code ends them (the track's "fxend":
 * efLib_DestroyAll). Without pieces the player works both out from the
 * replay's states, as before (common/effects.ts shineAt, SHIELD_MODELS).
 */
import type { TrackEvent, ViewerTrack } from "../track";
import { SHINE_HIT_LIFE, SHINE_START_LIFE } from "../../common/effects";

/** the shield's bubbles: the spawn and the common model it makes */
export const SHIELD_FX: Record<number, number> = { 0x417: 0x0b, 0x418: 0x0c, 0x419: 0x0d, 0x41a: 0x0e };
/** the reflector's: the hexagon (EfFxData model 0, until ended), the flash as
 *  it comes out (1, 20 frames) and the flash of a reflect (2, 12 frames) */
export const REFLECTOR_FX = { loop: 0x488, start: 0x489, hit: 0x48a } as const;

const keyOf = (owner: number) => `${owner >> 1}:${owner & 1}`;

/** a binary search: the last index whose frame is at or before `frame`, or -1 */
function lastAt(list: number[], frame: number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] <= frame) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export class TrackShapes {
  /** by fighter ("port:nana"): its shield spawns' frames and models */
  private shields = new Map<string, { at: number[]; model: number[] }>();
  /** by fighter and kind: the frames the reflector's models were made on */
  private shines = new Map<string, Record<"loop" | "start" | "hit", number[]>>();
  /** by fighter: the frames all its effects ended on */
  private ends = new Map<string, number[]>();
  /** whether the track has pieces at all (else the replay's way is used) */
  readonly has: boolean;

  constructor(tr: ViewerTrack) {
    const pieces = tr.between("fxp", -1e9, 1e9);
    this.has = pieces.length > 0;
    for (const e of pieces) {
      // (a spawn's first piece: one a spawn)
      if (e[3] !== "f" || Number(e[5]) !== 0) continue;
      const gfx = Number(e[2]), key = keyOf(Number(e[4])), frame = e[0];
      if (SHIELD_FX[gfx] !== undefined) {
        let s = this.shields.get(key);
        if (!s) this.shields.set(key, (s = { at: [], model: [] }));
        s.at.push(frame);
        s.model.push(SHIELD_FX[gfx]);
        continue;
      }
      const kind = gfx === REFLECTOR_FX.loop ? "loop" : gfx === REFLECTOR_FX.start ? "start" : gfx === REFLECTOR_FX.hit ? "hit" : null;
      if (!kind) continue;
      let r = this.shines.get(key);
      if (!r) this.shines.set(key, (r = { loop: [], start: [], hit: [] }));
      r[kind].push(frame);
    }
    for (const e of tr.between("fxend", -1e9, 1e9) as TrackEvent[]) {
      if (e[2] !== "f") continue;
      const key = keyOf(Number(e[3]));
      let l = this.ends.get(key);
      if (!l) this.ends.set(key, (l = []));
      l.push(e[0]);
    }
  }

  /** the shield's bubble up for a fighter on a game frame: its model and how
   *  many frames it has run, or null when no spawn made one yet */
  shieldAt(key: string, frame: number): { m: number; age: number } | null {
    const s = this.shields.get(key);
    if (!s) return null;
    const i = lastAt(s.at, frame);
    return i < 0 ? null : { m: s.model[i], age: frame - s.at[i] };
  }

  /** the reflector's models up for a fighter on a game frame, each by how
   *  long it has run (-1: not up), or null when none is: each from the last
   *  spawn of it, gone at the fighter's next end of all its effects (one on
   *  the frame it is made ends the ones before it, not it) or when its life
   *  is run - the frames the fighter stands in hitlag not counted, as the
   *  game pauses its effects then (`held`: whether it is held on a frame) */
  shineAt(key: string, frame: number, held: (frame: number) => boolean): { start: number; loop: number; hit: number } | null {
    const r = this.shines.get(key);
    if (!r) return null;
    const ends = this.ends.get(key) ?? [];
    const age = (list: number[], life: number) => {
      const i = lastAt(list, frame);
      if (i < 0) return -1;
      const made = list[i];
      const end = ends[lastAt(ends, frame)];
      if (end !== undefined && end > made) return -1;
      let n = 0;
      for (let g = made + 1; g <= frame; g++) if (!(held(g - 1) && held(g))) n++;
      return n < life ? n : -1;
    };
    const out = { start: age(r.start, SHINE_START_LIFE), loop: age(r.loop, Infinity), hit: age(r.hit, SHINE_HIT_LIFE) };
    return out.start < 0 && out.loop < 0 && out.hit < 0 ? null : out;
  }

  /** the spawns of these models on a game frame, by fighter (the parity harness's) */
  startsAt(frame: number): [number, string][] {
    const out: [number, string][] = [];
    for (const [key, s] of this.shields) {
      const i = lastAt(s.at, frame);
      for (let k = i; k >= 0 && s.at[k] === frame; k--) out.push([0x417 + s.model[k] - 0x0b, key]);
    }
    for (const [key, r] of this.shines) {
      for (const kind of ["loop", "start", "hit"] as const) {
        const list = r[kind];
        const i = lastAt(list, frame);
        for (let k = i; k >= 0 && list[k] === frame; k--) out.push([REFLECTOR_FX[kind], key]);
      }
    }
    return out;
  }
}

const filesOf = new WeakMap<ViewerTrack, Set<number>>();
/** the effect files a track's pieces name (an id's thousands: 30 the stage's own) */
export function trackFilesOf(tr: ViewerTrack): Set<number> {
  let s = filesOf.get(tr);
  if (!s) {
    s = new Set<number>();
    for (const e of tr.between("fxp", -1e9, 1e9)) s.add(Math.floor(Number(e[7]) / 1000));
    filesOf.set(tr, s);
  }
  return s;
}

const made = new WeakMap<ViewerTrack, TrackShapes>();
/** a track's shapes, made once */
export function trackShapes(tr: ViewerTrack): TrackShapes {
  let s = made.get(tr);
  if (!s) made.set(tr, (s = new TrackShapes(tr)));
  return s;
}
