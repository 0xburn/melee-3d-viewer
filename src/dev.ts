/* the dev page (dev.html): a local .slp, its viewer track and a game files
 * folder, handed to the embed page by postMessage. Nothing leaves the browser. */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const player = $<HTMLIFrameElement>("player");
const send = (m: object) => player.contentWindow?.postMessage(m, "*");
let slpUrl: string | null = null, trackUrl: string | null = null, slpName = "replay.slp";

function load() {
  if (!slpUrl) return;
  send({ type: "load", url: slpUrl, name: slpName, trackUrl });
}
$("slp").onchange = (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  if (slpUrl) URL.revokeObjectURL(slpUrl);
  slpUrl = URL.createObjectURL(f);
  slpName = f.name;
  load();
};
$("track").onchange = (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (trackUrl) URL.revokeObjectURL(trackUrl);
  trackUrl = f ? URL.createObjectURL(f) : null;
  load();
};
$("game").onchange = (e) => {
  const files = [...((e.target as HTMLInputElement).files ?? [])];
  if (files.length) send({ type: "gameFiles", files });
};
$("view").onchange = (e) => send({ type: "view", view: (e.target as HTMLSelectElement).value });
$("hudslots").onchange = (e) => send({ type: "hudslots", slots: (e.target as HTMLSelectElement).value });
$("play").onclick = () => send({ type: "toggle" });

// Full Window (the player over the page) and Full Screen (the display): the
// buttons, or the player's own keys (its {type: "fullKey"}: F, W, Esc). The
// same one again, or Esc, leaves.
const box = $("box");
let full: "window" | "screen" | null = null;
function setFull(how: "window" | "screen" | null) {
  if (full === "screen" && how !== "screen" && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  full = how;
  box.classList.toggle("full", how !== null);
  if (how === "screen") {
    box.requestFullscreen({ navigationUI: "hide" }).catch(() => {
      // (not allowed here: back as it was)
      if (full === "screen") setFull(null);
    });
  }
  player.focus();
}
const toggleFull = (how: "window" | "screen") => setFull(full === how ? null : how);
$("fullwindow").onclick = () => toggleFull("window");
$("fullscreen").onclick = () => toggleFull("screen");
// (the browser's own Esc lets go of the screen)
document.addEventListener("fullscreenchange", () => { if (full === "screen" && !document.fullscreenElement) setFull(null); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && full) setFull(null); });

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== player.contentWindow || !e.data) return;
  const m = e.data;
  if (m.type === "renderer") $("status").textContent = m.reason ? `${m.renderer}: ${m.reason}` : m.renderer;
  else if (m.type === "loaded") $("status").textContent = `${m.frames} frames`;
  else if (m.type === "track") $("status").textContent = `viewer track: ${m.state}`;
  else if (m.type === "fullKey") {
    if (m.how === "leave") { if (full) setFull(null); }
    else if (m.how === "window" || m.how === "screen") toggleFull(m.how);
  }
});
