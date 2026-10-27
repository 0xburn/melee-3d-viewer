/* The replay player that draws with the game's own draw path (gx.html): melee-sim-light's graphics build plays the replay and runs the
 * game's display pass, and the GX renderer (render3d/gxr) draws what it sends. The page's default player stays the default; this
 * one is chosen by opening gx.html (embed.html?renderer=gx goes there).
 *
 * URL parameters: replayUrl, name, frame (game frame, -123 = first), files (the game files folder URL; the names it reads come from
 * sim-files.json beside the module, else the extraction's list), core (the module, default gx/gx-core.js), backend (gl, cpu),
 * speed, playback (slippi, original), pace (60, console), paused=1.
 * Messages in: {type: "load", url, name?, frame?}, {type: "seek", frame}, play, pause, toggle, {type: "gameFiles", files},
 * {type: "speed", speed}, {type: "playback", playback}, {type: "pace", pace}. Out: {type: "loaded", frames, playback, pace},
 * {type: "frame", frame, running}, {type: "renderer", renderer, reason}.
 */
import { decode } from "@shelacek/ubjson";
import { CpuBackend } from "./render3d/gxr/cpu";
import { gxNames, namesToRead, readGameFiles } from "./sim/gamefiles";
import type { GameFilesFrom } from "./sim/protocol";
import { readTape } from "./sim/tape";
import { isPlaybackMode, PLAYBACK_MODES, type GxCoreFactory, type PlaybackMode } from "./render3d/gxpath/core";
import { GxPlayback, isPace, PACES, SPEEDS, type Pace } from "./render3d/gxpath/playback";
import { ControllerOverlay, isOverlayShow, type OverlayShow } from "./render3d/gxpath/overlay";
import { GxScreen } from "./render3d/gxpath/screen";
import { CRT_PRESETS, CURVE_MAX, isCrtPreset, type CrtPreset } from "./render3d/crt";
import { GxSession, type GameFiles, type SessionBackend } from "./render3d/gxpath/session";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const q = new URLSearchParams(location.search);
const FIRST_FRAME = -123;
const post = (m: object) => { if (window.parent !== window) window.parent.postMessage(m, "*"); };
const logLine = (s: string) => { try { void fetch("/log", { method: "POST", body: s }); } catch { /* no test server */ } };
let lastLogged = "";
const info = (s: string) => { $("info").textContent = s; const first = s.split(String.fromCharCode(10))[0]; if (first.startsWith("step ")) return; if (first !== lastLogged) { lastLogged = first; console.log("gx: " + first); } };

let playback: GxPlayback | null = null;
let glBackend: { present(): void; reset(): void } | null = null;
/** where the first load's time went, ms (the checks read it: window.__gx.loadTimes) */
const loadTimes: Record<string, number> = {};
let session: GxSession | null = null;
let filesFrom: GameFilesFrom | null = q.get("files") ? { kind: "url", base: new URL(q.get("files")!, location.href).href } : null;
const coreUrl = new URL(q.get("core") ?? "gx/gx-core.js", location.href).href;
let gameFiles: GameFiles | null = null;
const screen = new GxScreen($("view"));
const pads = new ControllerOverlay($("view"), () => session?.tape ?? null);
let padShow: OverlayShow = isOverlayShow(q.get("controllers")) ? (q.get("controllers") as OverlayShow) : "off";
let crtPreset: CrtPreset = isCrtPreset(q.get("crt")) ? (q.get("crt") as CrtPreset) : "off";
screen.setCrt(crtPreset);
let retryText: string | null = null;
let playbackMode: PlaybackMode = isPlaybackMode(q.get("playback")) ? (q.get("playback") as PlaybackMode) : "slippi";
let pace: Pace = isPace(q.get("pace")) ? (q.get("pace") as Pace) : "60";
let currentUrl: string | null = null;

/** Playback is fixed from the replay's first frame: a change plays the replay again from the start, back to the frame shown */
function setPlaybackMode(m: PlaybackMode) {
  if (m === playbackMode) return;
  playbackMode = m;
  showButtons();
  if (!currentUrl || !session) return;
  const frame = session.tape.gameFrame(Math.max(0, session.shown)), wasPlaying = playback?.playing ?? false;
  void loadReplay(currentUrl, frame, wasPlaying).catch(fail);
}
function setPace(p: Pace) { pace = p; playback?.setPace(p); showButtons(); }

async function makeBackend(env: ConstructorParameters<typeof CpuBackend>[0]): Promise<SessionBackend> {
  // (one WebGL renderer for the page: a replay loaded again, or played again for another playback setting, reuses its context and shaders)
  if (glBackend) { glBackend.reset(); return glBackend as unknown as SessionBackend; }
  if (q.get("backend") !== "cpu") {
    try {
      const { GxGl } = await import("./render3d/gxr/gl");
      const gl = screen.glFlat.getContext("webgl2", { preserveDrawingBuffer: true });
      if (gl) {
        const b = new GxGl(gl, {}, { workers: Math.max(0, Number(q.get("workers") ?? Math.min(3, Math.max(0, (navigator.hardwareConcurrency || 4) - 2)))) });
        info("preparing the renderer (the first time in this browser this can take a minute)...");
        const t = performance.now();
        await b.prepare();
        loadTimes.shaders = performance.now() - t;
        // (the optional shader variants compile in the background: a draw that needs one waits for it)
        void b.warm();
        glBackend = b;
        screen.setGlMode(true);
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

async function loadReplay(url: string, frame: number, play = q.get("paused") !== "1" && frame === FIRST_FRAME) {
  playback?.pause();
  session?.close();
  const t0 = performance.now(), mark = (k: string) => { loadTimes[k] = performance.now() - t0; };
  info("reading the replay...");
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const parsed = decode(bytes, { useTypedArrays: true }) as { raw: Uint8Array; metadata?: { playedOn?: string } };
  // (a replay from before Slippi 3.17 records the C-stick only after the game processed it: Slippi's playback plays a +-0.9875 as the
  // raw 79 it reads back to; the console's own game may have had 80 there, which only the snap of UCF 1.0's cardinals tells apart)
  const tape = readTape(parsed.raw, parsed.metadata, { cstickSnap: playbackMode === "original", stadiumTransformations: true });
  mark("replay");
  if (!filesFrom) throw new Error("no game files: give ?files=<folder url> or hand over the folder's files");
  if (!gameFiles) {
    info("reading the game files...");
    // (a picked folder: the names the draw path reads, from what is in it; a folder by URL: the module's own list beside it)
    const names = filesFrom.kind === "files" ? gxNames(filesFrom.list.map((f) => f.name)) : await namesToRead(filesFrom, new URL("sim-files.json", coreUrl).href);
    gameFiles = { names, files: await readGameFiles(filesFrom, names) };
  }
  mark("gameFiles");
  info("starting the simulator...");
  const factory = (await import(/* @vite-ignore */ coreUrl)).default as GxCoreFactory;
  session = new GxSession({
    factory, coreOptions: { locateFile: (p: string) => new URL(p, coreUrl).href }, files: gameFiles, tape,
    makeBackend, playback: playbackMode,
  });
  session.setPictures(true);
  await session.warmup();
  mark("warmedUp");
  session.setPictures(screen.needsPixels);
  playback = new GxPlayback(session, {
    onPicture: (rgba) => screen.show(rgba),
    onShown: () => { if (glBackend && !screen.needsPixels) glBackend.present(); },
    onState: update,
    onError: fail,
    onRetry: (text) => { retryText = text; update(); },
  });
  playback.setSpeed(Number(q.get("speed") ?? 1) || 1);
  playback.setPace(pace);
  currentUrl = url;
  post({ type: "loaded", frames: tape.count, playback: playbackMode, pace });
  (window as unknown as { __gx: object }).__gx = { session, playback };
  await playback.seek(Math.max(0, frame - FIRST_FRAME));
  mark("firstFrame");
  (window as unknown as { __gx: { loadTimes?: object } }).__gx.loadTimes = { ...loadTimes };
  logLine("load " + JSON.stringify(loadTimes));
  if (q.get("bench")) void bench(session);
  if (q.get("harness")) {
    const names = q.get("harness")!.split(",");
    const { runHarness } = await import("./render3d/gxpath/harness");
    const msg = await runHarness(session, names, (w) => replayUrl !== null && w.startsWith(replayUrl.split("/").pop()!.replace(/\.slp$/, "") + "-"));
    await fetch("/done", { method: "POST", body: "ok " + msg });
    return;
  }
  if (play) playback.play();
  pads.set(padShow, you);
  update();
}

let you: number | null = null;
function update() {
  const p = playback, s = session;
  if (!p || !s) return;
  $("play").textContent = p.playing ? "Pause" : p.ended ? "Replay" : "Play";
  $("play").setAttribute("aria-pressed", String(p.playing));
  const row = Math.max(0, s.shown);
  $("seekfill").style.width = `${(100 * row) / Math.max(1, s.frameCount - 1)}%`;
  const gf = s.tape.gameFrame(row);
  pads.update(row);
  $("where").textContent = `frame ${gf} (${row + 1} / ${s.frameCount})`;
  document.querySelectorAll<HTMLButtonElement>("#speeds button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.speed) === p.speed)));
  const T = s.totals, n = Math.max(1, T.frames);
  info(
    `step ${s.times.step.toFixed(2)} ms  hand-off ${s.times.handoff.toFixed(2)} ms  render ${s.times.render.toFixed(2)} ms` +
    `  (means ${(T.step / n).toFixed(2)} / ${(T.handoff / n).toFixed(2)} / ${(T.render / n).toFixed(2)})` +
    `\nstream ${(T.streamBytes / n / 1024).toFixed(0)} KiB a frame, memory sent ${(T.regionBytes / 1048576).toFixed(1)} MiB, simulator heap ${(s.memoryBytes / 1048576).toFixed(0)} MiB` +
    (retryText ? `\n${retryText}` : s.diverged ? `\nthe game parts from the replay at frame ${s.diverged.frame} (${s.diverged.lane})` : "") +
    (s.drivesTried.length > 1 ? `\nsettings tried: ${s.drivesTried.map((d) => `${d.index + 1} held to row ${d.row}`).join(", ")}; playing ${s.driveIndex + 1}` : ""),
  );
  post({ type: "frame", frame: gf, running: p.playing });
}

function fail(e: unknown) {
  const text = String((e as Error)?.stack ?? e);
  info("error: " + text);
  logLine("error: " + text);
}

const label = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);
const showButtons = () => {
  $("crt").textContent = `TV: ${label(crtPreset)}`;
  $("pads").textContent = `Controllers: ${label(padShow)}`;
  $("playback").textContent = `Playback: ${label(playbackMode)}`;
  $("pace").textContent = `Speed: ${pace === "console" ? "Console (59.94)" : "60"}`;
};
showButtons();
$("crt").onclick = () => { crtPreset = CRT_PRESETS[(CRT_PRESETS.indexOf(crtPreset) + 1) % CRT_PRESETS.length]; screen.setCrt(crtPreset, crtPreset === "off" ? 0 : undefined); session?.setPictures(screen.needsPixels); showButtons(); };
const PAD_CHOICES: OverlayShow[] = ["off", "both", "left", "right"];
$("pads").onclick = () => { padShow = PAD_CHOICES[(PAD_CHOICES.indexOf(padShow) + 1) % PAD_CHOICES.length]; pads.set(padShow, you); if (session) pads.update(Math.max(0, session.shown)); showButtons(); };
$("playback").onclick = () => setPlaybackMode(PLAYBACK_MODES[(PLAYBACK_MODES.indexOf(playbackMode) + 1) % PLAYBACK_MODES.length]);
$("pace").onclick = () => setPace(PACES[(PACES.indexOf(pace) + 1) % PACES.length]);
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
    case "crt":
      if (isCrtPreset(m.crt)) { crtPreset = m.crt; const c = Number(m.curve); screen.setCrt(crtPreset, Number.isFinite(c) ? Math.min(CURVE_MAX, Math.max(0, c)) : undefined); session?.setPictures(screen.needsPixels); showButtons(); }
      break;
    case "controllers":
      if (isOverlayShow(m.show)) { padShow = m.show; const n = Number(m.you); you = Number.isInteger(n) && n >= 1 && n <= 4 ? n - 1 : null; pads.set(padShow, you); if (session) pads.update(Math.max(0, session.shown)); showButtons(); }
      break;
    case "hudslots":
      // (the HUD is the game's own, in the slots the game puts it: only the game's layout exists here)
      post({ type: "hudslots", slots: "game", note: "the HUD is drawn by the game, in its own slots" });
      break;
    case "speed": if (typeof m.speed === "number") playback?.setSpeed(m.speed); break;
    case "playback": if (isPlaybackMode(m.playback)) setPlaybackMode(m.playback); break;
    case "pace": if (isPace(m.pace)) setPace(m.pace); break;
  }
});
const replayUrl = q.get("replayUrl");
if (replayUrl) void loadReplay(replayUrl, Number(q.get("frame") ?? FIRST_FRAME)).catch(fail);
else info("waiting for a replay: replayUrl=<url> or a {type: \"load\"} message");

/** ?bench=1 (a measuring run, for the checks): every row of the replay stepped and drawn as fast as the page can, the per-row times posted to /bench;
 *  with hash=1 also each row's stream hash as the native recorder prints it (streamhash.ts) */
async function bench(s: GxSession) {
  const total: number[] = [], render: number[] = [], step: number[] = [], hashes: string[] = [];
  const frameHash = q.get("hash") ? (await import("./render3d/gxpath/streamhash")).frameHash : null;
  s.setPictures(false);
  await s.start();
  const t0 = performance.now();
  while (s.index < s.frameCount) {
    const t = performance.now();
    while (performance.now() - t < 1 && s.index < s.frameCount) {
      const a = performance.now();
      s.step(true);
      if (glBackend) glBackend.present();
      total.push(performance.now() - a);
      if (frameHash) hashes.push(frameHash(s.core_!));
      step.push(s.times.step);
      render.push(s.times.render);
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
  const body = JSON.stringify({ rows: total.length, seconds: (performance.now() - t0) / 1000, isolated: (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true, total, step, render, wasmHeap: s.memoryBytes, jsHeap: heap, diverged: s.diverged, playback: s.playback, hashes, loadTimes, pool: (s as unknown as { backend?: { poolStats?: unknown } }).backend?.poolStats ?? null });
  await fetch("/bench", { method: "POST", body });
}
