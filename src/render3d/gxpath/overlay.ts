/* The Controller overlay for the game's draw-path player: the players' controllers (the M-Overlay skin, components/viewer/moverlay.ts) drawn
 * over the picture in a layer of their own, one beside each player's HUD slot, from the replay's inputs for the frame shown. The layer is above
 * the picture and never in it: the game's pictures are not touched. Inputs come from the tape's wire rows (src/sim/tape.ts).
 */
import { MO_VIEW, moPaint, TRAIL, type Shown } from "../../components/viewer/moverlay";
import { isOverlayShow, overlayPorts, type OverlayShow, type Pad } from "../../viewer/controllerInputs";
import { INPUT_PLAYER, offsetOf, readField, STREAM_FRAME } from "../../sim/wire";
import type { Tape } from "../../sim/tape";

export { isOverlayShow, type OverlayShow };
const PORT_COLORS = ["#e54c4c", "#4b4ce5", "#d9c33b", "#38b44a"];

/** Slippi's physical button bits (the pre-frame event's buttons word) */
const B = { dLeft: 0x1, dRight: 0x2, dDown: 0x4, dUp: 0x8, z: 0x10, rDigital: 0x20, lDigital: 0x40, a: 0x100, b: 0x200, x: 0x400, y: 0x800, start: 0x1000 };

/** a slot's pad from a wire stream frame (STREAM_FRAME.size bytes) */
export function padOfWire(frame: Uint8Array, slot: number): Pad {
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const base = offsetOf(STREAM_FRAME, "input") + INPUT_PLAYER.size * slot;
  const r = (name: string) => readField(v, INPUT_PLAYER, name, 0, base);
  const buttons = r("buttons"), axis = (n: number) => Math.max(-1, Math.min(1, n / 80));
  return {
    x: axis(r("nml_main_x")), y: axis(r("nml_main_y")), cx: axis(r("nml_c_x")), cy: axis(r("nml_c_y")),
    l: Math.min(1, r("l") / 140), r: Math.min(1, r("r") / 140), lDigital: !!(buttons & B.lDigital), rDigital: !!(buttons & B.rDigital),
    trigger: Math.min(1, Math.max(r("l"), r("r")) / 140),
    a: !!(buttons & B.a), b: !!(buttons & B.b), xb: !!(buttons & B.x), yb: !!(buttons & B.y), z: !!(buttons & B.z), start: !!(buttons & B.start),
    dUp: !!(buttons & B.dUp), dDown: !!(buttons & B.dDown), dLeft: !!(buttons & B.dLeft), dRight: !!(buttons & B.dRight),
  };
}

export class ControllerOverlay {
  readonly layer = document.createElement("div");
  private pads = new Map<number, { box: HTMLDivElement; canvas: HTMLCanvasElement }>();
  private you: number | null = null;
  private buf = new Uint8Array(STREAM_FRAME.size);

  constructor(host: HTMLElement, private tape: () => Tape | null) {
    Object.assign(this.layer.style, { position: "absolute", inset: "0", pointerEvents: "none", zIndex: "5" });
    this.layer.setAttribute("aria-hidden", "true");
    host.append(this.layer);
  }

  /** whose controllers to show (the replay must be loaded; call again after loading another) */
  set(show: OverlayShow, you: number | null = this.you): void {
    this.you = you;
    for (const p of this.pads.values()) p.box.remove();
    this.pads.clear();
    const t = this.tape();
    if (!t || show === "off") return;
    const ports = t.gx.ports;
    const on = new Set(overlayPorts(ports.map((p) => ({ playerIndex: p })), show, you));
    ports.forEach((port, slot) => {
      if (!on.has(port)) return;
      const box = document.createElement("div");
      // (the game puts a player's HUD in the slot of their port: the controller goes beside it)
      Object.assign(box.style, { position: "absolute", left: `${11.5 + 20 * port}%`, bottom: "24%", width: "17%", display: "flex", flexDirection: "column", alignItems: "center" });
      const name = document.createElement("div");
      name.textContent = `Player ${port + 1}`;
      Object.assign(name.style, { font: "700 12px/1.25 system-ui, sans-serif", color: PORT_COLORS[port] ?? "#f2f2f2", textShadow: "0 0 2px #000, 0 0 3px #000", marginBottom: "3px" });
      const art = document.createElement("div");
      Object.assign(art.style, { width: "100%", borderRadius: "6px", background: "rgba(6, 8, 14, 0.78)", outline: `1.5px solid ${PORT_COLORS[port] ?? "#f2f2f2"}`, overflow: "hidden" });
      const canvas = document.createElement("canvas");
      canvas.style.display = "block";
      art.append(canvas);
      box.append(name, art);
      this.layer.append(box);
      this.pads.set(slot, { box, canvas });
    });
  }

  /** the frame shown is tape row `row` */
  update(row: number): void {
    const t = this.tape();
    if (!t || !this.pads.size || row < 0) return;
    for (const [slot, { canvas }] of this.pads) {
      const w = canvas.parentElement!.getBoundingClientRect().width;
      if (!w) continue;
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round((pw * MO_VIEW.h) / MO_VIEW.w));
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; canvas.style.width = `${pw / dpr}px`; canvas.style.height = `${ph / dpr}px`; }
      t.frame(row, this.buf);
      const pad = padOfWire(this.buf, slot);
      const main: [number, number][] = [], c: [number, number][] = [];
      for (let f = row - 1; f >= Math.max(0, row - TRAIL); f--) {
        t.frame(f, this.buf);
        const q = padOfWire(this.buf, slot);
        main.push([q.x, q.y]);
        c.push([q.cx, q.cy]);
      }
      const shown: Shown = { player: slot, pad, trail: { main, c }, ghosts: [] };
      const g = canvas.getContext("2d")!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, pw, ph);
      const k = pw / MO_VIEW.w;
      g.setTransform(k, 0, 0, k, -MO_VIEW.x * k, -MO_VIEW.y * k);
      moPaint(g, shown);
    }
  }
}
