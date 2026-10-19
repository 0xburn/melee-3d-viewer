/// <reference lib="dom" />
/* 3D replay viewer: the Console view on a CRT - a Sony Trinitron.
 *
 * The 480p look (look480.ts) makes the picture the console sends to the TV;
 * this draws that picture as a Trinitron tube would show it, in place of the
 * plain stretch over the canvas. Our own implementation, written from how
 * the tubes work and from what the well-known CRT shaders describe (crt-geom,
 * crt-royale, Timothy Lottes's) - none of their code.
 *
 * What a Trinitron does to the picture, and how each is drawn here:
 * - The beam. Each of the 480 lines is a beam with a Gaussian profile across
 *   the line; a brighter beam is wider (its spot grows with the current), so
 *   dark lines show a gap between them and bright ones fill it. The
 *   profile is normalized, so the light a line gives stays its own however
 *   wide it spreads. Along the line the signal is band-limited: a Gaussian
 *   over the line's pixels, and red and blue land a little apart from green
 *   (convergence).
 * - Gamma. The game's colors were made for a TV: decoded as a tube does
 *   (BT.1886's 2.4, with a tube's small black level), mixed as light, and
 *   encoded for this screen with sRGB's curve.
 * - The aperture grille. Unbroken vertical red, green and blue phosphor
 *   stripes (not a shadow mask's dots or slots), and the one or two thin
 *   damper wires across the tube that hold the grille steady. The stripes
 *   are laid on the canvas's own pixels, a whole number of pixels a triad, each
 *   pixel's share of each stripe worked out once (maskWeights) - so they never
 *   beat against the screen's pixels. They fade where the picture is small,
 *   where a real tube's stripes are finer than a pixel.
 * - Halation. Light from the phosphors spreads in the glass: a blurred copy
 *   of the picture (a quarter the pixels, blurred one way then the other)
 *   takes a share of the light.
 * - The tube. Flat top to bottom, curved left to right (cylindrical), as
 *   much as the player's Curve slider says (each TV has its own, a slight
 *   one by default: CRT_LOOKS' curve). The curve is the last thing done to
 *   the picture: each screen pixel asks where on the tube it looks (bend),
 *   so the beams are drawn there and the grille stays on the screen's own
 *   pixels; the damper wires bow with the lines. The line art the player
 *   draws over items goes through the same map the other way (unbend) and
 *   is cut at the same edge (tubeOutline), so it stays on what it marks.
 *   Darker toward the corners, and the corners slightly rounded.
 * - The beam's width is never narrower than a screen pixel can show (each
 *   line's profile is widened by the pixel's own footprint), so the lines
 *   do not shimmer as the window changes size: small, they melt into an even
 *   picture, as a real set's do from across the room.
 */
export type CrtPreset = "off" | "trinitron" | "pvm";
export const CRT_PRESETS: readonly CrtPreset[] = ["off", "trinitron", "pvm"];
export const isCrtPreset = (v: unknown): v is CrtPreset => CRT_PRESETS.includes(v as CrtPreset);

/** how one TV draws the picture */
export interface CrtLook {
  beamDark: number;   // the beam's width (sigma, in line spacings) on a dark line
  beamBright: number; // and on a full-brightness one
  hSigma: number;     // the spread along a line, in the picture's pixels
  converge: number;   // red right and blue left of green, in the picture's pixels
  mask: number;       // the grille's strength, 0..1
  stripeFill: number; // how much of a triad its three stripes cover (the rest is the grille's gaps)
  glow: number;       // halation: the share of the light spread in the glass
  wires: number;      // how much a damper wire darkens the line it crosses
  vignette: number;   // darker toward the corners
  corner: number;     // the corners' rounding, a share of the picture's height
  curve: number;      // left-to-right curvature (0: flat): the recommended one, the slider's mark
  gain: number;       // brightness, for the light the grille takes
}

export const CRT_LOOKS: Record<Exclude<CrtPreset, "off">, CrtLook> = {
  // a consumer Trinitron (Sony's KV sets): a softer spot, lines that mostly
  // melt together, a visible glow, a slight curve
  trinitron: { beamDark: 0.30, beamBright: 0.50, hSigma: 0.45, converge: 0.16, mask: 0.32, stripeFill: 0.78,
               glow: 0.14, wires: 0.12, vignette: 0.16, corner: 0.018, curve: 0.05, gain: 1.12 },
  // a broadcast monitor (Sony's PVM): a tight spot, dark gaps between the
  // lines, sharp along them, little glow, nearly flat
  pvm: { beamDark: 0.21, beamBright: 0.38, hSigma: 0.32, converge: 0.05, mask: 0.42, stripeFill: 0.72,
         glow: 0.07, wires: 0.08, vignette: 0.08, corner: 0.010, curve: 0.015, gain: 1.16 },
};
/** the most the slider curves the tube: clearly bowed, never a fishbowl */
export const CURVE_MAX = 0.3;

/** the tube's map, as the shader has it: where a point of the screen (x, y,
 *  0..1 across and down or up) shows the picture from, 0..1 the same way */
export function bend(curve: number, x: number, y: number): [number, number] {
  const cx = x - 0.5, cy = y - 0.5;
  return [0.5 + cx * (1 + curve * 0.25 * cx * cx), 0.5 + cy * (1 + curve * cx * cx)];
}
/** and back: where a point of the picture shows on the screen (the line art
 *  over it). Across, a cubic that only rises: a few of Newton's steps */
export function unbend(curve: number, x: number, y: number): [number, number] {
  const px = x - 0.5;
  let cx = px;
  for (let i = 0; i < 5; i++) cx -= (cx + curve * 0.25 * cx * cx * cx - px) / (1 + curve * 0.75 * cx * cx);
  return [0.5 + cx, 0.5 + (y - 0.5) / (1 + curve * cx * cx)];
}
/** the picture's edge on a w x h screen as the tube shows it, rounded
 *  corners and all (corner: CrtLook's): an SVG path to cut the line art at */
export function tubeOutline(curve: number, corner: number, w: number, h: number): string {
  // the rounded rectangle the shader keeps (its corners in the picture's
  // own pixels), walked around, each point taken to the screen
  const r = corner * h, pts: string[] = [];
  const at = (x: number, y: number) => {
    const [u, v] = unbend(curve, x / w, y / h);
    pts.push(`${(u * w).toFixed(2)} ${(v * h).toFixed(2)}`);
  };
  const N = 32, A = 6;
  const corners: [number, number, number][] = [[w - r, r, -Math.PI / 2], [w - r, h - r, 0], [r, h - r, Math.PI / 2], [r, r, Math.PI]];
  const sides: [number, number, number, number][] = [[r, 0, w - r, 0], [w, r, w, h - r], [w - r, h, r, h], [0, h - r, 0, r]];
  for (let s = 0; s < 4; s++) {
    const [x0, y0, x1, y1] = sides[s];
    for (let i = 0; i < N; i++) at(x0 + (x1 - x0) * i / N, y0 + (y1 - y0) * i / N);
    const [cx, cy, a0] = corners[s];
    for (let i = 0; i < A; i++) {
      const a = a0 + (Math.PI / 2) * i / A;
      at(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
  }
  return `M${pts.join("L")}Z`;
}

const SRC_W = 640, SRC_H = 480;
const GLOW_W = SRC_W / 2, GLOW_H = SRC_H / 2;
const MAX_TRIAD = 8;

/** the pixels a triad of stripes takes on a canvas this wide (device pixels):
 *  three at the sizes players use, more on a very large canvas, so the
 *  stripes keep about the pitch of a living-room set's */
export function triadPixels(width: number): number {
  return Math.max(3, Math.min(MAX_TRIAD, Math.round(width / 560)));
}

/** each of a triad's n pixels: how much of the red, green and blue stripe it
 *  shows (each channel scaled so its mean over the triad is 1: the grille
 *  moves light around, the picture keeps its brightness). The stripes sit at
 *  the middle of each third, `fill` of the triad between them, with soft
 *  edges; a pixel's share is the stripe's coverage averaged over the pixel. */
export function maskWeights(n: number, fill: number): Float32Array {
  const out = new Float32Array(n * 3);
  const half = fill / 6, soft = 0.04, steps = 64;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let s = 0; s < steps; s++) {
        const t = (i + (s + 0.5) / steps) / n;
        let d = Math.abs(t - (c + 0.5) / 3);
        d = Math.min(d, 1 - d);
        sum += Math.min(1, Math.max(0, (half - d) / soft + 0.5));
      }
      out[i * 3 + c] = sum / steps;
    }
  }
  for (let c = 0; c < 3; c++) {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += out[i * 3 + c];
    mean /= n;
    for (let i = 0; i < n; i++) out[i * 3 + c] = mean > 0 ? out[i * 3 + c] / mean : 1;
  }
  return out;
}

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// the tube's response, the picture's values to light: BT.1886 (the standard
// model of a CRT - a 2.4 power with the tube's own black level, here 0.02%
// of its white, taken back off so black stays this screen's black): deep
// blacks without crushing the darks into them
export const TUBE_BLACK = 0.0002;
const LB = Math.pow(TUBE_BLACK, 1 / 2.4);
const TUBE_A = Math.pow(1 - LB, 2.4), TUBE_B = LB / (1 - LB);
/** one value of the picture (0..1) as the tube's light (0..1), as the shader has it */
export const tubeLight = (v: number) => TUBE_A * Math.pow(v + TUBE_B, 2.4) - TUBE_BLACK;
const LIN = `const float GAMMA = 2.4;
vec3 lin(vec3 c) { return ${TUBE_A.toFixed(7)} * pow(c + ${TUBE_B.toFixed(7)}, vec3(GAMMA)) - ${TUBE_BLACK.toFixed(7)}; }`;

// halation, first step: the picture as light at half the size (each 2 x 2
// averaged), kept as its square root so 8 bits a channel hold the darks
const GLOW_DOWN_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
out vec4 outColor;
${LIN}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  vec3 a = lin(texelFetch(uSrc, p, 0).rgb) + lin(texelFetch(uSrc, p + ivec2(1, 0), 0).rgb)
         + lin(texelFetch(uSrc, p + ivec2(0, 1), 0).rgb) + lin(texelFetch(uSrc, p + ivec2(1, 1), 0).rgb);
  outColor = vec4(sqrt(a * 0.25), 1.0);
}`;

// then blurred one way (uDir), a Gaussian of 2.5 of its pixels (5 of the picture's)
const GLOW_BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform ivec2 uDir;
out vec4 outColor;
const int W = ${GLOW_W}, H = ${GLOW_H};
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 acc = vec3(0.0);
  float ws = 0.0;
  for (int k = -6; k <= 6; k++) {
    float w = exp(-0.5 * float(k * k) / 6.25);
    ivec2 q = clamp(p + uDir * k, ivec2(0), ivec2(W - 1, H - 1));
    vec3 c = texelFetch(uSrc, q, 0).rgb;
    acc += c * c * w;
    ws += w;
  }
  outColor = vec4(sqrt(acc / ws), 1.0);
}`;

// the tube
const TUBE_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;   // the console's picture, 640 x 480
uniform sampler2D uGlow;  // its halation (GLOW_*)
uniform vec2 uOut;        // the canvas, pixels
uniform vec3 uMask[${MAX_TRIAD}];
uniform int uMaskN;
uniform float uMaskK;
uniform vec2 uBeam;       // the beam's sigma, dark and bright, line spacings
uniform float uPre;       // a screen pixel's own footprint, line spacings
uniform float uHSig;
uniform float uConv;
uniform float uGlowK;
uniform float uWires;
uniform float uWirePx;
uniform float uVig;
uniform float uCorner;
uniform float uCurve;
uniform float uGain;
out vec4 outColor;
const int W = ${SRC_W}, H = ${SRC_H};
${LIN}

// a line's color at x (the picture's pixels, centers at whole numbers): the
// band-limited signal along it, red and blue converged a little off green
vec3 along(int y, float x) {
  float x0 = floor(x), f = x - x0;
  vec3 acc = vec3(0.0), ws = vec3(0.0);
  float k2 = -0.5 / (uHSig * uHSig);
  vec3 shift = vec3(uConv, 0.0, -uConv);
  for (int k = -1; k <= 2; k++) {
    int xi = int(x0) + k;
    // (past the picture's edges the beam is blanked)
    vec3 c = xi >= 0 && xi < W ? lin(texelFetch(uSrc, ivec2(xi, y), 0).rgb) : vec3(0.0);
    vec3 d = vec3(float(k) - f) + shift;
    vec3 w = exp(k2 * d * d);
    acc += c * w;
    ws += w;
  }
  return acc / ws;
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

vec3 srgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 here = gl_FragCoord.xy / uOut;
  vec2 uv = here;
  vec2 cc = uv - 0.5;
  if (uCurve > 0.0) {
    // a cylinder curved left to right: lines toward the sides bow (bend)
    uv.x = 0.5 + cc.x * (1.0 + uCurve * 0.25 * cc.x * cc.x);
    uv.y = 0.5 + cc.y * (1.0 + uCurve * cc.x * cc.x);
  }
  // the rounded corners (outside: the tube's black)
  vec2 px = uv * uOut;
  float r = uCorner * uOut.y;
  vec2 e = max(vec2(r) - min(px, uOut - px), 0.0);
  float inside = clamp(r - length(e) + 0.5, 0.0, 1.0);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) inside = 0.0;

  vec2 s = uv * vec2(float(W), float(H)) - 0.5;
  int n = int(floor(s.y + 0.5));
  vec3 col = vec3(0.0);
  for (int k = -1; k <= 1; k++) {
    int y = n + k;
    if (y < 0 || y >= H) continue;
    vec3 c = along(y, s.x);
    float d = s.y - float(y);
    // brighter: a wider spot; never narrower than a screen pixel can show
    vec3 sig = mix(vec3(uBeam.x), vec3(uBeam.y), sqrt(c));
    sig = sqrt(sig * sig + uPre * uPre);
    col += c * exp(-0.5 * d * d / (sig * sig)) / sig;
  }
  col *= 0.3989423;

  // the aperture grille: this pixel's share of each stripe
  int mi = int(gl_FragCoord.x) % uMaskN;
  col *= mix(vec3(1.0), uMask[mi], uMaskK);

  // halation
  vec3 g = texture(uGlow, uv).rgb;
  col = mix(col, g * g, uGlowK);

  // the damper wires, a third of the way from the top and from the bottom,
  // bowed with the lines (flat, fy is this pixel's own row exactly)
  float y1 = floor(uOut.y / 3.0) + 0.5, y2 = floor(uOut.y * 2.0 / 3.0) + 0.5;
  float fy = gl_FragCoord.y + (uv.y - here.y) * uOut.y;
  float wd = min(abs(fy - y1), abs(fy - y2));
  col *= 1.0 - uWires * clamp(uWirePx + 0.5 - wd, 0.0, 1.0);

  float vig = 1.0 - uVig * pow(length(cc) * 1.41421, 3.0);
  col *= uGain * vig * inside;
  // (a little noise against banding in the glow and the vignette)
  outColor = vec4(srgb(col) + (hash(gl_FragCoord.xy) - 0.5) / 255.0, 1.0);
}`;

interface Target { fb: WebGLFramebuffer; tex: WebGLTexture }

/** the CRT pass: draws the console's 640 x 480 picture onto the canvas as the TV shows it */
export class Crt {
  private down: Target;
  private blurA: Target;
  private blurB: Target;
  private downProg: WebGLProgram;
  private blurProg: WebGLProgram;
  private tubeProg: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private uDir: WebGLUniformLocation | null;
  private maskFor = "";

  constructor(private gl: WebGL2RenderingContext, public look: CrtLook) {
    const tex = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, GLOW_W, GLOW_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return { fb, tex: t };
    };
    this.down = tex();
    this.blurA = tex();
    this.blurB = tex();
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
    this.downProg = prog(GLOW_DOWN_FS);
    this.blurProg = prog(GLOW_BLUR_FS);
    this.uDir = gl.getUniformLocation(this.blurProg, "uDir");
    this.tubeProg = prog(TUBE_FS);
    gl.uniform1i(gl.getUniformLocation(this.tubeProg, "uGlow"), 1);
    for (const n of ["uOut", "uMask", "uMaskN", "uMaskK", "uBeam", "uPre", "uHSig", "uConv", "uGlowK", "uWires",
                     "uWirePx", "uVig", "uCorner", "uCurve", "uGain"]) {
      this.u[n] = gl.getUniformLocation(this.tubeProg, n);
    }
  }

  /** the picture (src: 640 x 480) onto the framebuffer bound for it, w x h
   *  pixels; a vertex array with nothing in it bound, depth, blending and
   *  culling off. Leaves texture unit 0 active and the target bound. */
  draw(src: WebGLTexture, w: number, h: number, target: WebGLFramebuffer | null = null) {
    const gl = this.gl, L = this.look, u = this.u;
    // halation: down, across, up
    gl.activeTexture(gl.TEXTURE0);
    gl.viewport(0, 0, GLOW_W, GLOW_H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.down.fb);
    gl.useProgram(this.downProg);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(this.blurProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurA.fb);
    gl.uniform2i(this.uDir, 1, 0);
    gl.bindTexture(gl.TEXTURE_2D, this.down.tex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurB.fb);
    gl.uniform2i(this.uDir, 0, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.blurA.tex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // the tube
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.tubeProg);
    const n = triadPixels(w);
    const key = `${n}:${L.stripeFill}`;
    if (key !== this.maskFor) {
      this.maskFor = key;
      gl.uniform3fv(u.uMask, maskWeights(n, L.stripeFill));
      gl.uniform1i(u.uMaskN, n);
    }
    gl.uniform2f(u.uOut, w, h);
    // the grille fades out on a small picture, where a tube's stripes are
    // finer than a pixel: full from about a 1000-pixel-wide picture
    const k = Math.min(1, Math.max(0, (w - 380) / 620));
    gl.uniform1f(u.uMaskK, L.mask * k * k * (3 - 2 * k));
    gl.uniform2f(u.uBeam, L.beamDark, L.beamBright);
    // (a box a pixel tall has a sigma of 0.29 of it; a little more, so no
    // line is ever sharper than the screen can sample)
    gl.uniform1f(u.uPre, 0.36 * SRC_H / h);
    gl.uniform1f(u.uHSig, L.hSigma);
    gl.uniform1f(u.uConv, L.converge);
    gl.uniform1f(u.uGlowK, L.glow);
    gl.uniform1f(u.uWires, L.wires);
    // (a wire a little over one pixel at 1080 lines and up, never under one)
    gl.uniform1f(u.uWirePx, Math.max(0.5, h / 2000));
    gl.uniform1f(u.uVig, L.vignette);
    gl.uniform1f(u.uCorner, L.corner);
    gl.uniform1f(u.uCurve, L.curve);
    gl.uniform1f(u.uGain, L.gain);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.blurB.tex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** the pass alone, timed: n draws onto a w x h target of its own, ms each
   *  (the graphics card's work waited for: the time it takes, not the time
   *  to queue it) */
  bench(src: WebGLTexture, w: number, h: number, n = 120): number {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.disable(gl.STENCIL_TEST);
    const px = new Uint8Array(4);
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (let i = 0; i < 10; i++) this.draw(src, w, h, fb);
    sync();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) this.draw(src, w, h, fb);
    sync();
    const ms = (performance.now() - t0) / n;
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb); gl.deleteTexture(t); gl.deleteVertexArray(vao);
    gl.enable(gl.DEPTH_TEST);
    return ms;
  }

  dispose() {
    const gl = this.gl;
    for (const t of [this.down, this.blurA, this.blurB]) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); }
    gl.deleteProgram(this.downProg); gl.deleteProgram(this.blurProg); gl.deleteProgram(this.tubeProg);
  }
}

/** the checks (tests): the pass on a made-up picture of its
 *  own - ramps, bars and a checkerboard, the same every time - drawn at
 *  w x h with this look and read back, bottom row first. Leaves GL state
 *  the caller tracks changed. */
export function crtPixels(gl: WebGL2RenderingContext, look: CrtLook, w: number, h: number): Uint8Array {
  const img = new Uint8Array(SRC_W * SRC_H * 4);
  for (let y = 0; y < SRC_H; y++) {
    for (let x = 0; x < SRC_W; x++) {
      const i = (y * SRC_W + x) * 4;
      img[i] = (x * 255 / (SRC_W - 1)) | 0;
      img[i + 1] = ((x >> 5) + (y >> 5)) & 1 ? 230 : 25;
      img[i + 2] = (y * 255 / (SRC_H - 1)) | 0;
      img[i + 3] = 255;
    }
  }
  const tex = (tw: number, th: number, data: Uint8Array | null) => {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  };
  const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL), pre = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  const src = tex(SRC_W, SRC_H, img), out = tex(w, h, null);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, pre);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.disable(gl.STENCIL_TEST);
  const crt = new Crt(gl, look);
  crt.draw(src, w, h, fb);
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  crt.dispose();
  gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb); gl.deleteTexture(src); gl.deleteTexture(out); gl.deleteVertexArray(vao);
  gl.enable(gl.DEPTH_TEST);
  return px;
}
