/* the Controller overlay - the players' controllers drawn over the
 * picture (the View menu's Controller overlay section; embed.tsx).
 *
 * The controller is M'Overlay's default GameCube skin (Bkacjios, MIT;
 * src/assets/controllers/m-overlay/, its SOURCE.txt and license),
 * used as it ships and drawn the way its
 * skins/default.lua does: each button's outline, its pressed picture while
 * held, in the skin's own colors; the sticks moved over their gates, the gate
 * cut away under the stick; L and R filled by how far they are pressed, the
 * click at the end. Never our own drawing, never tinted by the port. Ours is
 * only around it: each player's name above, in their port's color; a dark
 * see-through backing with a thin outline in that color, so it reads over a
 * bright stage or the CRT's glow; the frames before as a fading trail of the
 * sticks' centers; and a ghost shown over the game (simulated runs) as rings
 * in its color on the sticks, buttons and triggers it holds.
 *
 * Which players: the setting's choice, resolved for this game (overlayPorts):
 * both, the left player (the lower port), the right one, only you (the
 * port the page says is you: none in a game you are not in), or none. One a
 * player, beside their HUD's slot (two players: the outer slots,
 * hudslots.ts) and never over it. It is the page's own layer, above
 * everything in the picture - the 3D player's canvas with its CRT pass and
 * curve, the HUD, the line art - so it is always flat and crisp, at the
 * screen's own pixels. It follows playback frame for frame, the replay's own
 * inputs (viewer/controllerInputs.ts).
 */
import { createEffect, createMemo, For, onCleanup, onMount, Show } from "solid-js";
import { characterNameByExternalId } from "~/common/ids";
import { hudSlot, outerSlots } from "~/common/hudslots";
import { hudSlotsNow } from "~/state/hudSlotsStore";
import { replayStore } from "~/state/replayStore";
import { OverlayShow, overlayPorts, Pad, padAt, trailAt } from "~/viewer/controllerInputs";
import { MO_VIEW, moPaint, TRAIL, type Shown } from "./moverlay";

// the frames behind the stick
// the port colors (the CSS variables --p1..--p4), read from the page that
// holds the player when it can be (same origin), else these
const PORT_COLORS = ["#e54c4c", "#4b4ce5", "#d9c33b", "#38b44a"];
function portColors(): string[] {
  try {
    const css = getComputedStyle(window.parent.document.documentElement);
    return PORT_COLORS.map((c, i) => css.getPropertyValue(`--p${i + 1}`).trim() || c);
  } catch {
    return PORT_COLORS;
  }
}

// a player's controller as the skin draws it: their inputs on the frame shown,
// the trail behind the sticks, and every ghost's inputs (the Inputs panel,
// panels/Inputs.tsx, draws the same skin with no trail and no ghosts)
// what the checks read off a player's controller: the inputs it shows
function heldNames(p: Pad | null): string {
  if (!p) return "";
  const out: string[] = [];
  for (const [k, n] of [["a", "A"], ["b", "B"], ["xb", "X"], ["yb", "Y"], ["z", "Z"], ["start", "start"]] as const) if (p[k]) out.push(n);
  return out.sort().join(",");
}
const xy = (x: number, y: number) => `${x.toFixed(4)},${y.toFixed(4)}`;

export function Controllers(props: { show: OverlayShow; you: number | null }) {
  const colors = portColors();
  const all = createMemo(() =>
    (replayStore.replayData?.settings.playerSettings ?? []).filter(Boolean)
  );
  // the players the choice shows in this game
  const players = createMemo(() => {
    const on = new Set(overlayPorts(all(), props.show, props.you));
    return all().filter((p) => on.has(p.playerIndex));
  });
  const outer = createMemo(() => {
    const d = replayStore.replayData;
    return d ? outerSlots(d.settings, hudSlotsNow()) : false;
  });
  // each shown player's inputs on the frame shown, and every ghost's
  const shown = createMemo((): Shown[] => {
    const d = replayStore.replayData;
    if (!d) return [];
    const f = replayStore.frame, from = replayStore.range?.[0] ?? 0;
    return players().map((ps) => ({
      player: ps.playerIndex,
      pad: padAt(d, f, ps.playerIndex),
      trail: trailAt(d, f, ps.playerIndex, TRAIL, from),
      ghosts: replayStore.ghosts.flatMap((g) => {
        // (none before a ghost's moment when it was cut to it: parser.ts's held)
        if (f < (g.replayData.held ?? 0)) return [];
        const pad = padAt(g.replayData, f, ps.playerIndex);
        return pad ? [{ pad, color: g.color }] : [];
      }),
    }));
  });
  const name = (i: number) => {
    const ps = all().find((p) => p.playerIndex === i);
    if (!ps) return "";
    return [ps.displayName, ps.connectCode, ps.nametag].find((n) => n !== undefined && n.length > 0) ??
      characterNameByExternalId[ps.externalCharacterId] ?? "";
  };
  // two players: beside the outer slots, inward; more: over each one's slot
  const place = (i: number): Record<string, string> => {
    const slot = hudSlot(replayStore.replayData!.settings, i, hudSlotsNow());
    if (outer()) return slot === 0 ? { left: "30%", bottom: "2%", width: "19.5%" }
                                   : { right: "30%", bottom: "2%", width: "19.5%" };
    return { left: `${11.5 + 20 * slot}%`, bottom: "24%", width: "17%" };
  };

  return (
    <div class="ctl-layer pointer-events-none absolute inset-0 z-[5]" data-controllers={props.show} aria-hidden="true">
      {/* the name sized by the controller's width; the backing dark enough to
          read over a bright stage and the CRT's glow */}
      <style>{`.ctl-pad { container-type: inline-size; }
        .ctl-name { font: 700 clamp(8px, 6.5cqw, 14px) / 1.25 system-ui, sans-serif; margin-bottom: 1.5cqw;
                    text-shadow: 0 0 2px #000, 0 0 3px #000, 0 0 4px #000; }
        .ctl-art { border-radius: 6cqw; background: rgba(6, 8, 14, 0.78); backdrop-filter: blur(3px);
                   box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45); }`}</style>
      <For each={players()}>
        {(ps) => {
          const s = () => shown().find((x) => x.player === ps.playerIndex);
          const color = colors[ps.playerIndex] ?? "#f2f2f2";
          return (
            <div class="ctl-pad absolute flex flex-col items-center" style={place(ps.playerIndex)}
                 data-controller={ps.playerIndex + 1} data-main={s()?.pad ? xy(s()!.pad!.x, s()!.pad!.y) : ""}
                 data-c={s()?.pad ? xy(s()!.pad!.cx, s()!.pad!.cy) : ""} data-held={heldNames(s()?.pad ?? null)}
                 data-l={(s()?.pad?.l ?? 0).toFixed(4)} data-r={(s()?.pad?.r ?? 0).toFixed(4)}
                 data-ghosts={s()?.ghosts.length ?? 0}>
              <div class="ctl-name w-full truncate text-center" style={{ color }}>{name(ps.playerIndex)}</div>
              <div class="ctl-art relative w-full" style={{ outline: `1.5px solid ${color}` }}>
                <Show when={s()}>{(x) => <MOverlay shown={x()} />}</Show>
              </div>
            </div>
          );
        }}
      </For>
    </div>
  );
}

// --- M'Overlay ------------------------------------------------------------------

export function MOverlay(props: { shown: Shown }) {
  let canvas!: HTMLCanvasElement;
  let box!: HTMLDivElement;
  const draw = () => {
    // the canvas a whole number of the screen's pixels, and shown at exactly
    // that size: one canvas pixel to one screen pixel, nothing resampled
    const w = box.getBoundingClientRect().width;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round((pw * MO_VIEW.h) / MO_VIEW.w));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
      canvas.style.width = `${pw / dpr}px`;
      canvas.style.height = `${ph / dpr}px`;
    }
    const g = canvas.getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, pw, ph);
    const k = pw / MO_VIEW.w;
    g.setTransform(k, 0, 0, k, -MO_VIEW.x * k, -MO_VIEW.y * k);
    moPaint(g, props.shown);
  };
  onMount(() => {
    const ro = new ResizeObserver(draw);
    ro.observe(box);
    // (a page zoom or another screen changes the pixel ratio, not the size)
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener("change", draw);
    onCleanup(() => { ro.disconnect(); mq.removeEventListener("change", draw); });
    draw();
  });
  createEffect(() => { void props.shown; draw(); });
  return (
    <div ref={box} class="w-full overflow-hidden" style={{ "aspect-ratio": `${MO_VIEW.w} / ${MO_VIEW.h}` }} data-skin="moverlay">
      <canvas ref={canvas} class="block" />
    </div>
  );
}

