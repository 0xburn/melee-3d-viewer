/* GX renderer: the TEV's arithmetic and the blend unit on the CPU (spec sections 10.4 and 11.5). The reference the shader is
 * checked against. */

const sx11 = (v: number): number => (v << 21) >> 21;

/** combiner arithmetic for one component. a, b, c are bytes, d the 11-bit signed value; mode: bias code 0 none, 1 +128, 2 -128, 3 compare */
export function tevRegular(isAlpha: boolean, a: number, b: number, c: number, d: number, bias: number, op: number, scale: number, clamp: number): number {
  const ls = scale === 1 ? 1 : scale === 2 ? 2 : 0, rs = scale === 3 ? 1 : 0;
  const B = bias === 1 ? 128 : bias === 2 ? -128 : 0;
  const cw = c + (c >> 7);
  let t = a * (256 - cw) + b * cw;
  t = t << ls;
  if (!isAlpha) {
    t = t + (scale === 3 ? 0 : op ? 127 : 128);
    t = t >> 8;
    t = op ? -t : t;
  } else {
    t = t + (scale !== 3 ? 0 : op ? 127 : 128);
    t = op ? (-t) >> 8 : t >> 8;
  }
  let r = ((d + B) << ls) + t;
  r = r >> rs;
  return clampTev(r, clamp);
}

export function clampTev(r: number, clamp: number): number {
  r = (r << 16) >> 16;
  if (clamp) return r < 0 ? 0 : r > 255 ? 255 : r;
  return r < -1024 ? -1024 : r > 1023 ? 1023 : r;
}

/** compare mode result for one component: cond already evaluated */
export function tevCompare(cond: boolean, c: number, d: number, clamp: number): number {
  return clampTev(d + (cond ? c : 0), clamp);
}

export const sext11 = sx11;

// ---------------------------------------------------------------------------------------------------------------------
// blend (11.5)

/** s and d are [r, g, b, a] bytes. Returns the result in out. mode is BP[0x41], dstAlpha is BP[0x42] */
export function blend(mode: number, dstAlpha: number, s: number[], d: number[], out: number[]): void {
  const enable = mode & 1, logic = (mode >> 1) & 1, sub = (mode >> 11) & 1;
  const dfc = (mode >> 5) & 7, sfc = (mode >> 8) & 7, lop = (mode >> 12) & 15;
  if (enable) {
    if (sub) {
      for (let k = 0; k < 4; k++) out[k] = Math.max(0, d[k] - s[k]);
    } else {
      for (let k = 0; k < 4; k++) {
        let fs: number, fd: number;
        switch (sfc) {
          case 0: fs = 0; break; case 1: fs = 255; break; case 2: fs = d[k]; break; case 3: fs = 255 - d[k]; break;
          case 4: fs = s[3]; break; case 5: fs = 255 - s[3]; break; case 6: fs = d[3]; break; default: fs = 255 - d[3];
        }
        switch (dfc) {
          case 0: fd = 0; break; case 1: fd = 255; break; case 2: fd = s[k]; break; case 3: fd = 255 - s[k]; break;
          case 4: fd = s[3]; break; case 5: fd = 255 - s[3]; break; case 6: fd = d[3]; break; default: fd = 255 - d[3];
        }
        fs += fs >> 7; fd += fd >> 7;
        out[k] = Math.min(255, (s[k] * fs + d[k] * fd) >> 8);
      }
    }
  } else if (logic) {
    const S = (s[3] | (s[2] << 8) | (s[1] << 16) | (s[0] << 24)) >>> 0;
    const Dd = (d[3] | (d[2] << 8) | (d[1] << 16) | (d[0] << 24)) >>> 0;
    let r: number;
    switch (lop) {
      case 0: r = 0; break; case 1: r = S & Dd; break; case 2: r = S & ~Dd; break; case 3: r = S; break;
      case 4: r = ~S & Dd; break; case 5: r = Dd; break; case 6: r = S ^ Dd; break; case 7: r = S | Dd; break;
      case 8: r = ~(S | Dd); break; case 9: r = ~(S ^ Dd); break; case 10: r = ~Dd; break; case 11: r = S | ~Dd; break;
      case 12: r = ~S; break; case 13: r = ~S | Dd; break; case 14: r = ~(S & Dd); break; default: r = -1;
    }
    r >>>= 0;
    out[0] = r >>> 24; out[1] = (r >>> 16) & 255; out[2] = (r >>> 8) & 255; out[3] = r & 255;
  } else {
    out[0] = s[0]; out[1] = s[1]; out[2] = s[2]; out[3] = s[3];
  }
  if ((dstAlpha >> 8) & 1) out[3] = dstAlpha & 255;
}
