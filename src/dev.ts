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
$("play").onclick = () => send({ type: "toggle" });

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== player.contentWindow || !e.data) return;
  const m = e.data;
  if (m.type === "renderer") $("status").textContent = m.reason ? `${m.renderer}: ${m.reason}` : m.renderer;
  else if (m.type === "loaded") $("status").textContent = `${m.frames} frames`;
  else if (m.type === "track") $("status").textContent = `viewer track: ${m.state}`;
});
