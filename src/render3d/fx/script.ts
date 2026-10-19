/* 3D replay viewer: a fighter's move scripts, as a timeline.
 *
 * Every subaction in PlXx.dat has a small script the game runs frame by
 * frame alongside its animation: timers, loops, subroutines, and commands
 * that spawn effects and hitboxes (ftaction.c / lbcommand.c in the Melee
 * decompilation describe the commands; the scripts themselves are read from
 * your file). Run ahead once here, it becomes a list of what happens
 * on which frame of the move - so the viewer can put the game's own dust,
 * sparks and hitboxes where and when the game did.
 */
import { Archive } from "../hsd";

export interface GfxEvent {
  kind: "gfx";
  frame: number;
  gfx: number;
  /** a joint index, or (common) one of the fighter's named parts */
  bone: number;
  common: boolean;
  destroyOnChange: boolean;
  offset: [number, number, number];
  range: [number, number, number];
}

export interface HitEvent {
  kind: "hit";
  frame: number;
  id: number;
  bone: number;
  common: boolean;
  damage: number;
  size: number;
  offset: [number, number, number];
  element: number;
  ignoreScale: boolean;
}

export type ScriptEvent =
  | GfxEvent
  | HitEvent
  | { kind: "hitEnd"; frame: number; id: number }
  | { kind: "hitEndAll"; frame: number }
  | { kind: "hitDamage"; frame: number; id: number; damage: number }
  | { kind: "hitSize"; frame: number; id: number; size: number }
  | { kind: "landFx"; frame: number; gfx: number }
  /** a footstep: its sound, and the floor's material's effect if it has one, at a foot (alt: the other) */
  | { kind: "stepFx"; frame: number; alt: boolean }
  /** the flag a move's own code waits for (Falcon Punch's fire comes out on it) */
  | { kind: "flag"; frame: number }
  /** a color animation (fx/colanim.ts), for at most `frames` (0: its own length) */
  | { kind: "colanim"; frame: number; anim: number; frames: number }
  /** the whole body made intangible (2), invincible (1) or hittable again (0) */
  | { kind: "bodyState"; frame: number; state: number }
  /** a smash attack may charge from here, with this color animation while it does */
  | { kind: "smashCharge"; frame: number; anim: number }
  /** the sword's trail on (0) or off (-1) from here (fx/swordtrail.ts); `item`: the held item's sword */
  | { kind: "swordTrail"; frame: number; value: number; item: boolean }
  /** a face texture (the costume's texture list: eyes, mouth) set to a frame of its animation (render3d/face.ts) */
  | { kind: "tex"; frame: number; slot: number; slot2: number | null; texFrame: number }
  /** a model part (hands, a mouth, eyelids) posed by one of its part animations, over `blend` frames (face.ts) */
  | { kind: "partAnim"; frame: number; slot: number; anim: number; blend: number }
  /** a model part switched to one of its variants (-1: hidden) from here (ftAction_80071D40: ftParts_80074B0C) */
  | { kind: "modelPart"; frame: number; part: number; variant: number }
  /** one of the move's four variables (fp->cmd_vars) set, for its code to read (ftAction_80071820) */
  | { kind: "cmdVar"; frame: number; index: number; value: number };

/** an event of a script that loops back to a point after it: run once, as
 *  the move begins, not again each time its animation starts over (Mewtwo's
 *  charging light: started before the loop's label, running on its own) */
export type Once = { once?: boolean };

// words each command takes (generic 0-9, then the fighter commands from 10)
const GENERIC = [1, 1, 1, 1, 1, 2, 1, 2, 1, 1];
const FIGHTER = [5, 5, 1, 1, 1, 1, 1, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1, 1, 1, 7, 4, 1, 1, 1, 1, 1,
                 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 3, 2, 1, 4];
const s16 = (v: number) => (v << 16) >> 16;

/** A move whose animation loops by itself (its subaction's flag
 *  0x40000000, Fighter_ChangeMotionState: x594_b1_loop, the AObjs set to
 *  loop) is not begun again as its animation starts over: its script runs
 *  on by its own timer (ftAction_80073240). `length` its animation's frames,
 *  `horizon` how far on to run it. */
export interface ScriptClock { length: number; horizon: number }

/** The events of one script, with the frame of the move each happens on.
 *  With a clock, by the game's command timer: a wait of frames counts on,
 *  a wait until a frame is one of the animation's (as it loops), a wait
 *  for the animation's end waits for it to start over, and a goto back into
 *  what has run goes round again, up to the horizon. */
export function runScript(a: Archive, start: number, clock?: ScriptClock): ScriptEvent[] {
  const d = a.data, reloc = a.reloc;
  const out: ScriptEvent[] = [];
  let p: number | null = start;
  let frame = 0;
  // (with a clock: the command timer, Infinity waiting for the animation to
  // start over; the commands go on at the first frame it is not above 0)
  let timer = 0, lastRound = -1;
  const animFrame = (f: number) => (clock && clock.length > 0 ? f % clock.length : f);
  const settle = () => {
    if (timer === Infinity) {
      const L = clock!.length;
      if (L > 0) frame = (Math.floor(frame / L) + 1) * L;
      timer = -animFrame(frame);
    } else if (timer > 0) {
      const k = Math.ceil(timer);
      frame += k;
      timer -= k;
    }
  };
  // where the script being run began (a goto moves it), and how many gotos
  let base = start, jumps = 0;
  const stack: { kind: "loop" | "sub"; at: number; count: number; base?: number }[] = [];
  // (the events made before each command first ran: a loop back to a command
  // leaves the ones before it run once)
  const seen = new Map<number, number>();
  for (let steps = 0; p !== null && steps < (clock ? 20000 : 4000); steps++) {
    if (p + 4 > d.byteLength) break;
    if (clock && frame > clock.horizon) break;
    if (!seen.has(p)) seen.set(p, out.length);
    const w: number = d.getUint32(p);
    const op = w >>> 26;
    const size = op < 10 ? GENERIC[op] : FIGHTER[op - 10] ?? 1;
    const next: number = p + size * 4;
    switch (op) {
      case 0: // end
        p = null;
        continue;
      case 1: // wait this many frames
        if (clock) { timer += w & 0x3ffffff; settle(); } else frame += w & 0x3ffffff;
        break;
      case 2: // wait until this frame
        if (clock) { timer = (w & 0x3ffffff) - animFrame(frame); settle(); } else frame = Math.max(frame, w & 0x3ffffff);
        break;
      case 3: // loop start: the body runs this many times
        stack.push({ kind: "loop", at: next, count: w & 0x3ffffff });
        break;
      case 4: { // loop end
        const top = stack[stack.length - 1];
        if (top?.kind === "loop" && --top.count > 0) { p = top.at; continue; }
        if (top?.kind === "loop") stack.pop();
        break;
      }
      case 5: { // subroutine
        const target: number | null = reloc.has(p + 4) ? d.getUint32(p + 4) : null;
        if (target !== null && stack.length < 16) { stack.push({ kind: "sub", at: next, count: 0, base }); base = p = target; continue; }
        break;
      }
      case 6: { // return
        const top = stack.pop();
        if (top?.kind === "sub") { p = top.at; base = top.base ?? base; continue; }
        p = null;
        continue;
      }
      case 7: { // goto
        // back into what has run: a looping move starts its script over with
        // its animation, whose frame count the replay gives; the timeline
        // ends here. Anywhere else it goes on there: an air version's script
        // is its ground version's (Fox's and Falco's air reflector, most air
        // specials: a goto to the other's start)
        const target: number | null = reloc.has(p + 4) ? d.getUint32(p + 4) : null;
        if (target !== null && (target < base || target > p) && jumps < 8) { jumps++; base = target; p = target; continue; }
        // (with a clock: round again, while time goes on)
        if (clock && target !== null && seen.has(target)) {
          if (frame === lastRound) { p = null; continue; }
          lastRound = frame;
          p = target;
          continue;
        }
        const first = target === null ? undefined : seen.get(target);
        if (first !== undefined) for (let i = 0; i < first; i++) (out[i] as Once).once = true;
        p = null;
        continue;
      }
      case 8: // wait for the animation to start over
        if (clock) { timer = Infinity; settle(); }
        break;
      case 10: { // spawn an effect
        const w1 = d.getUint32(p + 4), w2 = d.getUint32(p + 8), w3 = d.getUint32(p + 12), w4 = d.getUint32(p + 16);
        out.push({
          kind: "gfx", frame, gfx: w1 >>> 16,
          bone: (w >>> 18) & 0xff, common: ((w >>> 17) & 1) === 1, destroyOnChange: ((w >>> 16) & 1) === 1,
          offset: [s16(w2 >>> 16) / 256, s16(w2) / 256, s16(w3 >>> 16) / 256],
          range: [(w3 & 0xffff) / 256, (w4 >>> 16) / 256, (w4 & 0xffff) / 256],
        });
        break;
      }
      case 11: { // create a hitbox
        const w1 = d.getUint32(p + 4), w2 = d.getUint32(p + 8), w3 = d.getUint32(p + 12), w4 = d.getUint32(p + 16);
        out.push({
          kind: "hit", frame, id: (w >>> 23) & 7, bone: (w >>> 11) & 0xff, common: ((w >>> 10) & 1) === 1,
          damage: w & 0x3ff, size: (w1 >>> 16) / 256,
          offset: [s16(w1) / 256, s16(w2 >>> 16) / 256, s16(w2) / 256],
          element: (w4 >>> 18) & 0x1f,
          ignoreScale: ((w3 >>> 2) & 1) === 1,
        });
        break;
      }
      case 12: out.push({ kind: "hitDamage", frame, id: (w >>> 23) & 7, damage: w & 0x7fffff }); break;
      case 13: out.push({ kind: "hitSize", frame, id: (w >>> 23) & 7, size: (w & 0x7fffff) / 256 }); break;
      case 15: out.push({ kind: "hitEnd", frame, id: w & 0x3ffffff }); break;
      case 16: out.push({ kind: "hitEndAll", frame }); break;
      case 21: out.push({ kind: "flag", frame }); break;
      case 26: out.push({ kind: "bodyState", frame, state: w & 0x3ffffff }); break;
      case 46: out.push({ kind: "colanim", frame, anim: (w >>> 18) & 0xff, frames: w & 0x3ffff }); break;
      case 56: out.push({ kind: "smashCharge", frame, anim: d.getUint32(p + 4) >>> 24 }); break;
      case 40: { // a face texture to a frame of its animation, and maybe a second (ftAction_800726F4)
        const s7 = (v: number) => ((v & 0x7f) << 25) >> 25;
        out.push({ kind: "tex", frame, slot: s7(w >>> 18), slot2: (w >>> 25) & 1 ? s7(w >>> 11) : null, texFrame: ((w & 0x7ff) << 21) >> 21 });
        break;
      }
      case 41: { // a model part's pose, blended in over some frames (ftAction_800727C8)
        const s7 = (v: number) => ((v & 0x7f) << 25) >> 25;
        out.push({ kind: "partAnim", frame, slot: s7(w >>> 19), anim: s7(w >>> 12), blend: w & 0xfff });
        break;
      }
      case 31: out.push({ kind: "modelPart", frame, part: (w << 6) >> 25, variant: (w << 13) >> 13 }); break;
      case 19: out.push({ kind: "cmdVar", frame, index: (w >>> 24) & 3, value: w & 0xffffff }); break;
      case 55: out.push({ kind: "landFx", frame, gfx: w & 0xffff }); break;
      case 54: out.push({ kind: "stepFx", frame, alt: ((w >>> 25) & 1) === 1 }); break;
      case 49: out.push({ kind: "swordTrail", frame, value: (w << 7) >> 7, item: ((w >>> 25) & 1) === 1 }); break;
    }
    p = next;
  }
  return out;
}

// words each item command takes, of the ones known (itanimlist.c: from 10 an
// effect, a hitbox); the rest are taken as one
const ITEM: Record<number, number> = { 10: 5, 11: 6 };

/** The element of the first hitbox an item's state script makes (its
 *  command 11, it_802790C0: the element where a move's hitbox has it), or
 *  null when it makes none: what a projectile's hit is, fire or electric. */
export function itemHitElement(a: Archive, start: number): number | null {
  const d = a.data;
  let p = start;
  for (let steps = 0; steps < 64 && p + 4 <= d.byteLength; steps++) {
    const w = d.getUint32(p), op = w >>> 26;
    if (op === 0 || op === 6 || op === 7) return null;
    if (op === 11) return p + 20 <= d.byteLength ? (d.getUint32(p + 16) >>> 18) & 0x1f : null;
    p += 4 * (op < 10 ? GENERIC[op] : ITEM[op] ?? 1);
  }
  return null;
}

/** a hitbox live at a frame of the move */
export interface LiveHit { id: number; bone: number; common: boolean; damage: number; size: number;
                           offset: [number, number, number]; element: number; ignoreScale: boolean }

/** the hitboxes live at frame `frame` of a move (its events, in order) */
export function hitsAt(events: ScriptEvent[], frame: number): LiveHit[] {
  const live = new Map<number, LiveHit>();
  for (const e of events) {
    if (e.frame > frame) break;
    if (e.kind === "hit") live.set(e.id, { ...e });
    else if (e.kind === "hitEnd") live.delete(e.id);
    else if (e.kind === "hitEndAll") live.clear();
    else if (e.kind === "hitDamage") { const h = live.get(e.id); if (h) h.damage = e.damage; }
    else if (e.kind === "hitSize") { const h = live.get(e.id); if (h) h.size = e.size; }
  }
  return [...live.values()];
}
