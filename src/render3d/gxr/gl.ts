/// <reference lib="dom" />
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
import { COPY_FS, CLEAR_FS, PICTURE_FS, PRESENT_FS } from "./glsl-copy";
import { HEADER_TEXELS, MEM_BYTES, MEM_PAL, MEM_PAL_SIZE, MEM_ROW, MEM_TMEM, pixelShader, STATE_WORDS, TILE } from "./glsl-pixel";
import { compile, compileDone, Compiling, finishCompile, FULLSCREEN_VS, intTexture, IntTex, startCompile, uploadRows } from "./glutil";
import { bitsOf } from "./f32";
import type { GxBackend } from "./gpu";
import { planeCount, setupCtx, setupTriInto, TS } from "./setup";
import { bits, GxRegs } from "./state";
import { formatInfo, levelOffset } from "./texunit";
import { VertexData } from "./vertex";
import { assemble, clipLine, cullClipInto, lineTriangles, Pool, poly, polyState, transformVertices, V_STRIDE, xfDraw } from "./xform";

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
  /** draws are skipped while this is false (the spec's reference draws nothing in the first frame of a recording; a viewer leaves it on) */
  drawing = true;
  onPicture: ((rgba: Uint8Array, frame: number) => void) | null = null;
  pictures = 0;
  tris = 0;
  /** called after a pass has been drawn (tests compare the EFB there) */
  onFlush: (() => void) | null = null;
  passes = 0;
  /** the features of the last pass's program (tests) */
  lastFeatures = 0;
  /** timing of the last frame's work, ms (CPU front half, GPU submit) */
  stats = { cpuMs: 0, flushMs: 0, uploadMs: 0, memBytes: 0, listEntries: 0, tilesTouched: 0 };

  private gl: WebGL2RenderingContext;
  private pending: Map<string, Compiling>;
  private progs = new Map<string, WebGLProgram>();
  private get progPixel(): WebGLProgram { return this.program("pixel"); }
  private get progCopy(): WebGLProgram { return this.program("copy"); }
  private get progClear(): WebGLProgram { return this.program("clear"); }
  private get progPicture(): WebGLProgram { return this.program("picture"); }
  /** what the queued draws need beyond the base shader: 1 the indirect unit, 2 the exponential fog and range adjustment */
  private needFeatures = 0;
  private stateFeatures: number[] = [];
  private mem!: IntTex;
  private memFbo!: WebGLFramebuffer;
  private efb: Fbo[] = [];
  private cur = 0;
  private pictureFbo!: { fbo: WebGLFramebuffer; tex: WebGLTexture };
  /** the pass inputs, in a ring: a pass still running on the GPU keeps reading its own set while the next is written */
  private sets: { data: IntTex; list: IntTex; tiles: IntTex }[] = [];
  private setNo = 0;
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
  /** the texture ranges the queued triangles read: start -> length */
  private used = new Map<number, number>();
  private tmemVersion = -1;
  private pool = new Pool();
  private trip: number[] = [];
  private entTile = new Int32Array(1 << 16);
  private entTri = new Int32Array(1 << 16);
  private lineIdx: number[] = [];
  private need = new Uint8Array(4096);
  private uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  /** whether `stats` are kept (reading the clock per draw costs about 1% of a frame) */
  measure = false;
  /** GPU time of the passes (ms), when the browser has timer queries and `timing` is on */
  timing = false;
  private timer: { ext: any; pending: { q: WebGLQuery; what: string }[]; ms: Record<string, number> } | null = null;

  /** options of the pixel shader (test aids) */
  constructor(gl: WebGL2RenderingContext, private shaderOptions: { debugRegs?: [number, number] } = {}) {
    this.gl = gl;
    if (gl.getParameter(gl.MAX_TEXTURE_SIZE) < MEM_ROWS) throw new Error(`the GX renderer needs textures of ${MEM_ROWS} texels (this GPU's limit is ${gl.getParameter(gl.MAX_TEXTURE_SIZE)})`);
    // the programs compile in the background (when the browser can); `prepare()` waits for them, and the first draw would
    this.pending = new Map([
      ["pixel", startCompile(gl, FULLSCREEN_VS, pixelShader(shaderOptions))], ["copy", startCompile(gl, FULLSCREEN_VS, COPY_FS)],
      ["clear", startCompile(gl, FULLSCREEN_VS, CLEAR_FS)], ["picture", startCompile(gl, FULLSCREEN_VS, PICTURE_FS)],
      ["present", startCompile(gl, FULLSCREEN_VS, PRESENT_FS)],
    ]);
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
    for (let i = 0; i < 4; i++) this.sets.push({ data: intTexture(gl, "RGBA32UI", 1024, 64), list: intTexture(gl, "R32UI", 4096, 64), tiles: intTexture(gl, "RG32UI", 1024, 2) });
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
    this.q.n = 0; this.bb = []; this.triOffsets = []; this.used.clear(); this.dirty = [];
    this.palMap.clear(); this.palNext = 0;
    this.resetStates();
    this.tmemVersion = -1;
    for (const e of this.efb) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, e.fbo);
      gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));
    }
    this.cur = 0; this.pictures = 0; this.tris = 0; this.passes = 0;
  }

  private program(name: string): WebGLProgram {
    let p = this.progs.get(name);
    if (!p) { p = finishCompile(this.gl, this.pending.get(name)!); this.progs.set(name, p); this.pending.delete(name); }
    return p;
  }

  /** wait (without blocking the page) until the shaders are compiled; `features` also starts the optional pixel shader variants
   *  (1: the indirect texture unit, 2: the exponential fog and range adjustment) so that no draw has to wait for them later */
  async prepare(features = 0): Promise<void> {
    for (const f of [1, 2, 3]) if ((features & f) === f && !this.pending.has("pixel" + f) && !this.progs.has("pixel" + f)) {
      this.pending.set("pixel" + f, startCompile(this.gl, FULLSCREEN_VS, pixelShader({ ...this.shaderOptions, indirect: (f & 1) !== 0, fogExtra: (f & 2) !== 0 })));
    }
    for (const [name, c] of [...this.pending]) {
      while (!compileDone(this.gl, c)) await new Promise((r) => setTimeout(r, 10));
      this.program(name);
    }
  }

  /** the pixel program for a set of features (compiled when first needed) */
  private pixelProgram(features: number): WebGLProgram {
    if (features === 0) return this.progPixel;
    const key = "pixel" + features;
    if (!this.progs.has(key) && !this.pending.has(key)) this.pending.set(key, startCompile(this.gl, FULLSCREEN_VS, pixelShader({ ...this.shaderOptions, indirect: (features & 1) !== 0, fogExtra: (features & 2) !== 0 })));
    return this.program(key);
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
      for (const [start, len] of this.used) {
        if (a < start + len && start < a + n) { this.flush(); break; }
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
    for (let i = 1; i < d.length; i += 2) this.stats.memBytes += d[i];
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
    this.stateIndex.clear(); this.stateRanges = []; this.stateFeatures = [];
    this.lastStateVersion = [-1, -1, -1];
  }

  /** the state index for the registers now (queued draws share it until a register changes) */
  private wScratch = new Uint32Array(STATE_WORDS);

  /** the memory ranges (start, length) of the textures the enabled stages read, for the hazard check */
  private textureRanges(regs: GxRegs, nStages: number): number[] {
    const ranges: number[] = [];
    const seen = new Set<number>();
    for (let si = 0; si < nStages; si++) {
      const ord = regs.bp[0x28 + (si >> 1)] >>> (si & 1 ? 12 : 0);
      if (!bits(ord, 6, 1)) continue;
      const m = bits(ord, 0, 3);
      if (seen.has(m)) continue;
      seen.add(m);
      const hi = m >= 4, k = m & 3;
      const img0 = regs.bp[(hi ? 0xa8 : 0x88) + k], img1 = regs.bp[(hi ? 0xac : 0x8c) + k], img3 = regs.bp[(hi ? 0xb4 : 0x94) + k];
      const fmt = bits(img0, 20, 4), W = bits(img0, 0, 10), H = bits(img0, 10, 10);
      if (bits(img1, 21, 1)) continue;
      let levels = 1, mw = W + 1, mh = H + 1;
      while (mw > 1 || mh > 1) { mw >>= 1; mh >>= 1; levels++; }
      const fi = formatInfo(fmt);
      const size = levelOffset(fmt, W, H, levels - 1) + Math.max(mw, fi.bw) * Math.max(mh, fi.bh) * fi.nibbles / 2 + 64;
      ranges.push((img3 & 0xffffff) * 32, size);
    }
    return ranges;
  }

  private stateFor(regs: GxRegs): number {
    if (this.stateCount > 20000) { this.flush(); this.palMap.clear(); this.palNext = 0; this.resetStates(); }
    const tv = regs.tmemVersion;
    if (this.lastStateVersion[0] === regs.bpVersion && this.lastStateVersion[1] === regs.xfVersion && this.lastStateVersion[2] === tv) return this.lastState;
    const w = this.wScratch;
    w.fill(0);
    w.set(regs.bp);
    for (let i = 0; i < 8; i++) w[0xe0 + i] = regs.tevBank[0][i];
    for (let i = 0; i < 8; i++) w[256 + i] = regs.tevBank[1][i];
    let projMask = 0;
    for (let n = 0; n < 8; n++) if ((regs.xf[0x1040 + n] >> 1) & 1) projMask |= 1 << n;
    w[272] = projMask;
    w[273] = regs.xf[0x101a];
    const nStages = bits(regs.bp[0], 10, 4) + 1;
    let seen = 0;
    for (let m = 0; m < 8; m++) w[264 + m] = NO_PAL;
    for (let si = 0; si < nStages; si++) {
      const ord = regs.bp[0x28 + (si >> 1)] >>> (si & 1 ? 12 : 0);
      if (!((ord >> 6) & 1)) continue;
      const m = ord & 7;
      if ((seen >> m) & 1) continue;
      seen |= 1 << m;
      const hi = m >= 4, k = m & 3;
      const fmt = (regs.bp[(hi ? 0xa8 : 0x88) + k] >> 20) & 15;
      if (fmt === 8 || fmt === 9 || fmt === 10) {
        const pal = regs.tluts.get(regs.bp[(hi ? 0xb8 : 0x98) + k] & 0x3ff);
        if (pal) { w[264 + m] = this.paletteAddress(pal); w[274 + m] = pal.length; }
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
      this.stateRanges[found] = this.textureRanges(regs, nStages);
      let feat = 0;
      if (bits(regs.bp[0], 16, 3) > 0) for (let si = 0; si < nStages; si++) if (regs.bp[0x10 + si] !== 0) feat |= 1;
      if (bits(regs.bp[0xf1], 21, 3) > 2 || (bits(regs.bp[0xf1], 21, 3) !== 0 && bits(regs.bp[0xe8], 10, 1))) feat |= 2;
      this.stateFeatures[found] = feat;
    }
    this.lastStateVersion = [regs.bpVersion, regs.xfVersion, tv];
    this.lastState = found;
    return found;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // draws

  draw(regs: GxRegs, mem: Memory, vd: VertexData, tris: number[], lines: number[], points: number[], prims: { type: number; base: number; count: number }[]): void {
    if (!this.drawing) return;
    const t0 = this.measure ? performance.now() : 0;
    this.attach(mem, regs);
    if (regs.tmemVersion !== this.tmemVersion) { this.flush(); this.uploadTmem(regs); }
    const st = this.stateFor(regs);
    const ranges = this.stateRanges[st];
    this.needFeatures |= this.stateFeatures[st];
    for (let i = 0; i < ranges.length; i += 2) if ((this.used.get(ranges[i]) ?? 0) < ranges[i + 1]) this.used.set(ranges[i], ranges[i + 1]);
    const pool = this.pool;
    pool.clear();
    const x = xfDraw(regs, vd);
    const trip = this.trip;
    trip.length = 0;
    for (let i = 0; i < prims.length; i++) assemble(prims[i].type, prims[i].count, prims[i].base, trip);
    // only the vertices a triangle uses are transformed (a run also holds points, which draw nothing)
    if (this.need.length < vd.n) this.need = new Uint8Array(Math.max(vd.n, this.need.length * 2));
    const need = this.need;
    need.fill(0, 0, vd.n);
    for (let i = 0; i < trip.length; i++) need[trip[i]] = 1;
    const lineIdx = this.lineIdx;
    lineIdx.length = 0;
    for (let i = 0; i < prims.length; i++) {
      const p = prims[i];
      if (p.type === 5) for (let k = 0; k + 1 < p.count; k += 2) lineIdx.push(p.base + k, p.base + k + 1);
      else if (p.type === 6) for (let k = 0; k + 1 < p.count; k++) lineIdx.push(p.base + k, p.base + k + 1);
    }
    for (let i = 0; i < lineIdx.length; i++) need[lineIdx[i]] = 1;
    const base = transformVertices(x, regs, vd, pool, need);
    const sc = setupCtx(regs.bp);
    const cull = bits(regs.bp[0], 14, 2);
    const mark = pool.n;
    const q = this.q;
    const nPlanes = planeCount(sc);
    const words = (HEADER_TEXELS + nPlanes) * 4;
    for (let i = 0; i + 2 < trip.length; i += 3) {
      pool.n = mark;
      if (!cullClipInto(pool, cull, base + trip[i] * V_STRIDE, base + trip[i + 1] * V_STRIDE, base + trip[i + 2] * V_STRIDE)) continue;
      const n = polyState.n;
      for (let k = 1; k + 1 < n; k++) {
        q.ensure(words);
        const o = q.n;
        if (!setupTriInto(pool, x, sc, poly[0], poly[k], poly[k + 1], q.floats, o + HEADER_TEXELS * 4, null, 4)) continue;
        this.pushHeader(o, st);
        q.n += words;
      }
    }
    // lines (unverified by the recorded windows): clipped, then two triangles of the line width each
    if (lineIdx.length) {
      const size = bits(regs.bp[0x22], 0, 8);
      for (let i = 0; i + 1 < lineIdx.length; i += 2) {
        pool.n = mark;
        const cl = clipLine(pool, base + lineIdx[i] * V_STRIDE, base + lineIdx[i + 1] * V_STRIDE);
        if (!cl) continue;
        const pieces: { scr: Float64Array; v: [number, number, number] }[] = [];
        lineTriangles(pool, x, cl[0], cl[1], size, pieces);
        for (const pc of pieces) {
          q.ensure(words);
          const o = q.n;
          if (!setupTriInto(pool, x, sc, pc.v[0], pc.v[1], pc.v[2], q.floats, o + HEADER_TEXELS * 4, pc.scr, 4)) continue;
          this.pushHeader(o, st);
          q.n += words;
        }
      }
    }
    if (this.measure) this.stats.cpuMs += performance.now() - t0;
  }

  /** the header words of the triangle set up last (TS), at word o of the queue, and its place in the bins */
  private pushHeader(o: number, st: number): void {
    const q = this.q;
    const I = q.ints, U = q.words;
    I[o] = TS.minx; I[o + 1] = TS.maxx; I[o + 2] = TS.miny; I[o + 3] = TS.maxy;
    I[o + 4] = TS.DX12; I[o + 5] = TS.DY12; I[o + 6] = TS.DX23; I[o + 7] = TS.DY23;
    I[o + 8] = TS.DX31; I[o + 9] = TS.DY31; I[o + 10] = TS.C1; I[o + 11] = TS.C2;
    I[o + 12] = TS.C3; I[o + 13] = TS.xi; I[o + 14] = TS.yi; U[o + 15] = bitsOf(TS.ox);
    U[o + 16] = bitsOf(TS.oy); U[o + 17] = st; U[o + 18] = TS.np; U[o + 19] = 0;
    this.triOffsets.push(o);
    this.bb.push(Math.max(0, TS.minx), Math.max(0, TS.miny), Math.min(EFB_W - 1, TS.maxx), Math.min(EFB_H - 1, TS.maxy));
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
    const tu = this.measure ? performance.now() : 0;
    if (this.attached) this.uploadDirty(this.attached);
    if (this.measure) this.stats.uploadMs += performance.now() - tu;
    if (nt === 0) { this.used.clear(); return; }
    const t0 = this.measure ? performance.now() : 0;
    const gl = this.gl;
    // bins: every triangle goes into the tiles its blocks can reach and where its three edge tests can pass for some pixel. The edge test
    // of a pixel is C + DX * 16y - DY * 16x > 0 (32-bit); its largest value over a tile is at one corner, so a tile where that corner
    // fails an edge holds no covered pixel. Triangles with edge numbers too big for plain arithmetic to match the wrapping 32-bit
    // arithmetic of the shader are binned by their bounds only.
    const nTiles = TILES_X * TILES_Y;
    const counts = new Uint32Array(nTiles + 1);
    const bb = this.bb;
    const I = this.q.ints;
    let ent = this.entTile;
    let entTri = this.entTri;
    let ne = 0;
    for (let i = 0; i < nt; i++) {
      const o = this.triOffsets[i];
      const tx0 = bb[i * 4] >> 4, ty0 = bb[i * 4 + 1] >> 4, tx1 = bb[i * 4 + 2] >> 4, ty1 = bb[i * 4 + 3] >> 4;
      const dx12 = I[o + 4], dy12 = I[o + 5], dx23 = I[o + 6], dy23 = I[o + 7], dx31 = I[o + 8], dy31 = I[o + 9], c1 = I[o + 10], c2 = I[o + 11], c3 = I[o + 12];
      const safe = Math.abs(dx12) < 16384 && Math.abs(dy12) < 16384 && Math.abs(dx23) < 16384 && Math.abs(dy23) < 16384 && Math.abs(dx31) < 16384 &&
        Math.abs(dy31) < 16384 && Math.abs(c1) < 1073741824 && Math.abs(c2) < 1073741824 && Math.abs(c3) < 1073741824;
      if (ne + (tx1 - tx0 + 1) * (ty1 - ty0 + 1) > ent.length) {
        const n2 = Math.max(ent.length * 2, ne + (tx1 - tx0 + 1) * (ty1 - ty0 + 1));
        const e2 = new Int32Array(n2), t2 = new Int32Array(n2);
        e2.set(ent.subarray(0, ne)); t2.set(entTri.subarray(0, ne));
        ent = this.entTile = e2; entTri = this.entTri = t2;
      }
      for (let ty = ty0; ty <= ty1; ty++) {
        const y0 = ty << 4, y1 = y0 + 15;
        for (let tx = tx0; tx <= tx1; tx++) {
          if (safe) {
            const x0 = tx << 4, x1 = x0 + 15;
            if (c1 + 16 * (dx12 > 0 ? dx12 * y1 : dx12 * y0) - 16 * (dy12 > 0 ? dy12 * x0 : dy12 * x1) <= 0) continue;
            if (c2 + 16 * (dx23 > 0 ? dx23 * y1 : dx23 * y0) - 16 * (dy23 > 0 ? dy23 * x0 : dy23 * x1) <= 0) continue;
            if (c3 + 16 * (dx31 > 0 ? dx31 * y1 : dx31 * y0) - 16 * (dy31 > 0 ? dy31 * x0 : dy31 * x1) <= 0) continue;
          }
          const t = ty * TILES_X + tx;
          counts[t]++;
          ent[ne] = t; entTri[ne] = o >> 2; ne++;
        }
      }
    }
    const start = new Uint32Array(nTiles + 1);
    let total = 0;
    for (let t = 0; t < nTiles; t++) { start[t] = total; total += counts[t]; }
    this.stats.listEntries += total;
    const list = new Uint32Array(Math.max(1, Math.ceil(total / 4096)) * 4096);
    const fill = new Uint32Array(nTiles);
    for (let e = 0; e < ne; e++) { const t = ent[e]; list[start[t] + fill[t]++] = entTri[e]; }
    const tiles = new Uint32Array(1024 * 2 * 2);
    for (let t = 0; t < TILES_X * TILES_Y; t++) { tiles[t * 2] = start[t]; tiles[t * 2 + 1] = counts[t]; }
    // uploads
    const set = this.sets[this.setNo++ % this.sets.length];
    set.data = this.grow(set.data, this.q.n, 4096);
    const dataRows = Math.ceil(this.q.n / 4096);
    uploadRows(gl, set.data, 0, 0, 1024, dataRows, this.q.words.subarray(0, dataRows * 4096));
    set.list = this.grow(set.list, list.length, 4096);
    uploadRows(gl, set.list, 0, 0, 4096, list.length / 4096, list);
    uploadRows(gl, set.tiles, 0, 0, 1024, 2, tiles);
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
    const p = this.pixelProgram(this.needFeatures);
    this.lastFeatures = this.needFeatures;
    gl.useProgram(p);
    this.bindTex(p, 0, "uMem", this.mem);
    this.bindTex(p, 1, "uData", set.data);
    this.bindTex(p, 2, "uTiles", set.tiles);
    this.bindTex(p, 3, "uList", set.list);
    this.bindTex(p, 4, "uStates", this.statesTex);
    this.bindTex(p, 5, "uEfb", src.tex);
    gl.uniform1i(this.u(p, "uTilesX"), TILES_X);
    gl.uniform4i(this.u(p, "uK"), 4, 25, 3, 2);
    const tq = this.timeBegin();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.timeEnd(tq, "pixel");
    this.cur = 1 - this.cur;
    this.passes++;
    this.q.n = 0; this.bb = []; this.triOffsets = []; this.used.clear(); this.needFeatures = 0;
    if (this.measure) this.stats.flushMs += performance.now() - t0;
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

  /** draw the frame buffer (its top 640 x 480) into the canvas's own framebuffer, `width` x `height` pixels, nearest filtering. Queued
   *  triangles are drawn first. */
  present(width: number, height: number, pixFmt = 0): void {
    this.flush();
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.SCISSOR_TEST);
    const pr = this.program("present");
    gl.useProgram(pr);
    this.bindTex(pr, 0, "uEfb", this.efb[this.cur].tex);
    gl.uniform1i(this.u(pr, "uPixFmt"), pixFmt);
    gl.uniform2f(this.u(pr, "uSize"), width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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
