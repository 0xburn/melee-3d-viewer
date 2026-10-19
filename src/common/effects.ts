/* the game's common effects, worked out from the replay alone.
 *
 * A replay records each fighter's action state, its frame counter, where it
 * is, its percent and whether an L-cancel worked - not the effects the game
 * drew. Most of those follow from the state changes, so both players (the
 * line art and the 3D one) ask here what was on screen at a frame and draw it
 * their own way:
 *
 *   dust     a ground jump leaving the floor, a dash starting, a run
 *            braking, every landing, and the trail behind a wavedash or
 *            waveland while it slides
 *   spark    a hit landing (the fighter's percent going up)
 *   lcancel  a successful L-cancel: the fighter flashes white for a few
 *            frames (the convention of Training Mode, which the players
 *            know; the game itself shows nothing)
 *   puff     Sheik's and Zelda's vanish and Mewtwo's teleport, where the
 *            fighter goes and where it comes back
 *
 * Everything is looked for in the frames just before the one asked for, so
 * the answer is the same whether the replay played to it or jumped there.
 * Shine and the angel platform are states the fighter is in, not events, so
 * the players read those straight from the state (shineAt, onAngelPlatform).
 *
 * No imports: the tests (tests) read this file
 * directly. The two shapes below are the parts of the parser's PlayerState
 * and ReplayData (types.ts) it reads; those fit them as they are.
 */
export interface PlayerState {
  readonly internalCharacterId: number;
  readonly actionStateId: number;
  readonly actionStateFrameCounter: number;
  readonly xPosition: number;
  readonly yPosition: number;
  readonly facingDirection: number;
  readonly percent: number;
  readonly isDead: boolean;
  readonly isGrounded: boolean;
  readonly lCancelStatus: "successful" | "missed" | undefined;
  /** frames of hitlag left (the reflector's effects stand still in it) */
  readonly hitlagRemaining?: number;
}
export interface ReplayData {
  readonly frames: readonly {
    readonly players: readonly ({ readonly playerIndex: number; readonly state: PlayerState;
                                  readonly nanaState?: PlayerState } | undefined)[];
  }[];
}

export type FxKind = "dust" | "spark" | "lcancel" | "puff";

export interface Fx {
  kind: FxKind;
  /** where it started, in game units */
  x: number;
  y: number;
  /** its speed at the start, units a frame; slowed by FRICTION each frame */
  vx: number;
  vy: number;
  /** frames since it started, and how many it lasts */
  age: number;
  life: number;
  /** its size (a radius, game units) at the start and at the end */
  size0: number;
  size1: number;
  /** 0..1, fixed for this effect: which way a spark turns, which puff frame */
  seed: number;
  player: number;
  nana: boolean;
}

// action states (the game's common ones)
const DASH = 20, RUN_BRAKE = 23, KNEE_BEND = 24, JUMP_F = 25, JUMP_B = 26;
const LANDING = 42, LANDING_SPECIAL = 43, ESCAPE_AIR = 236;
const REBIRTH = 12, REBIRTH_WAIT = 13;
const LANDINGS = new Set([LANDING, LANDING_SPECIAL, 70, 71, 72, 73, 74]);

// how far back to look: the longest effect's life
const LOOK_BACK = 24;
/** the dust slows like the game's (its generators' friction, about 0.88) */
export const FRICTION = 0.88;
const DUST_LIFE = 18, SPARK_LIFE = 10, LCANCEL_LIFE = 5, PUFF_LIFE = 20;
// a wavedash's slide leaves dust while it is still moving this fast, for
// this many frames after it lands, one puff every other frame
const SLIDE_SPEED = 0.35, SLIDE_FRAMES = 16;

// a fighter the game does not draw while it travels: Sheik's Vanish and
// Zelda's Farore's Wind (their travel states) and Mewtwo's Teleport.
// Internal character ids.
const VANISH: Record<number, Set<number>> = {
  7: new Set([356, 359]),   // Sheik
  19: new Set([350, 353]),  // Zelda
  16: new Set([354, 357]),  // Mewtwo
};
export const vanished = (st: PlayerState) => !!VANISH[st.internalCharacterId]?.has(st.actionStateId);

/** where an effect is at its age */
export function fxAt(fx: Fx): { x: number; y: number; size: number; t: number } {
  const t = Math.min(1, fx.age / Math.max(1, fx.life));
  const k = (1 - Math.pow(FRICTION, fx.age)) / (1 - FRICTION);
  return { x: fx.x + fx.vx * k, y: fx.y + fx.vy * k, size: fx.size0 + (fx.size1 - fx.size0) * t, t };
}

// a small fixed number from the frame and the fighter, so each effect looks
// a little different and the same every time it is drawn
const seedOf = (frame: number, player: number, k: number) => {
  const s = Math.sin(frame * 12.9898 + player * 78.233 + k * 37.719) * 43758.5453;
  return s - Math.floor(s);
};

/** Every effect on screen at this frame (an index into data.frames).
 *  height(internal character id): where a fighter's middle is above its
 *  feet, for the hit sparks; 8 when not given. */
export function effectsAt(data: ReplayData, frame: number, height?: (char: number) => number): Fx[] {
  const out: Fx[] = [];
  const frames = data.frames;
  for (let back = 0; back < LOOK_BACK; back++) {
    const t = frame - back;
    const now = frames[t], before = frames[t - 1];
    if (!now || !before) break;
    for (const p of now.players) {
      if (!p) continue;
      const q = before.players[p.playerIndex];
      if (!q) continue;
      spawn(out, p.state, q.state, t, back, p.playerIndex, false, height);
      if (p.nanaState && q.nanaState) spawn(out, p.nanaState, q.nanaState, t, back, p.playerIndex, true, height);
      slide(out, data, p.playerIndex, false, t, back);
      if (p.nanaState) slide(out, data, p.playerIndex, true, t, back);
    }
  }
  return out;
}

function spawn(out: Fx[], s: PlayerState, prev: PlayerState, t: number, age: number, player: number, nana: boolean,
               height?: (char: number) => number) {
  if (s.isDead || prev.isDead) return;
  const a = s.actionStateId, b = prev.actionStateId;
  const face = s.facingDirection || 1;
  const add = (kind: FxKind, x: number, y: number, vx: number, vy: number, life: number, size0: number, size1: number, k = 0) => {
    if (age >= life) return;
    out.push({ kind, x, y, vx, vy, age, life, size0, size1, seed: seedOf(t, player + (nana ? 4 : 0), k), player, nana });
  };
  // a ground jump leaving the floor: dust out to both sides of the feet
  if ((a === JUMP_F || a === JUMP_B) && b === KNEE_BEND) {
    add("dust", prev.xPosition - 1, prev.yPosition + 0.5, -0.55, 0.12, DUST_LIFE, 2.6, 5.2, 1);
    add("dust", prev.xPosition + 1, prev.yPosition + 0.5, 0.55, 0.12, DUST_LIFE, 2.6, 5.2, 2);
  }
  // a dash starting (every turn of a dash dance too): dust kicked up behind
  if (a === DASH && b !== DASH) {
    add("dust", s.xPosition - face * 2.5, s.yPosition + 0.5, -face * 0.7, 0.1, DUST_LIFE, 2.4, 4.8, 3);
    add("dust", s.xPosition - face * 4.5, s.yPosition + 1.5, -face * 0.35, 0.18, DUST_LIFE - 3, 1.8, 3.6, 4);
  }
  // a run braking: a little dust ahead of the feet
  if (a === RUN_BRAKE && b !== RUN_BRAKE) {
    add("dust", s.xPosition + face * 2, s.yPosition + 0.5, face * 0.4, 0.08, DUST_LIFE - 4, 2, 4, 5);
  }
  // any landing: dust out to both sides; a wavedash's or waveland's is
  // bigger, and thrown the way it slides
  if (LANDINGS.has(a) && !LANDINGS.has(b) && s.isGrounded !== false) {
    const wave = a === LANDING_SPECIAL && b === ESCAPE_AIR;
    const dx = s.xPosition - prev.xPosition;
    const big = wave ? 1.35 : 1;
    const lean = wave ? Math.max(-0.5, Math.min(0.5, dx * 0.15)) : 0;
    add("dust", s.xPosition - 1.5, s.yPosition + 0.5, -0.7 + lean, 0.1, DUST_LIFE, 2.6 * big, 5.4 * big, 6);
    add("dust", s.xPosition + 1.5, s.yPosition + 0.5, 0.7 + lean, 0.1, DUST_LIFE, 2.6 * big, 5.4 * big, 7);
  }
  // a hit landing: a spark where the fighter was hit (its middle: a replay
  // does not say which hitbox met which hurtbox)
  const dmg = s.percent - prev.percent;
  if (dmg >= 0.5 && s.actionStateId > REBIRTH_WAIT) {
    const h = height ? height(s.internalCharacterId) : 8;
    add("spark", s.xPosition, s.yPosition + h, 0, 0, SPARK_LIFE, 3 + Math.min(dmg, 25) * 0.3, 6 + Math.min(dmg, 25) * 0.55, 8);
  }
  // a successful L-cancel
  if (s.lCancelStatus === "successful") add("lcancel", s.xPosition, s.yPosition, 0, 0, LCANCEL_LIFE, 0, 0, 9);
  // vanishing and coming back
  if (vanished(s) !== vanished(prev)) {
    const at = vanished(s) ? prev : s;
    for (const [k, dx, dy] of [[10, 0, 7], [11, -4, 4], [12, 4, 4], [13, -3, 10], [14, 3, 10]]) {
      add("puff", at.xPosition + dx * 0.6, at.yPosition + dy, dx * 0.08, 0.05, PUFF_LIFE, 1.8, 5.5, k);
    }
  }
}

// The slide after a wavedash or waveland: LandingFallSpecial entered from an
// air dodge, still moving along the ground. A puff every other frame, where
// the feet were, left behind as the fighter slides on.
function slide(out: Fx[], data: ReplayData, player: number, nana: boolean, t: number, age: number) {
  if (age >= DUST_LIFE) return;
  const st = (i: number) => {
    const p = data.frames[i]?.players[player];
    return p ? (nana ? p.nanaState : p.state) : undefined;
  };
  const s = st(t), prev = st(t - 1);
  if (!s || !prev || s.actionStateId !== LANDING_SPECIAL || s.isDead) return;
  const since = Math.round(s.actionStateFrameCounter);
  if (since < 2 || since > SLIDE_FRAMES || since % 2) return;
  const entry = st(t - since), before = st(t - since - 1);
  if (!entry || !before || entry.actionStateId !== LANDING_SPECIAL || before.actionStateId !== ESCAPE_AIR) return;
  const dx = s.xPosition - prev.xPosition;
  if (Math.abs(dx) < SLIDE_SPEED) return;
  const back = -Math.sign(dx);
  out.push({
    kind: "dust", x: s.xPosition + back * 1.5, y: s.yPosition + 0.4, vx: back * 0.25, vy: 0.1,
    age, life: DUST_LIFE - 4, size0: 1.5 + Math.min(Math.abs(dx), 2.5) * 0.5, size1: 3.5 + Math.min(Math.abs(dx), 2.5),
    seed: seedOf(t, player + (nana ? 4 : 0), 20 + since), player, nana,
  });
}

/** Fox's and Falco's reflector (internal ids 1 and 22), from their down-B
 *  states 360-369: Start, Loop, Hit (a reflect), End and Turn, on the ground
 *  and in the air. The game (ftfoxspeciallw.c) puts one of three effects on
 *  the hip at a time, and ends it at the next change of state that does not
 *  keep it (Fighter_ChangeMotionState without Ft_MF_KeepGfx, or the move's
 *  own ftCommon_8007DB24: efLib_DestroyAll):
 *    - the start flash (1161) as the move starts, for its own 20 frames at
 *      most; it ends as the loop starts
 *    - the hexagon (1160) as the loop starts, until something ends it; kept
 *      through Turn and the ground and air switches, ended by a reflect,
 *      and made again from its start when the loop comes back after one
 *    - the reflect flash (1162) as a reflect starts, for its own 12 frames
 *      at most; it ends as the loop comes back (or a new reflect starts)
 *  End is entered keeping none of them, and anything else (a jump out of
 *  the loop, a hit, a grab, a KO) leaves the reflector states: nothing is
 *  left on. Each effect stands still while its fighter is in hitlag
 *  (efLib_PauseAll/ResumeAll): its age counts the frames it was not held. */
export interface Shine {
  /** frames since the move started (the start flash), or -1 */
  start: number;
  /** frames since the hexagon came up, or -1 */
  loop: number;
  /** frames since the reflect began (its flash), or -1 */
  hit: number;
}

const SHINE_CHARS = new Set([1, 22]);
const inShine = (a: number) => a >= 360 && a <= 369;
const shineKind = (a: number) => (a - 360) % 5; // 0 start 1 loop 2 hit 3 end 4 turn
// the effects' own lives (EfFxData's descriptions: 20.1 and 12.1; the hexagon's 0.1 is "until ended")
export const SHINE_START_LIFE = 20, SHINE_HIT_LIFE = 12;

export function shineAt(data: ReplayData, frame: number, player: number, nana = false): Shine | null {
  const st = (i: number) => {
    const p = data.frames[i]?.players[player];
    return p ? (nana ? p.nanaState : p.state) : undefined;
  };
  const s = st(frame);
  if (!s || !SHINE_CHARS.has(s.internalCharacterId) || !inShine(s.actionStateId) || s.isDead) return null;
  const kind = shineKind(s.actionStateId);
  // End: all three ended as it began
  if (kind === 3) return null;
  // which of the three is up (the loop and the turn share the hexagon), and
  // the frame it was made on: back to where its part of the move began (a
  // new reflect during a reflect starts over, its frame counter going back)
  const part = (k: number) => (k === 4 ? 1 : k);
  const held = (i: number) => (st(i)?.hitlagRemaining ?? 0) > 0;
  let made = frame;
  for (let back = 1; back < 600; back++) {
    const q = st(frame - back), next = st(frame - back + 1)!;
    if (!q || !inShine(q.actionStateId) || part(shineKind(q.actionStateId)) !== part(kind)) break;
    if (kind === 2 && next.actionStateFrameCounter < q.actionStateFrameCounter) break;
    made = frame - back;
  }
  // its age: the frames since, but those it stood still in hitlag (the one
  // hitlag starts on still moves it on: efLib_Update's EF_STATE_ENTERING_PAUSE)
  let age = 0;
  for (let i = made + 1; i <= frame; i++) if (!(held(i - 1) && held(i))) age++;
  if (kind === 0) return age < SHINE_START_LIFE ? { start: age, loop: -1, hit: -1 } : null;
  if (kind === 2) return age < SHINE_HIT_LIFE ? { start: -1, loop: -1, hit: age } : null;
  return { start: -1, loop: age, hit: -1 };
}

/** on the angel platform: brought back after losing a stock, until they
 *  move off it or its time runs out (Rebirth, then RebirthWait) */
export const onAngelPlatform = (s: PlayerState) =>
  !s.isDead && (s.actionStateId === REBIRTH || s.actionStateId === REBIRTH_WAIT);

/** Yoshi's Story's Shy Guys: items of type 0xD2 */
export const SHY_GUY = 0xd2;

/** How white a fighter flashes for an L-cancel at this frame: 1 on the
 *  landing frame, fading over the next few; 0 when not. */
export function lcancelFlash(data: ReplayData, frame: number, player: number, nana = false): number {
  for (let back = 0; back < LCANCEL_LIFE; back++) {
    const p = data.frames[frame - back]?.players[player];
    const s = p ? (nana ? p.nanaState : p.state) : undefined;
    if (!s) return 0;
    if (s.lCancelStatus === "successful") return 1 - back / LCANCEL_LIFE;
    if (!LANDINGS.has(s.actionStateId)) return 0;
  }
  return 0;
}

/** A ghost's run number: the number its label starts with ("2 run"),
 *  or null (the explorer's one ghost is named, not numbered). */
export function runNumber(label: string | undefined): number | null {
  const m = /^\s*(\d{1,2})(?!\d)/.exec(label ?? "");
  return m ? Number(m[1]) : null;
}
