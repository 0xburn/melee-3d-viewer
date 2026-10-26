/* The replay player that draws with the game's own draw path (gx.html): melee-sim-light's graphics build plays the replay and runs the
 * game's display pass, and the GX renderer (render3d/gxr) draws what it sends. The page's default player stays the default; this
 * one is chosen by opening gx.html (embed.html?renderer=gx goes there).
 *
 * URL parameters: replayUrl, name, frame (game frame, -123 = first), files (the game files folder URL; the names it reads come from
 * sim-files.json beside the module, else the extraction's list), core (the module, default gx/gx-core.js), backend (gl, cpu),
 * speed, paused=1.
 * Messages in: {type: "load", url, name?, frame?}, {type: "seek", frame}, play, pause, toggle, {type: "gameFiles", files},
 * {type: "speed", speed}. Out: {type: "loaded", frames}, {type: "frame", frame, running}, {type: "renderer", renderer, reason}.
 */
import { decode } from "@shelacek/ubjson";
import { CpuBackend } from "./render3d/gxr/cpu";
import { gxNames, namesToRead, readGameFiles } from "./sim/gamefiles";
import type { GameFilesFrom } from "./sim/protocol";
import { readTape } from "./sim/tape";
import type { GxCoreFactory } from "./render3d/gxpath/core";
import { GxPlayback, SPEEDS } from "./render3d/gxpath/playback";
import { GxSession, type GameFiles, type SessionBackend } from "./render3d/gxpath/session";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const q = new URLSearchParams(location.search);
const canvas = $<HTMLCanvasElement>("screen");
const ctx = canvas.getContext("2d")!;
const FIRST_FRAME = -123;
const post = (m: object) => { if (window.parent !== window) window.parent.postMessage(m, "*"); };
const logLine = (s: string) => { try { void fetch("/log", { method: "POST", body: s }); } catch { /* no test server */ } };
const info = (s: string) => { $("info").textContent = s; console.log("gx: " + s.split(String.fromCharCode(10))[0]); };

let playback: GxPlayback | null = null;
let session: GxSession | null = null;
let filesFrom: GameFilesFrom | null = q.get("files") ? { kind: "url", base: new URL(q.get("files")!, location.href).href } : null;
const coreUrl = new URL(q.get("core") ?? "gx/gx-core.js", location.href).href;
let gameFiles: GameFiles | null = null;
let picture: ImageData | null = null;

async function makeBackend(env: ConstructorParameters<typeof CpuBackend>[0]): Promise<SessionBackend> {
  if (q.get("backend") !== "cpu") {
    try {
      const { GxGl } = await import("./render3d/gxr/gl");
      const gl = document.createElement("canvas").getContext("webgl2");
      if (gl) {
        const b = new GxGl(gl);
        await b.prepare();
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        console.log("gx: GL renderer " + (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown"));
        post({ type: "renderer", renderer: "gx-gl", reason: null });
        return b as unknown as SessionBackend;
      }
      post({ type: "renderer", renderer: "gx-cpu", reason: "WebGL 2 is not available" });
    } catch (e) {
      post({ type: "renderer", renderer: "gx-cpu", reason: String((e as Error)?.message ?? e) });
    }
  } else post({ type: "renderer", renderer: "gx-cpu", reason: null });
  return new CpuBackend(env as never) as unknown as SessionBackend;
}

function show(rgba: Uint8Array) {
  if (!picture) picture = new ImageData(640, 480);
  picture.data.set(rgba.subarray(0, 640 * 480 * 4));
  ctx.putImageData(picture, 0, 0);
}

async function loadReplay(url: string, frame: number) {
  playback?.pause();
  session?.close();
  info("reading the replay...");
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const parsed = decode(bytes, { useTypedArrays: true }) as { raw: Uint8Array; metadata?: { playedOn?: string } };
  const tape = readTape(parsed.raw, parsed.metadata, { cstickSnap: true });
  if (!filesFrom) throw new Error("no game files: give ?files=<folder url> or hand over the folder's files");
  if (!gameFiles) {
    info("reading the game files...");
    const names = await namesToRead(filesFrom, new URL("sim-files.json", coreUrl).href)
      .catch(() => (filesFrom!.kind === "files" ? gxNames(filesFrom!.list.map((f) => f.name)) : Promise.reject(new Error("no file list"))));
    gameFiles = { names, files: await readGameFiles(filesFrom, names) };
  }
  info("starting the simulator...");
  const factory = (await import(/* @vite-ignore */ coreUrl)).default as GxCoreFactory;
  session = new GxSession({
    factory, coreOptions: { locateFile: (p: string) => new URL(p, coreUrl).href }, files: gameFiles, tape,
    makeBackend,
  });
  await session.start();
  playback = new GxPlayback(session, {
    onPicture: (rgba) => show(rgba),
    onState: update,
    onError: fail,
  });
  playback.setSpeed(Number(q.get("speed") ?? 1) || 1);
  post({ type: "loaded", frames: tape.count });
  (window as unknown as { __gx: object }).__gx = { session, playback };
  await playback.seek(Math.max(0, frame - FIRST_FRAME));
  if (q.get("paused") !== "1" && frame === FIRST_FRAME) playback.play();
  update();
}

function update() {
  const p = playback, s = session;
  if (!p || !s) return;
  $("play").textContent = p.playing ? "Pause" : p.ended ? "Replay" : "Play";
  $("play").setAttribute("aria-pressed", String(p.playing));
  const row = Math.max(0, s.shown);
  $("seekfill").style.width = `${(100 * row) / Math.max(1, s.frameCount - 1)}%`;
  const gf = s.tape.gameFrame(row);
  $("where").textContent = `frame ${gf} (${row + 1} / ${s.frameCount})`;
  document.querySelectorAll<HTMLButtonElement>("#speeds button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.speed) === p.speed)));
  const T = s.totals, n = Math.max(1, T.frames);
  info(
    `step ${s.times.step.toFixed(2)} ms  hand-off ${s.times.handoff.toFixed(2)} ms  render ${s.times.render.toFixed(2)} ms` +
    `  (means ${(T.step / n).toFixed(2)} / ${(T.handoff / n).toFixed(2)} / ${(T.render / n).toFixed(2)})` +
    `\nstream ${(T.streamBytes / n / 1024).toFixed(0)} KiB a frame, memory sent ${(T.regionBytes / 1048576).toFixed(1)} MiB, simulator heap ${(s.memoryBytes / 1048576).toFixed(0)} MiB` +
    (s.diverged ? `\nthe game parts from the replay at frame ${s.diverged.frame} (${s.diverged.lane})` : ""),
  );
  post({ type: "frame", frame: gf, running: p.playing });
}

function fail(e: unknown) {
  const text = String((e as Error)?.stack ?? e);
  info("error: " + text);
  logLine("error: " + text);
}

$("play").onclick = () => playback?.toggle();
$("fwd").onclick = () => playback?.stepForward();
$("back").onclick = () => { void playback?.stepBack(); };
$("seek").onclick = (e) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  if (session && playback) void playback.seek(Math.round(((e.clientX - r.left) / r.width) * (session.frameCount - 1)));
};
for (const s of SPEEDS) {
  const b = document.createElement("button");
  b.textContent = `${s}x`;
  b.dataset.speed = String(s);
  b.onclick = () => playback?.setSpeed(s);
  $("speeds").append(b);
}
document.addEventListener("keydown", (e) => {
  if (e.key === " ") { playback?.toggle(); e.preventDefault(); }
  else if (e.key === "ArrowRight") playback?.stepForward();
  else if (e.key === "ArrowLeft") void playback?.stepBack();
});
window.addEventListener("message", (e) => {
  const m = e.data as { type?: string; [k: string]: unknown };
  if (!m || typeof m.type !== "string") return;
  switch (m.type) {
    case "load": void loadReplay(String(m.url), typeof m.frame === "number" ? m.frame : FIRST_FRAME).catch(fail); break;
    case "gameFiles": filesFrom = { kind: "files", list: m.files as File[] }; gameFiles = null; break;
    case "seek": if (playback && typeof m.frame === "number") void playback.seek(m.frame - FIRST_FRAME); break;
    case "play": playback?.play(); break;
    case "pause": playback?.pause(); break;
    case "toggle": playback?.toggle(); break;
    case "speed": if (typeof m.speed === "number") playback?.setSpeed(m.speed); break;
  }
});
const replayUrl = q.get("replayUrl");
if (replayUrl) void loadReplay(replayUrl, Number(q.get("frame") ?? FIRST_FRAME)).catch(fail);
else info("waiting for a replay: replayUrl=<url> or a {type: \"load\"} message");
