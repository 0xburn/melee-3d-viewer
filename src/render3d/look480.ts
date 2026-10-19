/* 3D replay viewer: the "480p look" - the picture as the console
 * makes it, for comparing with our own sharper one.
 *
 * What the game sets up (sysdolphin's video and initialize code, Melee's
 * render modes), in our words:
 * - It draws into a 640 x 480 frame buffer, 8 bits a channel (its pixel
 *   format is the 24-bit color one: no 6-bit color, so nothing to dither),
 *   with no anti-aliasing.
 * - Each frame is copied out to the video buffer through the copy's vertical
 *   filter. In progressive mode with the game's Deflicker option on (its
 *   default), the seven weights are 8, 8, 10, 12, 10, 8, 8 out of 64: a
 *   quarter of the line above, half of the line itself, a quarter of the line
 *   below - a slight vertical softening. (Deflicker off uses 0, 0, 21, 22,
 *   21, 0, 0: no softening.) Gamma stays 1.0.
 * - The video buffer holds YUV 4:2:2: full brightness per pixel, color
 *   once per pair, so color edges are softer than brightness edges.
 * - The video interface shows those 640 x 480 pixels over the whole 73:60
 *   picture (the camera's own aspect), which this does by stretching them
 *   over the canvas.
 *
 * So: the scene is drawn into a 640 x 480 target (bind()), then two small
 * passes do the copy - the vertical filter and the conversion to 8-bit YUV,
 * then the color shared by each pair of pixels and back to RGB - and one
 * more stretches the result over the canvas (present()) - or, with a TV
 * chosen, draws it as a CRT shows it (crt.ts). How the hardware averages a pair's
 * color is not in the game's code; this takes the pair's color with a
 * 1-2-1 weighting centered on its first pixel and blends between pairs for
 * the second, the usual way to halve and restore it.
 */

import { Crt, type CrtLook } from "./crt";

export const LOOK_W = 640, LOOK_H = 480;

const VS = `#version 300 es
out vec2 vUv;
void main() {
  // one triangle over the whole target
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// the copy, first half: the vertical filter (16, 32, 16 of 64, in 0..255 as
// the copy computes it; lines beyond the top and bottom repeat the edge),
// then each pixel's Y, Cb and Cr, 8 bits each
const COPY_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
out vec4 outColor;
const int H = ${LOOK_H};
void main() {
  int x = int(gl_FragCoord.x), y = int(gl_FragCoord.y);
  vec3 a = texelFetch(uSrc, ivec2(x, min(y + 1, H - 1)), 0).rgb;
  vec3 b = texelFetch(uSrc, ivec2(x, y), 0).rgb;
  vec3 c = texelFetch(uSrc, ivec2(x, max(y - 1, 0)), 0).rgb;
  vec3 f = floor((floor(a * 255.0 + 0.5) * 16.0 + floor(b * 255.0 + 0.5) * 32.0 + floor(c * 255.0 + 0.5) * 16.0) / 64.0);
  float Y = floor(0.257 * f.r + 0.504 * f.g + 0.098 * f.b + 16.5);
  vec2 C = vec2(-0.148 * f.r - 0.291 * f.g + 0.439 * f.b, 0.439 * f.r - 0.368 * f.g - 0.071 * f.b) + 128.0;
  outColor = vec4(Y, clamp(C, 0.0, 255.0), 255.0) / 255.0;
}`;

// the second half: the color shared by each pair - 1-2-1 over the pair's
// first pixel and its neighbors, rounded to 8 bits - blended between pairs
// for the second pixel, and back to RGB
const PAIR_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
out vec4 outColor;
const int W = ${LOOK_W};
vec2 cc(int x, int y) { return texelFetch(uSrc, ivec2(clamp(x, 0, W - 1), y), 0).gb * 255.0; }
vec2 pair(int x, int y) { return floor((cc(x - 1, y) + 2.0 * cc(x, y) + cc(x + 1, y)) * 0.25 + 0.5); }
void main() {
  int x = int(gl_FragCoord.x), y = int(gl_FragCoord.y);
  float Y = texelFetch(uSrc, ivec2(x, y), 0).r * 255.0;
  int x0 = x & ~1;
  vec2 C;
  if (x == x0) C = pair(x0, y);
  else {
    // x0 - 1 .. x0 + 3 once each
    vec2 m = cc(x0 - 1, y), p = cc(x0, y), q = cc(x0 + 1, y), r = cc(x0 + 2, y), s = cc(x0 + 3, y);
    vec2 c0 = floor((m + 2.0 * p + q) * 0.25 + 0.5);
    vec2 c1 = x0 + 2 < W ? floor((q + 2.0 * r + s) * 0.25 + 0.5) : c0;
    C = 0.5 * (c0 + c1);
  }
  float cb = C.x - 128.0, cr = C.y - 128.0, l = 1.164 * (Y - 16.0);
  vec3 rgb = vec3(l + 1.596 * cr, l - 0.813 * cr - 0.391 * cb, l + 2.018 * cb);
  outColor = vec4(clamp(rgb / 255.0, 0.0, 1.0), 1.0);
}`;

// the picture over the canvas
const SHOW_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = vec4(texture(uSrc, vUv).rgb, 1.0); }`;

interface Target { fb: WebGLFramebuffer; tex: WebGLTexture }

export class Look480 {
  private scene: Target & { depth: WebGLRenderbuffer };
  private yuv: Target;
  private copied: Target;
  private copyProg: WebGLProgram;
  private pairProg: WebGLProgram;
  private showProg: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  // the two passes' time on the graphics card, when the browser can say
  private timer: any;
  private queries: WebGLQuery[] = [];
  /** the time the copy and the stretch take, ms: the mean of the last 60
   *  measured (null: not known) */
  gpuMs: number | null = null;
  private samples: number[] = [];
  /** the TV it is shown on (crt.ts), or null: stretched as it is */
  private crt: Crt | null = null;

  constructor(private gl: WebGL2RenderingContext) {
    const tex = (filter: number) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, LOOK_W, LOOK_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const target = (t: WebGLTexture) => {
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return fb;
    };
    const st = tex(gl.NEAREST);
    const depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, LOOK_W, LOOK_H);
    const sfb = target(st);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("the 480p frame buffer");
    this.scene = { fb: sfb, tex: st, depth };
    const yt = tex(gl.NEAREST);
    this.yuv = { fb: target(yt), tex: yt };
    const ct = tex(gl.LINEAR);
    this.copied = { fb: target(ct), tex: ct };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const prog = (fs: string) => {
      const sh = (type: number, src: string) => {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
        return s;
      };
      const p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
      gl.useProgram(p);
      gl.uniform1i(gl.getUniformLocation(p, "uSrc"), 0);
      return p;
    };
    this.copyProg = prog(COPY_FS);
    this.pairProg = prog(PAIR_FS);
    this.showProg = prog(SHOW_FS);
    this.vao = gl.createVertexArray()!;
    this.timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  }

  /** the TV the picture is shown on from the next frame (null: none) */
  setCrt(look: CrtLook | null) {
    if (!look) { this.crt?.dispose(); this.crt = null; return; }
    if (this.crt) this.crt.look = look;
    else this.crt = new Crt(this.gl, look);
  }
  /** the CRT pass alone at w x h, ms a frame (null: no TV chosen) */
  benchCrt(w: number, h: number, n?: number): number | null {
    return this.crt ? this.crt.bench(this.copied.tex, w, h, n) : null;
  }

  /** draw the scene into the 640 x 480 frame buffer from here on */
  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fb);
    gl.viewport(0, 0, LOOK_W, LOOK_H);
  }

  /** the copy and the stretch over the canvas (w x h pixels); leaves the
   *  canvas bound, and GL state the renderer tracks changed (it forgets it) */
  present(w: number, h: number) {
    const gl = this.gl, t = this.timer;
    this.readTimer();
    let q: WebGLQuery | null = null;
    if (t && this.queries.length < 4) {
      q = gl.createQuery();
      gl.beginQuery(t.TIME_ELAPSED_EXT, q!);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.depthMask(false);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    // the copy, 640 x 480 to 640 x 480: filtered to YUV, then the pairs' color
    gl.viewport(0, 0, LOOK_W, LOOK_H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.yuv.fb);
    gl.useProgram(this.copyProg);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.copied.fb);
    gl.useProgram(this.pairProg);
    gl.bindTexture(gl.TEXTURE_2D, this.yuv.tex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (this.crt) this.crt.draw(this.copied.tex, w, h);
    else {
      // stretched over the canvas
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(this.showProg);
      gl.bindTexture(gl.TEXTURE_2D, this.copied.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    if (q) { gl.endQuery(t.TIME_ELAPSED_EXT); this.queries.push(q); }
  }

  private readTimer() {
    const gl = this.gl, t = this.timer;
    if (!t) return;
    while (this.queries.length) {
      const q = this.queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!gl.getParameter(t.GPU_DISJOINT_EXT)) {
        // the mean of the last 60 measured
        this.samples.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        if (this.samples.length > 60) this.samples.shift();
        this.gpuMs = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
      }
      gl.deleteQuery(q);
      this.queries.shift();
    }
  }

  dispose() {
    const gl = this.gl;
    for (const q of this.queries) gl.deleteQuery(q);
    this.crt?.dispose();
    gl.deleteFramebuffer(this.scene.fb); gl.deleteTexture(this.scene.tex); gl.deleteRenderbuffer(this.scene.depth);
    gl.deleteFramebuffer(this.yuv.fb); gl.deleteTexture(this.yuv.tex);
    gl.deleteFramebuffer(this.copied.fb); gl.deleteTexture(this.copied.tex);
    gl.deleteProgram(this.copyProg); gl.deleteProgram(this.pairProg); gl.deleteProgram(this.showProg);
    gl.deleteVertexArray(this.vao);
  }
}
