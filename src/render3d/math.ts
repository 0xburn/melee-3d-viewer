/* 3D replay viewer: 4x4 matrices, column-major, written into
 * caller-owned arrays so a frame allocates nothing. */

export type Mat = Float32Array;

export const mat = (): Mat => ident(new Float32Array(16));

export function ident(out: Mat): Mat {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

const tmp = new Float32Array(16);

/** out = a * b (out may be a or b) */
export function mul(out: Mat, a: Mat, b: Mat): Mat {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    tmp[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    tmp[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    tmp[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    tmp[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  out.set(tmp);
  return out;
}

/** mul on matrices inside bigger arrays, at their offsets: out[o] = a[ao] * b[bo]
 *  (out may overlap a or b; no views made, which cost more than the sums) */
export function mulAt(out: Float32Array, o: number, a: Float32Array, ao: number, b: Float32Array, bo: number) {
  for (let c = 0; c < 4; c++) {
    const q = bo + c * 4;
    const b0 = b[q], b1 = b[q + 1], b2 = b[q + 2], b3 = b[q + 3];
    tmp[c * 4] = a[ao] * b0 + a[ao + 4] * b1 + a[ao + 8] * b2 + a[ao + 12] * b3;
    tmp[c * 4 + 1] = a[ao + 1] * b0 + a[ao + 5] * b1 + a[ao + 9] * b2 + a[ao + 13] * b3;
    tmp[c * 4 + 2] = a[ao + 2] * b0 + a[ao + 6] * b1 + a[ao + 10] * b2 + a[ao + 14] * b3;
    tmp[c * 4 + 3] = a[ao + 3] * b0 + a[ao + 7] * b1 + a[ao + 11] * b2 + a[ao + 15] * b3;
  }
  for (let k = 0; k < 16; k++) out[o + k] = tmp[k];
}

/** out = inverse(m) (identity when m is singular; out may be m) */
export function invert(out: Mat, m: Mat): Mat {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return ident(out);
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

/** out = T * Rz * Ry * Rx * S, as HSD builds a joint's local matrix */
export function srt(out: Mat, sx_: number, sy_: number, sz_: number, rx: number, ry: number, rz: number,
                    tx: number, ty: number, tz: number): Mat {
  const cx = Math.cos(rx), cy = Math.cos(ry), cz = Math.cos(rz);
  const sx = Math.sin(rx), sy = Math.sin(ry), sz = Math.sin(rz);
  out[0] = cy * cz * sx_; out[1] = cy * sz * sx_; out[2] = -sy * sx_; out[3] = 0;
  out[4] = (sx * sy * cz - cx * sz) * sy_; out[5] = (sx * sy * sz + cx * cz) * sy_; out[6] = sx * cy * sy_; out[7] = 0;
  out[8] = (cx * sy * cz + sx * sz) * sz_; out[9] = (cx * sy * sz - sx * cz) * sz_; out[10] = cx * cy * sz_; out[11] = 0;
  out[12] = tx; out[13] = ty; out[14] = tz; out[15] = 1;
  return out;
}

/** A perspective projection whose center is moved by (shiftX, shiftY) in
 * normalized device units: an off-axis frustum. The viewer looks straight
 * down -z and moves the image instead of tilting the camera, so the plane
 * the fighters stand in maps to the screen without distortion and the
 * line-art overlays (items, shields) can be drawn over it exactly. */
export function perspective(out: Mat, fovy: number, aspect: number, near: number, far: number,
                            shiftX = 0, shiftY = 0): Mat {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[8] = shiftX;
  out[9] = shiftY;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

/** a camera at eye looking down -z, y up */
export function translation(out: Mat, x: number, y: number, z: number): Mat {
  ident(out);
  out[12] = x; out[13] = y; out[14] = z;
  return out;
}

/** a camera at `eye` looking at `at`, y up (no roll): the view matrix */
export function lookAt(out: Mat, eye: number[], at: number[]): Mat {
  let zx = eye[0] - at[0], zy = eye[1] - at[1], zz = eye[2] - at[2];
  const zl = Math.hypot(zx, zy, zz) || 1;
  zx /= zl; zy /= zl; zz /= zl;
  // right = up x back, then up = back x right
  let xx = zz, xy = 0, xz = -zx;
  const xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl; xy /= xl; xz /= xl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

export function transformPoint(m: Mat, x: number, y: number, z: number): [number, number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}
