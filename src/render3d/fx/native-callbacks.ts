/* 3D replay viewer: the effects a fighter's own code starts, besides its move scripts.
 *
 * Most of a move's effects are in its script (fx/script.ts), but some are made
 * by the move's code: a callback run as the move begins, or when the script
 * sets one of the move's command variables. Loading the effect's description
 * does not start it; the callback does. These are the ones the replay shows
 * the trigger of (the action state, and the script's command variables at the
 * state's frame counter). Only without a viewer track: with one, every effect
 * start is the track's (fx/world.ts).
 */
import type { ScriptEvent } from "./script";

/** an effect a callback starts: on which frame of the move (its script's clock), which, and on which part */
export interface NativeEffectEvent {
  frame: number;
  gfx: number;
  /** the fighter part it goes on: an index into fp->parts, which is not the scripts' common bone number */
  part: number;
  /** `part` is a common bone number after all (the callback looks it up: ftParts_GetBoneIndex) */
  commonPart?: boolean;
}

interface Callback {
  characters: number[];
  states: number[];
  gfx: (state: number) => number;
  part: number;
  commonPart?: boolean;
  /** "entry": as the move begins; else on the first frame its script sets the command variable `index`
   *  (to `value`, or with no value given to anything but 0) */
  when: "entry" | { index: number; value?: number };
}

const DK = 3, KIRBY = 4, POPO = 10, NANA = 11, MEWTWO = 16, FOX = 1, FALCO = 22;

const CALLBACKS: Callback[] = [
  // Giant Punch's swing, Donkey Kong's and Kirby's copy (ftdonkeyspecialn.c, ftkirbyspecialdonkey.c): the first
  // frame its command variable 0 is set
  { characters: [DK], states: [372, 373, 377, 378], gfx: (s) => s < 374 ? 0x4c8 : 0x4c9, part: 0, when: { index: 0 } },
  { characters: [KIRBY], states: [458, 459, 463, 464], gfx: (s) => s < 460 ? 0x4a9 : 0x4aa, part: 0, when: { index: 0 } },
  // Final Cutter: one set of effects through all its states (each one listed, so a seek into a later one
  // still makes them: fx/world.ts cutterHistory)
  { characters: [KIRBY], states: [385, 386, 387, 388, 389, 390, 391, 392], gfx: () => 0x494, part: 0, when: "entry" },
  // Spinning Kong: made by both the ground and the air version's entry (ftdonkeyspecialhi.c)
  { characters: [DK], states: [381, 382], gfx: () => 0x4ca, part: 0, when: "entry" },
  // Hand Slap: as it enters its loop (ftdonkeyspeciallw.c)
  { characters: [DK], states: [384], gfx: () => 0x4cc, part: 0, when: "entry" },
  // Blizzard, Popo's and Nana's: on the left ring finger when the script sets command variable 0 to 1
  // (ftpopospeciallw.c fn_80122D2C)
  { characters: [POPO, NANA], states: [357, 358], gfx: () => 0x4ec, part: 29, when: { index: 0, value: 1 } },
  // Teleport's start, once (ftmewtwospecialhi.c)
  { characters: [MEWTWO], states: [353, 356], gfx: () => 0x4e8, part: 5, when: "entry" },
  // Fire Fox's and Fire Bird's charge and launch, on common bones (ftFx_SpecialHi_CreateChargeGFX,
  // ftFx_SpecialHi_CreateLaunchGFX)
  { characters: [FOX, FALCO], states: [353, 354], gfx: () => 0x48b, part: 1, commonPart: true, when: "entry" },
  { characters: [FOX, FALCO], states: [355, 356], gfx: () => 0x48c, part: 4, commonPart: true, when: "entry" },
];

const applies = (c: Callback, character: number, state: number) => c.characters.includes(character) && c.states.includes(state);

/** the effects the callbacks start in a fighter's state, by its move script (for the command variables) */
export function nativeEffectEvents(character: number, state: number, script: readonly ScriptEvent[]): NativeEffectEvent[] {
  const out: NativeEffectEvent[] = [];
  for (const c of CALLBACKS) {
    if (!applies(c, character, state)) continue;
    let frame = 0;
    if (c.when !== "entry") {
      const { index, value } = c.when;
      const set = script.find((e) => e.kind === "cmdVar" && e.index === index && (value === undefined ? e.value !== 0 : e.value === value));
      if (!set) continue;
      frame = set.frame;
    }
    const event: NativeEffectEvent = { frame, gfx: c.gfx(state), part: c.part };
    if (c.commonPart) event.commonPart = true;
    out.push(event);
  }
  return out;
}

/** every effect a callback may start in a fighter's state: the learned table (fx/world.ts learnedEvents)
 *  leaves these to the callbacks, so they are not started twice */
export function nativeEffectIds(character: number, state: number): number[] {
  return CALLBACKS.filter((c) => applies(c, character, state)).map((c) => c.gfx(state));
}

/** The states whose callback effects carry on from one to the next: a move's ground and air versions as it
 *  lands or leaves the floor, and Final Cutter's parts. Going to any other state (an interruption too) ends
 *  them, and the next entry starts them again. */
const FAMILIES: Record<number, number[][]> = {
  [FOX]: [[353, 354], [355, 356]],
  [FALCO]: [[353, 354], [355, 356]],
  [DK]: [[372, 377], [373, 378], [381, 382], [384]],
  [KIRBY]: [[458, 463], [459, 464], [385, 386, 387, 388, 389, 390, 391, 392]],
  [POPO]: [[357, 358]],
  [NANA]: [[357, 358]],
  [MEWTWO]: [[353, 356]],
};

/** which family a fighter's state is in ("character:index"), or null for none */
export function nativeEffectFamily(character: number, state: number): string | null {
  const index = FAMILIES[character]?.findIndex((g) => g.includes(state)) ?? -1;
  return index < 0 ? null : `${character}:${index}`;
}

/** Which of a family's callback effects have been started: each once, however often its animation starts
 *  over and across its ground and air versions (the move's code takes the command variable's trigger once). */
export class NativeCallbackClock {
  private family: string | null = null;
  private fired = new Set<number>();

  /** the fighter's state on this frame; true when it is a new family (its effects start afresh) */
  enter(character: number, state: number): boolean {
    const family = nativeEffectFamily(character, state);
    if (family === this.family) return false;
    this.family = family;
    this.fired.clear();
    return true;
  }

  /** the events due by the move's frame `now` that have not been started yet */
  take(events: readonly NativeEffectEvent[], now: number): NativeEffectEvent[] {
    return events.filter((e, index) => {
      if (e.frame > now || this.fired.has(index)) return false;
      this.fired.add(index);
      return true;
    });
  }
}

/** The script's effects on the last step of an animation that the move's code leaves in that same step: the
 *  replay shows the next state already, and its counter does not cover them. Teleport's start goes to its
 *  travel this way (ftMt_SpecialHiStart_Anim, ftMt_SpecialAirHiStart_Anim), and its frame-8 flash must be made
 *  before the start's model goes; any animation that ran to its end (`animationEnded`) the same way. */
export function outgoingNativeScriptEvents(character: number, from: number, to: number, counter: number, rate: number,
                                           script: readonly ScriptEvent[], animationEnded = false): ScriptEvent[] {
  const teleport = character === MEWTWO && ((from === 353 && to === 354) || (from === 356 && to === 357));
  if (!animationEnded && !teleport) return [];
  return script.filter((e) => e.kind === "gfx" && e.frame > counter && e.frame <= counter + rate);
}

/** The frame of Final Cutter's effect animation at `age` frames (efLib_Cb_SetRotYAndTransition): frames 0 to
 *  63, then 60 to 64 over and over until the move lets go (`releasedAt`), then on from frame 65 (its last 11). */
export function cutterAnimationFrame(age: number, releasedAt?: number): number {
  if (releasedAt !== undefined && age >= releasedAt) return 65 + age - releasedAt;
  return age < 64 ? age : 60 + (age - 64) % 5;
}
