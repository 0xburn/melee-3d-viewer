/* The picture on the page: the game's 640 x 480 copy to the screen, shown flat on a 2D canvas, or through the CRT pass (render3d/crt.ts) on a
 * WebGL canvas when a TV is chosen. Both are the page's own display: the picture the renderer made (and the pictures the checks read) is the
 * same bytes either way.
 */
import { Crt, CRT_LOOKS, type CrtLook, type CrtPreset } from "../crt";

export class GxScreen {
  readonly flat: HTMLCanvasElement;
  readonly tube: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img = new ImageData(640, 480);
  private gl: WebGL2RenderingContext | null = null;
  private crt: Crt | null = null;
  private tex: WebGLTexture | null = null;
  private preset: CrtPreset = "off";
  private curve = 0;
  private last: Uint8Array | null = null;

  constructor(host: HTMLElement) {
    this.flat = document.createElement("canvas");
    this.flat.width = 640;
    this.flat.height = 480;
    this.flat.id = "screen";
    this.tube = document.createElement("canvas");
    this.tube.width = 1280;
    this.tube.height = 960;
    this.tube.style.display = "none";
    for (const c of [this.flat, this.tube]) Object.assign(c.style, { aspectRatio: "73 / 60", maxWidth: "100%", maxHeight: "100%", background: "#000" });
    host.append(this.flat, this.tube);
    this.ctx = this.flat.getContext("2d")!;
  }

  /** the TV the picture is shown on (off: flat), and how much its tube curves (0 flat to crt.ts CURVE_MAX) */
  setCrt(preset: CrtPreset, curve = this.curve): void {
    this.preset = preset;
    this.curve = curve;
    const on = preset !== "off";
    this.flat.style.display = on ? "none" : "";
    this.tube.style.display = on ? "" : "none";
    if (on && !this.gl) {
      this.gl = this.tube.getContext("webgl2", { preserveDrawingBuffer: true });
      if (!this.gl) { this.flat.style.display = ""; this.tube.style.display = "none"; return; }
      this.tex = this.gl.createTexture();
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.tex);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
    }
    if (on && this.gl) {
      const look: CrtLook = { ...CRT_LOOKS[preset as Exclude<CrtPreset, "off">], curve };
      if (this.crt) this.crt.look = look;
      else this.crt = new Crt(this.gl, look);
    }
    if (this.last) this.show(this.last);
  }

  show(rgba: Uint8Array): void {
    this.last = rgba.slice(0, 640 * 480 * 4);
    if (this.preset === "off" || !this.gl || !this.crt) {
      this.img.data.set(this.last);
      this.ctx.putImageData(this.img, 0, 0);
      return;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 640, 480, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.last);
    this.crt.draw(this.tex!, this.tube.width, this.tube.height);
  }
}
