/* 3D replay viewer: a stage's own particles.
 *
 * A stage file has a particle bank of its own (map_ptcl, map_texg: bank 30
 * to the game). Its animations start generators from it, as keys on a
 * joint's track 0x28 (efLib_Cb_DPtcl -> grLib_801C99C0): Battlefield's
 * stars streaming past, Final Destination's twinkling ones, Fountain of
 * Dreams' spray, Whispy's leaves. Those are made where the joint is, turned
 * as it is (hsd_8039EFAC). The stage's code makes others itself, at a place
 * of its own (grLib_801C96F8): those come from the stage's logic (gr/*.ts)
 * as emitters. They run on the effects' particle system (fx/particles.ts).
 *
 * The particles at a frame depend on everything since the match started;
 * after a jump they are run again from far enough back that what shows is
 * what the game showed (WARM frames), and a generator made before that and
 * still going is made at that point, the time it has used taken off.
 */
import { EffectBank } from "../fx/bank";
import { AppSRT, Generator, ParticleSystem } from "../fx/particles";
import { STADIUM_NORMAL, type Part, type Run, type Stage } from "../stage";

/** a generator the stage's code makes at a place of its own */
export interface Emitter {
  gen: number;
  /** the frames (the replay's index) it is made and ended (ended: its
   *  particles run out; null: it runs on) */
  from: number;
  to: number | null;
  /** where: its transform (grLib_801C96F8's psAppSRT: the place, and the stage's scale) */
  srt: AppSRT;
  /** made on a joint of a part instead (grLib_801C97DC: where it is then, turned as it is) */
  joint?: { part: number; joint: number };
  /** with `joint`: made on the joint and going with it (grLib_801C9808), and
   *  which joint that is to the stage's code's ends (stage object * 65536 +
   *  the joint) */
  on?: number;
  /** ended at `to` with its particles at once (hsd_8039D4DC's second way) */
  now?: boolean;
  /** it runs until the stage's code ends it, however long (a form's own: the player's limit for a generator
   *  with no life of its own is not the game's) */
  untilEnded?: boolean;
  /** from the common effects' bank (EfCoData) rather than the stage's own */
  bank?: "common";
}

/** the stage's code ending the generators on `count` joints of a stage
 *  object from `from` on (stage object * 65536 + joint), on frame `at` (the
 *  replay's index), `now`: their particles at once (grLib_801C9908) */
export interface Ender { at: number; from: number; count: number; now: boolean }

/** how far back the particles are run after a jump: longer than any stage particle lives */
const WARM = 330;
/** frames stepped one by one before a jump counts as one */
const STEP = 8;

export class StageParticles {
  readonly ps = new ParticleSystem();
  readonly bank: EffectBank | null;
  frame = -1;
  /** the stage's code's emitters, as its logic lists them */
  emitters: Emitter[] = [];
  /** the stage's code's ends by joint, as its logic lists them */
  enders: Ender[] = [];
  /** the frame being stepped (a generator going with a joint is placed for it) */
  private stepping = -1;
  /** the parts posed for the frame being stepped, by part */
  private posedFor = new Map<Part, number>();
  /** the common effects' bank, for the emitters that use it (set when the effects are read) */
  common: EffectBank | null = null;
  private live = new Map<Emitter, Generator>();

  constructor(private st: Stage) {
    let bank: EffectBank | null = null;
    try { bank = new EffectBank(st.file, "map_ptcl", 1000 + st.stageId); } catch { /* no particles */ }
    this.bank = bank;
  }

  get particles() { return this.ps.particles; }

  /** start over (a new logic: another track) */
  reset() { this.frame = -1; }

  /** step to this frame (the replay's index). The stage is left posed for
   *  some other frame: pose the one drawn after. */
  step(frame: number) {
    if (!this.bank || frame === this.frame) return;
    this.posedFor.clear();
    const gap = frame - this.frame;
    if (this.frame >= 0 && gap > 0 && gap <= STEP) {
      for (let g = this.frame + 1; g <= frame; g++) this.one(g);
    } else {
      this.ps.clear();
      this.live.clear();
      this.ps.rng.seed(0x5eed + frame);
      const start = Math.max(0, frame - WARM);
      this.catchUp(start);
      for (let g = start; g <= frame; g++) this.one(g);
    }
    this.frame = frame;
  }

  /** the generators made before `start` that still run then: made now, with the time they used gone */
  private catchUp(start: number) {
    const bank = this.bank!;
    this.stepping = start;
    // (what is up then: a generator going with a form's joint is made only on a form that is)
    this.st.logic?.apply(this.st, start);
    for (const e of this.emitters) {
      // (the ones placed once from a joint are short puffs: those from before are gone; one going with its
      // joint runs on)
      if (e.from >= start || (e.to !== null && e.to <= start) || (e.joint && e.on === undefined)) continue;
      const g = this.make(e, start);
      // (one that runs until the stage's code ends it is made afresh: a short-lived one of those - the fire
      // form's flames - is what makes the long-running ones its particles leave)
      if (g && g.genLife > 0 && !e.untilEnded) {
        const used = start - e.from;
        if (used >= g.genLife) this.ps.kill(g);
        else g.genLife -= used;
      }
    }
    // the animations' generators: every key fired within the longest
    // generator's life before `start`
    let longest = 0;
    for (const c of bank.cmds) if (c && c.genLife > longest) longest = c.genLife;
    longest = Math.min(longest, 4000);
    // (the stage's logic asked every so often, not every frame: what it
    // says changes seldom, and a key a frame or two off makes no difference
    // to a generator only half-way through its life by then)
    const from = Math.max(0, start - longest);
    for (let g = from; g < start; g++) {
      this.fire(g, (gen) => {
        const c = bank.cmds[gen], used = start - g;
        return c && c.genLife > 0 && used < c.genLife ? used : null;
      }, (g - from) % 30 === 0);
    }
  }

  private one(g: number) {
    this.stepping = g;
    this.fire(g, () => 0);
    for (const x of this.enders) if (x.at === g) this.ps.endStage(x.from, x.count, x.now);
    for (const e of this.emitters) {
      if (e.to === g) {
        const gen = this.live.get(e);
        // (one on a joint is ended by the stage's code's end of its joints: Ender)
        if (gen && e.on === undefined) { if (e.now) this.ps.end(gen, true); else this.ps.kill(gen); }
        this.live.delete(e);
      }
      if (e.from === g) this.make(e, g);
    }
    this.ps.step();
  }

  /** whether a part is drawn on the frame the stage's logic was last asked about (a Stadium form's while it is up) */
  private isUp(p: Part): boolean {
    return this.st.isForm(p) ? !!this.st.formUpOf(p) : this.st.up.has(p.index);
  }

  /** a part's joint's world matrix on the frame being stepped (the part posed for it once) */
  private jointNow(p: Part, joint: number): Float32Array | null {
    if (this.posedFor.get(p) !== this.stepping) { this.st.poseAt(p, this.stepping); this.posedFor.set(p, this.stepping); }
    const W = p.skeleton.world;
    return (joint + 1) * 16 > W.length ? null : W.slice(joint * 16, joint * 16 + 16);
  }

  private make(e: Emitter, frame: number): Generator | null {
    const bank = e.bank === "common" ? this.common : this.bank;
    if (!bank) return null;
    if (e.joint) {
      const p = this.st.partOf(e.joint.part);
      if (!p || !this.isUp(p)) return null;
      this.st.poseAt(p, frame);
      this.posedFor.set(p, frame);
      const g = this.fromJoint(p, e.joint.joint, e.gen, 0, bank);
      if (g && e.untilEnded) g.maxAge = Infinity;
      if (g && e.on !== undefined) {
        const j = e.joint.joint;
        g.follow = () => this.jointNow(p, j);
        // (its emission turned as the joint is each frame, as hsd_8039EFAC's is)
        g.rot = null;
        g.stageAt = e.on;
        this.live.set(e, g);
      }
      return g;
    }
    const g = this.ps.generator(bank, e.gen);
    if (!g) return null;
    g.srt = { ...e.srt };
    if (e.untilEnded) g.maxAge = Infinity;
    this.live.set(e, g);
    return g;
  }

  /** the generators the stage's animations start on frame `g`, each made
   *  where its joint is then, having used `use(gen)` frames of its life
   *  (null: not made) */
  private fire(g: number, use: (gen: number) => number | null, ask = true) {
    const st = this.st;
    if (ask) st.logic?.apply(st, g);
    // (the parts up, and Pokemon Stadium's forms up, each on what it plays: a form from the frame it was made)
    const parts = st.parts.filter((p) => st.up.has(p.index));
    for (const f of st.formsUp) if (f.form !== STADIUM_NORMAL) parts.push(...st.formParts(f.form));
    for (const p of parts) {
      const runs = st.runsOf(p) ?? defaultRuns(p);
      let posed = false;
      for (const r of runs) {
        if (r.hold !== undefined) continue;
        const keys = st.keysOf(p, r.anim);
        for (const k of keys) {
          if (!inRun(p, r, k.joint) || !fires(st, p, r, k.joint, k.time, g)) continue;
          const used = use(k.gen);
          if (used === null) continue;
          if (!posed) { st.poseAt(p, g); posed = true; this.posedFor.set(p, g); }
          const gen = this.fromJoint(p, k.joint, k.gen, used);
          // (a Stadium form's: on its joint and going with it, its emission turned as the joint is, as
          // hsd_8039EFAC's is - the fountains' joints move. The other stages' are placed once, as before)
          if (gen && st.isForm(p)) { const j = k.joint; gen.follow = () => this.jointNow(p, j); gen.rot = null; }
        }
      }
    }
    // (and the copies the code makes of a part: Fountain's water columns)
    for (const [e, runs] of [...st.extraRuns]) {
      let posed = false;
      for (const r of runs) {
        for (const k of st.keysOf(e, r.anim)) {
          if (!inRun(e, r, k.joint) || !fires(st, e, r, k.joint, k.time, g)) continue;
          const used = use(k.gen);
          if (used === null) continue;
          if (!posed) { st.poseExtra(e, g); posed = true; }
          this.fromJoint(e, k.joint, k.gen, used);
        }
      }
    }
  }

  private fromJoint(p: Part, joint: number, gen: number, used: number, bank = this.bank!): Generator | null {
    const W = p.skeleton.world;
    if ((joint + 1) * 16 > W.length) return null;
    const gn = this.ps.generator(bank, gen);
    if (!gn) return null;
    const o = joint * 16;
    gn.px = W[o + 12]; gn.py = W[o + 13]; gn.pz = W[o + 14];
    gn.type |= gn.kind & 0x20000 ? 0x500 : 0x700;
    const axis = (c: number) => {
      const x = W[o + c * 4], y = W[o + c * 4 + 1], z = W[o + c * 4 + 2], n = Math.hypot(x, y, z) || 1;
      return [x / n, y / n, z / n];
    };
    const [a, b, c] = [axis(0), axis(1), axis(2)];
    gn.rot = [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
    if (used > 0 && gn.genLife > 0) gn.genLife -= used;
    return gn;
  }
}

/** a part the code leaves alone plays its first set from the start, looping (Stage.update) */
const defaults = new WeakMap<Part, Run[]>();
function defaultRuns(p: Part): Run[] {
  let r = defaults.get(p);
  if (!r) defaults.set(p, (r = [{ anim: 0, joint: 0, deep: true, from: -1, rate: 1, loop: true }]));
  return r;
}

function inRun(p: Part, r: Run, j: number): boolean {
  if (j === r.joint) return true;
  if (!r.deep) return false;
  for (let q = p.joints[j]?.parent ?? -1; q >= 0; q = p.joints[q].parent) if (q === r.joint) return true;
  return false;
}

/** whether a key at `time` in the run's animation fires on frame g: its
 *  clock passes it on that frame's step (the first step, at time 0, fires
 *  what is at 0 or before), and again each time a looping one comes round */
export function fires(st: Stage, p: Part, r: Run, joint: number, time: number, g: number): boolean {
  if (g < r.from) return false;
  const t1 = (g - r.from) * r.rate;
  if (g === r.from) return time <= t1;
  const t0 = t1 - r.rate;
  const set = st.animSet(p, r.anim);
  const ao = set?.[joint] ?? set?.find((x) => x) ?? null;
  const end = ao?.end ?? 0;
  const loop = !r.once && (r.loop || st.loops(p, r.anim) || !!ao?.loop);
  if (!loop || end <= 0) return t0 < time && time <= t1;
  // the first time it comes round after t0
  const k = time + Math.max(0, Math.floor((t0 - time) / end) + 1) * end;
  return k <= t1;
}
