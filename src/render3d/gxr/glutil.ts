/// <reference lib="dom" />
/* GX renderer: small WebGL 2 helpers (programs, integer textures, a full-screen pass). */

/** a program being compiled: with KHR_parallel_shader_compile the browser compiles on another thread and `ready()` says when it is done */
export interface Compiling { program: WebGLProgram; vs: WebGLShader; fs: WebGLShader; fsSource: string }

/** start compiling and linking; nothing here waits for the compiler (reading a compile or link status would) */
export function startCompile(gl: WebGL2RenderingContext, vs: string, fs: string): Compiling {
  const mk = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const v = mk(gl.VERTEX_SHADER, vs), f = mk(gl.FRAGMENT_SHADER, fs);
  const p = gl.createProgram()!;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  return { program: p, vs: v, fs: f, fsSource: fs };
}

/** whether the browser has finished compiling (always true without the extension: reading the status then waits) */
export function compileDone(gl: WebGL2RenderingContext, c: Compiling): boolean {
  const ext = gl.getExtension("KHR_parallel_shader_compile");
  return ext ? gl.getProgramParameter(c.program, ext.COMPLETION_STATUS_KHR) === true : true;
}

/** the program, after checking the compile and link status (this waits for the compiler if it is still running) */
export function finishCompile(gl: WebGL2RenderingContext, c: Compiling): WebGLProgram {
  for (const [s, src] of [[c.vs, ""], [c.fs, c.fsSource]] as [WebGLShader, string][]) {
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s) ?? "";
      const lines = src.split("\n");
      const m = /ERROR: \d+:(\d+)/.exec(log);
      const at = m ? Number(m[1]) : 0;
      throw new Error(`shader compile failed: ${log}\n${lines.slice(Math.max(0, at - 4), at + 3).join("\n")}`);
    }
  }
  if (!gl.getProgramParameter(c.program, gl.LINK_STATUS)) throw new Error("program link failed: " + gl.getProgramInfoLog(c.program));
  return c.program;
}

/** compile and link, waiting for the result */
export function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  return finishCompile(gl, startCompile(gl, vs, fs));
}

/** a triangle that covers the viewport */
export const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export interface IntTex { tex: WebGLTexture; w: number; h: number; fmt: "R8UI" | "R32UI" | "RG32UI" | "RGBA32UI" }

const FMT = (gl: WebGL2RenderingContext) => ({
  R8UI: { internal: gl.R8UI, format: gl.RED_INTEGER, type: gl.UNSIGNED_BYTE },
  R32UI: { internal: gl.R32UI, format: gl.RED_INTEGER, type: gl.UNSIGNED_INT },
  RG32UI: { internal: gl.RG32UI, format: gl.RG_INTEGER, type: gl.UNSIGNED_INT },
  RGBA32UI: { internal: gl.RGBA32UI, format: gl.RGBA_INTEGER, type: gl.UNSIGNED_INT },
});

export function intTexture(gl: WebGL2RenderingContext, fmt: IntTex["fmt"], w: number, h: number): IntTex {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, FMT(gl)[fmt].internal, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { tex, w, h, fmt };
}

/** upload `data` into rows [y, y + rows) of full width (data holds rows * w * components elements) */
export function uploadRows(gl: WebGL2RenderingContext, t: IntTex, x: number, y: number, w: number, rows: number, data: ArrayBufferView): void {
  const f = FMT(gl)[t.fmt];
  gl.bindTexture(gl.TEXTURE_2D, t.tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, rows, f.format, f.type, data);
}
