import type { ScriptEvent } from './script';

/** Native callbacks driven by observable motion entries and command variables.
 * Keep these separate from asset-script gfx events: loading an effect definition
 * does not run the C callback that creates it. Parts are Fighter_Part indices. */
export interface NativeEffectEvent { frame: number; gfx: number; part: number }
export function nativeEffectEvents(character: number, state: number, _grounded: boolean,
                                   script: readonly ScriptEvent[]): NativeEffectEvent[] {
  const out: NativeEffectEvent[] = [];
  const entry = (gfx: number, part = 0) => out.push({frame: 0, gfx, part});
  const command = (index: number, value: number, gfx: number, part = 0) => {
    const event = script.find(e => e.kind === 'cmdVar' && e.index === index && e.value === value);
    if (event) out.push({frame: event.frame, gfx, part});
  };
  // ftdonkeyspecialn.c / ftkirbyspecialdonkey.c: first nonzero cmd_var[0].
  const punch = character === 3 && [372,373,377,378].includes(state);
  const copiedPunch = character === 4 && [458,459,463,464].includes(state);
  if (punch || copiedPunch) {
    const event = script.find(e => e.kind === 'cmdVar' && e.index === 0 && e.value !== 0);
    if (event) out.push({frame: event.frame, gfx: copiedPunch ? (state < 460 ? 0x4a9 : 0x4aa) : (state < 374 ? 0x4c8 : 0x4c9), part: 0});
  }
  // Final Cutter keeps one set of effects through all of its motion phases.
  // Later phases are included so a seek can reconstruct the original effects.
  if (character === 4 && state >= 385 && state <= 392) entry(0x494);
  // ftdonkeyspecialhi.c: both grounded/aerial entry functions create 0x4ca.
  if (character === 3 && (state === 381 || state === 382)) entry(0x4ca);
  // ftdonkeyspeciallw.c doAnim: effect starts as Hand Slap enters its loop.
  if (character === 3 && state === 384) entry(0x4cc);
  // ftpopospeciallw.c fn_80122D2C: both Popo and Nana use left ring finger.
  if ((character === 10 || character === 11) && (state === 357 || state === 358)) command(0, 1, 0x4ec, 29);
  // ftmewtwospecialhi.c accessory callback, once at Teleport startup.
  if (character === 16 && (state === 353 || state === 356)) entry(0x4e8, 5);
  return out;
}

/** Ground/air switches preserve these C callbacks' effect state. Other motion
 * transitions (including interruption) destroy it and permit a new activation. */
const FAMILIES: Record<number, number[][]> = {
  3: [[372,377], [373,378], [381,382], [384]],
  4: [[458,463], [459,464], [385,386,387,388,389,390,391,392]],
  10: [[357,358]], 11: [[357,358]], 16: [[353,356]],
};
export function nativeEffectFamily(character: number, state: number): string | null {
  const index = FAMILIES[character]?.findIndex(g => g.includes(state)) ?? -1;
  return index < 0 ? null : `${character}:${index}`;
}

/** The command variable is consumed by native code. Repeating the animation or
 * switching between the ground/air versions must not consume it a second time. */
export class NativeCallbackClock {
  private family: string | null = null;
  private fired = new Set<number>();
  enter(character: number, state: number): boolean {
    const family = nativeEffectFamily(character, state);
    if (family === this.family) return false;
    this.family = family;
    this.fired.clear();
    return true;
  }
  take(events: readonly NativeEffectEvent[], now: number): NativeEffectEvent[] {
    return events.filter((e, index) => {
      if (e.frame > now || this.fired.has(index)) return false;
      this.fired.add(index);
      return true;
    });
  }
}

/** The final animation step runs before its C callback changes motion. Those
 * script commands are absent from the new post-frame state's counter. */
export function outgoingNativeScriptEvents(character: number, from: number, to: number,
                                           counter: number, rate: number,
                                           script: readonly ScriptEvent[], animationEnded = false): ScriptEvent[] {
  // ftMt_Special{Air,}HiStart_Anim enters Lost on the end step. Its frame-8
  // detached flash must be queued before the startup model is destroyed.
  if (!animationEnded && (character !== 16 || !((from === 353 && to === 354) || (from === 356 && to === 357)))) return [];
  return script.filter(e => e.kind === 'gfx' && e.frame > counter && e.frame <= counter + rate);
}

/** efLib_Cb_SetRotYAndTransition: initial 65-frame lifetime, then five-frame
 * holds beginning at animation 60; release requests frame 65 for 11 frames. */
export function cutterAnimationFrame(age: number, releasedAt?: number): number {
  if (releasedAt !== undefined && age >= releasedAt) return 65 + age - releasedAt;
  return age < 64 ? age : 60 + (age - 64) % 5;
}
