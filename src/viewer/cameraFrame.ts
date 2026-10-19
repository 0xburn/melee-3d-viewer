/* what the Simple view's camera frames (components/viewer/Camera.tsx).
 *
 * Without ghosts it is Slippi Lab's camera, unchanged: a box round every real
 * fighter (and Nana while she is in the game), 25 units of padding, at least
 * 100 x 100, scaled to fit 640 x 480.
 *
 * With simulated ghosts on screen it frames them too, the way Melee's own
 * camera frames several players (cm/camera.c, ftCamera; render3d/camera.ts
 * is our writing of it for the 3D and Console views, which already count
 * every ghost as a fighter of its own). Every fighter, real or ghost, is a
 * subject:
 *  - a point (its position, lifted by its camera box) with extents round it
 *    (the default camera box: 8 either side, 12 up, 2 down), the extents
 *    grown by Melee's factor for how many subjects there are (1.32 for two,
 *    1.16 for three, 1 for four or more);
 *  - held inside the stage's camera range, so a fighter far away never zooms
 *    the picture out past the stage. A fighter on its way out (KO'd within
 *    the next KO_LEAD frames) is held inside the blast zones instead, and
 *    where it will cross the line is framed from then on too: the camera's
 *    pace is slow, and a fighter sent flying crosses in a few frames, so the
 *    picture has to start opening up before it gets there;
 *  - a KO'd fighter is kept where it went for KO_HOLD frames (Melee keeps it
 *    until the game puts it to sleep), then it stops counting and the camera
 *    eases back. One asleep, or not in the game, never counts.
 * The box round the subjects then gets the same padding, minimum size and
 * 640 x 480 fit as without ghosts, and Camera.tsx eases toward it at the same
 * pace, so turning ghosts on or off eases the picture over.
 */
import type { Frame, PlayerState } from "../common/types";

export interface Bounds { left: number; right: number; top: number; bottom: number }
/** a stage's camera range (where Melee's camera goes no further) and its blast zones */
export interface StageLimits { camera: Bounds; blast: Bounds }

/** by external stage id: the camera range Melee's camera uses (the stage
 *  file's general points 0x95 and 0x96 at its scale; Pokemon Stadium has no
 *  center point, so the game uses its stand-in range) and the blast zones
 *  (Stage.tsx draws the same ones) */
export const STAGE_LIMITS: Record<number, StageLimits> = {
  2: { camera: { left: -123.75, right: 123.75, top: 112.5, bottom: -84.75 }, // Fountain of Dreams
       blast: { left: -198.75, right: 198.75, top: 202.5, bottom: -146.25 } },
  3: { camera: { left: -170, right: 170, top: 120, bottom: -60 }, // Pokemon Stadium
       blast: { left: -230, right: 230, top: 180, bottom: -111 } },
  8: { camera: { left: -126, right: 125.3, top: 118.3, bottom: -49.7 }, // Yoshi's Story
       blast: { left: -175.7, right: 173.6, top: 168, bottom: -91 } },
  28: { camera: { left: -165, right: 165, top: 190, bottom: -81 }, // Dream Land
        blast: { left: -255, right: 255, top: 250, bottom: -123 } },
  31: { camera: { left: -160, right: 160, top: 136, bottom: -47.2 }, // Battlefield
        blast: { left: -224, right: 224, top: 200, bottom: -108.8 } },
  32: { camera: { left: -170, right: 170, top: 114, bottom: -80 }, // Final Destination
        blast: { left: -246, right: 246, top: 188, bottom: -140 } },
};
/** any other stage: the game's stand-in camera range, blast zones well past it */
export const DEFAULT_LIMITS: StageLimits = {
  camera: { left: -170, right: 170, top: 120, bottom: -60 },
  blast: { left: -250, right: 250, top: 250, bottom: -150 },
};
export const stageLimits = (stageId: number): StageLimits => STAGE_LIMITS[stageId] ?? DEFAULT_LIMITS;

/** the camera's padding and smallest box (Slippi Lab's), and what it fits */
export const PADDING = 25, MINIMUM = 100, VIEW_W = 640, VIEW_H = 480;
/** frames a KO'd fighter is still framed where it went */
export const KO_HOLD = 40;
/** frames before a KO from which a fighter is framed up to the blast zones */
export const KO_LEAD = 60;
// Melee's camera box when a fighter's own is not known (render3d/camera.ts
// DEFAULT_BOX) and its factor for how many subjects there are
const LIFT = 10, SIDE = 8, UP = 12, DOWN = -2;
const WEIGHT = [0, 1.5, 1.32, 1.16, 1.0];

export interface Focus { x: number; y: number }
/** where the camera aims and how much it scales the picture */
export interface CameraTarget { x: number; y: number; scale: number }
/** a ghost as the camera needs it: its replay's frames and its first real one */
export interface GhostFrames { frames: Frame[]; held?: number }

// Melee's action states: 0-10 KO'd, 11 asleep (out of the game for now)
const isKO = (s: PlayerState) => s.actionStateId <= 10;
const inGame = (s: PlayerState) => s.actionStateId > 11;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const inside = (p: Focus, b: Bounds): Focus => ({ x: clamp(p.x, b.left, b.right), y: clamp(p.y, b.bottom, b.top) });

/** the old camera's points: every real fighter, and Nana while she is in the game */
export function fighterFocuses(frame: Frame): Focus[] {
  return frame.players.filter(Boolean).flatMap((player) =>
    (player.nanaState && !player.nanaState.isDead && player.nanaState.actionStateId > 11
      ? [player.state, player.nanaState]
      : [player.state]
    ).map((s) => ({ x: s.xPosition, y: s.yPosition }))
  );
}

/** the old camera's box round points: padding, a smallest size, the 640 x 480 fit */
export function frameBox(focuses: Focus[]): CameraTarget {
  const xs = focuses.map(({ x }) => x);
  const ys = focuses.map(({ y }) => y);
  const xMin = Math.min(...xs) - PADDING;
  const xMax = Math.max(...xs) + PADDING;
  const yMin = Math.min(...ys) - PADDING;
  const yMax = Math.max(...ys) + PADDING;
  const xRange = Math.max(xMax - xMin, MINIMUM);
  const yRange = Math.max(yMax - yMin, MINIMUM);
  // scale both axes based on the most zoomed out one.
  return { x: (xMin + xMax) / 2, y: (yMin + yMax) / 2, scale: Math.min(VIEW_W / xRange, VIEW_H / yRange) };
}

const stateAt = (frames: Frame[], f: number, player: number, nana: boolean): PlayerState | undefined => {
  const p = frames[f]?.players[player];
  return (nana ? p?.nanaState : p?.state) ?? undefined;
};

/** one fighter as a subject of Melee's camera: where it is and, on its way
 *  out, where it crosses the blast line (`to`) */
export interface Subject extends Focus { to?: Focus }

/** one fighter as a subject of Melee's camera at frame f, or null when it
 *  does not count (asleep, gone, or KO'd longer than KO_HOLD frames ago) */
export function subjectPoint(frames: Frame[], f: number, player: number, nana: boolean, lim: StageLimits): Subject | null {
  const s = stateAt(frames, f, player, nana);
  if (!s) return null;
  if (isKO(s)) {
    // where it went: its last frame in the game, if that was not long ago
    for (let k = 1; k <= KO_HOLD; k++) {
      const b = stateAt(frames, f - k, player, nana);
      if (!b) return null;
      if (inGame(b)) return inside({ x: b.xPosition, y: b.yPosition }, lim.blast);
      if (!isKO(b)) return null;
    }
    return null;
  }
  if (!inGame(s) || s.isDead) return null;
  // on its way out (KO'd within KO_LEAD frames): framed up to the blast
  // zones, and where it will cross them framed already, so the camera (as
  // slow as it is) has the line in the picture by the time it gets there;
  // else held inside the camera range
  for (let k = 1; k <= KO_LEAD; k++) {
    const a = stateAt(frames, f + k, player, nana);
    if (!a) break;
    if (isKO(a)) {
      const last = stateAt(frames, f + k - 1, player, nana)!;
      return { ...inside({ x: s.xPosition, y: s.yPosition }, lim.blast), to: inside({ x: last.xPosition, y: last.yPosition }, lim.blast) };
    }
  }
  return inside({ x: s.xPosition, y: s.yPosition }, lim.camera);
}

/** every subject a replay's frame f has: each player, and Nana */
function subjects(frames: Frame[], f: number, lim: StageLimits): Subject[] {
  const out: Subject[] = [];
  for (const p of frames[f]?.players ?? []) {
    if (!p) continue;
    const a = subjectPoint(frames, f, p.playerIndex, false, lim);
    if (a) out.push(a);
    if (p.nanaState) {
      const n = subjectPoint(frames, f, p.playerIndex, true, lim);
      if (n) out.push(n);
    }
  }
  return out;
}

/** the ghosts' subjects at frame f: only ghosts drawn there (not before
 *  their moment: parser.ts's held, not past their replay's end) */
export function ghostSubjects(ghosts: GhostFrames[], f: number, lim: StageLimits): Subject[] {
  return ghosts.flatMap((g) => (g.frames[f] === undefined || f < (g.held ?? 0) ? [] : subjects(g.frames, f, lim)));
}

/** Melee's box round its subjects: each one's camera box, grown by the
 *  factor for how many there are */
export function subjectBox(subjects: Subject[]): Focus[] {
  const m = subjects.length < 5 ? WEIGHT[subjects.length] : 1;
  return subjects.flatMap((s) => (s.to ? [s, s.to] : [s])).flatMap(({ x, y }) => [
    { x: x - SIDE * m, y: y + LIFT + DOWN * m },
    { x: x + SIDE * m, y: y + LIFT + UP * m },
  ]);
}

/** what the camera aims for at frame f of the real replay with these ghosts on screen */
export function cameraTarget(frames: Frame[], f: number, ghosts: GhostFrames[], lim: StageLimits): CameraTarget {
  // (a frame past a replay's end - a run shorter than the moment's loop - has none: the last one)
  const at = frames[f] === undefined ? frames.length - 1 : f;
  const g = ghosts.length ? ghostSubjects(ghosts, at, lim) : [];
  if (!g.length) return frameBox(fighterFocuses(frames[at]));
  const all = [...subjects(frames, at, lim), ...g];
  return frameBox(subjectBox(all));
}

/** one frame's step of the camera toward its target (Slippi Lab's pace) */
export const FOLLOW = 0.04;
export function stepCamera(from: CameraTarget | undefined, to: CameraTarget): CameraTarget {
  const smooth = (a: number, b: number) => a + (b - a) * FOLLOW;
  return { x: smooth(from?.x ?? to.x, to.x), y: smooth(from?.y ?? to.y, to.y), scale: smooth(from?.scale ?? 5, to.scale) };
}
