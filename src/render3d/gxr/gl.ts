/* GX renderer: the WebGL 2 backend. The front half of the pipeline (vertex transform, clipping, triangle setup: xform.ts and setup.ts)
 * runs on the CPU in 32-bit float; the triangles of a run go to the GPU as words, and one fragment-shader pass per run (glsl-pixel.ts)
 * does the pixel stage. EFB copies into texture memory and the clear after a copy are passes too (glsl-copy.ts).
 *
 * Order and memory: a pass reads texture memory (a copy of main memory on the GPU) as it was at the pass; a run of triangles is queued
 * until something would change what it reads: a copy of the EFB (which reads the EFB as it must then be), a memory write that lands on
 * a texture a queued triangle uses, a new TMEM. Everything else is queued across draws.
 */
import { Memory } from "./dff";
import { copyFormat, copyParams } from "./copy";
import { COPY_FS, CLEAR_FS, PICTURE_FS } from "./glsl-copy";
import { HEADER_WORDS, MEM_BYTES, MEM_PAL, MEM_PAL_SIZE, MEM_ROW, MEM_TMEM, PIXEL_FS, STATE_WORDS, TILE } from "./glsl-pixel";
import { compile, FULLSCREEN_VS, intTexture, IntTex, uploadRows } from "./glutil";
import { bitsOf } from "./f32";
import type { GxBackend } from "./gpu";
import { setupCtx, setupTri, Tri } from "./setup";
import { bits, GxRegs } from "./state";
import { formatInfo, levelOffset } from "./texunit";
import { VertexData } from "./vertex";
import { assemble, cullClip, Pool, transformVertices, V_STRIDE, xfDraw } from "./xform";

const EFB_W = 640, EFB_H = 528;
const TILES_X = EFB_W / TILE, TILES_Y = EFB_H / TILE;
const NO_PAL = 0xffffffff;
const MEM_ROWS = MEM_BYTES / MEM_ROW;

interface Fbo { fbo: WebGLFramebuffer; tex: IntTex }

class Growable {
  words = new Uint32Array(4096 * 16);
  ints = new Int32Array(this.words.buffer);
  floats = new Float32Array(this.words.buffer);
  n = 0;
  ensure(extra: number): void {
    if (this.n + extra <= this.words.length) return;
    let cap = this.words.length;
    while (cap < this.n + extra) cap *= 2;
    const w = new Uint32Array(cap);
    w.set(this.words.subarray(0, this.n));
    this.words = w; this.ints = new Int32Array(w.buffer); this.floats = new Float32Array(w.buffer);
  }
}

export class GxGl implements GxBackend {
  /** draws are skipped until this is set (the reference draws nothing in the first frame) */
  drawing = false;
  onPicture: ((rgba: Uint8Array, frame: number) => void) | null = null;
  pictures = 0;
  tris = 0;
  /** called after a pass has been drawn (tests compare the EFB there) */
  onFlush: (() => void) | null = null;
  passes = 0;
  /** timing of the last frame's work, ms (CPU front half, GPU submit) */
  stats = { cpuMs: 0, flushMs: 0 };

  private gl: WebGL2RenderingContext;
  private progPixel: WebGLProgram;
  private progCopy: WebGLProgram;
  private progClear: WebGLProgram;
  private progPicture: WebGLProgram;
  private mem!: IntTex;
  private memFbo!: WebGLFramebuffer;
  private efb: Fbo[] = [];
  private cur = 0;
  private pictureFbo!: { fbo: WebGLFramebuffer; tex: WebGLTexture };
  private dataTex: IntTex;
  private listTex: IntTex;
  private tilesTex: IntTex;
  private statesTex: IntTex;
  private q = new Growable();
  private bb: number[] = [];
  private triOffsets: number[] = [];
  private states = new Growable();
  private stateCount = 0;
  private stateUploaded = 0;
  private stateIndex = new Map<number, number[]>();
  private stateRanges: number[][] = [];
  private lastStateVersion = [-1, -1, -1];
  private lastState = 0;
  private palMap = new Map<Uint8Array, number>();
  private palNext = 0;
  private attached: Memory | null = null;
  private dirty: number[] = [];
  private used: number[] = [];
  private tmemVersion = -1;
  private pool = new Pool();
  private uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  /** GPU time of the passes (ms), when the browser has timer queries and `timing` is on */
  timing = false;
  private timer: { ext: any; pending: { q: WebGLQuery; what: string }[]; ms: Record<string, number> } | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("EXT_color_buffer_float is needed");
    this.progPixel = compile(gl, FULLSCREEN_VS, PIXEL_FS);
    this.progCopy = compile(gl, FULLSCREEN_VS, COPY_FS);
    this.progClear = compile(gl, FULLSCREEN_VS, CLEAR_FS);
    this.progPicture = compile(gl, FULLSCREEN_VS, PICTURE_FS);
    this.mem = intTexture(gl, "R8UI", MEM_ROW, MEM_ROWS);
    this.memFbo = this.fboOf(this.mem);
    for (let i = 0; i < 2; i++) { const t = intTexture(gl, "RG32UI", EFB_W, EFB_H); this.efb.push({ fbo: this.fboOf(t), tex: t }); }
    const pt = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, pt);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, EFB_W, EFB_H);
    const pf = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, pf);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pt, 0);
    this.pictureFbo = { fbo: pf, tex: pt };
    this.dataTex = intTexture(gl, "R32UI", 4096, 64);
    this.listTex = intTexture(gl, "R32UI", 4096, 64);
    this.tilesTex = intTexture(gl, "RG32UI", 1024, 2);
    this.statesTex = intTexture(gl, "R32UI", 4096, 64);
    this.timer = { ext: null, pending: [], ms: {} };
  }

  private syncPixel = new Uint32Array(4);
  private sync(): void {
    // reading a pixel back waits for everything before it (gl.finish() may return at once)
    const gl = this.gl;
    gl.readPixels(0, 0, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, this.syncPixel);
  }
  private timeBegin(): number { if (!this.timing) return 0; this.sync(); return performance.now(); }
  private timeEnd(t0: number, what: string): void {
    if (!this.timing || !this.timer) return;
    this.sync();
    this.timer.ms[what] = (this.timer.ms[what] ?? 0) + performance.now() - t0;
  }
  /** wall-clock ms of the passes by kind since the last call (only with `timing`: every pass waits for the GPU) */
  collectTimes(): Record<string, number> {
    const t = this.timer;
    if (!t) return {};
    const out = t.ms;
    t.ms = {};
    return out;
  }

  /** back to a fresh processor: an empty frame buffer, no memory attached */
  reset(): void {
    const gl = this.gl;
    if (this.attached) { this.attached.onTouch = null; this.attached.beforeWrite = null; }
    this.attached = null;
    this.q.n = 0; this.bb = []; this.triOffsets = []; this.used = []; this.dirty = [];
    this.palMap.clear(); this.palNext = 0;
    this.resetStates();
    this.tmemVersion = -1;
    for (const e of this.efb) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, e.fbo);
      gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));
    }
    this.cur = 0; this.pictures = 0; this.tris = 0; this.passes = 0;
  }

  private fboOf(t: IntTex): WebGLFramebuffer {
    const gl = this.gl;
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    return fbo;
  }

  private u(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.uniforms.get(p);
    if (!m) { m = new Map(); this.uniforms.set(p, m); }
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name));
    return m.get(name)!;
  }

  private bindTex(p: WebGLProgram, unit: number, name: string, t: IntTex): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform1i(this.u(p, name), unit);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // memory

  private attach(mem: Memory, regs: GxRegs): void {
    if (this.attached === mem) return;
    this.attached = mem;
    const gl = this.gl;
    // the whole main memory, then TMEM
    uploadRows(gl, this.mem, 0, 0, MEM_ROW, mem.data.length / MEM_ROW, mem.data);
    this.uploadTmem(regs);
    this.dirty = [];
    mem.onTouch = (a, n) => { this.dirty.push(a, n); };
    mem.beforeWrite = (a, n) => {
      for (let i = 0; i < this.used.length; i += 2) {
        if (a < this.used[i] + this.used[i + 1] && this.used[i] < a + n) { this.flush(); break; }
      }
    };
  }

  private uploadTmem(regs: GxRegs): void {
    uploadRows(this.gl, this.mem, 0, MEM_TMEM / MEM_ROW, MEM_ROW, regs.tmem.length / MEM_ROW, regs.tmem);
    this.tmemVersion = regs.tmemVersion;
  }

  /** upload bytes [a, a + n) of a source array that holds memory from address `base` */
  private uploadBytes(a: number, n: number, src: Uint8Array, base: number): void {
    const gl = this.gl;
    const end = a + n;
    let p = a;
    // head: up to the next row start
    if (p & (MEM_ROW - 1)) {
      const m = Math.min(end, (p | (MEM_ROW - 1)) + 1) - p;
      uploadRows(gl, this.mem, p & (MEM_ROW - 1), p / MEM_ROW | 0, m, 1, src.subarray(p - base, p - base + m));
      p += m;
    }
    const rows = (end - p) / MEM_ROW | 0;
    if (rows > 0) { uploadRows(gl, this.mem, 0, p / MEM_ROW, MEM_ROW, rows, src.subarray(p - base, p - base + rows * MEM_ROW)); p += rows * MEM_ROW; }
    if (p < end) uploadRows(gl, this.mem, 0, p / MEM_ROW, end - p, 1, src.subarray(p - base, end - base));
  }

  private uploadDirty(mem: Memory): void {
    if (!this.dirty.length) return;
    const d = this.dirty;
    this.dirty = [];
    // merge into ranges by start
    const idx: number[] = [];
    for (let i = 0; i < d.length; i += 2) idx.push(i);
    idx.sort((x, y) => d[x] - d[y]);
    let s = -1, e = -1;
    for (const i of idx) {
      const a = d[i], b = d[i] + d[i + 1];
      if (s < 0) { s = a; e = b; } else if (a <= e) e = Math.max(e, b); else { this.uploadBytes(s, e - s, mem.data, 0); s = a; e = b; }
    }
    if (s >= 0) this.uploadBytes(s, e - s, mem.data, 0);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // state

  private paletteAddress(bytes: Uint8Array): number {
    let a = this.palMap.get(bytes);
    if (a !== undefined) return a;
    if (this.palNext + bytes.length > MEM_PAL_SIZE) {
      this.flush();
      this.palMap.clear(); this.palNext = 0;
      this.resetStates();
    }
    a = MEM_PAL + this.palNext;
    this.uploadBytes(a, bytes.length, bytes, a);
    this.palMap.set(bytes, a);
    this.palNext = (this.palNext + bytes.length + 31) & ~31;
    return a;
  }

  private resetStates(): void {
    this.stateCount = 0; this.stateUploaded = 0; this.states.n = 0;
    this.stateIndex.clear(); this.stateRanges = [];
    this.lastStateVersion = [-1, -1, -1];
  }

  /** the state index for the registers now (queued draws share it until a register changes) */
  private stateFor(regs: GxRegs): number {
    const tv = regs.tmemVersion;
    if (this.lastStateVersion[0] === regs.bpVersion && this.lastStateVersion[1] === regs.xfVersion && this.lastStateVersion[2] === tv) return this.lastState;
    const w = new Uint32Array(STATE_WORDS);
    w.set(regs.bp);
    for (let i = 0; i < 8; i++) w[0xe0 + i] = regs.tevBank[0][i];
    for (let i = 0; i < 8; i++) w[256 + i] = regs.tevBank[1][i];
    const ranges: number[] = [];
    let projMask = 0;
    for (let n = 0; n < 8; n++) if (bits(regs.xf[0x1040 + n], 1, 1)) projMask |= 1 << n;
    w[272] = projMask;
    w[273] = bitsOf(new Float32Array(regs.xf.buffer, regs.xf.byteOffset, regs.xf.length)[0x101a]);
    const nStages = bits(regs.bp[0], 10, 4) + 1;
    const seen = new Set<number>();
    for (let m = 0; m < 8; m++) w[264 + m] = NO_PAL;
    for (let si = 0; si < nStages; si++) {
      const ord = regs.bp[0x28 + (si >> 1)] >>> (si & 1 ? 12 : 0);
      if (!bits(ord, 6, 1)) continue;
      const m = bits(ord, 0, 3);
      if (seen.has(m)) continue;
      seen.add(m);
      const hi = m >= 4, k = m & 3;
      const img0 = regs.bp[(hi ? 0xa8 : 0x88) + k], img1 = regs.bp[(hi ? 0xac : 0x8c) + k], img3 = regs.bp[(hi ? 0xb4 : 0x94) + k], tl = regs.bp[(hi ? 0xb8 : 0x98) + k];
      const fmt = bits(img0, 20, 4), W = bits(img0, 0, 10), H = bits(img0, 10, 10);
      if (!bits(img1, 21, 1)) {
        let levels = 1, mw = W + 1, mh = H + 1;
        while (mw > 1 || mh > 1) { mw >>= 1; mh >>= 1; levels++; }
        const fi = formatInfo(fmt);
        const size = levelOffset(fmt, W, H, levels - 1) + Math.max(mw, fi.bw) * Math.max(mh, fi.bh) * fi.nibbles / 2 + 64;
        ranges.push((img3 & 0xffffff) * 32, size);
      }
      if (fmt === 8 || fmt === 9 || fmt === 10) {
        const pal = regs.tluts.get(bits(tl, 0, 10));
        if (pal) w[264 + m] = this.paletteAddress(pal);
      }
    }
    // hash and find
    let h = 2166136261;
    for (let i = 0; i < STATE_WORDS; i++) { h ^= w[i]; h = Math.imul(h, 16777619); }
    h >>>= 0;
    let found = -1;
    const cands = this.stateIndex.get(h);
    if (cands) {
      for (const c of cands) {
        const base = c * STATE_WORDS;
        let same = true;
        for (let i = 0; i < STATE_WORDS; i++) if (this.states.words[base + i] !== w[i]) { same = false; break; }
        if (same) { found = c; break; }
      }
    }
    if (found < 0) {
      found = this.stateCount++;
      this.states.ensure(STATE_WORDS);
      this.states.words.set(w, found * STATE_WORDS);
      this.states.n = this.stateCount * STATE_WORDS;
      if (cands) cands.push(found); else this.stateIndex.set(h, [found]);
      this.stateRanges[found] = ranges;
    }
    this.lastStateVersion = [regs.bpVersion, regs.xfVersion, tv];
    this.lastState = found;
    return found;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // draws

  draw(regs: GxRegs, mem: Memory, vd: VertexData, tris: number[], lines: number[], points: number[], prims: { type: number; base: number; count: number }[]): void {
    if (!this.drawing) return;
    const t0 = performance.now();
    this.attach(mem, regs);
    if (regs.tmemVersion !== this.tmemVersion) { this.flush(); this.uploadTmem(regs); }
    const st = this.stateFor(regs);
    const ranges = this.stateRanges[st];
    for (let i = 0; i < ranges.length; i += 2) this.used.push(ranges[i], ranges[i + 1]);
    const pool = this.pool;
    pool.clear();
    const x = xfDraw(regs, vd);
    const base = transformVertices(x, regs, vd, pool);
    const sc = setupCtx(regs.bp);
    const cull = bits(regs.bp[0], 14, 2);
    const trip: number[] = [];
    for (const p of prims) assemble(p.type, p.count, p.base, trip);
    const mark = pool.n;
    for (let i = 0; i + 2 < trip.length; i += 3) {
      pool.n = mark;
      const poly = cullClip(pool, cull, base + trip[i] * V_STRIDE, base + trip[i + 1] * V_STRIDE, base + trip[i + 2] * V_STRIDE);
      if (!poly) continue;
      for (let k = 1; k + 1 < poly.length; k++) {
        const t = setupTri(pool, x, sc, st, poly[0], poly[k], poly[k + 1]);
        if (t) this.push(t);
      }
    }
    this.stats.cpuMs += performance.now() - t0;
  }

  private push(t: Tri): void {
    const q = this.q;
    const need = HEADER_WORDS + t.np * 3;
    q.ensure(need);
    const o = q.n;
    this.triOffsets.push(o);
    const I = q.ints, U = q.words;
    I[o] = t.DX12; I[o + 1] = t.DY12; I[o + 2] = t.DX23; I[o + 3] = t.DY23; I[o + 4] = t.DX31; I[o + 5] = t.DY31;
    I[o + 6] = t.C1; I[o + 7] = t.C2; I[o + 8] = t.C3;
    I[o + 9] = t.minx; I[o + 10] = t.maxx; I[o + 11] = t.miny; I[o + 12] = t.maxy;
    I[o + 13] = t.xi; I[o + 14] = t.yi;
    U[o + 15] = bitsOf(t.ox); U[o + 16] = bitsOf(t.oy);
    U[o + 17] = t.state; U[o + 18] = t.np;
    const pw = new Uint32Array(t.planes.buffer, t.planes.byteOffset, t.np * 3);
    U.set(pw, o + HEADER_WORDS);
    q.n += need;
    this.bb.push(Math.max(0, t.minx), Math.max(0, t.miny), Math.min(EFB_W - 1, t.maxx), Math.min(EFB_H - 1, t.maxy));
    this.tris++;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // passes

  private grow(t: IntTex, n: number, perRow: number): IntTex {
    const rows = Math.ceil(n / perRow);
    if (rows <= t.h) return t;
    let h = t.h;
    while (h < rows) h *= 2;
    this.gl.deleteTexture(t.tex);
    return intTexture(this.gl, t.fmt, t.w, h);
  }

  flush(): void {
    const nt = this.triOffsets.length;
    // memory writes that have landed go to the GPU now, before anything that writes memory there (a copy) or reads it
    if (this.attached) this.uploadDirty(this.attached);
    if (nt === 0) { this.used = []; return; }
    const t0 = performance.now();
    const gl = this.gl;
    // bins
    const counts = new Uint32Array(TILES_X * TILES_Y + 1);
    const bb = this.bb;
    for (let i = 0; i < nt; i++) {
      const tx0 = bb[i * 4] >> 4, ty0 = bb[i * 4 + 1] >> 4, tx1 = bb[i * 4 + 2] >> 4, ty1 = bb[i * 4 + 3] >> 4;
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) counts[ty * TILES_X + tx]++;
    }
    const start = new Uint32Array(TILES_X * TILES_Y + 1);
    let total = 0;
    for (let t = 0; t < TILES_X * TILES_Y; t++) { start[t] = total; total += counts[t]; }
    const list = new Uint32Array(Math.max(1, Math.ceil(total / 4096)) * 4096);
    const fill = new Uint32Array(TILES_X * TILES_Y);
    for (let i = 0; i < nt; i++) {
      const off = this.triOffsets[i];
      const tx0 = bb[i * 4] >> 4, ty0 = bb[i * 4 + 1] >> 4, tx1 = bb[i * 4 + 2] >> 4, ty1 = bb[i * 4 + 3] >> 4;
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) { const t = ty * TILES_X + tx; list[start[t] + fill[t]++] = off; }
    }
    const tiles = new Uint32Array(1024 * 2 * 2);
    for (let t = 0; t < TILES_X * TILES_Y; t++) { tiles[t * 2] = start[t]; tiles[t * 2 + 1] = counts[t]; }
    // uploads
    this.dataTex = this.grow(this.dataTex, this.q.n, 4096);
    const dataRows = Math.ceil(this.q.n / 4096);
    uploadRows(gl, this.dataTex, 0, 0, 4096, dataRows, this.q.words.subarray(0, dataRows * 4096));
    this.listTex = this.grow(this.listTex, list.length, 4096);
    uploadRows(gl, this.listTex, 0, 0, 4096, list.length / 4096, list);
    uploadRows(gl, this.tilesTex, 0, 0, 1024, 2, tiles);
    const st0 = this.statesTex;
    this.statesTex = this.grow(this.statesTex, this.states.n, 4096);
    if (this.statesTex !== st0) this.stateUploaded = 0;
    const sRows = Math.ceil(this.states.n / 4096);
    const sFirst = Math.floor(this.stateUploaded * STATE_WORDS / 4096);
    this.states.ensure(sRows * 4096 - this.states.n);
    uploadRows(gl, this.statesTex, 0, sFirst, 4096, sRows - sFirst, this.states.words.subarray(sFirst * 4096, sRows * 4096));
    this.stateUploaded = this.stateCount;
    // the pass
    const src = this.efb[this.cur], dst = this.efb[1 - this.cur];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, EFB_W, EFB_H);
    gl.disable(gl.SCISSOR_TEST);
    const p = this.progPixel;
    gl.useProgram(p);
    this.bindTex(p, 0, "uMem", this.mem);
    this.bindTex(p, 1, "uData", this.dataTex);
    this.bindTex(p, 2, "uTiles", this.tilesTex);
    this.bindTex(p, 3, "uList", this.listTex);
    this.bindTex(p, 4, "uStates", this.statesTex);
    this.bindTex(p, 5, "uEfb", src.tex);
    gl.uniform1i(this.u(p, "uTilesX"), TILES_X);
    gl.uniform4i(this.u(p, "uK"), 4, 25, 3, 2);
    const tq = this.timeBegin();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.timeEnd(tq, "pixel");
    this.cur = 1 - this.cur;
    this.passes++;
    this.q.n = 0; this.bb = []; this.triOffsets = []; this.used = [];
    this.stats.flushMs += performance.now() - t0;
    this.onFlush?.();
  }

  /** wait for the GPU (timing, tests) */
  finish(): void { this.gl.finish(); }

  copy(regs: GxRegs, mem: Memory, value: number): { toXfb: boolean; rect: number[]; clear: boolean } {
    this.attach(mem, regs);
    this.flush();
    const gl = this.gl;
    const p = copyParams(regs.bp);
    const src = this.efb[this.cur];
    if (p.toScreen) {
      if (this.onPicture) this.onPicture(this.readPicture(p.pixFmt), this.pictures);
      this.pictures++;
    } else {
      const fmt = copyFormat(p.tp, p.intensity);
      const ID: Record<string, number> = { I4: 0, I8: 1, IA4: 2, IA8: 3, RGB565: 4, RGB5A3: 5, RGBA8: 6, R4: 7, RA4: 8, RA8: 9, A8: 10, R8: 11, G8: 12, B8: 13, RG8: 14, GB8: 15 };
      if (fmt !== "none") {
        const BL: Record<string, [number, number, number]> = {
          I4: [3, 3, 32], I8: [3, 2, 32], IA4: [3, 2, 32], IA8: [2, 2, 32], RGB565: [2, 2, 32], RGB5A3: [2, 2, 32], RGBA8: [2, 2, 64],
          R4: [3, 3, 32], RA4: [3, 2, 32], RA8: [2, 2, 32], A8: [3, 2, 32], R8: [3, 2, 32], G8: [3, 2, 32], B8: [3, 2, 32], RG8: [2, 2, 32], GB8: [2, 2, 32],
        };
        const [kw, kh, bytes] = BL[fmt];
        const sh = p.half ? 1 : 0;
        const bx = ((p.wm >> sh) >> kw) + 1, by = ((p.hm >> sh) >> kh) + 1;
        const dest = p.dest & 0x1ffffff;
        const total = (by - 1) * p.stride + bx * bytes;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.memFbo);
        gl.viewport(0, 0, MEM_ROW, MEM_ROWS);
        gl.enable(gl.SCISSOR_TEST);
        const row0 = dest / MEM_ROW | 0, row1 = Math.min(MEM_ROWS - 1, (dest + total) / MEM_ROW | 0);
        gl.scissor(0, row0, MEM_ROW, row1 - row0 + 1);
        const pr = this.progCopy;
        gl.useProgram(pr);
        this.bindTex(pr, 0, "uEfb", src.tex);
        const set = (n: string, v: number) => gl.uniform1i(this.u(pr, n), v);
        set("uDest", dest); set("uStride", p.stride); set("uFmt", ID[fmt]); set("uBlocksX", bx); set("uBlocksY", by); set("uKw", kw); set("uKh", kh);
        set("uBytes", bytes); set("uHalf", sh); set("uX0", p.x0); set("uY0", p.y0); set("uPixFmt", p.pixFmt);
        const tq = this.timeBegin();
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.timeEnd(tq, "copy");
        gl.disable(gl.SCISSOR_TEST);
      }
    }
    return { toXfb: p.toScreen, rect: [p.x0, p.y0, p.wm + 1, p.hm + 1], clear: p.clear };
  }

  copyClear(regs: GxRegs): void {
    this.flush();
    const gl = this.gl;
    const p = copyParams(regs.bp);
    const bp = regs.bp;
    const mode = bp[0x41];
    const r = bp[0x4f] & 255, a = (bp[0x4f] >> 8) & 255, b = bp[0x50] & 255, g = (bp[0x50] >> 8) & 255;
    const src = this.efb[this.cur], dst = this.efb[1 - this.cur];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, EFB_W, EFB_H);
    gl.disable(gl.SCISSOR_TEST);
    const pr = this.progClear;
    gl.useProgram(pr);
    this.bindTex(pr, 0, "uEfb", src.tex);
    gl.uniform4i(this.u(pr, "uRect"), p.x0, p.y0, p.x0 + p.wm, p.y0 + p.hm);
    const color = p.pixFmt === 1 ? ((b >> 2) << 6 | (g >> 2) << 12 | (r >> 2) << 18) >>> 0 : (b | (g << 8) | (r << 16)) >>> 0;
    gl.uniform1ui(this.u(pr, "uColor"), color);
    gl.uniform1ui(this.u(pr, "uAlpha6"), a >> 2);
    gl.uniform1ui(this.u(pr, "uDepth"), bp[0x51] & 0xffffff);
    gl.uniform1i(this.u(pr, "uColorUpd"), (mode >> 3) & 1);
    gl.uniform1i(this.u(pr, "uAlphaUpd"), (mode >> 4) & 1);
    gl.uniform1i(this.u(pr, "uZUpd"), bits(bp[0x40], 4, 1));
    gl.uniform1i(this.u(pr, "uPixFmt"), p.pixFmt);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = 1 - this.cur;
  }

  /** set the frame buffer (tests) */
  writeEfb(color: Uint32Array, depth: Uint32Array): void {
    const raw = new Uint32Array(EFB_W * EFB_H * 2);
    for (let i = 0; i < color.length; i++) { raw[i * 2] = color[i]; raw[i * 2 + 1] = depth[i]; }
    uploadRows(this.gl, this.efb[this.cur].tex, 0, 0, EFB_W, EFB_H, raw);
  }

  /** bytes [a, a + n) of the GPU's copy of memory (slow: tests) */
  readMem(a: number, n: number): Uint8Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.memFbo);
    const row0 = a / MEM_ROW | 0, row1 = (a + n - 1) / MEM_ROW | 0;
    const raw = new Uint32Array(MEM_ROW * (row1 - row0 + 1) * 4);
    gl.readPixels(0, row0, MEM_ROW, row1 - row0 + 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, raw);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = raw[(a - row0 * MEM_ROW + i) * 4];
    return out;
  }

  /** the whole EFB: color words and depths (slow: tests) */
  readEfb(): { color: Uint32Array; depth: Uint32Array } {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.efb[this.cur].fbo);
    const raw = new Uint32Array(EFB_W * EFB_H * 4);
    gl.readPixels(0, 0, EFB_W, EFB_H, gl.RGBA_INTEGER, gl.UNSIGNED_INT, raw);
    const color = new Uint32Array(EFB_W * EFB_H), depth = new Uint32Array(EFB_W * EFB_H);
    for (let i = 0; i < color.length; i++) { color[i] = raw[i * 4]; depth[i] = raw[i * 4 + 1]; }
    return { color, depth };
  }

  /** the top 640 x 480 of the EFB as RGBA bytes (R, G, B, A) */
  readPicture(pixFmt: number): Uint8Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pictureFbo.fbo);
    gl.viewport(0, 0, EFB_W, EFB_H);
    gl.disable(gl.SCISSOR_TEST);
    const pr = this.progPicture;
    gl.useProgram(pr);
    this.bindTex(pr, 0, "uEfb", this.efb[this.cur].tex);
    gl.uniform1i(this.u(pr, "uPixFmt"), pixFmt);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const out = new Uint8Array(EFB_W * 480 * 4);
    gl.readPixels(0, 0, EFB_W, 480, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }
}
