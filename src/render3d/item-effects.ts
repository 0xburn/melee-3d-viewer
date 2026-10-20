/** Lucky Stats: visible native item transitions. Disappearance alone is not
 * an impact: absorption, owner cleanup and offscreen removal also delete items. */
export interface ItemEffectState { typeId: number; state?: number }
export function itemTransitionEffects(previous: ItemEffectState | undefined, current: ItemEffectState): number[] {
  if (previous?.typeId === current.typeId && previous.state === current.state) return [];
  const { typeId: type, state } = current;
  if (type === 0x5d && state === 3) return [0x40c];
  if (type === 0x5f && (state === 2 || state === 3)) return [state === 2 ? 0x40c : 0x40e];
  if ((type === 0x3a || type === 0x3b) && state === 5) return [0x40e];
  if (type === 0x56 && state === 2) return [0x4ce, 0x4cf];
  if ((type === 0x70 || type === 0x90) && state !== undefined && state >= 10 && state <= 17) return [0x40e];
  return [];
}

/** Ice Shot callbacks: charge sparkle, launch trail and ground spray.
 * Airborne state 3 destroys the attached generators; landing restarts spray. */
export function iceTransitionEffects(previous: ItemEffectState | undefined, current: ItemEffectState) {
  if (current.typeId !== 0x6a && current.typeId !== 0x85) return null;
  if (previous?.typeId === current.typeId && previous.state === current.state) return null;
  const copy = current.typeId === 0x85;
  if (current.state === 3) return { stop: true, effects: [] as number[] };
  if (current.state === 2) return { stop: false, effects: [
    ...(previous?.state === 3 ? [] : [copy ? 0x4af : 0x4ea]), copy ? 0x4b0 : 0x4eb,
  ] };
  if (!previous) return { stop: false, effects: [copy ? 0x4ae : 0x4e9] };
  return null;
}
