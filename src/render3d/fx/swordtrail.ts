/* 3D replay viewer: the swing strip a sword leaves (the game's
 * "afterimage", ftafterimage.c).
 *
 * While a move's script has the trail on (its command 49: on with 0, off
 * with -1; a new move turns it off), every frame out of hitlag the fighter
 * notes where its sword joint is and which way it points (the joint's x
 * axis, at its size), keeping the last three. With two or more, a strip is
 * drawn through them from the newest: between each pair, one more step for
 * every 5 degrees the blade turned, the blade swung about the axis they share.
 * The strip runs from an inner to an outer length along the blade - the
 * fighter's full lengths at the newest, narrowing to a share of them at the
 * oldest - in the inner and outer colors of the fighter's data, its alpha
 * fading from one value to another along it. Marth and Roy keep the numbers
 * at their special attributes +0x78, Link and Young Link at +0x64: inner and
 * outer share, alpha at the newest and oldest, the two colors, the part
 * the sword is, and the inner and outer lengths.
 *
 * Written from what the game's code does; the numbers are
 * read from your fighter files.
 */
import type { ScriptEvent } from "./script";

/** a sword's trail numbers (the fighter's data) */
export interface SwordAttrs {
  innerShare: number;
  outerShare: number;
  alphaNew: number;
  alphaOld: number;
  inner: [number, number, number];
  outer: [number, number, number];
  part: number;
  innerLen: number;
  outerLen: number;
}

/** where the fighter keeps its sword's numbers (special attributes), by internal id */
export const SWORD_ATTRS: Record<number, number> = { 6: 0x64, 20: 0x64, 18: 0x78, 26: 0x78 };

/** read from a fighter's special attributes (float and whole-number readers) */
export function swordAttrs(at: number, float: (o: number) => number, int: (o: number) => number): SwordAttrs {
  const b = (o: number, k: number) => (int(at + o) >>> (24 - 8 * k)) & 0xff;
  return {
    innerShare: float(at), outerShare: float(at + 4),
    alphaNew: b(8, 0), alphaOld: b(8, 1),
    inner: [b(8, 2), b(8, 3), b(0xc, 0)],
    outer: [b(0xc, 2), b(0xc, 3), b(0x10, 0)],
    part: int(at + 0x14), innerLen: float(at + 0x18), outerLen: float(at + 0x1c),
  };
}

/** one noted place of the blade: its joint, and its x axis (at its size) */
export interface BladeSample { p: [number, number, number]; d: [number, number, number] }

const STEP = 0.0872664600610733; // 5 degrees

const len = (v: number[]) => Math.hypot(v[0], v[1], v[2]);

/** v turned about the unit axis u by angle a (Rodrigues) */
function rotate(v: number[], u: number[], a: number): number[] {
  const c = Math.cos(a), s = Math.sin(a), k = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) * (1 - c);
  return [v[0] * c + (u[1] * v[2] - u[2] * v[1]) * s + u[0] * k,
          v[1] * c + (u[2] * v[0] - u[0] * v[2]) * s + u[1] * k,
          v[2] * c + (u[0] * v[1] - u[1] * v[0]) * s + u[2] * k];
}

/** The strip, as the game builds it: samples newest first; out: its
 *  vertices in the game's drawing order (x, y, z, r, g, b, a each, colors
 *  0..1), a triangle strip. Null with fewer than two samples. */
export function trailStrip(samples: BladeSample[], at: SwordAttrs): Float32Array | null {
  if (samples.length < 2) return null;
  const inL = at.innerLen, outL = at.outerLen;
  // the distances along the outer tips, newest to oldest, as the game adds
  // them up (it measures each tip from the difference before, not the tip)
  const cum = [0];
  let total = 0, prev = [0, 0, 0];
  samples.forEach((s, i) => {
    const d = [s.d[0] * outL + s.p[0] - prev[0], s.d[1] * outL + s.p[1] - prev[1], s.d[2] * outL + s.p[2] - prev[2]];
    if (i !== 0) { total += len(d); cum.push(total); }
    prev = d;
  });
  if (total < 0.00001) total = 1;
  const diff = outL - inL;
  const bIn = at.innerShare * diff + inL, bOut = at.outerShare * diff + inL;
  const inD = inL - bIn, outD = outL - bOut;
  const aRange = at.alphaNew - at.alphaOld;
  const v: number[] = [];
  const put = (d: number[], p: number[], si: number, so: number, alpha: number) => {
    const a = Math.min(Math.max(alpha | 0, 0), 255) / 255;
    v.push(d[0] * si + p[0], d[1] * si + p[1], d[2] * si + p[2], at.inner[0] / 255, at.inner[1] / 255, at.inner[2] / 255, a);
    v.push(d[0] * so + p[0], d[1] * so + p[1], d[2] * so + p[2], at.outer[0] / 255, at.outer[1] / 255, at.outer[2] / 255, a);
  };
  let f = 1, k = 0;
  for (let i = 0; i < samples.length; i++) {
    const cur = samples[i];
    let so = f * outD + bOut, si = f * inD + bIn;
    let alpha = (f * aRange + at.alphaOld) | 0;
    k++;
    put(cur.d, cur.p, si, so, alpha);
    if (i === samples.length - 1) break;
    const next = samples[i + 1];
    const c = cur.d, n = next.d;
    const cr = [c[1] * n[2] - c[2] * n[1], c[2] * n[0] - c[0] * n[2], c[0] * n[1] - c[1] * n[0]];
    const cl = len(cr);
    if (cl <= 0) continue; // (the game keeps the share it had when the axes are parallel)
    const axis = cr.map((x) => x / cl);
    const lc = len(c) * len(n);
    const angle = lc > 1e-10 ? Math.acos(Math.min(1, Math.max(-1, (c[0] * n[0] + c[1] * n[1] + c[2] * n[2]) / lc))) : 0;
    const steps = Math.trunc(angle / STEP);
    f = 1 - cum[k] / total;
    if (!steps) continue;
    const frac = 1 / (steps + 1);
    const da = angle * frac;
    const dIn = frac * ((f * inD + bIn) - si), dOut = frac * ((f * outD + bOut) - so);
    const dAlpha = Math.trunc(frac * ((f * aRange + at.alphaOld) - alpha));
    const dp = [frac * (next.p[0] - cur.p[0]), frac * (next.p[1] - cur.p[1]), frac * (next.p[2] - cur.p[2])];
    const p = [...cur.p];
    for (let j = 1; j <= steps; j++) {
      p[0] += dp[0]; p[1] += dp[1]; p[2] += dp[2];
      si += dIn; so += dOut; alpha += dAlpha;
      put(rotate(c, axis, da * j), p, si, so, alpha);
    }
  }
  // the game's order: the first vertex, the third, then the rest from the second
  const n = v.length / 7;
  const out = new Float32Array((n + 1) * 7);
  out.set(v.slice(0, 7), 0);
  out.set(v.slice(14, 21), 7);
  out.set(v.slice(7), 14);
  return out;
}

/** the trails of every fighter in a replay, stepped frame by frame */
export class SwordTrails {
  /** per fighter: the count the game keeps (-1 off, else how many noted, up to 3) and the samples, newest first */
  private rings = new Map<string, { count: number; samples: BladeSample[] }>();
  private attrs = new Map<object, SwordAttrs | null>();

  clear(key?: string) {
    if (key === undefined) this.rings.clear();
    else this.rings.delete(key);
  }

  /** a fighter's frame: its move's script events between the frame before
   *  (`prev`, -1 at the move's start) and now; `entered`: a new move; the
   *  sword joint's world matrix (null: none) */
  step(key: string, events: readonly ScriptEvent[], prev: number, now: number, entered: boolean, hitlag: boolean,
       blade: Float32Array | null) {
    let r = this.rings.get(key);
    if (!r) this.rings.set(key, (r = { count: -1, samples: [] }));
    if (entered) r.count = -1;
    for (const e of events) {
      if (e.frame > now) break;
      if (e.kind === "swordTrail" && e.frame > prev) r.count = e.value;
    }
    if (r.count === -1 || hitlag || !blade) return;
    r.samples.unshift({ p: [blade[12], blade[13], blade[14]], d: [blade[0], blade[1], blade[2]] });
    if (r.samples.length > 3) r.samples.length = 3;
    if (r.count < 3) r.count++;
  }

  /** the strip to draw for a fighter now, or null */
  strip(key: string, attrs: SwordAttrs | null): Float32Array | null {
    const r = this.rings.get(key);
    if (!r || !attrs || r.count <= 1) return null;
    return trailStrip(r.samples.slice(0, r.count), attrs);
  }

  /** for the checks: each fighter's count and samples */
  debug(): Record<string, unknown> {
    const out: Record<string, unknown> = Object.fromEntries([...this.rings].map(([k, r]) => [k, { count: r.count, samples: r.samples }]));
    out.attrs = [...this.attrs.values()];
    return out;
  }

  /** a fighter's numbers, read once */
  attrsOf(fighter: object, read: () => SwordAttrs | null): SwordAttrs | null {
    if (!this.attrs.has(fighter)) this.attrs.set(fighter, read());
    return this.attrs.get(fighter) ?? null;
  }
}
