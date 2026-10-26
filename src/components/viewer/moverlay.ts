/* M'Overlay's default GameCube skin drawn on a canvas (the Controller overlay's picture; Controllers.tsx and the game's draw-path page share it). */
import { MO_PATHS } from "../../assets/controllers/m-overlay/paths";
import type { Pad } from "../../viewer/controllerInputs";

export const TRAIL = 6;

export interface Shown {
  player: number;
  pad: Pad | null;
  trail: { main: [number, number][]; c: [number, number][] };
  ghosts: { pad: Pad; color: string }[];
}

// its textures as their own outlines (src/assets/controllers/m-overlay/paths.ts,
// traced from its PNGs by a tracing script): drawn as shapes, they
// stay sharp at every size the players need - a texture resampled to a fifth
// of its 128 pixels (or past them, full screen) steps and blurs
const MO_SHAPES = new Map<string, { w: number; h: number; path: Path2D }>();
function moShape(name: string) {
  let s = MO_SHAPES.get(name);
  if (!s) {
    const p = MO_PATHS[name];
    if (!p) return null;
    s = { w: p.w, h: p.h, path: new Path2D(p.d) };
    MO_SHAPES.set(name, s);
  }
  return s;
}
/** a texture, in a color (as LÖVE's setColor draws a white one), at x, y and w x h of the skin's canvas */
function moDraw(g: CanvasRenderingContext2D, name: string, color: string, x: number, y: number, w: number, h: number) {
  const s = moShape(name);
  if (!s) return;
  g.save();
  g.translate(x, y);
  g.scale(w / s.w, h / s.h);
  g.fillStyle = color;
  g.fill(s.path, "evenodd");
  g.restore();
}

// default.lua's colors and places (its canvas's units)
const MO_WHITE = "#ffffff", MO_CSTICK = "#ffeb00";
const MO_BUTTONS: { k: keyof Pad; tex: string; color: string; x: number; y: number; ring: [number, number, number, number] }[] = [
  // (ring: the button's own picture's box, for a ghost's ring round it)
  { k: "a", tex: "a", color: "#00e196", x: 12 + 64 + 256, y: 48, ring: [351, 67, 441, 157] },
  { k: "b", tex: "b", color: "#e60000", x: 16 + 256, y: 92, ring: [312, 133, 360, 181] },
  { k: "xb", tex: "x", color: MO_WHITE, x: 138 + 256, y: 32, ring: [435, 64, 480, 132] },
  { k: "yb", tex: "y", color: MO_WHITE, x: 60 + 256, y: -16, ring: [345, 27, 413, 72] },
  { k: "z", tex: "z", color: "#a54ba5", x: 128 + 256, y: -32, ring: [423, 12, 472, 51] },
  { k: "start", tex: "start", color: MO_WHITE, x: 256, y: 26, ring: [301, 72, 339, 110] },
];
const MO_DPAD: [keyof Pad, string][] = [["dUp", "up"], ["dDown", "down"], ["dLeft", "left"], ["dRight", "right"]];
// what of its canvas the skin draws on: everything it draws, and a little room
export const MO_VIEW = { x: 14, y: 6, w: 474, h: 249 };
// where a stick's center is (default.lua: the quad's center over its gate)
const moMain = (x: number, y: number) => [64 + 22 + 44 * x, 64 + 8 + 44 * (1 - y)] as const;
const moC = (x: number, y: number) => [64 + 48 + 128 + 32 * x, 64 + 18 + 32 * (1 - y)] as const;

// a gate with the stick's mask cut out of it (default.lua's stencil), then the stick
function moStick(g: CanvasRenderingContext2D, gate: string, mask: string, stick: string, color: string,
                 gx: number, gy: number, at: readonly [number, number]) {
  const mk = moShape(mask);
  g.save();
  if (mk) {
    const cut = new Path2D();
    cut.rect(-1000, -1000, 3000, 3000);
    cut.addPath(mk.path, new DOMMatrix().translate(at[0] - 64, at[1] - 64).scale(128 / mk.w, 128 / mk.h));
    g.clip(cut, "evenodd");
  }
  moDraw(g, gate, color, gx, gy, 128, 128);
  g.restore();
  moDraw(g, stick, color, at[0] - 64, at[1] - 64, 128, 128);
}

export function moPaint(g: CanvasRenderingContext2D, s: Shown) {
  const p = s.pad;
  const ring = (cx: number, cy: number, r: number, color: string) => {
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.strokeStyle = color; g.lineWidth = 4; g.stroke();
  };
  // the trail: where the stick's center was, fainter frame by frame
  const trail = (pts: [number, number][], at: (x: number, y: number) => readonly [number, number], color: string, r: number) => {
    pts.forEach(([x, y], i) => {
      const [cx, cy] = at(x, y);
      g.globalAlpha = 0.7 * (1 - (i + 1) / (TRAIL + 1));
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = color; g.fill();
    });
    g.globalAlpha = 1;
  };
  // the main stick, white; the C-stick, yellow
  trail(s.trail.main, moMain, MO_WHITE, 9);
  moStick(g, "joystick-gate", "joystick-mask", "joystick", MO_WHITE, 22, 52, moMain(p?.x ?? 0, p?.y ?? 0));
  trail(s.trail.c, moC, MO_CSTICK, 7);
  moStick(g, "c-stick-gate", "c-stick-mask", "c-stick", MO_CSTICK, 176, 52, moC(p?.cx ?? 0, p?.cy ?? 0));
  for (const gh of s.ghosts) {
    ring(...moMain(gh.pad.x, gh.pad.y), 47, gh.color);
    ring(...moC(gh.pad.cx, gh.pad.cy), 34, gh.color);
  }
  // L and R: the outline, the click's line, the analog fill inside it
  const bar = (x: number, value: number, click: boolean, side: "l" | "r", ghosts: number[]) => {
    moDraw(g, "analog-outline", MO_WHITE, x + 6, 14, 116, 24);
    const lineX = side === "l" ? x + 14 + 88 : x + 14 + 12;
    g.strokeStyle = MO_WHITE; g.lineWidth = 4;
    g.beginPath(); g.moveTo(lineX, 20); g.lineTo(lineX, 32); g.stroke();
    g.save();
    g.beginPath(); g.roundRect(x + 14, 20, 100, 12, 6); g.clip();
    g.fillStyle = MO_WHITE;
    let v = Math.max(0, Math.min(1, value));
    if (click) { g.fillRect(side === "l" ? x + 14 + 88 : x + 14, 20, 12, 12); v = 1; }
    if (side === "l") g.fillRect(x + 14, 20, 88 * v, 12);
    else g.fillRect(x + 14 + 12 + 88 * (1 - v), 20, 88 * v, 12);
    g.restore();
    s.ghosts.forEach((gh, i) => {
      const gv = Math.max(0, Math.min(1, ghosts[i]));
      const gx = side === "l" ? x + 14 + 88 * gv : x + 14 + 12 + 88 * (1 - gv);
      g.strokeStyle = gh.color; g.lineWidth = 4;
      g.beginPath(); g.moveTo(gx, 16); g.lineTo(gx, 36); g.stroke();
    });
  };
  bar(24, p?.l ?? 0, !!p?.lDigital, "l", s.ghosts.map((x) => x.pad.l));
  bar(48 + 128, p?.r ?? 0, !!p?.rDigital, "r", s.ghosts.map((x) => x.pad.r));
  // the D-pad: its gate, and the pressed direction
  moDraw(g, "d-pad-gate", MO_WHITE, 108, 144, 128, 128);
  for (const [k, n] of MO_DPAD) if (p?.[k]) moDraw(g, `d-pad-pressed-${n}`, MO_WHITE, 108, 144, 128, 128);
  // the buttons: the outline, or the pressed picture while held
  for (const b of MO_BUTTONS) {
    moDraw(g, `${b.tex}-${p?.[b.k] ? "pressed" : "outline"}`, b.color, b.x, b.y, 128, 128);
    for (const gh of s.ghosts) {
      if (!gh.pad[b.k]) continue;
      const [x0, y0, x1, y1] = b.ring;
      g.beginPath();
      g.ellipse((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2 + 6, (y1 - y0) / 2 + 6, 0, 0, Math.PI * 2);
      g.strokeStyle = gh.color; g.lineWidth = 4; g.stroke();
    }
  }
}
