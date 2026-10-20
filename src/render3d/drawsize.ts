/* 3D replay viewer: how many pixels the 3D view draws at (renderer.ts begin).
 *
 * The canvas follows its element: the CSS size the page gives it times the
 * screen's pixel ratio, so a player made bigger (Full Window, Full Screen)
 * draws at its new size rather than showing a small picture blown up. Within
 * a cap: the ratio counts up to MAX_DPR (a 300% screen is drawn at 200%), and
 * the whole picture up to MAX_DRAW_PIXELS - a 4K screen's worth - scaled down
 * evenly past that (a 73:60 player filling a 4K display at 150% is 2628 x 2160,
 * under it; an 8K one is drawn at the cap and shown a little larger). Neither
 * side is ever more than the graphics card can draw into (maxDim, its
 * MAX_VIEWPORT_DIMS).
 *
 * With a CRT on (exact), the canvas takes the screen pixels it covers as the
 * browser reports them, so the grille's stripes land on the screen's own
 * pixels (crt.ts); the scene itself is 640 x 480 then. Past the cap those
 * are scaled like any other size.
 */

export const MAX_DPR = 2;
export const MAX_DRAW_PIXELS = 3840 * 2160;

export function drawingSize(cssW: number, cssH: number, dpr: number,
                            opts: { device?: [number, number]; exact?: boolean; maxDim?: number } = {}): [number, number] {
  const max = opts.maxDim && opts.maxDim > 0 ? opts.maxDim : Infinity;
  const d = opts.device;
  const fits = (w: number, h: number) => w * h <= MAX_DRAW_PIXELS && w <= max && h <= max;
  if (opts.exact && d && d[0] > 0 && d[1] > 0 && fits(d[0], d[1])) return [Math.round(d[0]), Math.round(d[1])];
  const r = Math.min(Number.isFinite(dpr) && dpr > 0 ? dpr : 1, MAX_DPR);
  let w = Math.max(1, cssW) * r, h = Math.max(1, cssH) * r;
  if (w * h > MAX_DRAW_PIXELS) {
    const s = Math.sqrt(MAX_DRAW_PIXELS / (w * h));
    w *= s; h *= s;
  }
  if (w > max || h > max) {
    const s = max / Math.max(w, h);
    w *= s; h *= s;
  }
  // (rounded, or down where rounding would pass a cap)
  const [rw, rh] = fits(Math.round(w), Math.round(h)) ? [Math.round(w), Math.round(h)] : [Math.floor(w), Math.floor(h)];
  return [Math.max(1, rw), Math.max(1, rh)];
}
