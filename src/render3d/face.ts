/* 3D replay viewer: a fighter's face - its eyes and mouth - and
 * its hands' poses.
 *
 * Two things change them beyond the body's animation (ftanim.c):
 *  - the costume's texture list (ftData+8, +8 and +C: for each costume, the
 *    textures - counted over the model's meshes in order - its code can
 *    turn): each is held on a frame of its costume's texture animation
 *    (the costume file's matanim joint). Marth's eyes open, half shut,
 *    shut, wincing, looking aside; Fox's pupils looking about. A move's
 *    script sets one (command 0x28, ftAction_800726F4); a hit's knockback
 *    sets the fighter's two to frame 3 and its end back to 0 (each
 *    fighter's OnKnockbackEnter/Exit); a change of action state puts every
 *    one back to 0, but for the few states entered without that
 *    (Ft_MF_SkipMatAnim: lying still after a bounce, a broken shield).
 *  - its part animations (ftData+0x1C: up to five, each a set of model
 *    parts - a hand's fingers, a mouth, eyelids - and a list of poses for
 *    them): a move's script poses one (command 0x29), over so many frames,
 *    and the body's animation leaves those parts alone until the action
 *    state changes (ftAnim_80070F28). Fox, Falco, Yoshi and Ganondorf's
 *    knockback poses their slots 3 and 4 (pose 3; pose 2 as it ends).
 *
 * Kirby's colored copy hats (Jigglypuff's, Mewtwo's...) carry a face of
 * their own, turned with his (ftKb_Init_UnkCallbackPairs0_1): the same
 * slots and frames, on the hat's own list.
 */
import { AObj, Archive, JObj, MatAnim, TexAnim, loadAnimJoint, loadMatAnimJoint, ptr, sample } from "./hsd";
import type { Skeleton } from "./skeleton";
import type { ScriptEvent } from "./fx/script";
import { HoldRun, holdSlots, type Hold, type ItemVis } from "./itemhold";

type TexState = Skeleton["states"][number]["tex"][number];

/** the textures a fighter's code can turn, and their animations */
export class FaceTextures {
  slots: ({ ts: TexState; anim: TexAnim } | null)[] = [];

  /** `list`: the texture numbers (counted over the model's meshes, each
   *  mesh's textures in order); `matAnim`: the model's matanim joint */
  constructor(sk: Skeleton, joints: JObj[], list: number[], matAnim: (MatAnim | null)[][]) {
    // every texture of the model, numbered as the game counts them
    const all: { ts: TexState; joint: number; k: number }[] = [];
    joints.forEach((jo, j) => jo.dobjs.forEach((d, k) => {
      for (const ts of sk.states[d.index]?.tex ?? []) all.push({ ts, joint: j, k });
    }));
    for (const n of list) {
      const t = all[n];
      const anim = t ? matAnim[t.joint]?.[t.k]?.tex.find((x) => x.id === t.ts.tobj.id) : undefined;
      this.slots.push(t && anim ? { ts: t.ts, anim } : null);
    }
  }

  /** each slot on its frame (a missing one: 0) */
  apply(frames: ArrayLike<number> | null) {
    this.slots.forEach((s, i) => {
      if (!s) return;
      const f = frames?.[i] ?? 0;
      for (const tr of s.anim.aobj?.tracks ?? []) {
        const v = sample(tr.keys, f);
        if (v === null) continue;
        // (cut to a whole number, as TObjUpdateFunc's casts do)
        if (tr.type === 1) { const im = s.anim.images[Math.trunc(v)]; if (im) s.ts.image = im; }
        else if (tr.type === 10) { const tl = s.anim.tluts[Math.trunc(v) & 0xff]; if (tl) s.ts.tlut = tl; }
      }
    });
  }
}

/** read a costume's face textures: the list for this costume (at `desc`:
 *  a count, then a table of lists by costume) and the model's matanim joint */
export function faceTextures(pl: Archive, desc: number, costume: number, md: Archive, sk: Skeleton, joints: JObj[]):
    FaceTextures | null {
  const d = pl.data;
  const n = d.getUint32(desc), lists = ptr(pl, desc + 4);
  const list = lists === null ? null : ptr(pl, lists + costume * 4) ?? ptr(pl, lists);
  if (!n || n > 16 || list === null) return null;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(d.getUint16(list + i * 2));
  const mat = [...md.publics].find(([k]) => k.endsWith("matanim_joint"));
  if (!mat) return null;
  try {
    return new FaceTextures(sk, joints, idx, loadMatAnimJoint(md, mat[1]));
  } catch {
    return null;
  }
}

/** a fighter's part animations (ftData+0x1C) */
export interface PartAnims {
  /** by slot: the first part, the parts it poses, and its poses (each the AObjs from the first part on) */
  slots: ({ start: number; parts: number[]; poses: (AObj | null)[][] } | null)[];
}

export function partAnims(pl: Archive, ftData: number): PartAnims {
  const d = pl.data, out: PartAnims = { slots: [] };
  const x1c = ptr(pl, ftData + 0x1c);
  for (let s = 0; x1c !== null && s < 5; s++) {
    const e = ptr(pl, x1c + s * 4);
    if (e === null) { out.slots.push(null); continue; }
    const start = d.getUint16(e), n = d.getUint16(e + 2), parts = ptr(pl, e + 4), anims = ptr(pl, e + 8);
    const ps: number[] = [];
    for (let i = 0; i < n && i < 64 && parts !== null; i++) ps.push(d.getUint8(parts + i));
    const poses: (AObj | null)[][] = [];
    for (let k = 0; anims !== null && k < 16; k++) {
      const aj = ptr(pl, anims + k * 4);
      if (aj === null) break;
      try { poses.push(loadAnimJoint(pl, aj)); } catch { poses.push([]); }
    }
    out.slots.push({ start, parts: ps, poses });
  }
  return out;
}

/** a part animation in force: its pose, and how far blended in (0..1) */
export interface PartPose { slot: number; pose: number; weight: number }

/** what a fighter's face and hands are doing on a frame */
export interface Face {
  tex: number[];
  parts: PartPose[];
  /** the model parts the state's script switched so far (part: variant, -1
   *  hidden); a change of state puts them back (ftParts_80074A8C) */
  models: Map<number, number>;
  /** the move's variables its script set so far (fp->cmd_vars: a move's code
   *  reads them, and clears them as it begins) */
  vars: number[];
}

/** the frames of a fighter's history the face is worked out from */
export interface FaceHistory {
  /** its state on a frame (the replay's index), or undefined */
  at(g: number): { actionStateId: number; actionStateFrameCounter: number; isInHitstun?: boolean } | undefined;
  /** the events of an action state's script */
  script(state: number): readonly ScriptEvent[];
  /** what an item in its hand does to the hand on a frame (itemhold.ts), null with none; left out: no hold poses */
  hold?(g: number): Hold | null;
  /** the frames an action state's script hides and shows a held item on */
  itemVis?(state: number): readonly ItemVis[];
}

// action states entered without putting the textures back (Ft_MF_SkipMatAnim):
// lying after a bounce, and a broken shield's fall, lying, standing and daze
const KEEP = new Set([184, 192, 206, 207, 208, 209, 210, 211]);
// the damage states: entered by a hit (ftCo_Damage), and ice's
const DAMAGE = (s: number) => (s >= 75 && s <= 91) || s === 325;
/** each fighter's knockback (ftData_OnKnockbackEnter): its texture slot
 *  besides 0 (-1: none), and whether it poses part slots 3 and 4 */
const KNOCKBACK: Record<number, { tex: number; parts: boolean }> = {
  0: { tex: 1, parts: false }, 1: { tex: 1, parts: true }, 3: { tex: 1, parts: false }, 4: { tex: 1, parts: false },
  5: { tex: 1, parts: false }, 6: { tex: 1, parts: false }, 7: { tex: 1, parts: false }, 8: { tex: 1, parts: false },
  9: { tex: 1, parts: false }, 10: { tex: 1, parts: false }, 11: { tex: 1, parts: false }, 12: { tex: 1, parts: false },
  14: { tex: 1, parts: true }, 15: { tex: 1, parts: false }, 16: { tex: 2, parts: false }, 17: { tex: 1, parts: false },
  18: { tex: 1, parts: false }, 19: { tex: 1, parts: false }, 20: { tex: 1, parts: false }, 21: { tex: 1, parts: false },
  22: { tex: 1, parts: true }, 23: { tex: 1, parts: false }, 25: { tex: -1, parts: true }, 26: { tex: 1, parts: false },
};
/** The face textures as the game switched them, from the viewer track
 *  ("tex": port, sub (Nana 1), slot, frame; slot -1 puts every one back,
 *  ftAnim_80070654), when it has them: by fighter, the switches in order. */
export class TrackFaces {
  private by = new Map<string, { f: number; slot: number; v: number }[]>();

  constructor(events: readonly (number | string)[][]) {
    for (const e of events) {
      const [f, , port, sub, slot, v] = e;
      const key = `${port}:${sub}`;
      let list = this.by.get(key);
      if (!list) this.by.set(key, (list = []));
      list.push({ f: Number(f), slot: Number(slot), v: Number(v) });
    }
  }

  /** the slots' frames at game frame `f` (the last switch of each since the
   *  last reset), or undefined for a fighter the track has none of */
  texAt(port: number, sub: number, f: number): number[] | undefined {
    const list = this.by.get(`${port}:${sub}`);
    if (!list) return undefined;
    let lo = 0, hi = list.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].f <= f) lo = m + 1; else hi = m; }
    const out: number[] = [];
    const seen = new Set<number>();
    for (let i = lo - 1; i >= 0; i--) {
      const e = list[i];
      if (e.slot < 0) break;
      if (seen.has(e.slot)) continue;
      seen.add(e.slot);
      if (e.slot < 16) out[e.slot] = e.v;
    }
    for (let i = 0; i < out.length; i++) out[i] ??= 0;
    return out;
  }
}

/** how far back a state's start is looked for */
const BACK = 900;

/** The face on frame `f` (the replay's index), from the fighter's history:
 *  back to where its action state (or this run of it) began, what that
 *  entry left (a hit's knockback, or what the state before left when this
 *  one keeps it), then the state's script up to now. */
export function faceAt(char: number, h: FaceHistory, f: number, depth = 0): Face {
  const out: Face = { tex: [], parts: [], models: new Map(), vars: [0, 0, 0, 0] };
  const now = h.at(f);
  if (!now) return out;
  const s = now.actionStateId;
  // back to this run's first frame: the same state, its counter not starting over
  let e = f;
  while (e > 0 && f - e < BACK) {
    const q = h.at(e - 1), c = h.at(e);
    if (!q || !c || q.actionStateId !== s || q.actionStateFrameCounter > c.actionStateFrameCounter) break;
    e--;
  }
  const first = h.at(e)!;
  // what the entry kept: the state before's textures (the part poses always go)
  if (KEEP.has(s) && depth < 4 && e > 0) out.tex = faceAt(char, h, e - 1, depth + 1).tex.slice();
  const kb = KNOCKBACK[char];
  const hit = DAMAGE(s) && kb !== undefined;
  const events = h.script(s);
  const entryCounter = first.actionStateFrameCounter;
  const set = (slot: number, v: number) => { if (slot >= 0 && slot < 16) out.tex[slot] = v; };
  const pose = (slot: number, p: number, blend: number, at: number) => {
    out.parts = out.parts.filter((x) => x.slot !== slot);
    out.parts.push({ slot, pose: p, weight: blend > 0 ? Math.min(1, (f - at + 1) / blend) : 1 });
  };
  const run = (e0: ScriptEvent, at: number) => {
    if (e0.kind === "tex") { set(e0.slot, e0.texFrame); if (e0.slot2 !== null) set(e0.slot2, e0.texFrame); }
    else if (e0.kind === "partAnim") pose(e0.slot, e0.anim, e0.blend, at);
    else if (e0.kind === "modelPart") out.models.set(e0.part, e0.variant);
    else if (e0.kind === "cmdVar") out.vars[e0.index] = e0.value;
  };
  // the script runs as the state is entered, before the hit's knockback: to
  // the replay's counter, the script's clock (its first frame; its first two
  // when the move's code advanced it a frame as it began - a hit's, an
  // attack's; to where one carried on part way through began it)
  // (a held item's hand pose, itemhold.ts: the slots' defaults go on as the state changes, before its script)
  const slots = h.hold ? holdSlots(char) : null;
  const held = slots ? new HoldRun(slots, (slot, p, at) => pose(slot, p, 0, at),
                                   (slot) => { out.parts = out.parts.filter((x) => x.slot !== slot); }) : null;
  const vis = held ? h.itemVis?.(s) ?? [] : [];
  let vi = 0;
  const shown = (upTo: number) => { const v: boolean[] = []; for (; vi < vis.length && vis[vi].frame <= upTo; vi++) v.push(vis[vi].on); return v; };
  if (held) held.enter(e, h.hold!(e), e > 0 ? h.hold!(e - 1) : null);
  let i = 0;
  for (; i < events.length && events[i].frame <= entryCounter; i++) run(events[i], e);
  if (held) { const now = h.hold!(e); held.step(e, now, now, shown(entryCounter)); }
  if (hit) {
    set(kb.tex, 3); set(0, 3);
    if (kb.parts) { pose(3, 3, 0, e); pose(4, 3, 0, e); }
  }
  // then frame by frame: the script, and the knockback's end with the
  // hitstun's. On a frame the move goes on, the script has run a frame past
  // the replay's counter (the counter is the animation's before the frame's
  // step): a wait's blink switched at its script's frame 20 shows on the
  // frame the replay's counter says 19 (the simulator's track), Kirby's
  // mouth posed at frame 4 of PK Flash's start on its counter's 3 (Dolphin)
  let stun = !!first.isInHitstun || hit;
  for (let g = e + 1; g <= f; g++) {
    const st = h.at(g);
    if (!st) break;
    const t = st.actionStateFrameCounter + 1;
    if (held) held.step(g, h.hold!(g), h.hold!(g - 1), shown(t));
    for (; i < events.length && events[i].frame <= t; i++) run(events[i], g);
    if (stun && st.isInHitstun === false) {
      stun = false;
      if (hit) {
        set(kb.tex, 0); set(0, 0);
        if (kb.parts) { pose(3, 2, 0, g); pose(4, 2, 0, g); }
      }
    }
  }
  return out;
}
