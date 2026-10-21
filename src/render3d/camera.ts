/* 3D replay viewer: the game's own match camera, run from the
 * replay.
 *
 * Slippi does not record the camera, but in a versus match the game's camera
 * follows from nothing the replay lacks: each fighter's position, facing and
 * state, the fighter's camera box (its data file), and the stage's camera
 * settings (grGroundParam and its general points). What it does each frame
 * was read from the Melee decompilation's camera code (cm/camera.c and
 * ft/ftcamera.c); this is our own writing of it:
 *
 *  - every fighter is a subject: a point (its position, lifted by its box)
 *    with extents left, right, up and down that ease toward the box's own
 *    half a unit a frame. A fighter who is KO'd stops updating (the camera
 *    keeps looking where they went) until the game puts them to sleep, and
 *    one coming back snaps to their box;
 *  - the subjects' extents, scaled by a factor for how many there are and the
 *    stage's track ratio, and each held inside the stage's camera range, make
 *    a box to frame;
 *  - the field of view eases toward the stage's own (grGroundParam +0x08,
 *    passed to the camera at the match's start); the distance is what fits the
 *    box, between the stage's nearest and farthest; the camera tilts down as
 *    the box sits low and turns as it sits to a side, both by the stage's
 *    factors, within limits, plus the stage's own pan;
 *  - if the picture's corners would reach past the camera range on the
 *    stage's plane, the target moves back in;
 *  - the camera's interest eases toward its target by a speed that grows with
 *    the spread, and its position by 0.15 a frame, both times the stage's
 *    smoothing.
 * It is stateful, so it is run once for a whole replay, from its first frame.
 */

import { Key, sample } from "./hsd";
import { C_MTXPerspective, cobjViewingMtx, mtxToGL, projectionToGL } from "./gxmath";

/** the stage's camera settings (in world units, the stage's scale applied) */
export interface StageCamera {
  /** the camera range, absolute */
  left: number; right: number; top: number; bottom: number;
  /** its center (general point 0x94) */
  cx: number; cy: number;
  /** the blast zones, absolute */
  blast: { left: number; right: number; top: number; bottom: number };
  /** the stage's quakes (loop, small, medium, large): the x and y the quake
   *  joint's animation moves it by, and how long it runs */
  quakes: ({ x: Key[] | null; y: Key[] | null; end: number } | null)[];
  /** grGroundParam: tilt and turn factors, pan (degrees), nearest and
   *  farthest distance, track ratio, smoothing, fixed zoom */
  pitchK: number; yawK: number; pan: number; near: number; far: number;
  trackRatio: number; smooth: number; fixedZoom: number;
  /** grGroundParam +0x08: the field of view the camera eases toward (degrees;
   *  Yoshi's Story 20, Battlefield 30), 0 when the file has none */
  fov: number;
}

/** a fighter's camera box (ftData+0x3C): its lift, horizontal extents
 *  (behind, ahead), vertical extents and depth, before its model scale */
export interface CameraBox { lift: number; back: number; ahead: number; v: [number, number, number] }

/** one fighter on one frame, as the camera needs it; `quake`: the quake it
 *  starts this frame (a hit's, a bounce's, its move script's: hitlag.ts quakeOf), 0 or none */
export interface CamActor { key: string; x: number; y: number; facing: number; state: number; box: CameraBox | null; scale: number;
                            quake?: number }

// the game's camera numbers (cm_803BCCA0, cm_803BCB64, cm_803BCB9C)
const FOV = 38, FOV_EASE = 0.1, FOV_START = 30, ASPECT = 1.2173333;
const PITCH_BASE = -30, PITCH_MAX = 5, PITCH_MIN = -7, YAW_MAX = 17.5, YAW_MIN = -17.5;
const BIAS_LOW = 0, BIAS_HIGH = 0.0682, BIAS_FROM = 60, BIAS_TO = 120;
const FOLLOW_SLOW = 0.05, FOLLOW_FAST = 0.1, FOLLOW_FROM = 120, FOLLOW_TO = 900;
const POSITION_EASE = 0.15;
// a quake's share at the farthest distance (it is whole at the nearest)
const QUAKE_FAR = 0.6;
const WEIGHT = [0, 1.5, 1.32, 1.16, 1.0];
const DEFAULT_BOX: CameraBox = { lift: 10, back: -8, ahead: 8, v: [12, -2, 0] };
const rad = (d: number) => (d * Math.PI) / 180;

interface Subject { x: number; y: number; ext: number[]; target: number[]; on: boolean; frozen: boolean; lastState: number;
                    since: number }
// a screen KO's frames on the screen before it is gone (fighter.ts)
const SCREEN_GONE = 43;

/** each player's scale, which their camera box is taken at: the match's own
 *  model scale (1 in a versus match; ftCamera_UpdateCameraBox multiplies the
 *  box by x34_scale.y, which is Player_GetModelScale), not the character's
 *  model scaling */
export function playerScales(players: ({ modelScale?: number } | null | undefined)[]): number[] {
  return players.map((p) => (p?.modelScale && p.modelScale > 0 ? p.modelScale : 1));
}

/** floats a frame in runCamera's track */
export const CAM_STRIDE = 7;

/** the camera on each frame: eye x y z, interest x y z, vertical field of
 *  view in degrees */
export function runCamera(st: StageCamera, frames: CamActor[][]): Float32Array {
  const run = cameraRun(st, (f) => frames[f], frames.length);
  run.advance(frames.length);
  return run.out;
}

/** a camera run that goes on as far as it is asked: the frames' fighters come from `actorsAt` one frame at a time,
 *  `advance(to)` runs the frames up to `to` (the game's camera is a state from one frame to the next, so they are
 *  run in order, from the first), and `out` is the whole track, filled as far as `done`. `fixed`: the first frames
 *  of a track the game's own camera made, which replace what the run makes for them (the run goes on from its own
 *  state, as it always did). */
export interface CameraRun {
  readonly out: Float32Array;
  readonly total: number;
  readonly done: number;
  advance(to: number): void;
}
export function cameraRun(st: StageCamera, actorsAt: (f: number) => CamActor[], total: number,
                          fixed?: { track: Float32Array; frames: number }): CameraRun {
  const out = new Float32Array(total * CAM_STRIDE);
  let done = 0;
  const subjects = new Map<string, Subject>();
  let quake: { kind: number; from: number } | null = null;
  // where the game's camera starts (its scene's camera)
  const pos = [0, 40.241425, 300.241], interest = [0, 10, 0];
  const targetPos = [...pos], targetInterest = [...interest];
  let fov = FOV_START;
  const inside = (x: number, y: number) => ({
    x: Math.min(st.right, Math.max(st.left, x)), y: Math.min(st.top, Math.max(st.bottom, y)),
  });
  const step = (f: number) => {
    // the subjects: each fighter's box, as its state has it
    for (const a of actorsAt(f)) {
      const box = a.box ?? DEFAULT_BOX, k = a.scale;
      const t = a.facing >= 0
        ? [box.back * k, box.ahead * k * st.fixedZoom, box.v[0] * k, box.v[1] * k, box.v[2] * k]
        : [-box.ahead * k * st.fixedZoom, -box.back * k, box.v[0] * k, box.v[1] * k, box.v[2] * k];
      let s = subjects.get(a.key);
      const dead = a.state <= 10, asleep = a.state === 11;
      if (!s) {
        s = { x: a.x, y: a.y + box.lift * k, ext: [...t], target: [...t], on: !asleep, frozen: false, lastState: a.state,
              since: f };
        subjects.set(a.key, s);
      }
      if (asleep) { s.on = false; s.lastState = a.state; continue; }
      // a hit that launches, a missed tech's bounce, a wall's, a move's
      // script's: the stage's quake of that size (Camera_RequestQuake), the
      // latest one's (the largest of those asked for on one frame)
      const asked = quake as { kind: number; from: number } | null;
      if (a.quake && !a.key.startsWith("g") && !(asked?.from === f && asked.kind >= a.quake)) quake = { kind: a.quake, from: f };
      if (!s.on) {
        // coming back: framed again, at its box at once
        s.on = true; s.frozen = false;
        s.ext = [...t];
      }
      if (dead) {
        // a KO: the camera keeps the box where it was, except a star or
        // screen KO, which is followed up to the top (ftCamera_80076320)
        if (a.state >= 4) {
          const span = st.blast.top - st.cy;
          s.x = span !== 0 ? (a.x * (st.top - st.cy)) / span : a.x;
          s.y = st.blast.top;
          s.target = t;
        }
        if (a.state !== s.lastState) s.since = f;
        // the stage's large quake: a KO through a blast line; a screen KO as
        // it hits the screen (7, 8, 10) and as it slides out of sight
        const real = !a.key.startsWith("g");
        if (real && a.state <= 3 && s.lastState > 3) quake = { kind: 3, from: f };
        if (real && (a.state === 7 || a.state === 8 || a.state === 10)
            && (s.since === f || f - s.since === SCREEN_GONE)) quake = { kind: 3, from: f };
        s.lastState = a.state;
        continue;
      }
      s.lastState = a.state;
      s.x = a.x; s.y = a.y + box.lift * k; s.target = t;
    }
    // extents ease toward their box, half a unit a frame
    let count = 0;
    for (const s of subjects.values()) {
      if (!s.on) continue;
      count++;
      for (let i = 0; i < 5; i++) {
        const d = s.target[i] - s.ext[i];
        s.ext[i] = d > 0.5 ? s.ext[i] + 0.5 : d < -0.5 ? s.ext[i] - 0.5 : s.target[i];
      }
    }
    // the box to frame
    let x0: number, x1: number, y0: number, y1: number;
    if (count) {
      const m = (count < 5 ? WEIGHT[count] : 1) * st.trackRatio;
      x0 = y0 = Infinity; x1 = y1 = -Infinity;
      for (const s of subjects.values()) {
        if (!s.on) continue;
        const b = inside(s.x, s.y);
        for (const e of [s.ext[0], s.ext[1]]) {
          const p = inside(b.x + e * m, s.y);
          x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
        }
        for (const e of [s.ext[3], s.ext[2]]) {
          const p = inside(s.x, b.y + e * m);
          y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
        }
      }
    } else {
      x0 = st.cx - 40; x1 = st.cx + 40; y0 = st.cy - 40; y1 = st.cy + 40;
    }
    const z = Math.abs(pos[2]);
    const zf = z < 80 ? 0 : z > 5000 ? 1 : (z - 80) / 4920;
    y0 -= 390 * zf + 10;
    // field of view, then where the camera should be (the match starts with
    // the camera put where it aims, at its field of view: Camera_8002F3AC)
    fov = f === 0 ? (st.fov > 0 ? st.fov : FOV) : fov + ((st.fov > 0 ? st.fov : FOV) - fov) * FOV_EASE;
    const spread = Math.max(x1 - x0, y1 - y0);
    const bias = spread > BIAS_TO ? BIAS_HIGH : spread < BIAS_FROM ? BIAS_LOW
      : BIAS_LOW + (BIAS_HIGH - BIAS_LOW) * (spread - BIAS_FROM) / (BIAS_TO - BIAS_FROM);
    const base = (y0 - st.cy + (y1 - st.cy)) * (0.5 - bias) + st.cy;
    let pitch = -rad((base + PITCH_BASE) * st.pitchK);
    pitch = Math.min(rad(PITCH_MAX), Math.max(rad(PITCH_MIN), pitch)) + rad(st.pan);
    const half = rad(fov) / 2;
    const tu = Math.tan(half + pitch), td = Math.tan(half - pitch);
    const dy = (y1 - y0) / (tu + td);
    const yOff = dy * Math.tan(pitch);
    targetInterest[1] = yOff + (y1 - dy * tu);
    let yaw = -rad((0.5 * (x0 + x1) - st.cx) * st.yawK);
    yaw = Math.min(rad(YAW_MAX), Math.max(rad(YAW_MIN), yaw));
    const tr = ASPECT * Math.tan(half - yaw), tl = ASPECT * Math.tan(half + yaw);
    const dx = (x1 - x0) / (tr + tl);
    const xOff = ASPECT * dx * Math.tan(yaw);
    targetInterest[0] = x1 - dx * tr - xOff;
    targetInterest[2] = 0;
    const dist = Math.min(st.far, Math.max(st.near, Math.max(dy, dx)));
    targetPos[0] = targetInterest[0] + xOff;
    targetPos[1] = targetInterest[1] - yOff;
    targetPos[2] = targetInterest[2] + dist;
    correct(st, targetPos, targetInterest, rad(fov) / 2);
    if (f === 0) {
      for (let i = 0; i < 3; i++) { pos[i] = targetPos[i]; interest[i] = targetInterest[i]; }
    }
    // ease toward the target
    const follow = Math.min(1, Math.max(0.0001, (spread > FOLLOW_TO ? FOLLOW_FAST : spread < FOLLOW_FROM ? FOLLOW_SLOW
      : FOLLOW_SLOW + (spread - FOLLOW_FROM) / (FOLLOW_TO - FOLLOW_FROM) * (FOLLOW_FAST - FOLLOW_SLOW)) * st.smooth));
    interest[0] += (targetInterest[0] - interest[0]) * follow;
    interest[1] += (targetInterest[1] - interest[1]) * follow;
    const ease = Math.min(1, POSITION_EASE * st.smooth);
    for (let i = 0; i < 3; i++) pos[i] += (targetPos[i] - pos[i]) * ease;
    // a quake: the stage's quake joint, frame by frame, moves the whole
    // picture by as much as it would move it on a 640 x 480 screen seen from
    // the distance that fits the box (Camera_ApplyQuake)
    let qx = 0, qy = 0;
    const q = quake ? st.quakes[quake.kind] : null;
    if (quake && q) {
      // (the quake's own object, made as it is asked for, first moves the
      // camera on the frame after: its animation's frame 0 there - as the
      // simulator's camera has it, two frames after the hit or the KO)
      const t = f - quake.from - 1;
      if (t > q.end) quake = null;
      else if (t >= 0) {
        const ox = (q.x ? sample(q.x, t) ?? 0 : 0) * 10, oy = (q.y ? sample(q.y, t) ?? 0 : 0) * 10;
        const tf = Math.tan(rad(FOV));
        const zfit = Math.min(st.far, Math.max(st.near, Math.max((y1 - y0) / tf, (x1 - x0) / (ASPECT * tf))));
        const halfH = zfit * Math.tan(rad(fov) / 2);
        const r = st.far - st.near < 0.001 ? 0.5 : (zfit - st.near) / (st.far - st.near);
        const fall = 1 + r * (QUAKE_FAR - 1);
        qx = fall * ox * ASPECT * halfH / 320;
        qy = fall * oy * halfH / 240;
      }
    }
    out.set([pos[0] + qx, pos[1] + qy, pos[2], interest[0] + qx, interest[1] + qy, interest[2], fov], f * CAM_STRIDE);
    if (fixed && f < fixed.frames) out.set(fixed.track.subarray(f * CAM_STRIDE, (f + 1) * CAM_STRIDE), f * CAM_STRIDE);
  };
  return {
    out,
    total,
    get done() { return done; },
    advance(to: number) {
      const end = Math.min(total, to);
      while (done < end) step(done++);
    },
  };
}

// the picture's four corners, cast onto the stage's plane: if one reaches
// past the camera range, the target moves back in by as much (the game's
// correction, Camera_8002A768)
function correct(st: StageCamera, pos: number[], interest: number[], half: number) {
  const d = [interest[0] - pos[0], interest[1] - pos[1], interest[2] - pos[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  const pitch = Math.atan2(d[1] / l, -d[2] / l), yaw = Math.atan2(-d[0] / l, -d[2] / l);
  let left = 0, right = 0, top = 0, bottom = 0, hit = 0;
  for (const [sy, sx] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    let v = [0, 0, -1];
    v = rotX(v, sy * half); v = rotY(v, sx * half);
    v[0] *= ASPECT;
    const n = Math.hypot(v[0], v[1], v[2]);
    v = [v[0] / n, v[1] / n, v[2] / n];
    v = rotX(v, pitch); v = rotY(v, yaw);
    if (v[2] >= -0.001) continue;
    const t = -pos[2] / v[2];
    const px = v[0] * t + pos[0], py = v[1] * t + pos[1];
    // which corner: top (sy 1) or bottom, and left (sx 1) or right
    if (sx > 0 && px < st.left && st.left - px > left) { left = st.left - px; hit |= 4; }
    if (sx < 0 && px > st.right && st.right - px < right) { right = st.right - px; hit |= 8; }
    if (sy > 0 && py > st.top && st.top - py < top) { top = st.top - py; hit |= 1; }
    if (sy < 0 && py < st.bottom && st.bottom - py > bottom) { bottom = st.bottom - py; hit |= 2; }
  }
  if (!hit) return;
  const cx = hit & 4 && hit & 8 ? 0.5 * (left + right) : hit & 4 ? left : hit & 8 ? right : 0;
  const cy = hit & 1 && hit & 2 ? 0.5 * (bottom + top) : hit & 1 ? top : hit & 2 ? bottom : 0;
  pos[0] += cx; pos[1] += cy; interest[0] += cx; interest[1] += cy;
}

const rotX = (v: number[], a: number) => {
  const s = Math.sin(a), c = Math.cos(a);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
};
const rotY = (v: number[], a: number) => {
  const s = Math.sin(a), c = Math.cos(a);
  return [v[0] * c + v[2] * s, v[1], v[2] * c - v[0] * s];
};

// ---------------------------------------------------------------- the camera's matrices, as the game makes them

/** the near and far planes the match camera's CObj is given (Camera_8002A4AC: game_camera.nearz, farz) */
export const CAM_NEAR = 0.1, CAM_FAR = 16384;
/** the match camera's aspect (cm_803BCB64.aspect) */
export const CAM_ASPECT = ASPECT;

const viewScratch = new Float32Array(12), eyeScratch = [0, 0, 0], atScratch = [0, 0, 0];

/** the view matrix of the camera at `eye` looking at `interest` (column major, for the renderer), made as
 *  HSD_CObjSetupViewingMtx makes it: its up from its roll (0: the match camera's), C_MTXLookAt, in float32 */
export function gameView(out: Float32Array, eye: ArrayLike<number>, interest: ArrayLike<number>, roll = 0): Float32Array {
  for (let i = 0; i < 3; i++) { eyeScratch[i] = eye[i]; atScratch[i] = interest[i]; }
  cobjViewingMtx(viewScratch, eyeScratch, atScratch, roll);
  return mtxToGL(viewScratch, out);
}

/** the projection of a camera with this vertical field of view (degrees): GX's, as makeProjectionMtx makes it
 *  (C_MTXPerspective), into `gx` (row major, as GX is loaded with it) and as GL takes it into `out` */
export function gameProjection(out: Float32Array, gx: Float32Array, fovDeg: number, aspect = CAM_ASPECT,
                               near = CAM_NEAR, far = CAM_FAR): Float32Array {
  C_MTXPerspective(gx, fovDeg, aspect, near, far);
  return projectionToGL(gx, out);
}
