/* 3D replay viewer: Final Destination's background.
 *
 * Behind the stage the game runs five backgrounds in a fixed order, half a
 * minute each, with animated changes between them (grLast.c's phases: the
 * code steps through them, grLast_8021B5C4 deciding when the next one is
 * due and grLast_8021B920 starting it). The background is five parts (4 to
 * 8), each looping one animation set on its joint 2 and all under it, while
 * each phase plays a set once on its joint 1 - that moves them in and out.
 * One phase brings in a sixth part (9) in their place, with the sky fading
 * from color to color at random; the color behind everything fades at
 * four changes; one change sends a burst of particles out from part 7, which
 * sways as it comes (grLast_8021ADD0).
 *
 * The viewer track has each phase as the game ran it ("fd": the phase, the
 * color it fades to and in how many frames) and the color behind
 * everything ("bgcolor"). Without one the phases follow the game's own
 * timing, worked out from the file (how long each animation and color
 * script runs); only the random colors are not the game's.
 *
 * Slippi's online play freezes the background (its "Frozen All" codes put a
 * nop over the call that steps the phases): such a replay stays on the first
 * background all match. The replay says whether it did (its gecko codes).
 */
import { ptr } from "../hsd";
import { Overlay } from "../fx/colanim";
import { Rng } from "../fx/particles";
import type { Emitter } from "./particles";
import { groundOverlay, Part, Run, Stage, StageLogic } from "../stage";
import type { ViewerTrack } from "../track";

/** the five parts, and the set each loops on its joint 2 (grNLa_803E8010) */
const LV: [number, number][] = [[4, 0], [5, 4], [6, 6], [7, 8], [8, 10]];
/** the part that stands in their place in phases 14 to 16 */
const SIXTH = 9;
/** the set each phase starts on joint 1 of the five */
const PHASE_SET: Record<number, number> = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 11: 9, 12: 10 };
/** frames a timed phase lasts: the code counts past 1800 */
const WAIT = 1802;

/** a phase: the game frame it began, and which */
export interface Phase { at: number; phase: number }
/** a fade of the color behind everything: from the frame it began, to a color, over so many frames */
interface Fade { at: number; to: [number, number, number]; frames: number }

export interface Schedule { phases: Phase[]; fades: Fade[] }

/** the frames a stage color script runs before it ends (grLib_801C96E8) */
function scriptLength(st: Stage, script: number): number {
  const o = new Overlay();
  o.startAt(script);
  for (let n = 1; n < 2000; n++) {
    if (o.step({ a: st.file }, null) || !o.running) return n;
  }
  return 2000;
}

/** yakumono_param's four scripts: the five fading out, the sixth in, the sixth out, the five in */
function scripts(st: Stage): (number | null)[] {
  const y = st.file.publics.get("yakumono_param");
  return [0, 4, 8, 12].map((o) => (y === undefined ? null : ptr(st.file, y + o)));
}

/** the phases and fades as the game times them, from the frame the match
 *  starts to `last`; the random colors from a seeded stand-in */
export function fixedSchedule(st: Stage, last: number): Schedule {
  const end = (part: number, set: number, joint: number) => {
    const p = st.partOf(part);
    return (p && st.animSet(p, set)?.[joint]?.end) || 0;
  };
  const allDone = (set: number) => Math.max(...LV.map(([part]) => end(part, set, 1)));
  const [s0, s4, s8, s12] = scripts(st).map((s) => (s === null ? 1 : scriptLength(st, s)));
  // part 7's joint 2 loops its set; two phases wait on where it is
  const period = end(7, 8, 2) || 160;
  const phases: Phase[] = [{ at: -123, phase: 1 }];
  const fades: Fade[] = [];
  const rng = new Rng(0xfd);
  // the timer starts as the match does (the stage's OnStart callback, frame -40)
  let S = -123, phase = 1, timerFrom = -40, made = -123;
  const t7 = (g: number) => g - made;
  let cur: [number, number, number] = [0, 0, 0];
  while (S < last) {
    let next: number;
    switch (phase) {
      case 1: next = timerFrom + WAIT; break;
      case 3: next = S + 1; break;
      case 5: case 7: case 12: case 15: next = S + WAIT; break;
      case 9: {
        let g = S + WAIT;
        while (((t7(g) % period) + period) % period !== 100 && g < S + WAIT + period) g++;
        next = g;
        break;
      }
      case 10: {
        let g = S + 1;
        while (((t7(g) % period) + period) % period !== 0 && g < S + 1 + period) g++;
        next = g;
        break;
      }
      case 13: next = S + Math.max(120, s0 - 1); break;
      case 14: next = S + Math.max(1, s4 - 1); break;
      case 16: next = S + Math.max(60, s8 - 1); break;
      case 17: next = S + Math.max(1, s12 - 1); break;
      default: next = S + 1 + allDone(PHASE_SET[phase]); break; // 2, 4, 6, 8, 11
    }
    if (phase === 15) {
      // the sky's random colors: a new one each time a fade ends
      let p = S + 1;
      while (p < next) {
        let c: [number, number, number];
        do c = [rng.next() < 0.5 ? 0 : 30, rng.next() < 0.5 ? 0 : 30, rng.next() < 0.5 ? 0 : 30];
        while ((c[0] === 30 && c[1] === 30 && c[2] === 30) || (c[0] === cur[0] && c[1] === cur[1]));
        const d = 60 + Math.floor(rng.next() * 60);
        fades.push({ at: p - 1, to: c, frames: d });
        cur = c;
        p += d;
      }
    }
    S = next;
    phase = phase === 17 ? 1 : phase + 1;
    phases.push({ at: S, phase });
    if (phase === 1) timerFrom = S;
    if (phase === 17) made = S + 1;
    const fadeTo: Record<number, [[number, number, number], number]> = {
      10: [[0xaa, 0xca, 0xff], 120], 13: [[0xc8, 0xc8, 0xc8], 120], 14: [[0, 0, 0], 60], 16: [[0, 0, 0], 60],
    };
    if (fadeTo[phase]) { fades.push({ at: S, to: fadeTo[phase][0], frames: fadeTo[phase][1] }); cur = fadeTo[phase][0]; }
  }
  return { phases, fades };
}

/** the phases as the viewer track has them */
export function trackSchedule(tr: ViewerTrack): Schedule {
  const phases: Phase[] = [];
  const fades: Fade[] = [];
  let last = -1, lastTarget = "";
  for (const [f, phase, r, g, b, frames] of tr.changes("fd", "")) {
    const at = Number(f), ph = Number(phase);
    if (ph !== last) { phases.push({ at, phase: ph }); last = ph; }
    const target = `${r},${g},${b}`, n = Number(frames);
    if (n > 0 && target !== lastTarget) {
      fades.push({ at: at - 1, to: [Number(r), Number(g), Number(b)], frames: n + 1 });
    }
    lastTarget = target;
  }
  if (!phases.length) phases.push({ at: -123, phase: 1 });
  return { phases, fades };
}

/** Part 7's sway (grLast_8021ADD0): its root turns about x and y on a
 *  random walk, within 15 and 10 degrees, that the code runs all the time
 *  but shows only as its weight rises through phase 9 (over 3 seconds) and
 *  falls in phase 10 (grLast_8021B2E8). The walk's random numbers are a
 *  seeded stand-in. Per frame from -123 (the replay's index): x, y. */
function swayOf(sched: Schedule, last: number): Float32Array {
  const deg = Math.PI / 180, lo = deg / 1000, span = deg / 250, cap = deg / 20, X = 15 * deg, Y = 10 * deg;
  const out = new Float32Array((last + 124) * 2);
  const rng = new Rng(0x7a7);
  const kick = () => (span * rng.next() + lo) * (rng.next() < 0.5 ? 1 : -1);
  let ax = 0, ay = 0, vx = 0, vy = 0, px = kick(), py = kick(), weight = 0, k = 0;
  const ph = sched.phases;
  for (let g = -123; g <= last; g++) {
    while (k + 1 < ph.length && ph[k + 1].at <= g) {
      k++;
      // (made anew with the five at 17)
      if (ph[k].phase === 17) { ax = ay = vx = vy = weight = 0; px = kick(); py = kick(); }
    }
    const phase = ph[k].phase;
    if (phase === 9) weight = Math.min(1, weight + 1 / 180);
    else if (phase === 10) weight = Math.max(0, weight - 1 / 58);
    vx = Math.max(-cap, Math.min(cap, (vx + px) * 0.99));
    vy = Math.max(-cap, Math.min(cap, (vy + py) * 0.99));
    ax += vx;
    if (ax > X) { ax = X; vx = -Math.abs(vx); px = -(span * rng.next() + lo); }
    else if (ax < -X) { ax = -X; vx = Math.abs(vx); px = span * rng.next() + lo; }
    ay += vy;
    if (ay > Y) { ay = Y; vy = -Math.abs(vy); py = -(span * rng.next() + lo); }
    else if (ay < -Y) { ay = -Y; vy = Math.abs(vy); py = span * rng.next() + lo; }
    out[(g + 123) * 2] = ax * weight;
    out[(g + 123) * 2 + 1] = ay * weight;
  }
  return out;
}

/** part 7's turn as the viewer track has it ("fdrot", on each change: x, y) */
function swayFromTrack(tr: ViewerTrack, last: number): Float32Array {
  const out = new Float32Array((last + 124) * 2);
  const ch = tr.changes("fdrot", "");
  let k = -1;
  for (let g = -123; g <= last; g++) {
    while (k + 1 < ch.length && Number(ch[k + 1][0]) <= g) k++;
    if (k < 0) continue;
    out[(g + 123) * 2] = Number(ch[k][1]);
    out[(g + 123) * 2 + 1] = Number(ch[k][2]);
  }
  return out;
}

export class FinalDestination implements StageLogic {
  /** the color behind everything by frame, when the track has it */
  private bg: [number, number][] | null = null;
  private scripts: (number | null)[];
  /** the burst of particles from part 7 as phase 9 begins, to the next phase */
  readonly emitters: Emitter[] = [];

  /** part 7's sway (its root's turn about x and y), by game frame from -123 */
  private sway: Float32Array;

  constructor(st: Stage, private sched: Schedule, tr: ViewerTrack | null, last: number) {
    this.scripts = scripts(st);
    this.sway = tr?.has("fdrot") ? swayFromTrack(tr, last) : swayOf(sched, last);
    if (tr?.has("bgcolor")) this.bg = tr.changes("bgcolor", "").map(([f, v]) => [Number(f), Number(v) >>> 0]);
    // the burst (grLib_801C96F8(0x7531) at part 7's joint 5), ended at phase 10
    const p7 = st.partOf(7);
    const ph = sched.phases;
    for (let i = 0; i < ph.length; i++) {
      if (ph[i].phase !== 9 || !p7) continue;
      const S = ph[i].at, E = ph[i + 1]?.at ?? null;
      const w = this.jointAt(st, p7, 5, S + 123);
      this.emitters.push({ gen: 30001, from: S + 123, to: E === null ? null : E + 123,
                           srt: { tx: w[0], ty: w[1], tz: w[2], rx: 0, ry: 0, rz: 0, sx: st.scale, sy: st.scale, sz: st.scale, follow: false } });
    }
  }

  /** where a joint of a part is at a frame (the replay's index) */
  private jointAt(st: Stage, p: Part, j: number, frame: number): [number, number, number] {
    st.poseAt(p, frame);
    return p.skeleton.position(j);
  }

  /** the phase entries in force at game frame g: the index of the current one */
  private at(g: number): number {
    const ph = this.sched.phases;
    let lo = 0, hi = ph.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ph[mid].at <= g) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  apply(st: Stage, frame: number) {
    const g = frame - 123;
    const ph = this.sched.phases;
    const i = this.at(g);
    const phase = ph[i].phase;
    const idx = (gameFrame: number) => gameFrame + 123;
    // back to the phase that last made the five (the match's start, or a 17)
    let made = 0;
    for (let k = i; k >= 0; k--) if (ph[k].phase === 17 || k === 0) { made = k; break; }
    const madeAt = made === 0 ? -123 : ph[made].at + 1;
    // the sets joint 1 of the five has played since they were made, in
    // order: what a set does not animate (whether the joint is hidden, its
    // turn) stays as the one before left it
    const sets: [number, number][] = [[0, madeAt]];
    for (let k = made + 1; k <= i; k++) {
      // (a phase 1 after the first leaves the five as 17 made them)
      const s = ph[k].phase === 1 ? undefined : PHASE_SET[ph[k].phase];
      if (s !== undefined) sets.push([s, ph[k].at + 1]);
    }
    const sixth = phase >= 14 && phase <= 16;
    for (const [part] of LV) st.up.delete(part);
    st.up.delete(SIXTH);
    if (sixth) {
      let k = i;
      while (k > 0 && ph[k].phase !== 14) k--;
      st.up.add(SIXTH);
      st.runs.set(SIXTH, [{ anim: 0, joint: 0, deep: true, from: idx(ph[k].at + 1), rate: 1 }]);
      // its color scripts: in at 14, out at 16
      const out = phase === 16;
      let s = i;
      while (s > 0 && ph[s].phase !== (out ? 16 : 14)) s--;
      this.tint(st, SIXTH, this.scripts[out ? 2 : 1], g - ph[s].at);
    } else {
      for (const [part, loopSet] of LV) {
        st.up.add(part);
        const runs: Run[] = [{ anim: loopSet, joint: 2, deep: true, from: idx(madeAt), rate: 1 }];
        const p = st.partOf(part);
        sets.forEach(([set, from], n) => {
          const last = n === sets.length - 1;
          const end = p ? st.animSet(p, set)?.[1]?.end ?? 0 : 0;
          runs.push({ anim: set, joint: 1, deep: false, once: true, from: idx(from), rate: 1, ...(last ? {} : { hold: end }) });
        });
        if (part === 4) {
          // joint 16 (the twinkling stars' generator) starts at each phase 1 and stops at the 2 after
          let k = i;
          while (k > 0 && ph[k].phase !== 1) k--;
          const from = k === 0 ? -123 : ph[k].at + 1;
          const stop = ph.slice(k + 1, i + 1).find((q) => q.phase === 2);
          runs.push({ anim: 0, joint: 16, deep: false, from: idx(from), rate: 1,
                      ...(stop ? { hold: stop.at - from } : {}) });
        }
        st.runs.set(part, runs);
        // the five fade out at 13, in again at 17
        if (phase === 13) this.tint(st, part, this.scripts[0], g - ph[i].at);
        else if (made > 0) this.tint(st, part, this.scripts[3], g - ph[made].at);
      }
    }
    st.background = this.background(g);
  }

  pose(st: Stage, frame: number) {
    const i = (frame) * 2;
    if (i < 0 || i + 1 >= this.sway.length || (this.sway[i] === 0 && this.sway[i + 1] === 0)) return;
    const p = st.partOf(7);
    if (!p || !st.up.has(7)) return;
    p.skeleton.rot[0] = this.sway[i];
    p.skeleton.rot[1] = this.sway[i + 1];
  }

  private tint(st: Stage, part: number, script: number | null, t: number) {
    const p = st.partOf(part);
    if (!p || script === null || t < 0) return;
    const c = groundOverlay(st.file, script, t);
    if (c) st.tints.set(p.skeleton, c);
  }

  /** the color behind everything at game frame g */
  private background(g: number): [number, number, number] {
    if (this.bg) {
      let v = 0xff;
      for (const [f, c] of this.bg) { if (f > g) break; v = c; }
      return [(v >>> 24) / 255, ((v >>> 16) & 0xff) / 255, ((v >>> 8) & 0xff) / 255];
    }
    // each fade goes from wherever the one before had got to when it began
    let c: [number, number, number] = [0, 0, 0];
    const fades = this.sched.fades;
    for (let i = 0; i < fades.length && fades[i].at <= g; i++) {
      const f = fades[i], until = Math.min(g, fades[i + 1]?.at ?? g);
      const k = Math.min(1, (until - f.at) / f.frames);
      c = [0, 1, 2].map((q) => c[q] + (f.to[q] - c[q]) * k) as [number, number, number];
    }
    return [Math.trunc(c[0]) / 255, Math.trunc(c[1]) / 255, Math.trunc(c[2]) / 255];
  }
}
