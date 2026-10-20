/* 3D replay viewer: the effects items' own code starts as they change state.
 *
 * A projectile that hits or bursts runs a callback as it enters its impact
 * state, and that callback makes the burst (once, on entry: not on each frame
 * the item lingers there). An item going away is not an impact by itself: it
 * also goes when it is absorbed, when its owner's move ends or when it leaves
 * the screen. The Ice Climbers' Ice Shot keeps effects of its own going while
 * it flies and slides. Only without a viewer track: with one, every effect
 * start is the track's (fx/world.ts).
 */

/** what these rules read of an item on a frame */
export interface ItemEffectState { typeId: number; state?: number }

/** the bursts each kind of item makes as it enters one of these states */
const IMPACTS: { types: number[]; states: number[]; effects: (state: number) => number[] }[] = [
  // Samus's bomb, going off (itsamusbomb.c)
  { types: [0x5d], states: [3], effects: () => [0x40c] },
  // Samus's missile, hitting and bursting (itsamusmissile.c)
  { types: [0x5f], states: [2, 3], effects: (s) => [s === 2 ? 0x40c : 0x40e] },
  // Link's and Young Link's bombs, going off (itlinkbomb.c)
  { types: [0x3a, 0x3b], states: [5], effects: () => [0x40e] },
  // Yoshi's egg, breaking: its puff and the shell's pieces (ityoshieggthrow.c)
  { types: [0x56], states: [2], effects: () => [0x4ce, 0x4cf] },
  // Shadow Ball, Mewtwo's and Kirby's copy, at the end of its flight at each charge (itmewtwoshadowball.c)
  { types: [0x70, 0x90], states: [10, 11, 12, 13, 14, 15, 16, 17], effects: () => [0x40e] },
];

/** the bursts an item makes on this frame: the ones of the state it has just entered */
export function itemTransitionEffects(previous: ItemEffectState | undefined, current: ItemEffectState): number[] {
  if (previous?.typeId === current.typeId && previous.state === current.state) return [];
  const { typeId, state } = current;
  if (state === undefined) return [];
  const impact = IMPACTS.find((i) => i.types.includes(typeId) && i.states.includes(state));
  return impact ? impact.effects(state) : [];
}

/** Ice Shot's effects, the Ice Climbers' (0x6a) and Kirby's copy (0x85): a sparkle as it is made, a trail
 *  and a spray along the floor as it slides (state 2); in the air (state 3) the effects on it end, and
 *  landing again starts the spray alone (itclimbersice.c) */
const ICE: Record<number, { made: number; trail: number; spray: number }> = {
  0x6a: { made: 0x4e9, trail: 0x4ea, spray: 0x4eb },
  0x85: { made: 0x4ae, trail: 0x4af, spray: 0x4b0 },
};

/** what Ice Shot does on this frame: whether the effects on it end (`stop`) and which it starts; null for
 *  none (not an Ice Shot, or no change) */
export function iceTransitionEffects(previous: ItemEffectState | undefined,
                                     current: ItemEffectState): { stop: boolean; effects: number[] } | null {
  const ice = ICE[current.typeId];
  if (!ice) return null;
  if (previous?.typeId === current.typeId && previous.state === current.state) return null;
  if (current.state === 3) return { stop: true, effects: [] };
  if (current.state === 2) {
    const landed = previous?.state === 3;
    return { stop: false, effects: landed ? [ice.spray] : [ice.trail, ice.spray] };
  }
  if (!previous) return { stop: false, effects: [ice.made] };
  return null;
}

/** every effect these rules may start for a kind of item: the learned table (fx/world.ts learnedEvents)
 *  leaves these to them, so they are not started twice */
export function itemRuleEffects(typeId: number): number[] {
  const out = IMPACTS.filter((i) => i.types.includes(typeId)).flatMap((i) => i.states.flatMap(i.effects));
  const ice = ICE[typeId];
  if (ice) out.push(ice.made, ice.trail, ice.spray);
  return out;
}
