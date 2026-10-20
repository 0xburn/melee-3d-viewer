/* 3D replay viewer: a small WebGL2 renderer for posed HSD models.
 *
 * Skinning happens on the GPU: each piece of mesh is uploaded once, and a
 * draw hands the shader the (up to ten) matrices its vertices pick from.
 *
 * Materials are drawn as the GameCube draws them (gx.ts has the math): the
 * vertex shader lights each vertex with the stage's lights (GX's color
 * channels, with their attenuation, and the specular channel) and makes the
 * texture coordinates; the fragment shader runs the texture environment HSD
 * builds for the material - the textures laid on the diffuse color, the
 * lighting, the specular term, the textures laid on after it - then the
 * alpha test and the fog. Pixel engine settings (blend, depth test and
 * write, color writes) come from the material as HSD sets them. Textures
 * are filtered as the file says, with the file's own mip levels.
 */
import { Archive, Image, MObj, TObj, Tlut, decodeImage } from "./hsd";
import { DrawGroup, Drawable, MatState, Skeleton, TexState } from "./skeleton";
import { Mat, invert, lookAt, mul } from "./math";
import { SHADOW_SIZE, shadowGray } from "./shadow";
import type { Tint as ColTint } from "./fx/colanim";
import { Fog, MatProgram, RENDER, compileMaterial, defaultAlphaTest, minFilter, mipLevels, textureMatrix } from "./gx";
import { DEFAULT_LIGHTS, LightSet, Lighting } from "./lightset";
import { LOOK_H, LOOK_W, Look480 } from "./look480";
import { GamePicture, type PictureOptions } from "./picture";
import { CRT_LOOKS, type CrtPreset, crtPixels } from "./crt";
import { drawingSize } from "./drawsize";
import { pageWeak } from "../state/pageCache";
import { idle } from "./idle";

const tmpM = new Float32Array(16);
const MIRROR_W = 80, MIRROR_H = 60;
// the fighters' shadows a material takes, at most, and their texture units (after the material's four)
const MAX_SHADOWS = 4, SHADOW_UNIT = 4;

// uMatF (vec4s): 0 diffuse.rgb alpha | 1 ambient.rgb shininess | 2 specular.rgb
//   | 3 each sampler's blend | 4 each sampler's LOD bias | 5 alpha test refs
//   (0..255) | 6..17 each sampler's texture matrix (3 rows) | 18..29 each
//   sampler's own TEV colors: konst, tev0, tev1
// uMatI (ivec4s): 0 stages, channel, flags (1 vertex base, 2 lit, 4
//   specular), alpha test (comp0 | comp1 << 3 | op << 6) | 1 each sampler's
//   coordinates (TexGen, -1 unused) | 2..5 each sampler's own TEV: color
//   inputs a..d (a byte each), alpha inputs, color mode, alpha mode (op |
//   bias << 4 | scale << 6 | clamp << 8 | on << 9) | 6, 7 the stages (tex |
//   color map << 2 | (alpha map + 1) << 6 | phase << 10)
const MATF = 30, MATI = 8;
// (a uniform block: each material keeps its own buffer of them, sent again
// only when something in it changes, and a draw only binds it)
const MAT_DECL = `layout(std140) uniform Mat {\n  vec4 uMatF[${MATF}];\n  ivec4 uMatI[${MATI}];\n};`;
const MAT_BYTES = (MATF + MATI) * 16;

const VS = `#version 300 es
in vec3 aPos; in vec3 aNrm; in vec2 aUv0; in vec2 aUv1; in vec4 aClr; in float aMtx; in vec3 aBin; in vec3 aTan;
uniform mat4 uViewProj;
uniform mat4 uView;
uniform mat4 uMats[10];
uniform float uInflate; // a ghost's outline: pushed out along the normal, world units
uniform float uPointSize; // a point list's points, pixels across (GX's point size)
${MAT_DECL}
// the lights (lightset.ts): the ambient, then each light's place (w 1) or
// the way to it (w 0), axis, color, angle attenuation (w: 1 diffuse, 2
// specular) and distance attenuation
uniform vec3 uAmbLight;
uniform int uNumLights;
uniform vec4 uLPos[8]; uniform vec4 uLAxis[8]; uniform vec4 uLCol[8]; uniform vec4 uLA[8]; uniform vec4 uLK[8];
uniform vec3 uEye;    // the camera, world space
uniform vec3 uSpecAt; // the drawn joint: the specular half-way vectors are aimed from it
// a fighter's color animation (fx/colanim.ts): a light from uOverDir that
// adds its color by its strength (mode 1) or lights the fighter as one more
// light (mode 2)
uniform vec4 uOverLight;
uniform vec3 uOverDir;
uniform int uOverMode;
// (each texture's s, t and q: GX divides by q at each pixel, which a
// projected texture - the stage's mirror image - needs across big triangles)
out vec4 vRas0; out vec3 vRas1; out vec3 vT0; out vec3 vT1; out vec3 vT2; out vec3 vT3;
out vec3 vNrmV; out vec3 vPosV; out vec3 vOverAdd; out vec3 vPosW;
out vec2 vBump; // an emboss bump map's coordinates, shifted toward the first diffuse light

vec3 texGen(int i, vec2 uv0, vec2 uv1, vec3 nv, vec4 W) {
  int kind = uMatI[1][i];
  vec4 r0 = uMatF[6 + i * 3], r1 = uMatF[7 + i * 3], r2 = uMatF[8 + i * 3];
  if (kind == 4) {
    // where the point falls in the stage's mirror image (projective)
    float q = dot(r2, W);
    return vec3(dot(r0, W), dot(r1, W), abs(q) > 1e-6 ? q : 1e-6);
  }
  if (kind == 2) {
    // the view-space normal through HSD's reflection matrix: (x, y, z, 1)
    // times rows of (m0 / 2, -m1 / 2, 0, m0 / 2 + m1 / 2 + m2 + m3)
    vec3 m0 = vec3(0.5 * r0.x, -0.5 * r0.y, 0.0), m1 = vec3(0.5 * r1.x, -0.5 * r1.y, 0.0), m2 = vec3(0.5 * r2.x, -0.5 * r2.y, 0.0);
    float s = dot(m0, nv) + 0.5 * r0.x + 0.5 * r0.y + r0.z + r0.w;
    float t = dot(m1, nv) + 0.5 * r1.x + 0.5 * r1.y + r1.z + r1.w;
    float w = dot(m2, nv) + 0.5 * r2.x + 0.5 * r2.y + r2.z + r2.w;
    return vec3(s, t, abs(w) > 1e-6 ? w : 1.0);
  }
  if (kind == 3) {
    // the first infinite light's highlight: half-way between it and the view
    vec3 L = vec3(0.0, 0.0, 1.0);
    for (int k = 0; k < 8; k++) {
      if (k >= uNumLights) break;
      if (uLPos[k].w == 0.0) { L = -uLPos[k].xyz; break; }
    }
    vec3 h = normalize(mat3(uView) * L + vec3(0.0, 0.0, -1.0));
    float e = 0.5 - 0.5 * dot(h, nv);
    return vec3(r0.x * e + r0.w, r1.x * e + r1.w, 1.0);
  }
  vec2 uv = kind == 1 ? uv1 : uv0;
  return vec3(dot(r0, vec4(uv, 1.0, 1.0)), dot(r1, vec4(uv, 1.0, 1.0)), 1.0);
}

// GX's color channel: the ambient, then each diffuse light by its angle and
// distance attenuation and the normal's turn to it, clamped
vec3 diffuseLights(vec3 W, vec3 N) {
  vec3 L = uAmbLight * uMatF[1].rgb;
  for (int k = 0; k < 8; k++) {
    if (k >= uNumLights) break;
    vec4 a = uLA[k];
    if ((int(a.w) & 1) == 0) continue;
    vec4 p = uLPos[k];
    vec3 ld = p.xyz; float dist = 0.0;
    if (p.w != 0.0) { vec3 v = p.xyz - W; dist = length(v); ld = v / max(dist, 1e-6); }
    float c = max(dot(ld, uLAxis[k].xyz), 0.0);
    vec3 kk = uLK[k].xyz;
    float att = max(a.x + a.y * c + a.z * c * c, 0.0) / max(kk.x + kk.y * dist + kk.z * dist * dist, 1e-6);
    L += uLCol[k].rgb * (att * max(dot(N, ld), 0.0));
  }
  if (uOverMode == 2) L += uOverLight.rgb * max(dot(N, uOverDir), 0.0);
  return min(L, vec3(1.0));
}

// the specular channel: each specular light aimed along the half-way vector
// between it and the eye as seen from the joint, attenuated by the material's
// shininess as GX's specular lights are
vec3 specularLights(vec3 W, vec3 N) {
  vec3 S = vec3(0.0);
  vec3 cdir = normalize(uSpecAt - uEye);
  float k0 = 0.5 * uMatF[1].w, k2 = 1.0 - k0;
  for (int k = 0; k < 8; k++) {
    if (k >= uNumLights) break;
    if ((int(uLA[k].w) & 2) == 0) continue;
    vec4 p = uLPos[k];
    vec3 lv = p.w == 0.0 ? -p.xyz : normalize(uSpecAt - p.xyz);
    vec3 h = -normalize(lv + cdir);
    vec3 ld = p.w == 0.0 ? p.xyz : normalize(p.xyz - W);
    float nl = dot(N, ld);
    float c = nl >= 0.0 ? max(dot(N, h), 0.0) : 0.0;
    float att = c * c / max(k0 + k2 * c * c, 1e-6);
    S += uLCol[k].rgb * (att * max(nl, 0.0));
  }
  return min(S, vec3(1.0));
}

void main() {
  mat4 M = uMats[int(aMtx + 0.5)];
  vec3 n = mat3(M) * aNrm;
  vec3 N = normalize(n + vec3(0.0, 0.0, 1e-9));
  vec4 w = M * vec4(aPos, 1.0);
  if (uInflate > 0.0) w.xyz += normalize(n + vec3(0.0, 0.0, 1e-4)) * uInflate;
  vec3 nv = normalize(mat3(uView) * N);
  vNrmV = nv;
  vPosV = (uView * w).xyz;
  vPosW = w.xyz;
  ivec4 m0 = uMatI[0];
  vRas0 = vec4(1.0);
  if (m0.y == 1) vRas0 = aClr;
  else if (m0.y == 2) vRas0 = vec4(diffuseLights(w.xyz, N), 1.0);
  vRas1 = (m0.z & 4) != 0 ? specularLights(w.xyz, N) : vec3(0.0);
  vOverAdd = uOverMode == 1 ? uOverLight.rgb * (uOverLight.a * max(dot(N, uOverDir), 0.0)) : vec3(0.0);
  vT0 = texGen(0, aUv0, aUv1, nv, w);
  vT1 = texGen(1, aUv0, aUv1, nv, w);
  vT2 = texGen(2, aUv0, aUv1, nv, w);
  vT3 = texGen(3, aUv0, aUv1, nv, w);
  // GX's bump texture coordinates: the map's own, moved by the first
  // diffuse light's direction along the tangent and the binormal
  int bs = ((m0.z >> 4) & 7) - 1;
  vBump = vec2(0.0);
  if (bs >= 0) {
    vec3 L = vec3(0.0);
    for (int k = 0; k < 8; k++) {
      if (k >= uNumLights) break;
      if ((int(uLA[k].w) & 1) == 0) continue;
      vec4 p = uLPos[k];
      L = p.w == 0.0 ? p.xyz : normalize(p.xyz - w.xyz);
      break;
    }
    vec3 b3 = bs == 0 ? vT0 : bs == 1 ? vT1 : bs == 2 ? vT2 : vT3;
    vec2 base = b3.xy / b3.z;
    vBump = base + vec2(dot(mat3(M) * aTan, L), dot(mat3(M) * aBin, L));
  }
  gl_Position = uViewProj * w;
  gl_PointSize = uPointSize;
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
in vec4 vRas0; in vec3 vRas1; in vec3 vT0; in vec3 vT1; in vec3 vT2; in vec3 vT3;
in vec3 vNrmV; in vec3 vPosV; in vec3 vOverAdd; in vec2 vBump; in vec3 vPosW;
uniform sampler2D uTex0; uniform sampler2D uTex1; uniform sampler2D uTex2; uniform sampler2D uTex3;
// the fighters' shadows (shadow.ts): each a picture and its world-to-(s, t)
// matrix, laid on a material that takes them (RENDER_SHADOW); and a shadow
// being made: every pixel one flat gray, nothing else read (uCast.a > 0)
uniform sampler2D uShadow0; uniform sampler2D uShadow1; uniform sampler2D uShadow2; uniform sampler2D uShadow3;
uniform mat4 uShadowM[4];
uniform int uShadowN;
uniform vec4 uCast;
${MAT_DECL}
uniform vec4 uTint; // a ghost: rgb, strength in a (0: not a ghost)
uniform vec4 uFlat; // one flat color (a ghost's outline), when a > 0
uniform vec4 uOutline; // the lit color toward rgb by a, when a > 0 (Mr. Game & Watch's outline: ftmaterial.c)
uniform float uFlash; // toward white (an L-cancel's flash), 0..1
uniform vec4 uOverColor; // a color animation's color, blended over by its alpha
uniform vec4 uFog; // GX fog: type (0 none), start, end (eye depth)
uniform vec3 uFogColor;
out vec4 outColor;

// a texture's own TEV stage (HSD_TObjTevDesc): GX_CC_* / GX_CA_* inputs, or
// TOBJ_TEV_* picks of its konst, tev0 and tev1 colors
vec3 tevC(int code, vec4 t, int i) {
  if (code == 8) return t.rgb;
  if (code == 9) return vec3(t.a);
  if (code == 12) return vec3(1.0);
  if (code == 13) return vec3(0.5);
  if (code < 0x80) return vec3(0.0);
  vec4 k = uMatF[18 + i * 3], r0 = uMatF[19 + i * 3], r1 = uMatF[20 + i * 3];
  if (code == 0x80) return k.rgb;
  if (code == 0x81) return vec3(k.r);
  if (code == 0x82) return vec3(k.g);
  if (code == 0x83) return vec3(k.b);
  if (code == 0x84) return vec3(k.a);
  if (code == 0x85) return r0.rgb;
  if (code == 0x86) return vec3(r0.a);
  if (code == 0x87) return r1.rgb;
  if (code == 0x88) return vec3(r1.a);
  return vec3(0.0);
}
float tevA(int code, vec4 t, int i) {
  if (code == 4) return t.a;
  if (code < 0x40) return 0.0;
  vec4 k = uMatF[18 + i * 3], r0 = uMatF[19 + i * 3], r1 = uMatF[20 + i * 3];
  if (code == 0x40) return k.r;
  if (code == 0x41) return k.g;
  if (code == 0x42) return k.b;
  if (code == 0x43) return k.a;
  if (code == 0x44) return r0.a;
  if (code == 0x45) return r1.a;
  return 0.0;
}
int byteOf(int v, int b) { return (v >> (8 * b)) & 0xff; }
vec4 tevStep(vec4 d, vec4 abc0, vec4 abc1, vec4 c, int mode) {
  // d + lerp(a, b, c) (or minus), biased, scaled, clamped
  vec4 m = mix(abc0, abc1, c);
  vec4 v = (mode & 15) == 1 ? d - m : d + m;
  int bias = (mode >> 4) & 3, scale = (mode >> 6) & 3;
  if (bias == 1) v += 0.5; else if (bias == 2) v -= 0.5;
  if (scale == 1) v *= 2.0; else if (scale == 2) v *= 4.0; else if (scale == 3) v *= 0.5;
  return ((mode >> 8) & 1) != 0 ? clamp(v, 0.0, 1.0) : v;
}
vec4 tevPre(int i, vec4 t) {
  int cm = uMatI[4][i], am = uMatI[5][i];
  vec4 o = t;
  if (((cm >> 9) & 1) != 0) {
    int ci = uMatI[2][i];
    vec3 a = tevC(byteOf(ci, 0), t, i), b = tevC(byteOf(ci, 1), t, i);
    vec3 c = tevC(byteOf(ci, 2), t, i), d = tevC(byteOf(ci, 3), t, i);
    o.rgb = tevStep(vec4(d, 0.0), vec4(a, 0.0), vec4(b, 0.0), vec4(c, 0.0), cm).rgb;
  }
  if (((am >> 9) & 1) != 0) {
    int ai = uMatI[3][i];
    float a = tevA(byteOf(ai, 0), t, i), b = tevA(byteOf(ai, 1), t, i);
    float c = tevA(byteOf(ai, 2), t, i), d = tevA(byteOf(ai, 3), t, i);
    o.a = tevStep(vec4(d), vec4(a), vec4(b), vec4(c), am).a;
  }
  return o;
}
vec4 sampleTex(int i) {
  float bias = uMatF[4][i];
  vec4 t;
  if (i == 0) t = texture(uTex0, vT0.xy / vT0.z, bias);
  else if (i == 1) t = texture(uTex1, vT1.xy / vT1.z, bias);
  else if (i == 2) t = texture(uTex2, vT2.xy / vT2.z, bias);
  else t = texture(uTex3, vT3.xy / vT3.z, bias);
  return tevPre(i, t);
}
// a texture's color map and alpha map (HSD's TObjMakeTExp), laid on
vec3 colorMap(int op, vec3 c, vec4 t, float b) {
  if (op == 1) return mix(c, t.rgb, t.a);
  if (op == 2) return mix(c, t.rgb, t.rgb);
  if (op == 3) return mix(c, t.rgb, b);
  if (op == 4) return c * t.rgb;
  if (op == 5) return t.rgb;
  if (op == 7) return c + t.rgb;
  if (op == 8) return c - t.rgb;
  return c;
}
float alphaMap(int op, float a, float t, float b) {
  if (op == 1) return mix(a, t, t);
  if (op == 2) return mix(a, t, b);
  if (op == 3) return a * t;
  if (op == 4) return t;
  if (op == 6) return a + t;
  if (op == 7) return a - t;
  return a;
}
bool cmp(int f, float a, float r) {
  if (f == 0) return false;
  if (f == 1) return a < r;
  if (f == 2) return a == r;
  if (f == 3) return a <= r;
  if (f == 4) return a > r;
  if (f == 5) return a != r;
  if (f == 6) return a >= r;
  return true;
}
void main() {
  if (uCast.a > 0.0) { outColor = vec4(uCast.rgb, 1.0); return; }
  ivec4 m0 = uMatI[0];
  int nSt = m0.x, flags = m0.z;
  vec4 tx[4];
  for (int i = 0; i < 4; i++) tx[i] = uMatI[1][i] >= 0 ? sampleTex(i) : vec4(0.0);
  vec3 c = (flags & 1) != 0 ? vRas0.rgb : uMatF[0].rgb;
  float a = (flags & 1) != 0 ? vRas0.a : uMatF[0].a;
  vec3 sp = uMatF[2].rgb;
  for (int phase = 0; phase < 4; phase++) {
    if (phase == 1 && (flags & 4) == 0) continue;
    for (int s = 0; s < 8; s++) {
      if (s >= nSt) break;
      int d = s < 4 ? uMatI[6][s] : uMatI[7][s - 4];
      if (((d >> 10) & 3) != phase) continue;
      int i = d & 3;
      vec4 t = tx[i];
      float b = uMatF[3][i];
      int am = ((d >> 6) & 15) - 1;
      if (phase == 1) sp = clamp(colorMap((d >> 2) & 15, sp, t, b), 0.0, 1.0);
      else c = clamp(colorMap((d >> 2) & 15, c, t, b), 0.0, 1.0);
      if (am >= 0) a = clamp(alphaMap(am, a, t.a, b), 0.0, 1.0);
    }
    // after the diffuse textures, the lighting; after the specular ones, the
    // specular term added
    if (phase == 0 && (flags & 2) != 0) { c *= vRas0.rgb; a *= vRas0.a; }
    if (phase == 1) c = clamp(c + clamp(sp * vRas1, 0.0, 1.0), 0.0, 1.0);
    // after everything HSD compiled, the emboss: plus the map, minus the map
    // shifted toward the light, both times the lit color
    int bs = ((flags >> 4) & 7) - 1;
    if (phase == 2 && bs >= 0) {
      vec4 u = bs == 0 ? texture(uTex0, vBump) : bs == 1 ? texture(uTex1, vBump) : bs == 2 ? texture(uTex2, vBump) : texture(uTex3, vBump);
      c = clamp(c + tx[bs].rgb * vRas0.rgb - u.rgb * vRas0.rgb, 0.0, 1.0);
    }
  }
  // the shadows, after all of the material's own stages: its color times
  // each one's texel (HSD_TObjSetupVolatileTev's TObjSetupTevModulateShadow)
  if ((flags & 256) != 0) {
    for (int k = 0; k < 4; k++) {
      if (k >= uShadowN) break;
      vec2 st = (uShadowM[k] * vec4(vPosW, 1.0)).xy;
      vec3 s = k == 0 ? textureLod(uShadow0, st, 0.0).rgb : k == 1 ? textureLod(uShadow1, st, 0.0).rgb
             : k == 2 ? textureLod(uShadow2, st, 0.0).rgb : textureLod(uShadow3, st, 0.0).rgb;
      c = clamp(c * s, 0.0, 1.0);
    }
  }
  c += vOverAdd;
  if (uOverColor.a > 0.0) c = mix(clamp(c, 0.0, 1.0), uOverColor.rgb, uOverColor.a);
  // the alpha test, on the 8-bit alpha
  float a8 = floor(clamp(a, 0.0, 1.0) * 255.0 + 0.5);
  int at = m0.w;
  bool p0 = cmp(at & 7, a8, uMatF[5].x), p1 = cmp((at >> 3) & 7, a8, uMatF[5].y);
  int op = (at >> 6) & 3;
  if (!(op == 0 ? (p0 && p1) : op == 1 ? (p0 || p1) : op == 2 ? (p0 != p1) : (p0 == p1))) discard;
  c = clamp(c, 0.0, 1.0);
  if (uFog.x > 0.0) {
    int ft = int(uFog.x) & 7;
    float f = max((-vPosV.z - uFog.y) / max(uFog.z - uFog.y, 1e-6), 0.0);
    float k = ft == 2 ? f : ft == 4 ? 1.0 - exp2(-8.0 * f) : ft == 5 ? 1.0 - exp2(-8.0 * f * f)
            : ft == 6 ? exp2(-8.0 * (1.0 - f)) : ft == 7 ? exp2(-8.0 * (1.0 - f) * (1.0 - f)) : 0.0;
    c = mix(c, uFogColor, clamp(k, 0.0, 1.0));
  }
  a = clamp(a, 0.0, 1.0);
  if (uFlat.a > 0.0) { outColor = uFlat; return; }
  if (uOutline.a > 0.0) { outColor = vec4(mix(c, uOutline.rgb, uOutline.a), a); return; }
  if (uTint.a > 0.0) {
    // a ghost: the model's shading in the ghost's color at full strength (a
    // dark green read as a hole in the stage), and a white rim at the edges,
    // so it stands apart from the real fighters and from the stage behind it
    float l = dot(c, vec3(0.3, 0.59, 0.11));
    float rim = pow(1.0 - abs(normalize(vNrmV).z), 1.2);
    vec3 g = uTint.rgb / max(max(uTint.r, uTint.g), max(uTint.b, 0.001));
    outColor = vec4(mix(g * (0.7 + 0.5 * l), vec3(1.0), 0.85 * rim), min(1.0, uTint.a * (0.9 + 0.3 * rim)));
    return;
  }
  outColor = vec4(mix(c, vec3(1.0), uFlash), a);
}`;

// The game's particles (fx/draw.ts builds the quads): the texture blends the
// environment color into the primary one, then the particle's own alpha
// compare (GX's two comparisons and their logic) decides the pixel
const PARTICLE_VS = `#version 300 es
in vec3 aPos; in vec2 aUv; in vec4 aPrim; in vec4 aEnv; in vec3 aCmp; in float aTex;
uniform mat4 uViewProj;
out vec2 vUv; out vec4 vPrim; out vec4 vEnv; flat out vec3 vCmp; flat out float vTex;
void main() {
  vUv = aUv; vPrim = aPrim; vEnv = aEnv; vCmp = aCmp; vTex = aTex;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;
const PARTICLE_FS = `#version 300 es
precision highp float;
in vec2 vUv; in vec4 vPrim; in vec4 vEnv; flat in vec3 vCmp; flat in float vTex;
uniform sampler2D uTex;
out vec4 outColor;
bool cmp(int f, float a, float r) {
  if (f == 0) return false;
  if (f == 1) return a < r;
  if (f == 2) return a == r;
  if (f == 3) return a <= r;
  if (f == 4) return a > r;
  if (f == 5) return a != r;
  if (f == 6) return a >= r;
  return true;
}
void main() {
  vec4 c = vPrim;
  if (vTex > 0.5) {
    // mirrored repeat, as the game's MirrorS/T texture coordinates want
    vec2 uv = 1.0 - abs(mod(vUv, 2.0) - 1.0);
    vec4 t = texture(uTex, uv);
    c = mix(vEnv, vPrim, t);
  }
  int mode = int(vCmp.x + 0.5);
  float a = floor(clamp(c.a, 0.0, 1.0) * 255.0 + 0.5);
  bool p0 = cmp((mode >> 3) & 7, a, vCmp.y), p1 = cmp(mode & 7, a, vCmp.z);
  int op = (mode >> 6) & 3;
  bool pass = op == 0 ? (p0 && p1) : op == 1 ? (p0 || p1) : op == 2 ? (p0 != p1) : (p0 == p1);
  if (!pass) discard;
  outColor = clamp(c, 0.0, 1.0);
}`;

// the model programs' attribute slots (the meshes' vertex arrays serve both),
// the uniforms looked up once they are linked, and the particles' slots
const ATTRS = ["aPos", "aNrm", "aUv0", "aUv1", "aClr", "aMtx", "aBin", "aTan"];
const UNIFORMS = ["uViewProj", "uView", "uMats", "uAmbLight", "uNumLights", "uLPos", "uLAxis",
                  "uLCol", "uLA", "uLK", "uEye", "uSpecAt", "uTint", "uTex0", "uTex1", "uTex2", "uTex3", "uInflate",
                  "uFlat", "uOutline", "uFlash", "uOverColor", "uOverLight", "uOverDir", "uOverMode",
                  "uFog", "uFogColor", "uPointSize", "uShadow0", "uShadow1", "uShadow2", "uShadow3", "uShadowM",
                  "uShadowN", "uCast"];
const PARTICLE_ATTRS = ["aPos", "aUv", "aPrim", "aEnv", "aCmp", "aTex"];
/** a particle quad buffer's layout (17 floats a vertex), into the vertex array bound */
function particleAttribs(gl: WebGL2RenderingContext) {
  const put = (i: number, size: number, at: number) => {
    gl.enableVertexAttribArray(i);
    gl.vertexAttribPointer(i, size, gl.FLOAT, false, 17 * 4, at * 4);
  };
  put(0, 3, 0); put(1, 2, 3); put(2, 4, 5); put(3, 4, 9); put(4, 3, 13); put(5, 1, 16);
}

/** an image's pixels at one of its levels, decoded once for the page: every
 *  player on it reads the game files' same bytes (files.ts), so the pixels
 *  of an image in them are kept by those bytes (pageWeak) */
function decoded(a: Archive, image: Image, tlut: Tlut | null, lv: { w: number; h: number; at: number }): Uint8Array {
  const byFile = pageWeak<ArrayBufferLike, Map<string, Uint8Array>>("pixels");
  const buf = a.data.buffer;
  let m = byFile.get(buf);
  if (!m) byFile.set(buf, (m = new Map()));
  const key = `${a.data.byteOffset + image.dataOff + lv.at}:${lv.w}x${lv.h}:${image.format}:${tlut ? a.data.byteOffset + tlut.offset : -1}`;
  let px = m.get(key);
  if (!px) {
    px = lv.at === 0 ? decodeImage(a, image, tlut)
      : decodeImage(a, { ...image, dataOff: image.dataOff + lv.at, width: lv.w, height: lv.h }, tlut);
    m.set(key, px);
  }
  return px;
}

interface TexCache {
  image: Image | null; tlut: Tlut | null; tex: WebGLTexture;
  tu: number; tv: number; su: number; sv: number; r: number; rx: number; ry: number; m: Float32Array; epoch: number;
  /** counts the changes to m (a material's block knows whether it has the latest) */
  ver: number;
}

interface GpuMesh {
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  count: number;
  type: number;
  /** what its indices draw: triangles, or points */
  mode: number;
  /** where its indices start in its vertex array's list, bytes */
  offset: number;
}

/** a ghost's look: its color and how solid it is */
export interface Tint { color: [number, number, number]; alpha: number }

/** a texture drawn into (Renderer.target) */
export interface RenderTarget { fbo: WebGLFramebuffer; tex: WebGLTexture; depth: WebGLRenderbuffer; w: number; h: number }

export type { Fog };

export type { Lighting };

/** the lighting a model gets when there is no stage: the game's own fallback */
export const DEFAULT_LIGHTING: Lighting = new LightSet(DEFAULT_LIGHTS).at(0);

// GX compare functions as GL's (NEVER .. ALWAYS)
const ZF = [0x200, 0x201, 0x202, 0x203, 0x204, 0x205, 0x206, 0x207];
const GL_MIN = [0x2600, 0x2601, 0x2700, 0x2701, 0x2702, 0x2703]; // NEAREST .. LINEAR_MIPMAP_LINEAR

/** what a material sets that never changes, packed (Renderer.staticsOf) */
interface MatStatics {
  p: MatProgram;
  /** its uniform block's contents as last sent (std140: its floats, then its integers), and views of them */
  bytes: Uint8Array; F: Float32Array; I: Int32Array;
  ubo: WebGLBuffer | null;
  sent: boolean;
  /** each sampler's texture state and its matrix's version, as last put in */
  tcs: (TexCache | null)[]; tcVers: number[];
  /** its pixel engine */
  colorOn: boolean; blend: number; srcF: number; dstF: number; zWrite: boolean; zFunc: number;
}

export class Renderer {
  gl: WebGL2RenderingContext;
  prog: WebGLProgram;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private attr: Record<string, number> = {};
  private lighting: Lighting | null = null;
  /** the lighting each program has, by version */
  private litVersion = new Map<WebGLProgram, number>();
  private view: Mat = new Float32Array(16);
  private proj: Mat = new Float32Array(16);
  private eye = [0, 0, 0];
  private meshes = new Map<string, GpuMesh>();
  private textures = new Map<string, WebGLTexture>();
  private archiveIds = new WeakMap<Archive, number>();
  private nextArchive = 1;
  private sphere: GpuMesh | null = null;
  private spriteTex = new Map<string, WebGLTexture>();
  private particleProg: WebGLProgram;
  private ploc: Record<string, WebGLUniformLocation | null> = {};
  private pvao: WebGLVertexArrayObject;
  private pvbo: WebGLBuffer;
  private pibo: WebGLBuffer;
  private pQuads = 0;
  private white: WebGLTexture;
  private bound: (WebGLTexture | null)[] = [null, null, null, null];
  // (a material block's layout: its floats, then its integers - std140's vec4s and ivec4s)
  private matBytes = new Uint8Array(MAT_BYTES);
  private matF = new Float32Array(this.matBytes.buffer, 0, MATF * 4);
  private matI = new Int32Array(this.matBytes.buffer, MATF * 16, MATI * 4);
  private viewProj: Mat = new Float32Array(16);
  /** each material's TEV, compiled once */
  private programs = new WeakMap<MatState, MatProgram>();
  /** draw calls in the last frame, for the stats */
  draws = 0;
  lost = false;

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      // (the canvas only takes the finished picture: picture.ts or the 480p look draws the scene)
      antialias: false, alpha: false, depth: true, stencil: true, preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("this browser has no WebGL2");
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.lost = true; });
    // The programs are compiled and linked by the graphics driver while the
    // page goes on (KHR_parallel_shader_compile, where the browser has it:
    // the model program's is seconds of work, per player), and looked at
    // only once they are done (ready). Nothing is drawn until then.
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    // the model program, and its variant for the shield's card (the only one
    // that writes its own depth, so every other draw keeps its early depth
    // test); both with the same attribute slots, so the meshes serve both
    const vs = sh(gl.VERTEX_SHADER, VS);
    const program = (vsh: WebGLShader, fs: string, attrs: string[]) => {
      const p = gl.createProgram()!;
      const f = sh(gl.FRAGMENT_SHADER, fs);
      gl.attachShader(p, vsh);
      gl.attachShader(p, f);
      attrs.forEach((n, i) => gl.bindAttribLocation(p, i, n));
      gl.linkProgram(p);
      this.linking.push({ p, shaders: [vsh, f] });
      return p;
    };
    const p = program(vs, FS, ATTRS);
    this.prog = p;
    this.current = p;
    ATTRS.forEach((n, i) => { this.attr[n] = i; });
    // the game's particles: one dynamic buffer of quads, drawn in batches
    const pp = program(sh(gl.VERTEX_SHADER, PARTICLE_VS), PARTICLE_FS, PARTICLE_ATTRS);
    this.particleProg = pp;
    this.pvao = gl.createVertexArray()!;
    gl.bindVertexArray(this.pvao);
    this.pvbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pvbo);
    particleAttribs(gl);
    this.pibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.pibo);
    gl.bindVertexArray(null);
    this.white = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    // the material block for draws that are no material's own (a ghost, a depth pass, a plain sphere)
    this.scratchUbo = gl.createBuffer()!;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.scratchUbo);
    gl.bufferData(gl.UNIFORM_BUFFER, MAT_BYTES, gl.DYNAMIC_DRAW);
    this.ready = this.whenLinked();
  }

  /** the programs being linked, and their shaders */
  private linking: { p: WebGLProgram; shaders: WebGLShader[] }[] = [];
  /** once the programs are linked and set up: nothing is drawn before (a
   *  failure - a shader the driver refuses - is its error) */
  readonly ready: Promise<void>;
  isReady = false;
  private async whenLinked() {
    const gl = this.gl;
    const ext = gl.getExtension("KHR_parallel_shader_compile") as { COMPLETION_STATUS_KHR: number } | null;
    if (ext) {
      // (asked a frame at a time: the answer is the driver's, not a wait)
      while (!this.linking.every((l) => gl.getProgramParameter(l.p, ext.COMPLETION_STATUS_KHR))) {
        if (gl.isContextLost()) throw new Error("the graphics card dropped the 3D view");
        await new Promise((r) => setTimeout(r, 16));
      }
    }
    for (const { p, shaders } of this.linking) {
      if (gl.getProgramParameter(p, gl.LINK_STATUS)) continue;
      const why = shaders.map((s) => gl.getShaderInfoLog(s)).filter((x) => x).join(" ") || gl.getProgramInfoLog(p);
      throw new Error(why || "a shader did not link");
    }
    const setUp = (p: WebGLProgram, loc: Record<string, WebGLUniformLocation | null>) => {
      for (const n of UNIFORMS) loc[n] = gl.getUniformLocation(p, n);
      gl.uniformBlockBinding(p, gl.getUniformBlockIndex(p, "Mat"), 0);
      gl.useProgram(p);
      gl.uniform1i(loc.uTex0, 0); gl.uniform1i(loc.uTex1, 1);
      gl.uniform1i(loc.uTex2, 2); gl.uniform1i(loc.uTex3, 3);
      for (let k = 0; k < MAX_SHADOWS; k++) gl.uniform1i(loc[`uShadow${k}`], SHADOW_UNIT + k);
    };
    setUp(this.prog, this.loc);
    for (const n of ["uViewProj", "uTex"]) this.ploc[n] = gl.getUniformLocation(this.particleProg, n);
    gl.useProgram(this.prog);
    this.current = this.prog;
    this.isReady = true;
  }
  private upload(d: Drawable): GpuMesh {
    // (kept on the drawable: a lookup by its key per draw adds up)
    const c = d.gpu;
    if (c && c.owner === this && c.epoch === this.meshEpoch) return c.mesh as GpuMesh;
    const m = (d.group ? this.modelMesh(d) : null) ?? this.uploadByKey(d);
    d.gpu = { owner: this, epoch: this.meshEpoch, mesh: m };
    return m;
  }

  /** each model's buffers: every mesh of a skeleton (its tag) in one vertex
   *  array, each mesh a stretch of the one index list, so a model's draws
   *  one after another bind nothing between them */
  private models = new Map<string, { vao: WebGLVertexArrayObject; buffers: WebGLBuffer[]; meshes: Map<string, GpuMesh> }>();
  private modelMesh(d: Drawable): GpuMesh | null {
    const g = d.group!;
    let model = this.models.get(g.tag);
    if (!model) this.models.set(g.tag, (model = this.buildModel(g)));
    return model.meshes.get(d.key) ?? null;
  }
  private buildModel(g: DrawGroup) {
    const gl = this.gl;
    // (a mesh whose arrays are not one entry a vertex is left to a vertex array of its own)
    const fits = (m: Drawable["mesh"]) => {
      const n = m.mtx.length;
      return m.pos.length === n * 3 && m.nrm.length === n * 3 && m.uv.length === n * 2 && m.uv1.length === n * 2 && m.clr.length === n * 4 &&
        (!m.bin || !m.tan || (m.bin.length === n * 3 && m.tan.length === n * 3));
    };
    const ds: Drawable[] = [];
    const seen = new Set<string>();
    let nv = 0, ni = 0, nbt = false;
    for (const d of g.drawables) {
      if (seen.has(d.key) || !fits(d.mesh)) continue;
      seen.add(d.key);
      ds.push(d);
      nv += d.mesh.mtx.length;
      ni += d.mesh.indices.length;
      if (d.mesh.bin && d.mesh.tan) nbt = true;
    }
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv0 = new Float32Array(nv * 2), uv1 = new Float32Array(nv * 2);
    const clr = new Float32Array(nv * 4), mtx = new Float32Array(nv);
    // (the meshes without binormals and tangents read zeros, as an attribute left off does)
    const bin = nbt ? new Float32Array(nv * 3) : null, tan = nbt ? new Float32Array(nv * 3) : null;
    const wide = nv > 65536;
    const idx = wide ? new Uint32Array(ni) : new Uint16Array(ni);
    const type = wide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, bytes = wide ? 4 : 2;
    const vao = gl.createVertexArray()!;
    const meshes = new Map<string, GpuMesh>();
    let v = 0, i = 0;
    for (const d of ds) {
      const m = d.mesh, n = m.mtx.length, ix = m.indices;
      pos.set(m.pos, v * 3); nrm.set(m.nrm, v * 3); uv0.set(m.uv, v * 2); uv1.set(m.uv1, v * 2); clr.set(m.clr, v * 4); mtx.set(m.mtx, v);
      if (bin && tan && m.bin && m.tan) { bin.set(m.bin, v * 3); tan.set(m.tan, v * 3); }
      for (let k = 0; k < ix.length; k++) idx[i + k] = ix[k] + v;
      meshes.set(d.key, { vao, buffers: [], count: ix.length, type, mode: m.points ? gl.POINTS : gl.TRIANGLES, offset: i * bytes });
      v += n;
      i += ix.length;
    }
    gl.bindVertexArray(vao);
    const buffers: WebGLBuffer[] = [];
    const buf = (data: Float32Array, name: string, size: number) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const l = this.attr[name];
      if (l >= 0) { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0); }
      buffers.push(b);
    };
    buf(pos, "aPos", 3); buf(nrm, "aNrm", 3); buf(uv0, "aUv0", 2); buf(uv1, "aUv1", 2); buf(clr, "aClr", 4); buf(mtx, "aMtx", 1);
    if (bin && tan) { buf(bin, "aBin", 3); buf(tan, "aTan", 3); }
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    buffers.push(ib);
    gl.bindVertexArray(null);
    this.vaoBound = null;
    return { vao, buffers, meshes };
  }
  /** the vertex array bound now (undefined: not known) */
  private vaoBound: WebGLVertexArrayObject | null | undefined = undefined;
  private bindVao(v: WebGLVertexArrayObject) {
    if (this.vaoBound === v) return;
    this.gl.bindVertexArray(v);
    this.vaoBound = v;
  }
  /** meshes' buffers forgotten so far (a drawable's own note of its buffers is good while this stands) */
  private meshEpoch = 0;
  private uploadByKey(d: Drawable): GpuMesh {
    let m = this.meshes.get(d.key);
    if (m) return m;
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffers: WebGLBuffer[] = [];
    const buf = (data: Float32Array, name: string, size: number) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const l = this.attr[name];
      if (l >= 0) { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0); }
      buffers.push(b);
    };
    buf(d.mesh.pos, "aPos", 3);
    buf(d.mesh.nrm, "aNrm", 3);
    buf(d.mesh.uv, "aUv0", 2);
    buf(d.mesh.uv1, "aUv1", 2);
    buf(d.mesh.clr, "aClr", 4);
    buf(d.mesh.mtx, "aMtx", 1);
    // (a mesh without binormals and tangents reads zeros: the attributes stay off)
    if (d.mesh.bin && d.mesh.tan) { buf(d.mesh.bin, "aBin", 3); buf(d.mesh.tan, "aTan", 3); }
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.mesh.indices, gl.STATIC_DRAW);
    buffers.push(ib);
    gl.bindVertexArray(null);
    this.vaoBound = null;
    m = { vao, buffers, count: d.mesh.indices.length, mode: d.mesh.points ? gl.POINTS : gl.TRIANGLES, offset: 0,
          type: d.mesh.indices instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT };
    this.meshes.set(d.key, m);
    return m;
  }

  /** forget the buffers of meshes whose key starts with this (a stage left behind) */
  release(prefix: string) {
    const gl = this.gl;
    for (const [k, m] of this.meshes) {
      if (!k.startsWith(prefix)) continue;
      gl.deleteVertexArray(m.vao);
      m.buffers.forEach((b) => gl.deleteBuffer(b));
      this.meshes.delete(k);
    }
    for (const [k, m] of this.models) {
      if (!k.startsWith(prefix)) continue;
      gl.deleteVertexArray(m.vao);
      m.buffers.forEach((b) => gl.deleteBuffer(b));
      this.models.delete(k);
    }
    this.meshEpoch++;
  }

  private archiveId(a: Archive): number {
    let id = this.archiveIds.get(a);
    if (!id) { id = this.nextArchive++; this.archiveIds.set(a, id); }
    return id;
  }

  // by the image object itself (a draw asks for its textures every frame:
  // no key to build), then by archive and offsets (the same image twice)
  private texByImage = new WeakMap<Image, Map<number, WebGLTexture>>();

  /** images the game renders into at run time (Pokemon Stadium's big
   *  screen): drawn from a picture the caller makes, uploaded when its
   *  version changes */
  private live = new WeakMap<Image, { tex: WebGLTexture | null; version: number; source: TexImageSource | null }>();

  /** show this picture where the file has the image (a render target), from now on */
  liveImage(image: Image, source: TexImageSource, version: number) {
    let l = this.live.get(image);
    if (!l) this.live.set(image, (l = { tex: null, version: -1, source: null }));
    l.source = source;
    if (l.version === version && l.tex) return;
    const gl = this.gl;
    // (a new texture for the image: the texture caches look again; a new
    // picture in the same one needs no looking up)
    if (!l.tex) this.imageEpoch++;
    if (!l.tex) {
      l.tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, l.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else gl.bindTexture(gl.TEXTURE_2D, l.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    l.version = version;
    this.bound.fill(null);
  }

  /** A part of the picture drawn so far into a live image's texture (w x
   *  h), scaled as the canvas scales a picture (bilinear, each of its pixels
   *  from the point under its center) and times a color (0-255): Pokemon
   *  Stadium's screen showing the match. All on the graphics card: the part
   *  copied out, then drawn into the texture. `rect`: fractions of the
   *  picture from its top left (x, y, w, h). The texture's first row is the
   *  top, as a canvas's upload has it. */
  captureLive(image: Image, w: number, h: number, rect: [number, number, number, number], tint: [number, number, number]) {
    const gl = this.gl;
    const l = this.live.get(image);
    if (!l?.tex) return;
    const [PW, PH] = this.look ? [LOOK_W, LOOK_H] : this.pic ? [this.pic.w, this.pic.h] : this.size;
    const sx = rect[0] * PW, sy = rect[1] * PH, sw = rect[2] * PW, sh = rect[3] * PH;
    // the picture's pixels under the part, bottom-up as GL counts its rows
    const x0 = Math.max(0, Math.floor(sx - 1)), x1 = Math.min(PW, Math.ceil(sx + sw + 1));
    const top = PH - (sy + sh), y0 = Math.max(0, Math.floor(top - 1)), y1 = Math.min(PH, Math.ceil(PH - sy + 1));
    const cw = x1 - x0, ch = y1 - y0;
    if (cw <= 0 || ch <= 0) return;
    const c = (this.cap ??= this.makeCapture());
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, c.tex);
    if (c.w < cw || c.h < ch) {
      c.w = Math.max(c.w, cw); c.h = Math.max(c.h, ch);
      // (color alone: the canvas's picture has no alpha to copy)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, c.w, c.h, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
    }
    // (from the picture as drawn so far: the game's frame buffer resolved, when it is multisampled)
    if (!this.look) this.pic?.readable();
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, x0, y0, cw, ch);
    // into the screen's texture: each of its pixels (x, y from the top) takes
    // the picture at (sx + (x + 0.5) sw / w, sy + (y + 0.5) sh / h)
    gl.bindFramebuffer(gl.FRAMEBUFFER, c.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, l.tex, 0);
    gl.viewport(0, 0, w, h);
    gl.useProgram(c.prog);
    gl.uniform4f(c.uMap, sw / w / c.w, sx / c.w - x0 / c.w, -sh / h / c.h, (PH - sy - y0) / c.h);
    gl.uniform3f(c.uTint, tint[0] / 255, tint[1] / 255, tint[2] / 255);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // back to the frame's picture
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    this.bindPicture();
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.prog);
    this.bound.fill(null);
    this.dirty();
  }
  private cap: { prog: WebGLProgram; fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number;
                 uMap: WebGLUniformLocation | null; uTint: WebGLUniformLocation | null } | null = null;
  private makeCapture() {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, `#version 300 es
void main() { vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0); gl_Position = vec4(p, 0.0, 1.0); }`));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec4 uMap; // s = fx * x + y, t = fy * z + w (fx, fy: the pixel's center)
uniform vec3 uTint;
out vec4 outColor;
void main() {
  vec2 st = vec2(gl_FragCoord.x * uMap.x + uMap.y, gl_FragCoord.y * uMap.z + uMap.w);
  outColor = vec4(texture(uSrc, st).rgb * uTint, 1.0);
}`));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    gl.useProgram(prog);
    gl.uniform1i(gl.getUniformLocation(prog, "uSrc"), 0);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { prog, fbo: gl.createFramebuffer()!, tex, w: 0, h: 0,
             uMap: gl.getUniformLocation(prog, "uMap"), uTint: gl.getUniformLocation(prog, "uTint") };
  }

  /** an image as a texture, wrapped and filtered as the TObj says: the
   *  file's own mip levels when it has them, HSD's minification filter */
  private texture(a: Archive, image: Image, tlut: Tlut | null, t: TObj): WebGLTexture {
    const live = this.live.get(image);
    if (live?.tex) return live.tex;
    const own = this.imageTex.get(image);
    if (own) return own;
    let byImage = this.texByImage.get(image);
    if (!byImage) this.texByImage.set(image, (byImage = new Map()));
    const minF = minFilter(t.lod ? t.lod.minFilt : null, !!image.mipmap, image.format);
    const k = (((tlut ? tlut.offset + 1 : 0) * 16 + (t.wrapS & 3) * 4 + (t.wrapT & 3)) * 8 + minF) * 2 + t.magFilt;
    const known = byImage.get(k);
    if (known) return known;
    const key = `${this.archiveId(a)}:${image.offset}:${tlut?.offset ?? 0}:${t.wrapS}${t.wrapT}:${minF}${t.magFilt}`;
    let tex = this.textures.get(key);
    if (tex) { byImage.set(k, tex); return tex; }
    const gl = this.gl;
    tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const levels = minF >= 2 ? mipLevels(image.width, image.height, image.format, image.maxLOD ?? 0) : [{ w: image.width, h: image.height, at: 0 }];
    let n = 0;
    for (const lv of levels) {
      let rgba: Uint8Array;
      try {
        rgba = decoded(a, image, tlut, lv);
      } catch { break; }
      gl.texImage2D(gl.TEXTURE_2D, n, gl.RGBA, lv.w, lv.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      n++;
    }
    const mip = minF >= 2 && n > 1;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, mip ? n - 1 : 0);
    if (mip) {
      gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MIN_LOD, image.minLOD ?? 0);
      gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MAX_LOD, Math.min(image.maxLOD ?? 0, n - 1));
    }
    const wrap = (w: number) => (w === 0 ? gl.CLAMP_TO_EDGE : w === 2 ? gl.MIRRORED_REPEAT : gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap(t.wrapS));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap(t.wrapT));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, GL_MIN[mip ? minF : minF & 1]);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, t.magFilt ? gl.LINEAR : gl.NEAREST);
    this.textures.set(key, tex);
    byImage.set(k, tex);
    this.bound.fill(null);
    return tex;
  }

  // images drawn with a texture made here instead of their own pixels
  private imageTex = new WeakMap<Image, WebGLTexture>();

  /** draw an image of a model with a texture made here (the HUD's magnifier:
   *  its picture of the fighter is drawn into a target each frame, as the
   *  game draws into the image its bubble shows) */
  bindImage(image: Image, tex: WebGLTexture) {
    this.imageTex.set(image, tex);
    this.bound.fill(null);
    this.imageEpoch++;
  }
  /** changes whenever an image is given another texture (the cache looks again) */
  private imageEpoch = 0;

  /** a texture to draw into, w x h, with a depth buffer of its own */
  target(w: number, h: number): RenderTarget {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.bound.fill(null);
    const t = { fbo, tex, depth, w, h };
    this.targets.push(t);
    return t;
  }
  private targets: RenderTarget[] = [];

  /** Draws from here on go through another camera: over the picture with
   *  the depth cleared (the HUD: the game draws it with cameras of its own,
   *  over the match), or into a target, cleared to a color first (the
   *  magnifier's picture). endOverlay() puts the match camera back. */
  overlay(viewProj: Mat, view: Mat, target: RenderTarget | null = null, clear: [number, number, number, number] | null = null,
          mirrored = false) {
    const gl = this.gl;
    this.endPass();
    // (a camera that turns the picture over turns the faces' winding too)
    this.mirrored = mirrored;
    this.overlayVP = viewProj;
    this.setCull(viewProj);
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.w, target.h);
    }
    gl.depthMask(true);
    if (clear) gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
    gl.clear(gl.DEPTH_BUFFER_BIT | (clear ? gl.COLOR_BUFFER_BIT : 0));
    gl.uniformMatrix4fv(this.loc.uViewProj, false, viewProj);
    gl.uniformMatrix4fv(this.loc.uView, false, view);
    this.camera(viewProj, view);
    this.dirty();
  }

  private mirrored = false;
  private overlayVP: Mat | null = null;

  // ---- a shift of what is drawn next, in world units: a fighter's hitlag
  // shake. The game adds it to the camera's view for the fighter's draw
  // (ftDrawCommon_8008051C), so its joints stay where they are - its
  // effects, its trail - and only its model moves.
  /** the camera draws go through now (the frame's, an overlay's, the mirror's) */
  private camVP: Mat = new Float32Array(16);
  private camView: Mat = new Float32Array(16);
  private shiftVP: Mat = new Float32Array(16);
  private shiftView: Mat = new Float32Array(16);
  private shifted = false;
  private camera(vp: Mat, view: Mat) {
    this.camVP = vp;
    this.camView = view;
    this.shifted = false;
  }
  /** move what is drawn from now on by (dx, dy) in the world; (0, 0) ends it */
  shiftDraws(dx: number, dy: number) {
    const gl = this.gl;
    if (!dx && !dy) {
      if (!this.shifted) return;
      this.shifted = false;
      gl.uniformMatrix4fv(this.loc.uViewProj, false, this.camVP);
      gl.uniformMatrix4fv(this.loc.uView, false, this.camView);
      this.setCull(this.camVP);
      return;
    }
    this.shifted = true;
    // M x translate(dx, dy, 0): M's last column gains dx its first and dy its second
    const at = (out: Mat, m: Mat) => {
      out.set(m);
      for (let r = 0; r < 4; r++) out[12 + r] = m[12 + r] + dx * m[r] + dy * m[4 + r];
    };
    at(this.shiftVP, this.camVP);
    at(this.shiftView, this.camView);
    gl.uniformMatrix4fv(this.loc.uViewProj, false, this.shiftVP);
    gl.uniformMatrix4fv(this.loc.uView, false, this.shiftView);
    this.setCull(this.shiftVP);
  }

  endOverlay() {
    const gl = this.gl;
    this.endPass();
    this.mirrored = false;
    this.overlayVP = null;
    this.setCull(this.viewProj);
    // back to the frame's picture: the canvas, or the 480p look's frame buffer
    this.bindPicture();
    gl.uniformMatrix4fv(this.loc.uViewProj, false, this.viewProj);
    gl.uniformMatrix4fv(this.loc.uView, false, this.view);
    this.camera(this.viewProj, this.view);
    this.dirty();
  }

  /** textures decoded and buffers made ahead of the first frame that needs
   *  them: queued, and done a few milliseconds at a time between the page's
   *  other work (a model's textures at once are a tenth of a second the
   *  page cannot move in); warmed() says when the queue is empty */
  warm(sk: Skeleton) {
    for (const d of sk.drawables) {
      this.warmQueue.push(() => this.upload(d));
      for (const t of d.state.tex) {
        this.warmQueue.push(() => { try { this.texture(d.archive, t.image, t.tlut, t.tobj); } catch { /* drawn without it */ } });
      }
    }
    this.pumpWarm();
  }
  private warmQueue: (() => void)[] = [];
  private warmAt = 0;
  private warmWaiting: (() => void)[] = [];
  private warmTimer: { cancel(): void } | null = null;
  /** how many things it has warmed so far (the warm-up's watch reads it: still moving) */
  warmDone = 0;
  private pumpWarm() {
    if (this.warmTimer !== null) return;
    // (in the page's idle time: between its frames, never in their way)
    this.warmTimer = idle((left) => {
      this.warmTimer = null;
      // (the queue's next few: what fits in the idle time, at least one)
      while (this.warmAt < this.warmQueue.length) {
        this.warmQueue[this.warmAt++]();
        this.warmDone++;
        if (left() < 2) break;
      }
      if (this.warmAt < this.warmQueue.length) { this.pumpWarm(); return; }
      this.warmQueue = [];
      this.warmAt = 0;
      const w = this.warmWaiting;
      this.warmWaiting = [];
      for (const f of w) f();
    });
  }
  /** once everything asked to be warmed so far is */
  warmed(): Promise<void> {
    if (this.warmAt >= this.warmQueue.length && this.warmTimer === null) return Promise.resolve();
    return new Promise((r) => this.warmWaiting.push(r));
  }

  /** a frame: the canvas at (cssW, cssH) CSS pixels (the caller knows its
   *  size; reading it here would lay the page out). device: the screen
   *  pixels it covers, when the browser says - with a CRT on (crt.ts), the
   *  canvas takes exactly those, so the grille's stripes land on the screen's
   *  own pixels (the scene is drawn at 640 x 480 then, whatever the canvas) */
  begin(viewProj: Mat, view: Mat, clear: [number, number, number], cssW: number, cssH: number,
        device?: [number, number]) {
    const gl = this.gl;
    // (its size follows the element, the screen's pixel ratio counted, within a cap: drawsize.ts)
    if (this.maxDim === 0) {
      const v = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null;
      this.maxDim = v ? Math.min(v[0], v[1]) : 4096;
    }
    const exact = !!(this.look && this.crt !== "off" && device && device[0] > 0 && device[1] > 0);
    const [w, h] = drawingSize(cssW, cssH, window.devicePixelRatio || 1, { device, exact, maxDim: this.maxDim });
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.size = [w, h];
    // the scene into the 480p look's 640 x 480 frame buffer (look480.ts), else into one of the game's shape at
    // the canvas's scale, stretched over the canvas at the end as Dolphin shows it (picture.ts)
    if (!this.look) (this.pic ??= new GamePicture(gl, this.picOpts)).resize(w, h);
    this.viewH = this.look ? LOOK_H : this.pic!.h;
    this.bindPicture();
    gl.clearColor(clear[0], clear[1], clear[2], 1);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0xff);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    this.ghostRef = 0;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    this.viewProj.set(viewProj);
    this.view.set(view);
    this.camera(this.viewProj, this.view);
    this.setCull(this.viewProj);
    this.culled = 0;
    mul(this.proj, viewProj, invert(tmpM, view));
    this.eye = [tmpM[12], tmpM[13], tmpM[14]];
    gl.useProgram(this.prog);
    this.frameUniforms(this.loc);
    this.draws = 0;
    this.dirty();
    this.uboBound = null;
    this.setTint(null);
    this.setFog(null);
  }

  /** what every draw of a frame shares, into a program */
  private frameUniforms(l: Record<string, WebGLUniformLocation | null>) {
    const gl = this.gl;
    gl.uniformMatrix4fv(l.uViewProj, false, this.viewProj);
    gl.uniformMatrix4fv(l.uView, false, this.view);
    gl.uniform3f(l.uEye, this.eye[0], this.eye[1], this.eye[2]);
    gl.uniform4f(l.uTint, 0, 0, 0, 0);
    gl.uniform4f(l.uFlat, 0, 0, 0, 0);
    gl.uniform4f(l.uOutline, 0, 0, 0, 0);
    gl.uniform1f(l.uFlash, 0);
    gl.uniform1f(l.uInflate, 0);
    gl.uniform4f(l.uCast, 0, 0, 0, 0);
    gl.uniform1i(l.uShadowN, 0);
  }

  /** where the frame's scene is drawn: the 480p look's frame buffer, or the game's picture's */
  private bindPicture() {
    const gl = this.gl;
    if (this.look) this.look.bind();
    else if (this.pic) this.pic.bind();
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.size[0], this.size[1]); }
  }
  /** the picture as the game's frame buffer has it, stretched over the canvas as Dolphin shows it
   *  (picture.ts); made on the first frame */
  private pic: GamePicture | null = null;
  // (no anti-aliasing, as the game's frame buffer: its edges are the game's)
  private picOpts: PictureOptions = { samples: 0 };
  /** the game's picture made again with other options, from the next frame (trials: __viewer3d.setPicture) */
  setPicture(opts: Partial<PictureOptions>) {
    this.picOpts = { ...this.picOpts, ...opts };
    this.pic?.dispose();
    this.pic = null;
  }

  /** the 480p look (look480.ts), from the next frame on */
  private look: Look480 | null = null;
  setLook480(on: boolean) {
    if (on === !!this.look) return;
    if (on) { this.look = new Look480(this.gl); this.look.setCrt(this.tv()); }
    else { this.look!.dispose(); this.look = null; }
  }
  /** the TV the 480p look is shown on (crt.ts) and its curve (the player's
   *  slider: 0 flat), from the next frame on */
  private crt: CrtPreset = "off";
  private curve = 0;
  setCrt(p: CrtPreset, curve = 0) {
    if (p === this.crt && curve === this.curve) return;
    this.crt = p;
    this.curve = curve;
    this.look?.setCrt(this.tv());
  }
  private tv() { return this.crt === "off" ? null : { ...CRT_LOOKS[this.crt], curve: this.curve }; }
  /** the CRT pass alone at w x h pixels, ms a frame (null: no TV on) */
  benchCrt(w: number, h: number, n?: number): number | null {
    const ms = this.look?.benchCrt(w, h, n) ?? null;
    this.dirty();
    this.bound.fill(null);
    this.gl.useProgram(this.prog);
    return ms;
  }
  /** the checks: the CRT pass on a made-up picture of its own at w x h,
   *  with a TV and a curve (crt.ts crtPixels) */
  crtPixels(p: Exclude<CrtPreset, "off">, curve: number, w: number, h: number): Uint8Array {
    const px = crtPixels(this.gl, { ...CRT_LOOKS[p], curve }, w, h);
    this.dirty();
    this.bound.fill(null);
    this.gl.useProgram(this.prog);
    return px;
  }
  /** the 480p look's copy and stretch on the graphics card, ms (null: off or not known) */
  get lookGpuMs(): number | null { return this.look?.gpuMs ?? null; }
  /** how many pixels tall the scene is drawn: the 480p look's 480, else the game's picture's */
  get pictureHeight(): number { return this.look ? 480 : this.pic?.h ?? this.canvas.height; }

  /** the end of a frame: the picture onto the canvas (the 480p look's copy, or the game's picture's stretch) */
  finish() {
    if (this.look) this.look.present(this.canvas.width, this.canvas.height);
    else if (this.pic) this.pic.present(this.canvas.width, this.canvas.height);
    else return;
    this.dirty();
    this.bound.fill(null);
    this.gl.useProgram(this.prog);
  }

  /** a fighter's color animation for the draws that follow, or null for none */
  setTint(t: ColTint | null) {
    const gl = this.gl, l = this.loc;
    if (!t) {
      if (!this.tinted) return;
      this.tinted = false;
      gl.uniform4f(l.uOverColor, 0, 0, 0, 0);
      gl.uniform1i(l.uOverMode, 0);
      return;
    }
    this.tinted = true;
    const c = t.color;
    gl.uniform4f(l.uOverColor, c?.[0] ?? 0, c?.[1] ?? 0, c?.[2] ?? 0, c?.[3] ?? 0);
    const li = t.light;
    gl.uniform1i(l.uOverMode, li ? (li.adds ? 1 : 2) : 0);
    if (li) {
      gl.uniform4f(l.uOverLight, li.rgb[0], li.rgb[1], li.rgb[2], li.a);
      gl.uniform3f(l.uOverDir, li.dir[0], li.dir[1], li.dir[2]);
    }
  }
  private tinted = true;

  /** the lights the draws that follow are lit by */
  setLighting(l: Lighting) {
    this.lighting = l;
    this.uploadLighting(this.current, this.loc);
  }
  /** the model program in use (the main one, or the shield's for a moment) */
  private current: WebGLProgram;

  private uploadLighting(p: WebGLProgram, loc: Record<string, WebGLUniformLocation | null>) {
    const l = this.lighting;
    if (!l || this.litVersion.get(p) === l.version) return;
    const gl = this.gl;
    this.litVersion.set(p, l.version);
    gl.uniform3fv(loc.uAmbLight, l.ambient);
    gl.uniform1i(loc.uNumLights, l.n);
    gl.uniform4fv(loc.uLPos, l.pos);
    gl.uniform4fv(loc.uLAxis, l.axis);
    gl.uniform4fv(loc.uLCol, l.color);
    gl.uniform4fv(loc.uLA, l.attnA);
    gl.uniform4fv(loc.uLK, l.attnK);
  }

  /** the fog the draws that follow are in (null: none, as the game's effects are) */
  setFog(f: Fog | null) {
    const gl = this.gl, l = this.loc;
    gl.uniform4f(l.uFog, f ? f.type : 0, f?.start ?? 0, f?.end ?? 0, 0);
    if (f) gl.uniform3f(l.uFogColor, f.color[0], f.color[1], f.color[2]);
  }

  /** a debug aid (?debug=flat): what is drawn next in one flat color, over
   *  every pixel the material lets through, or back to its own (null) */
  // ---- the fighters' shadows (shadow.ts)
  /** a fighter's shadow picture: one target per fighter, made once */
  shadowTarget(i: number): RenderTarget {
    let t = this.shadowTargets[i];
    if (!t) {
      const gl = this.gl;
      t = this.shadowTargets[i] = this.target(SHADOW_SIZE, SHADOW_SIZE);
      // (the game's shadow texture: clamped, magnified nearest, minified linear)
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.bound.fill(null);
    }
    return t;
  }
  private shadowTargets: RenderTarget[] = [];
  /** draws from here on make a shadow: into `t`, cleared white, through the
   *  shadow camera, every pixel the stage's shadow intensity (0..255) as the
   *  copy keeps it (shadowGray), two pixels in from each edge
   *  (HSD_ShadowStartRender); endShadow() puts the frame back */
  beginShadow(t: RenderTarget, viewProj: Mat, view: Mat, intensity: number) {
    const gl = this.gl;
    this.overlay(viewProj, view, t, [1, 1, 1, 1]);
    this.casting = true;
    const gray = shadowGray(intensity);
    gl.uniform4f(this.loc.uCast, gray, gray, gray, 1);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(2, 2, t.w - 4, t.h - 4);
  }
  endShadow() {
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.uniform4f(this.loc.uCast, 0, 0, 0, 0);
    this.casting = false;
    this.endOverlay();
  }
  /** a shadow being made (material() sets its pixel engine) */
  private casting = false;
  /** the shadows the materials that take them get from now on: each a
   *  picture and its world-to-(s, t) matrix, the last made first, as
   *  HSD_MObjAddShadowTexture puts each new one at the head of its list */
  setShadows(list: { tex: WebGLTexture; mtx: Mat }[]) {
    const gl = this.gl;
    const n = Math.min(MAX_SHADOWS, list.length);
    for (let k = 0; k < n; k++) {
      gl.activeTexture(gl.TEXTURE0 + SHADOW_UNIT + k);
      gl.bindTexture(gl.TEXTURE_2D, list[k].tex);
      this.shadowM.set(list[k].mtx, k * 16);
    }
    gl.activeTexture(gl.TEXTURE0);
    this.unit = 0;
    if (n) gl.uniformMatrix4fv(this.loc.uShadowM, false, this.shadowM.subarray(0, n * 16));
    gl.uniform1i(this.loc.uShadowN, n);
    this.shadowMaps = list.slice(0, n).map((x) => ({ mtx: x.mtx }));
  }
  private shadowM = new Float32Array(16 * MAX_SHADOWS);
  /** the shadows set now (the draw log reads them) */
  shadowMaps: { mtx: Mat }[] = [];

  setFlat(c: [number, number, number] | null) {
    this.gl.uniform4f(this.loc.uFlat, c?.[0] ?? 0, c?.[1] ?? 0, c?.[2] ?? 0, c ? 1 : 0);
  }

  /** what is drawn next as an outline (Mr. Game & Watch's, his props'): its
   *  own lit color taken toward the outline's by the outline's alpha, as the
   *  game's TEV stage does (ftmaterial.c, itmaterial.c: the color register
   *  and its alpha as the ratio), or back to its own (null) */
  setOutline(c: [number, number, number, number] | null) {
    this.gl.uniform4f(this.loc.uOutline, c?.[0] ?? 0, c?.[1] ?? 0, c?.[2] ?? 0, c ? Math.max(c[3], 1e-3) : 0);
  }

  /** what is drawn next writes no depth (an outline drawn behind its body) */
  setNoDepthWrite(on: boolean) { this.noDepthWrite = on; }
  private noDepthWrite = false;

  /** one pass over a skeleton: its opaque parts, or its see-through ones;
   *  flash (0..1) turns it toward white (an L-cancel) */
  drawSkeleton(sk: Skeleton, pass: "opa" | "xlu", flash = 0) {
    if (flash > 0) this.gl.uniform1f(this.loc.uFlash, flash);
    for (const d of sk.drawables) {
      if (d.translucent !== (pass === "xlu") || !sk.isVisible(d) || this.outOfView(d)) continue;
      this.drawOne(d, null, sk);
    }
    if (flash > 0) this.gl.uniform1f(this.loc.uFlash, 0);
  }

  // ---- what the camera cannot see is not sent at all (no GL calls for it).
  // A mesh's bounding sphere under each of the matrices its vertices pick
  // from (a vertex takes exactly one: the shader's uMats[aMtx]): wholly
  // outside one plane of the camera's frustum under all of them, none of
  // its triangles can reach the picture.
  /** the camera draws are culled against (null: none) and its six planes */
  private cullVP: Mat | null = null;
  private planes = new Float32Array(24);
  /** off with ?nocull (to compare) */
  private cullOn = typeof location === "undefined" || !new URLSearchParams(location.search).has("nocull");
  /** drawables skipped this frame as out of view (the checks read it) */
  culled = 0;

  /** cull against this camera from now on (null: draw everything) */
  private setCull(vp: Mat | null) {
    this.cullVP = this.cullOn ? vp : null;
    if (!this.cullVP) return;
    const m = vp!, P = this.planes;
    for (let i = 0; i < 3; i++) {
      for (const s of [1, -1]) {
        const o = (i * 2 + (s > 0 ? 0 : 1)) * 4;
        const a = m[3] + s * m[i], b = m[7] + s * m[4 + i], c = m[11] + s * m[8 + i], w = m[15] + s * m[12 + i];
        const l = Math.hypot(a, b, c) || 1;
        P[o] = a / l; P[o + 1] = b / l; P[o + 2] = c / l; P[o + 3] = w / l;
      }
    }
  }

  private sphereOf(d: Drawable): Float32Array {
    // (kept on the drawable: a lookup per draw would cost as much as the test)
    let s = d.sphere;
    if (s) return s;
    const p = d.mesh.pos;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i + 2 < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    let r = 0;
    for (let i = 0; i + 2 < p.length; i += 3) r = Math.max(r, Math.hypot(p[i] - cx, p[i + 1] - cy, p[i + 2] - cz));
    s = Float32Array.of(cx, cy, cz, p.length ? r * 1.01 + 1 : -1);
    d.sphere = s;
    return s;
  }

  /** whether nothing of a drawable can reach the picture */
  private outOfView(d: Drawable): boolean {
    // (a skinned mesh too - a fighter: its vertices each take one of its
    // matrices, so it is out when its sphere is under every one of them; the
    // test costs less than the draw, and the mirror's camera sees few of them)
    if (!this.cullVP) return false;
    const s = this.sphereOf(d);
    if (s[3] < 0) return false;
    const P = this.planes, M = d.mats, n = Math.max(1, Math.min(d.filled, d.nMats)), W = this.worldSph;
    for (let k = 0; k < n; k++) {
      const o = k * 16, w = k * 4;
      W[w] = M[o] * s[0] + M[o + 4] * s[1] + M[o + 8] * s[2] + M[o + 12];
      W[w + 1] = M[o + 1] * s[0] + M[o + 5] * s[1] + M[o + 9] * s[2] + M[o + 13];
      W[w + 2] = M[o + 2] * s[0] + M[o + 6] * s[1] + M[o + 10] * s[2] + M[o + 14];
      W[w + 3] = s[3] * Math.sqrt(Math.max(M[o] * M[o] + M[o + 1] * M[o + 1] + M[o + 2] * M[o + 2],
                                           M[o + 4] * M[o + 4] + M[o + 5] * M[o + 5] + M[o + 6] * M[o + 6],
                                           M[o + 8] * M[o + 8] + M[o + 9] * M[o + 9] + M[o + 10] * M[o + 10]));
    }
    for (let q = 0; q < 24; q += 4) {
      let out = true;
      for (let k = 0; k < n && out; k++) {
        const w = k * 4;
        if (P[q] * W[w] + P[q + 1] * W[w + 1] + P[q + 2] * W[w + 2] + P[q + 3] > -W[w + 3]) out = false;
      }
      if (out) { this.culled++; return true; }
    }
    return false;
  }
  private worldSph = new Float32Array(40);
  /** whether a drawable can reach the picture through the camera culled
   *  against now (not counted as culled) */
  inView(d: Drawable): boolean {
    const c = this.culled, out = this.outOfView(d);
    this.culled = c;
    return !out;
  }

  private setFogUniforms(l: Record<string, WebGLUniformLocation | null>, f: Fog | null) {
    this.gl.uniform4f(l.uFog, f ? f.type : 0, f?.start ?? 0, f?.end ?? 0, 0);
  }

  private ghostRef = 0;

  /** A ghost: the model once into the depth and stencil buffers, then its
   * nearest surface once in the ghost's color, so it reads as one
   * see-through shape rather than a stack of overlapping parts. The stencil
   * keeps it to the pixels where it is in front: where it stands exactly
   * where the real fighter does (every run shares the game up to the moment),
   * the real game reads on top, as in the line-art player. */
  drawGhost(sk: Skeleton, tint: Tint, outline = 0) {
    const gl = this.gl;
    const ref = (this.ghostRef = (this.ghostRef % 255) + 1);
    this.dirty();
    if (ref === 1 && this.draws > 0) { gl.stencilMask(0xff); gl.clear(gl.STENCIL_BUFFER_BIT); }
    this.plainMaterial();
    gl.disable(gl.BLEND);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.stencilFunc(gl.ALWAYS, ref, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.colorMask(false, false, false, false);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    for (const d of sk.drawables) if (sk.isVisible(d) && !d.translucent) this.drawGeometry(d);
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.EQUAL, ref, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.depthFunc(gl.EQUAL);
    gl.uniform4f(this.loc.uTint, tint.color[0], tint.color[1], tint.color[2], tint.alpha);
    for (const d of sk.drawables) if (sk.isVisible(d) && !d.translucent) this.drawOne(d, tint, sk);
    gl.uniform4f(this.loc.uTint, 0, 0, 0, 0);
    if (outline > 0) {
      // A dark edge just outside the silhouette, so a ghost stands off a light
      // stage as well as a dark one whatever its color (its white rim does
      // the rest): the model pushed out along its normals, drawn only where
      // the ghost itself is not, behind whatever the stage has in front.
      this.plainMaterial();
      gl.stencilFunc(gl.NOTEQUAL, ref, 0xff);
      gl.depthFunc(gl.LEQUAL);
      gl.uniform1f(this.loc.uInflate, outline);
      gl.uniform4f(this.loc.uFlat, 0.06, 0.07, 0.1, 0.85);
      gl.disable(gl.CULL_FACE);
      for (const d of sk.drawables) {
        if (!sk.isVisible(d) || d.translucent) continue;
        const m = this.upload(d);
        this.mats(d);
        this.bindVao(m.vao);
        gl.drawElements(m.mode, m.count, m.type, m.offset);
        this.draws++;
      }
      gl.uniform1f(this.loc.uInflate, 0);
      gl.uniform4f(this.loc.uFlat, 0, 0, 0, 0);
    }
    gl.disable(gl.STENCIL_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    this.dirty();
  }

  /** an opaque, untextured, never-discarded material: for depth-only passes */
  private plainMaterial() {
    const F = this.matF, I = this.matI;
    F.fill(0); I.fill(0);
    F[0] = F[1] = F[2] = F[3] = 1;
    I[4] = I[5] = I[6] = I[7] = -1;
    I[3] = 7 | (7 << 3);
    this.uploadMaterial();
  }

  /** a drawable's matrices, when they are not the ones already there */
  private mats(d: Drawable) {
    if (d === this.lastMatsD && d.stamp === this.lastMatsStamp) return;
    // (the same matrices as the draw before - two meshes on one joint - are
    // not sent again)
    const n = d.nMats * 16, L = this.lastMats, M = d.mats;
    let same = this.lastMatsD !== null && n === this.lastMatsN && n <= L.length;
    for (let k = 0; same && k < n; k++) if (M[k] !== L[k]) same = false;
    this.lastMatsD = d;
    this.lastMatsStamp = d.stamp;
    if (same) return;
    // only the ones it has: a vertex picks among its own (a rigid part's all
    // pick the first)
    this.gl.uniformMatrix4fv(this.loc.uMats, false, M, 0, n);
    this.lastMatsN = n;
    if (n <= L.length) L.set(M.subarray(0, n));
  }
  private lastMats = new Float32Array(32);
  private lastMatsN = 0;

  private drawGeometry(d: Drawable) {
    const gl = this.gl;
    const m = this.upload(d);
    this.mats(d);
    this.cull(d);
    this.bindVao(m.vao);
    gl.drawElements(m.mode, m.count, m.type, m.offset);
    this.draws++;
  }

  private cull(d: Drawable) {
    const gl = this.gl;
    const cull = d.pobj.flags & 0xc000;
    if (this.cs.cull === cull) return;
    // GX winds front faces clockwise
    if (this.cs.cull === -1) gl.frontFace(this.mirrored ? gl.CCW : gl.CW);
    if (cull === 0) gl.disable(gl.CULL_FACE);
    else {
      if (this.cs.cull <= 0) gl.enable(gl.CULL_FACE);
      gl.cullFace(cull === 0x8000 ? gl.BACK : cull === 0x4000 ? gl.FRONT : gl.FRONT_AND_BACK);
    }
    this.cs.cull = cull;
  }

  // The GL state the model draws last set, so a draw sets only what differs
  // (-1: not known - something else set it directly). A frame makes several
  // hundred draws; most share their state with the one before.
  private cs = { cull: -1, blend: -1, src: -1, dst: -1, eq: -1, dmask: -1, dfunc: -1, cmask: -1 };
  // the texture unit last made active, and the specular point last sent (not known: -1, NaN)
  private unit = -1;
  private specX = NaN; private specY = NaN; private specZ = NaN;
  private dirty() {
    const c = this.cs;
    c.cull = c.blend = c.src = c.dst = c.eq = c.dmask = c.dfunc = c.cmask = -1;
    this.unit = -1;
    this.specX = NaN;
    this.lastMatsD = null;
    this.vaoBound = undefined;
  }
  private setBlend(on: boolean, src = 0, dst = 0, eq = 0) {
    const gl = this.gl, c = this.cs;
    if (!on) { if (c.blend !== 0) { gl.disable(gl.BLEND); c.blend = 0; } return; }
    if (c.blend !== 1) { gl.enable(gl.BLEND); c.blend = 1; }
    if (c.eq !== eq) { gl.blendEquation(eq); c.eq = eq; }
    if (c.src !== src || c.dst !== dst) { gl.blendFunc(src, dst); c.src = src; c.dst = dst; }
  }
  private setDepth(mask: boolean, func: number) {
    const gl = this.gl, c = this.cs;
    const m = mask ? 1 : 0;
    if (c.dmask !== m) { gl.depthMask(mask); c.dmask = m; }
    if (c.dfunc !== func) { gl.depthFunc(func); c.dfunc = func; }
  }
  private setColorWrite(on: boolean) {
    const c = this.cs, v = on ? 1 : 0;
    if (c.cmask === v) return;
    this.gl.colorMask(on, on, on, on);
    c.cmask = v;
  }
  /** a material that is no material's own (matF, matI: a ghost, a depth
   *  pass, a plain sphere), into the scratch block and bound */
  private uploadMaterial() {
    const gl = this.gl;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.scratchUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.matBytes);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.scratchUbo);
    this.uboBound = this.scratchUbo;
  }
  private scratchUbo: WebGLBuffer;
  /** every material's block, to let go of with the renderer */
  private ubos: WebGLBuffer[] = [];
  /** the material block bound now (null: not known) */
  private uboBound: WebGLBuffer | null = null;
  private bindUbo(b: WebGLBuffer) {
    if (this.uboBound === b) return;
    this.gl.bindBufferBase(this.gl.UNIFORM_BUFFER, 0, b);
    this.uboBound = b;
  }
  // the matrices last uploaded: which drawable, as of which pose
  private lastMatsD: Drawable | null = null;
  private lastMatsStamp = -1;

  private drawOne(d: Drawable, tint: Tint | null, sk: Skeleton | null) {
    const gl = this.gl;
    if ((d.pobj.flags & 0xc000) === 0xc000) return;
    const m = this.upload(d);
    this.mats(d);
    if (!this.material(d, d.state, tint !== null, sk)) return;
    this.cull(d);
    // (points as wide as the model says, in the game's 480 lines: GX_SetPointSize)
    if (m.mode === gl.POINTS) gl.uniform1f(this.loc.uPointSize, (sk?.pointSize ?? 1) * this.viewH / 480);
    this.bindVao(m.vao);
    gl.drawElements(m.mode, m.count, m.type, m.offset);
    this.draws++;
  }

  // each texture's GL texture and matrix, looked up again only when its
  // animation changes its image or moves it
  private texCache = new WeakMap<TexState, TexCache>();
  private texState(a: Archive, t: TexState): TexCache {
    // (kept on the texture's state: a map lookup per texture per draw adds up)
    let c = t.gl?.owner === this ? t.gl.cache as TexCache : undefined;
    if (!c) t.gl = { owner: this, cache: (c = { image: null, tlut: null, tex: this.white, tu: NaN, tv: 0, su: 0, sv: 0, r: 0, rx: 0, ry: 0,
                                        m: new Float32Array(12), epoch: -1, ver: 0 }) };
    if (c.image !== t.image || c.tlut !== t.tlut || c.epoch !== this.imageEpoch) {
      try { c.tex = this.texture(a, t.image, t.tlut, t.tobj); } catch { c.tex = this.white; }
      c.image = t.image; c.tlut = t.tlut; c.epoch = this.imageEpoch;
    }
    if (c.tu !== t.translate[0] || c.tv !== t.translate[1] || c.su !== t.scale[0] || c.sv !== t.scale[1] || c.r !== t.rotate ||
        c.rx !== t.rotX || c.ry !== t.rotY) {
      const o = t.tobj;
      c.m.set(textureMatrix([t.translate[0], t.translate[1], o.translate[2]], [t.scale[0], t.scale[1], o.scale[2]],
                            [t.rotX, t.rotY, t.rotate], o.repeatS, o.repeatT, o.wrapT));
      c.tu = t.translate[0]; c.tv = t.translate[1]; c.su = t.scale[0]; c.sv = t.scale[1]; c.r = t.rotate;
      c.rx = t.rotX; c.ry = t.rotY;
      c.ver++;
    }
    return c;
  }

  // A stage's mirror image (Fountain of Dreams' pond, grizumi.c): an 80 x 60
  // picture, cleared white, of what is drawn between beginMirror and
  // endMirror, seen by the camera put upside down below the floor (its eye
  // and its aim with their heights negated); the pond's texture takes it
  // where each point falls in that picture.
  private mirror: { fb: WebGLFramebuffer; tex: WebGLTexture; depth: WebGLRenderbuffer } | null = null;
  private mirrorCache: TexCache = { image: null, tlut: null, tex: null as unknown as WebGLTexture, tu: 0, tv: 0, su: 0, sv: 0, r: 0,
                                    rx: 0, ry: 0, m: new Float32Array(12), epoch: 0, ver: 0 };
  private mirrorDrawn = false;
  private size = [1, 1];
  // the most either side of the canvas can be (the card's MAX_VIEWPORT_DIMS; 0 until it is asked)
  private maxDim = 0;
  /** the picture's height in pixels, drawn to now (points are sized by it) */
  private viewH = 1;
  private mirrorState(): TexCache {
    this.mirrorCache.tex = this.mirror && this.mirrorDrawn ? this.mirror.tex : this.white;
    return this.mirrorCache;
  }
  /** returns the mirror camera's right and up (world directions: what faces it) */
  beginMirror(): { right: number[]; up: number[] } {
    const gl = this.gl;
    if (!this.mirror) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MIRROR_W, MIRROR_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const depth = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, MIRROR_W, MIRROR_H);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth);
      this.mirror = { fb, tex, depth };
      this.bound.fill(null);
    }
    // the mirror camera: the eye and the point it looks at, heights negated
    const v = this.view;
    invert(tmpM, v);
    const eye = [tmpM[12], -tmpM[13], tmpM[14]];
    const at = [tmpM[12] - v[2] * 100, -(tmpM[13] - v[6] * 100), tmpM[14] - v[10] * 100];
    lookAt(this.mirrorView, eye, at);
    mul(this.mirrorViewProj, this.proj, this.mirrorView);
    // world -> the picture: s = 0.5 + 0.49 x, t = 0.5 + 0.49 y (the game's
    // light-perspective matrix; GL's pictures run bottom up), over w
    const m = this.mirrorViewProj, M = this.mirrorCache.m;
    this.mirrorCache.ver++;
    for (let c = 0; c < 4; c++) {
      M[c] = 0.49 * m[c * 4] + 0.5 * m[c * 4 + 3];
      M[4 + c] = 0.49 * m[c * 4 + 1] + 0.5 * m[c * 4 + 3];
      M[8 + c] = m[c * 4 + 3];
    }
    // (the picture may not be on a texture unit while it is drawn into)
    for (let n = 0; n < 4; n++) {
      if (this.bound[n] !== this.mirror.tex) continue;
      gl.activeTexture(gl.TEXTURE0 + n);
      gl.bindTexture(gl.TEXTURE_2D, this.white);
      this.bound[n] = this.white;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mirror.fb);
    gl.viewport(0, 0, MIRROR_W, MIRROR_H);
    gl.clearColor(1, 1, 1, 1);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(this.loc.uViewProj, false, this.mirrorViewProj);
    gl.uniformMatrix4fv(this.loc.uView, false, this.mirrorView);
    this.camera(this.mirrorViewProj, this.mirrorView);
    this.setCull(this.mirrorViewProj);
    // (particles and strips through it too)
    this.overlayVP = this.mirrorViewProj;
    this.dirty();
    const mv = this.mirrorView;
    return { right: [mv[0], mv[4], mv[8]], up: [mv[1], mv[5], mv[9]] };
  }
  endMirror() {
    const gl = this.gl;
    this.overlayVP = null;
    this.bindPicture();
    gl.uniformMatrix4fv(this.loc.uViewProj, false, this.viewProj);
    gl.uniformMatrix4fv(this.loc.uView, false, this.view);
    this.camera(this.viewProj, this.view);
    this.setCull(this.viewProj);
    this.dirty();
    this.endPass();
    this.mirrorDrawn = true;
  }
  /** the mirror image as last drawn (RGBA rows from the bottom), its
   *  texture matrix, and the cameras (debugging) */
  mirrorDebug() {
    const gl = this.gl;
    if (!this.mirror) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mirror.fb);
    const px = new Uint8Array(MIRROR_W * MIRROR_H * 4);
    gl.readPixels(0, 0, MIRROR_W, MIRROR_H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this.bindPicture();
    return { w: MIRROR_W, h: MIRROR_H, px: Array.from(px), tex: Array.from(this.mirrorCache.m), mirrorView: Array.from(this.mirrorView),
             mirrorViewProj: Array.from(this.mirrorViewProj), view: Array.from(this.view), proj: Array.from(this.proj) };
  }
  private mirrorView: Mat = new Float32Array(16);
  private mirrorViewProj: Mat = new Float32Array(16);

  /** the material's program, compiled on its first draw */
  /** a material whose render mode changed: its program and packed block made
   *  again on its next draw (HSD_MObjCompileTev) */
  forgetMaterial(s: MatState) {
    this.programs.delete(s);
    this.statics.delete(s);
    s.gl = undefined;
  }

  program(s: MatState): MatProgram {
    let p = this.programs.get(s);
    if (!p) {
      const skip = s.skip;
      const mirror = s.mirror;
      p = compileMaterial(s.mobj, s.tex.map((t) => t.tobj), skip ? (t) => skip.has(t) : undefined,
                          mirror ? (t) => mirror.has(t) : undefined);
      this.programs.set(s, p);
    }
    return p;
  }

  /** what a material sets that never changes: its program, packed (the
   *  uniform integers, the alpha test's references), its pixel engine; and
   *  its own uniform block, with a copy of what was last sent to it */
  private statics = new WeakMap<MatState, MatStatics>();
  private staticsOf(s: MatState): MatStatics {
    // (kept on the material's state: a map lookup per draw adds up)
    if (s.gl?.owner === this) return s.gl.cache as MatStatics;
    let c = this.statics.get(s);
    if (c) { s.gl = { owner: this, cache: c }; return c; }
    const gl = this.gl;
    const p = this.program(s);
    const bytes = new Uint8Array(MAT_BYTES);
    const F = new Float32Array(bytes.buffer, 0, MATF * 4), I = new Int32Array(bytes.buffer, MATF * 16, MATI * 4);
    I[4] = I[5] = I[6] = I[7] = -1;
    const pack = (x: number[]) => (x[0] | (x[1] << 8) | (x[2] << 16) | (x[3] << 24)) | 0;
    const md = (op: number, b: number, sc: number, clamp: number, on: boolean) =>
      (op & 15) | ((b & 3) << 4) | ((sc & 3) << 6) | (clamp ? 1 << 8 : 0) | (on ? 1 << 9 : 0);
    p.textures.forEach((ti, n) => {
      const t = s.tex[ti].tobj;
      I[4 + n] = p.texGen[n];
      F[16 + n] = t.lod ? t.lod.bias : 0;
      const tv = t.tev;
      if (!tv) return;
      I[8 + n] = pack(tv.colorIn);
      I[12 + n] = pack(tv.alphaIn);
      I[16 + n] = md(tv.colorOp, tv.colorBias, tv.colorScale, tv.colorClamp, (tv.active & 0x40000000) !== 0);
      I[20 + n] = md(tv.alphaOp, tv.alphaBias, tv.alphaScale, tv.alphaClamp, (tv.active & 0x80000000) !== 0);
    });
    const st = p.stages;
    for (let k = 0; k < st.length && k < 8; k++) {
      const q = st[k];
      I[24 + k] = q.tex | (q.colorMap << 2) | ((q.alphaMap + 1) << 6) | (q.phase << 10);
    }
    I[0] = Math.min(st.length, 8);
    I[1] = p.channel;
    I[2] = (p.vertexBase ? 1 : 0) | (p.lit ? 2 : 0) | (p.specular ? 4 : 0) | ((p.bump + 1) << 4) |
           (s.mobj.renderMode & RENDER.SHADOW ? 256 : 0);
    // the alpha test: the material's pixel engine's, else HSD's for its mode
    const mo = s.mobj, pe = mo.pe, mode = mo.renderMode;
    const at = pe ? [pe.alphaComp0, pe.ref0, pe.alphaOp, pe.alphaComp1, pe.ref1] : defaultAlphaTest(mode);
    I[3] = (at[0] & 7) | ((at[3] & 7) << 3) | ((at[2] & 3) << 6);
    F[7] = mo.shininess;
    F[20] = at[1]; F[21] = at[4];
    // the pixel engine, as HSD_SetupPEMode sets it
    let zOn = true, zFunc: number = mode & RENDER.ZMODE_ALWAYS ? gl.ALWAYS : gl.LEQUAL, zWrite = !(mode & RENDER.NO_ZUPDATE);
    let blend = mode & RENDER.XLU ? 1 : 0, src = 4, dst = 5, colorOn = true;
    if (pe) {
      zOn = (pe.flags & 0x10) !== 0;
      zFunc = ZF[pe.zComp] ?? gl.LEQUAL;
      zWrite = (pe.flags & 0x20) !== 0;
      blend = pe.type; src = pe.src; dst = pe.dst;
      colorOn = (pe.flags & 1) !== 0;
    }
    // (with the depth test off, GX writes no depth either)
    if (!zOn) { zFunc = gl.ALWAYS; zWrite = false; }
    c = { p, bytes, F, I, ubo: null, sent: false, tcs: [null, null, null, null], tcVers: [0, 0, 0, 0],
          colorOn, blend, srcF: blend === 1 ? srcFactor(gl, src) : 0, dstF: blend === 1 ? dstFactor(gl, dst) : 0, zWrite, zFunc };
    this.statics.set(s, c);
    s.gl = { owner: this, cache: c };
    return c;
  }

  /** a drawable's material into its uniform block and the pixel engine; false
   *  when it draws nothing */
  private material(d: Drawable, s: MatState, ghost: boolean, sk: Skeleton | null): boolean {
    const gl = this.gl;
    const c = this.staticsOf(s), p = c.p;
    const F = c.F;
    // what can change since the block was last sent, put in where it differs
    let ch = !c.sent;
    const dif = s.override ?? s.diffuse, amb = s.ambient, spc = s.specular;
    if (F[0] !== dif[0]) { F[0] = dif[0]; ch = true; }
    if (F[1] !== dif[1]) { F[1] = dif[1]; ch = true; }
    if (F[2] !== dif[2]) { F[2] = dif[2]; ch = true; }
    const al = Math.fround(s.alpha);
    if (F[3] !== al) { F[3] = al; ch = true; }
    if (F[4] !== amb[0]) { F[4] = amb[0]; ch = true; }
    if (F[5] !== amb[1]) { F[5] = amb[1]; ch = true; }
    if (F[6] !== amb[2]) { F[6] = amb[2]; ch = true; }
    if (F[8] !== spc[0]) { F[8] = spc[0]; ch = true; }
    if (F[9] !== spc[1]) { F[9] = spc[1]; ch = true; }
    if (F[10] !== spc[2]) { F[10] = spc[2]; ch = true; }
    const nt = p.textures.length;
    for (let n = 0; n < nt && n < 4; n++) {
      const t = s.tex[p.textures[n]];
      const tc = p.texGen[n] === 4 ? this.mirrorState() : this.texState(d.archive, t), tx = tc.tex;
      if (this.bound[n] !== tx) {
        if (this.unit !== n) { gl.activeTexture(gl.TEXTURE0 + n); this.unit = n; }
        gl.bindTexture(gl.TEXTURE_2D, tx);
        this.bound[n] = tx;
      }
      const bl = Math.fround(t.blending);
      if (F[12 + n] !== bl) { F[12 + n] = bl; ch = true; }
      if (c.tcs[n] !== tc || c.tcVers[n] !== tc.ver) {
        F.set(tc.m, 24 + n * 12);
        c.tcs[n] = tc; c.tcVers[n] = tc.ver;
        ch = true;
      }
      const tcol = t.tevColors;
      if (tcol) for (let k = 0, q = 72 + n * 12; k < 12; k++) if (F[q + k] !== tcol[k]) { F[q + k] = tcol[k]; ch = true; }
    }
    if (!c.ubo) {
      c.ubo = gl.createBuffer()!;
      this.ubos.push(c.ubo);
      gl.bindBuffer(gl.UNIFORM_BUFFER, c.ubo);
      gl.bufferData(gl.UNIFORM_BUFFER, c.bytes, gl.DYNAMIC_DRAW);
      c.sent = true;
      ch = false;
    }
    if (ch) {
      gl.bindBuffer(gl.UNIFORM_BUFFER, c.ubo);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, c.bytes);
      c.sent = true;
    }
    if (p.specular && sk) {
      const j = d.jobj.index * 16, W = sk.world;
      if (W[j + 12] !== this.specX || W[j + 13] !== this.specY || W[j + 14] !== this.specZ) {
        gl.uniform3f(this.loc.uSpecAt, W[j + 12], W[j + 13], W[j + 14]);
        this.specX = W[j + 12]; this.specY = W[j + 13]; this.specZ = W[j + 14];
      }
    }
    if (ghost) {
      // a ghost keeps what is at least half there: the material's block, its alpha test changed, through the scratch one
      this.matBytes.set(c.bytes);
      this.matI[3] = 4 | (7 << 3);
      this.matF[20] = 127;
      this.uploadMaterial();
      return true;
    }
    this.bindUbo(c.ubo);
    // (a shadow being made: no blend, no depth, color only - HSD_ShadowStartRender's pixel engine)
    if (this.casting) { this.setColorWrite(true); this.setBlend(false); this.setDepth(false, gl.ALWAYS); return true; }
    this.setColorWrite(c.colorOn);
    if (c.blend === 1) this.setBlend(true, c.srcF, c.dstF, gl.FUNC_ADD);
    else if (c.blend === 3) this.setBlend(true, gl.ONE, gl.ONE, gl.FUNC_REVERSE_SUBTRACT);
    else this.setBlend(false);
    this.setDepth(c.zWrite && !this.noDepthWrite, c.zFunc);
    return true;
  }

  /** after a pass that blended, put the defaults back */
  endPass() {
    const gl = this.gl;
    this.setBlend(false);
    if (this.cs.eq !== gl.FUNC_ADD) { gl.blendEquation(gl.FUNC_ADD); this.cs.eq = gl.FUNC_ADD; }
    this.setDepth(true, gl.LEQUAL);
    this.setColorWrite(true);
  }

  /** a see-through sphere (a shield bubble), in world units */
  drawSphere(center: number[], radius: number, color: [number, number, number], alpha: number) {
    const gl = this.gl;
    if (!this.sphere) this.sphere = this.makeSphere();
    const mats = new Float32Array(16);
    mats[0] = mats[5] = mats[10] = radius; mats[15] = 1;
    mats[12] = center[0]; mats[13] = center[1]; mats[14] = center[2];
    gl.uniformMatrix4fv(this.loc.uMats, false, mats);
    const F = this.matF, I = this.matI;
    F.fill(0); I.fill(0);
    F[0] = color[0]; F[1] = color[1]; F[2] = color[2]; F[3] = alpha;
    F[4] = F[5] = F[6] = 1;
    I[4] = I[5] = I[6] = I[7] = -1;
    I[1] = 2; I[2] = 2; I[3] = 7 | (7 << 3);
    this.uploadMaterial();
    this.specX = NaN;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.sphere.vao);
    gl.drawElements(gl.TRIANGLES, this.sphere.count, this.sphere.type, 0);
    this.draws++;
    this.dirty();
    this.lastMatsD = null;
    this.endPass();
  }

  /** a particle's texture: no mip levels, bilinear or nearest as the
   *  particle says (psdisp.c) */
  private spriteTexture(sprite: { key: string; w: number; h: number; rgba: Uint8Array }, near = false): WebGLTexture {
    const gl = this.gl;
    const key = near ? sprite.key + "|near" : sprite.key;
    let tex = this.spriteTex.get(key);
    if (!tex) {
      tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sprite.w, sprite.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, sprite.rgba);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, near ? gl.NEAREST : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, near ? gl.NEAREST : gl.LINEAR);
      this.spriteTex.set(key, tex);
      this.bound[0] = null;
    }
    return tex;
  }

  /** The game's particles: quads fx/draw.ts built (17 floats a vertex, four
   *  a quad), drawn batch by batch - each batch one texture and one blend. */
  drawParticles(data: Float32Array, batches: { sprite: { key: string; w: number; h: number; rgba: Uint8Array } | null;
                additive: boolean; near?: boolean; zwrite: boolean; nozcomp: boolean; first: number; count: number }[]) {
    if (!batches.length) return;
    const gl = this.gl;
    const quads = data.length / (17 * 4);
    gl.useProgram(this.particleProg);
    // (an overlay's particles - the HUD's - through its camera)
    gl.uniformMatrix4fv(this.ploc.uViewProj, false, this.overlayVP ?? this.viewProj);
    gl.uniform1i(this.ploc.uTex, 0);
    gl.bindVertexArray(this.pvao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pvbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    if (quads > this.pQuads) {
      this.pQuads = Math.max(quads, this.pQuads * 2, 64);
      const idx = new Uint16Array(this.pQuads * 6);
      for (let q = 0; q < this.pQuads; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.pibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    }
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.colorMask(true, true, true, true);
    gl.activeTexture(gl.TEXTURE0);
    for (const b of batches) {
      gl.bindTexture(gl.TEXTURE_2D, b.sprite ? this.spriteTexture(b.sprite, b.near) : this.white);
      if (b.additive) gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(b.zwrite);
      gl.depthFunc(b.nozcomp ? gl.ALWAYS : gl.LEQUAL);
      gl.drawElements(gl.TRIANGLES, b.count * 6, gl.UNSIGNED_SHORT, b.first * 12);
      this.draws++;
    }
    this.bound[0] = null;
    gl.bindVertexArray(null);
    gl.useProgram(this.prog);
    this.dirty();
    this.endPass();
  }

  private stripBuf: Float32Array = new Float32Array(17 * 64);
  private svao: WebGLVertexArrayObject | null = null;
  private svbo: WebGLBuffer | null = null;

  /** A sword's swing strip (fx/swordtrail.ts: x, y, z, r, g, b, a per vertex,
   *  a triangle strip), drawn as the game draws it: its vertex colors
   *  alone, blended by their alpha, what is fully clear dropped, tested
   *  against depth without writing it, both sides. */
  drawTrail(v: Float32Array) {
    const gl = this.gl;
    const n = v.length / 7;
    if (n < 3) return;
    if (this.stripBuf.length < n * 17) this.stripBuf = new Float32Array(n * 17 * 2);
    const b = this.stripBuf;
    for (let i = 0; i < n; i++) {
      const o = i * 17, s = i * 7;
      b[o] = v[s]; b[o + 1] = v[s + 1]; b[o + 2] = v[s + 2]; b[o + 3] = 0; b[o + 4] = 0;
      b[o + 5] = v[s + 3]; b[o + 6] = v[s + 4]; b[o + 7] = v[s + 5]; b[o + 8] = v[s + 6];
      b[o + 9] = b[o + 10] = b[o + 11] = b[o + 12] = 0;
      // the alpha test: greater than 0, and greater than 0
      b[o + 13] = (4 << 3) | 4; b[o + 14] = 0; b[o + 15] = 0; b[o + 16] = 0;
    }
    gl.useProgram(this.particleProg);
    gl.uniformMatrix4fv(this.ploc.uViewProj, false, this.overlayVP ?? this.viewProj);
    if (!this.svao) {
      this.svao = gl.createVertexArray()!;
      gl.bindVertexArray(this.svao);
      this.svbo = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.svbo);
      particleAttribs(gl);
    }
    gl.bindVertexArray(this.svao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.svbo);
    gl.bufferData(gl.ARRAY_BUFFER, b.subarray(0, n * 17), gl.STREAM_DRAW);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.depthFunc(gl.LEQUAL);
    gl.colorMask(true, true, true, true);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, n);
    this.draws++;
    gl.bindVertexArray(null);
    gl.useProgram(this.prog);
    this.dirty();
    this.endPass();
  }

  private makeSphere(): GpuMesh {
    const gl = this.gl;
    const pos: number[] = [], idx: number[] = [];
    const R = 16, S = 24;
    for (let i = 0; i <= R; i++)
      for (let j = 0; j <= S; j++) {
        const t = (i / R) * Math.PI, p = (j / S) * Math.PI * 2;
        pos.push(Math.sin(t) * Math.cos(p), Math.cos(t), Math.sin(t) * Math.sin(p));
      }
    for (let i = 0; i < R; i++)
      for (let j = 0; j < S; j++) {
        const a = i * (S + 1) + j, b = a + S + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffers: WebGLBuffer[] = [];
    const put = (data: Float32Array, name: string, size: number) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(this.attr[name]);
      gl.vertexAttribPointer(this.attr[name], size, gl.FLOAT, false, 0, 0);
      buffers.push(b);
    };
    const n = pos.length / 3;
    put(new Float32Array(pos), "aPos", 3);
    put(new Float32Array(pos), "aNrm", 3);
    put(new Float32Array(n * 2), "aUv0", 2);
    put(new Float32Array(n * 2), "aUv1", 2);
    put(new Float32Array(n * 4).fill(1), "aClr", 4);
    put(new Float32Array(n), "aMtx", 1);
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    buffers.push(ib);
    gl.bindVertexArray(null);
    this.vaoBound = null;
    return { vao, buffers, count: idx.length, type: gl.UNSIGNED_SHORT, mode: gl.TRIANGLES, offset: 0 };
  }

  /** read one pixel of what was just drawn (for the checks) */
  pixel(x: number, y: number): number[] {
    const gl = this.gl;
    const out = new Uint8Array(4);
    gl.readPixels(Math.round(x), Math.round(y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return [...out];
  }

  dispose() {
    const gl = this.gl;
    // (nothing more warmed: its textures would go to a renderer that is gone)
    this.warmQueue = [];
    this.warmAt = 0;
    this.warmTimer?.cancel();
    this.warmTimer = null;
    for (const f of this.warmWaiting.splice(0)) f();
    for (const m of [...this.meshes.values(), ...this.models.values()]) { gl.deleteVertexArray(m.vao); m.buffers.forEach((b) => gl.deleteBuffer(b)); }
    this.models.clear();
    for (const b of [...this.ubos, this.scratchUbo]) gl.deleteBuffer(b);
    this.ubos = [];
    for (const t of this.textures.values()) gl.deleteTexture(t);
    for (const t of this.spriteTex.values()) gl.deleteTexture(t);
    for (const t of this.targets) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); gl.deleteRenderbuffer(t.depth); }
    this.targets = [];
    this.spriteTex.clear();
    this.look?.dispose();
    this.look = null;
    this.pic?.dispose();
    this.pic = null;
    if (this.mirror) {
      gl.deleteFramebuffer(this.mirror.fb); gl.deleteTexture(this.mirror.tex); gl.deleteRenderbuffer(this.mirror.depth);
      this.mirror = null;
    }
    this.meshes.clear();
    this.meshEpoch++;
    this.textures.clear();
    this.texByImage = new WeakMap();
    this.texCache = new WeakMap();
  }
}

// GX blend factors. The source and destination tables differ in 2 and 3:
// for a source they mean the destination's color, and the other way round.
function srcFactor(gl: WebGL2RenderingContext, f: number): number {
  return [gl.ZERO, gl.ONE, gl.DST_COLOR, gl.ONE_MINUS_DST_COLOR, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
          gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA][f] ?? gl.ONE;
}
function dstFactor(gl: WebGL2RenderingContext, f: number): number {
  return [gl.ZERO, gl.ONE, gl.SRC_COLOR, gl.ONE_MINUS_SRC_COLOR, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
          gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA][f] ?? gl.ZERO;
}

export type { MObj };
