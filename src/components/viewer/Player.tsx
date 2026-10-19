import { createMemo, For, Show } from "solid-js";
import { lcancelFlash, runNumber } from "~/common/effects";
import { RenderData, replayStore } from "~/state/replayStore";
import { getPlayerOnFrame, getStartOfAction } from "~/viewer/viewerUtil";

// a ghost's color lifted toward white. Its rim is the color
// itself on the player's own light stage; a dark page restyles the player
// (its own stylesheet) and takes the lifted one, --gl, instead
function lighter(hex: string, by = 0.45): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * by));
  return `rgb(${c.join(",")})`;
}

// a second cue beside a run's color, so two runs (or a run and
// the stage behind it) are never told apart by color alone: each run's rim
// has its own dash, a dark casing under it keeps it clear of a light stage,
// and its number floats over its head
const RUN_DASH = ["", "46 18", "18 14", "46 14 8 14"];

export function Players() {
  const flash = (rd: RenderData) =>
    lcancelFlash(replayStore.replayData!, replayStore.frame, rd.playerState.playerIndex, rd.playerState.isNana);
  return (
    <>
      {/* simulated runs first, so the real game reads on top, and
          nothing like the real fighters: a see-through body in the run's
          color, a thick light rim and a soft glow of its own color */}
      <defs>
        <filter id="mlGhostGlow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="16" result="glow" />
          <feMerge>
            <feMergeNode in="glow" />
            <feMergeNode in="glow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <For each={replayStore.ghostRenderDatas}>
        {(renderDatas, g) => {
          const run = () => runNumber(replayStore.ghosts[g()]?.label) ?? (replayStore.ghosts.length > 1 ? g() + 1 : null);
          return (
            <For each={renderDatas}>
              {(renderData) => (
                <>
                  <path
                    class="mlghostcase"
                    transform={renderData.transforms.join(" ")}
                    d={renderData.path}
                    fill="none"
                    stroke-width={13}
                    stroke-linejoin="round"
                    stroke="#0f172a"
                    stroke-opacity={0.55}
                  />
                  <path
                    class="mlghost"
                    style={`--gl: ${lighter(renderData.outerColor)}`}
                    transform={renderData.transforms.join(" ")}
                    d={renderData.path}
                    fill={lighter(renderData.innerColor, 0.2)}
                    fill-opacity={0.55}
                    stroke-width={9}
                    stroke-linejoin="round"
                    stroke={renderData.outerColor}
                    stroke-dasharray={RUN_DASH[((run() ?? 1) - 1) % RUN_DASH.length] || undefined}
                    filter="url(#mlGhostGlow)"
                  />
                  <Show when={run() !== null && !renderData.playerState.isNana}>
                    <RunLabel n={run()!} color={renderData.outerColor}
                              x={renderData.playerState.xPosition}
                              y={renderData.playerState.yPosition + renderData.characterData.shieldOffset[1] * 2 + 5} />
                  </Show>
                </>
              )}
            </For>
          );
        }}
      </For>
      <For each={replayStore.renderDatas}>
        {(renderData) => (
          <>
            <path
              transform={renderData.transforms.join(" ")}
              d={renderData.path}
              fill={flash(renderData) > 0 ? mixWhite(renderData.innerColor, 0.35 + 0.6 * flash(renderData)) : renderData.innerColor}
              stroke-width={2}
              stroke={renderData.outerColor}
            />
            <Shield renderData={renderData} />
            <Show when={portTags() && !renderData.playerState.isNana}>
              <PortTag port={renderData.playerSettings.playerIndex + 1} color={renderData.innerColor}
                       x={renderData.playerState.xPosition}
                       y={renderData.playerState.yPosition + renderData.characterData.shieldOffset[1] * 2 + 5} />
            </Show>
          </>
        )}
      </For>
    </>
  );
}

// with three or four players, or teams, the port colors include
// red and green, which many players cannot tell apart: each fighter wears its
// port over its head as well (two players, red and blue, need no tag)
function portTags(): boolean {
  const settings = replayStore.replayData?.settings;
  if (!settings) return false;
  return settings.isTeams || settings.playerSettings.filter(Boolean).length > 2;
}

function PortTag(props: { port: number; color: string; x: number; y: number }) {
  return (
    <g transform={`translate(${props.x} ${props.y}) scale(1 -1)`} data-port-tag={props.port}>
      <rect x={-4} y={-2.6} width={8} height={5.2} rx={1.3} fill={props.color} stroke="#0f172a" stroke-width={0.5} />
      <text y={1.3} text-anchor="middle" font-size="3.6" font-weight="700" fill="white"
            style="font-family: system-ui, sans-serif">P{props.port}</text>
    </g>
  );
}

// a run's number in a small tag of its color, dark-edged, upright
function RunLabel(props: { n: number; color: string; x: number; y: number }) {
  return (
    <g transform={`translate(${props.x} ${props.y}) scale(1 -1)`} data-run-label={props.n}>
      <circle r={3.6} fill={props.color} stroke="#0f172a" stroke-width={0.7} />
      <text y={1.55} text-anchor="middle" font-size="4.6" font-weight="700" fill="#0f172a"
            style="font-family: system-ui, sans-serif">{props.n}</text>
    </g>
  );
}

// a color lifted toward white by `by` (0..1), for the L-cancel flash
function mixWhite(color: string, by: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!m) return "white";
  const n = parseInt(m[1], 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * Math.min(1, by)));
  return `rgb(${c.join(",")})`;
}

function Shield(props: { renderData: RenderData }) {
  // [0,60]
  const shieldHealth = createMemo(
    () => props.renderData.playerState.shieldSize
  );
  // [0,1]. If 0 is received, set to 1 because user may have released shield
  // during a Guard-related animation. As an example, a shield must stay active
  // for 8 frames minimum before it is dropped even if the player releases the
  // trigger early.
  // For GuardDamage the shield strength is fixed and ignores trigger updates,
  // so we must walk back to the first frame of stun and read trigger there.
  // (Nana's shield reads Nana's trigger, not Popo's)
  const triggerStrength = createMemo(() =>
    props.renderData.animationName === "GuardDamage"
      ? (getPlayerOnFrame(
          props.renderData.playerSettings.playerIndex,
          getStartOfAction(
            props.renderData.playerState,
            replayStore.replayData!
          ),
          replayStore.replayData!
        )[props.renderData.playerState.isNana ? "nanaInputs" : "inputs"]
          ?.processed.anyTrigger ?? 1)
      : props.renderData.playerInputs.processed.anyTrigger === 0
      ? 1
      : props.renderData.playerInputs.processed.anyTrigger
  );
  // Formulas from https://www.ssbwiki.com/Shield#Shield_statistics
  const triggerStrengthMultiplier = createMemo(
    () => 1 - (0.5 * (triggerStrength() - 0.3)) / 0.7
  );
  const shieldSizeMultiplier = createMemo(
    () => ((shieldHealth() * triggerStrengthMultiplier()) / 60) * 0.85 + 0.15
  );
  return (
    <>
      <Show
        when={["GuardOn", "Guard", "GuardReflect", "GuardDamage"].includes(
          props.renderData.animationName
        )}
      >
        <circle
          // TODO: shield tilts
          cx={
            props.renderData.playerState.xPosition +
            props.renderData.characterData.shieldOffset[0] *
              props.renderData.playerState.facingDirection
          }
          cy={
            props.renderData.playerState.yPosition +
            props.renderData.characterData.shieldOffset[1]
          }
          r={props.renderData.characterData.shieldSize * shieldSizeMultiplier()}
          fill={props.renderData.innerColor}
          opacity={0.6}
        />
      </Show>
    </>
  );
}
