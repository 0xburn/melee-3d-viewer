/* 3D replay viewer: charges a fighter keeps stored.
 *
 * Donkey Kong's Giant Punch, Samus's Charge Shot, Mewtwo's Shadow Ball and
 * Sheik's needles can be charged, canceled and kept for later; charged to
 * full, the game runs a color animation on the fighter for as long as the
 * charge is kept (DK's steam, Samus's glow: fx/colanim.ts, entries 57, 53,
 * 92 and 86, started by the move's code and again by the fighter's own
 * callback whenever its colors start over). A replay does not say how much
 * is stored, so it is counted here the way the moves' code counts it, from
 * the states the replay gives (ftdonkeyspecialn.c, ftsamusspecialn.c,
 * ftmewtwospecialn.c, ftseakspecialn.c):
 *   - DK: a swing each time the charging loop starts over (its animation's
 *     frame 0), up to the fighter's most (special attributes +0x2C); the
 *     punch lets it go.
 *   - Samus: a level every (+0x20, plus one) frames of holding the charge, up
 *     to +0x18; the shot lets it go.
 *   - Mewtwo: a level every (+0x0C, plus one) frames of the charging loop, up
 *     to +0x00; the throw lets it go.
 *   - Sheik: a needle each time her loop starts over, one to start, up to
 *     six; the throw lets them go. Six is full; her loop's next start
 *     starts the color itself (ftSk_SpecialNLoop_Anim), else it waits for
 *     the next change of state.
 * All of them are lost with a stock. What the replay cannot give: a charge
 * stored before the replay's first frame (none at a game's start), and one
 * Kirby copied; Game & Watch's bucket fills from what it catches, which the
 * replay does not record, so it is not shown. A viewer track (track.ts)
 * has what each of them holds, the simulator's own count: with one, that is
 * used instead, bucket and Kirby included (storedFromTrack).
 */
import type { PlayerState, ReplayData } from "../../common/types";

/** what a fighter's charge needs from its fighter file (its special attributes) */
export interface ChargeAttrs { int: (o: number) => number; float: (o: number) => number }

interface Rule {
  anim: number;
  /** one frame of the fighter in this state (the counter the replay gives,
   *  whether it just entered it, and from which): the charge moves on */
  step(n: Counter, s: PlayerState, entered: boolean, from: number): void;
}
interface Counter { n: number; t: number; full: boolean; started?: boolean }

const DK = 3, SHEIK = 7, SAMUS = 13, MEWTWO = 16;
const WAIT = 14, FALL = 29;
const atStart = (s: PlayerState) => Math.abs(s.actionStateFrameCounter) < 0.01;

function rule(char: number, a: ChargeAttrs): Rule | null {
  switch (char) {
    case DK: {
      // (the loop's own first frame is not counted - the state the replay
      // shows is the one its code has just changed to; and the swing that
      // fills it is not seen in the loop: the game leaves the loop for Wait
      // or Fall on that frame)
      const most = a.int(0x2c);
      return {
        anim: 57,
        step(n, s, entered, from) {
          const st = s.actionStateId;
          if ((st === 370 || st === 375) && atStart(s) && !entered) n.n = Math.min(most, n.n + 1);
          if (entered && (from === 370 || from === 375) && (st === WAIT || st === FALL)) n.n = most;
          if (entered && (st === 372 || st === 373 || st === 377 || st === 378)) n.n = 0;
          n.full = most > 0 && n.n >= most;
        },
      };
    }
    case SAMUS: {
      // (a level every so many frames of holding; the one that fills it ends
      // the hold that frame - into the same state a cancel goes to, so it is
      // told apart by the hold's own clock)
      const most = a.float(0x18), every = a.int(0x20);
      return {
        anim: 53,
        step(n, s, entered, from) {
          const st = s.actionStateId;
          if (entered && st === 343) n.t = 0;
          if (st === 344 && !entered && ++n.t > every) { n.t = 0; n.n = Math.min(most, n.n + 1); }
          if (entered && st === 345 && from === 344 && n.n === most - 1 && n.t === every) n.n = most;
          if (entered && (st === 346 || st === 348)) n.n = 0;
          n.full = most > 0 && n.n >= most;
        },
      };
    }
    case MEWTWO: {
      const most = a.float(0x0), every = a.int(0xc);
      return {
        anim: 92,
        step(n, s, entered) {
          const st = s.actionStateId;
          if (entered && (st === 341 || st === 346)) n.t = 0;
          if ((st === 342 || st === 347) && !entered && ++n.t > every) { n.t = 0; n.n = Math.min(most, n.n + 1); }
          if (st === 343 || st === 348) n.n = most;
          if (entered && (st === 345 || st === 350)) n.n = 0;
          n.full = most > 0 && n.n >= most;
        },
      };
    }
    case SHEIK:
      // (one needle to start; one more each time the loop starts over, up to
      // six: full. The loop's next start past six starts its color itself,
      // as a change of state does with six held; the throw lets them go)
      return {
        anim: 86,
        step(n, s, entered) {
          const st = s.actionStateId;
          if (entered && (st === 341 || st === 345) && n.n === 0) n.n = 1;
          if ((st === 342 || st === 346) && atStart(s) && !entered) {
            if (n.n >= 6) n.started = true;
            else n.n++;
          }
          if (entered && (st === 344 || st === 348)) n.n = 0;
          n.full = n.n >= 6;
        },
      };
  }
  return null;
}

/** A frame's value in the stored charges' arrays: the color animation of a
 *  full stored charge (0: none), and whether the move's own code starts it
 *  on that frame (Sheik's loop starting over with six held), besides the
 *  game's own start of it at every change of state while full
 *  (UnkMotionStates4 in ftCo_800C0134). A charge's color runs from a start
 *  until the next change of state, or until its script ends with the charge
 *  no longer full: one let go in a move keeps it through the move */
export const STARTS = 0x80;
export const storedAnim = (v: number) => v & ~STARTS;
export const storedStarts = (v: number) => (v & STARTS) !== 0;

/** for each fighter (by its key, "port:nana"), the color animation of a
 *  full stored charge on each frame (storedAnim; 0: none) and the frames the
 *  move starts it itself (storedStarts) */
export function storedCharges(data: ReplayData, attrs: (char: number) => ChargeAttrs | null): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const run = (port: number, nana: boolean) => {
    let r: Rule | null = null, char = -1, last = -1;
    const n: Counter = { n: 0, t: 0, full: false };
    let arr: Uint8Array | null = null;
    for (let f = 0; f < data.frames.length; f++) {
      const p = data.frames[f]?.players[port];
      const s = nana ? p?.nanaState : p?.state;
      if (!s) continue;
      if (s.internalCharacterId !== char) {
        char = s.internalCharacterId;
        const a = attrs(char);
        r = a ? rule(char, a) : null;
        n.n = n.t = 0; n.full = false; last = -1;
      }
      if (!r) continue;
      if (s.isDead || s.actionStateId <= 11) { n.n = n.t = 0; n.full = false; last = s.actionStateId; continue; }
      n.started = false;
      r.step(n, s, s.actionStateId !== last, last);
      last = s.actionStateId;
      if (n.full || n.started) {
        arr ??= new Uint8Array(data.frames.length);
        arr[f] = (n.full ? r.anim : 0) | (n.started ? r.anim | STARTS : 0);
      }
    }
    if (arr) out.set(`${port}:${nana ? 1 : 0}`, arr);
  };
  for (let port = 0; port < 4; port++) { run(port, false); run(port, true); }
  return out;
}

/** the track's stored charges, the way storedCharges gives them (null when the
 *  track has none): what each fighter holds (track.ts "charge" events, the
 *  fighter's own field), and the color animation its callback starts at full
 *  (the fighters' UnkMotionStates4 callbacks: ftdonkey.c, ftsamus.c,
 *  ftmewtwo.c, ftseak.c, ftgamewatch.c, and Kirby's for the ones he copies,
 *  against his own attributes) */
const GAME_AND_WATCH = 24, KIRBY = 4;
interface Full { field: string; anim: number; full: (a: ChargeAttrs, v: number) => boolean }
const FULL: Record<number, Full> = {
  [DK]: { field: "dk", anim: 57, full: (a, v) => v === a.int(0x2c) },
  [SAMUS]: { field: "ss", anim: 53, full: (a, v) => v === a.float(0x18) },
  [MEWTWO]: { field: "mt", anim: 92, full: (a, v) => v === a.float(0x0) },
  [SHEIK]: { field: "sk", anim: 86, full: (_, v) => v === 6 },
  [GAME_AND_WATCH]: { field: "gw", anim: 5, full: (_, v) => v >= 3 },
};
const COPIED: Record<number, Full> = {
  [DK]: { field: "kb.dk", anim: 58, full: (a, v) => v === a.int(0x190) },
  [SAMUS]: { field: "kb.ss", anim: 54, full: (a, v) => v === a.float(0x168) },
  [MEWTWO]: { field: "kb.mt", anim: 93, full: (a, v) => v === a.float(0x384) },
  [SHEIK]: { field: "kb.sk", anim: 87, full: (_, v) => v === 6 },
};

export interface ChargeTrack {
  has(type: string): boolean;
  charge(port: number, sub: number, field: string, frame: number): number | undefined;
}

export function storedFromTrack(data: ReplayData, track: ChargeTrack,
                                attrs: (char: number) => ChargeAttrs | null): Map<string, Uint8Array> | null {
  if (!track.has("charge")) return null;
  const out = new Map<string, Uint8Array>();
  for (let port = 0; port < 4; port++) {
    for (const sub of [0, 1]) {
      let arr: Uint8Array | null = null;
      for (let f = 0; f < data.frames.length; f++) {
        const p = data.frames[f]?.players[port];
        const s = sub ? p?.nanaState : p?.state;
        if (!s || s.isDead) continue;
        const char = s.internalCharacterId, a = attrs(char);
        if (!a) continue;
        // (the track numbers frames as the game does, from -123)
        const game = f - 123;
        const rule = char === KIRBY ? COPIED[track.charge(port, sub, "kb.kind", game) ?? -1] : FULL[char];
        if (!rule) continue;
        const v = track.charge(port, sub, rule.field, game);
        if (v === undefined || !rule.full(a, v)) continue;
        arr ??= new Uint8Array(data.frames.length);
        arr[f] = rule.anim;
      }
      if (arr) out.set(`${port}:${sub}`, arr);
    }
  }
  return out;
}
