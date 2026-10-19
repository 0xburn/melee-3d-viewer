import { createMemo, For, Show } from "solid-js";
import { hudCharacterName } from "~/common/ids";
import { RenderData, replayStore } from "~/state/replayStore";
import { hudSlot } from "~/common/hudslots";

export function PlayerHUD(props: { player: number }) {
  const renderData = createMemo(() =>
    replayStore.renderDatas.find(
      (renderData) =>
        renderData.playerSettings.playerIndex === props.player &&
        renderData.playerState.isNana === false
    )
  );
  // by the HUD's slot, not the port (two players: the outer slots, hudslots.ts)
  const position = createMemo(() => ({
    x: -30 + 20 * hudSlot(replayStore.replayData!.settings, props.player), // slots at: -30%, -10%, 10%, 30%
    y: 40, // y% is flipped by css to make the text right-side up.
  }));
  const name = createMemo(() =>
    renderData()
      ? [
          renderData()!.playerSettings.displayName,
          renderData()!.playerSettings.connectCode,
          renderData()!.playerSettings.nametag,
          renderData()!.playerSettings.displayName,
          hudCharacterName(renderData()!.playerState.internalCharacterId),
        ].find((n) => n !== undefined && n.length > 0)
      : ""
  );
  // the HUD sits on a plate of its own, drawn over the picture
  // (after the camera's stage and fighters, Viewer.tsx), so it reads on any
  // stage like the 3D view's (dark red and blue words
  // with a black outline over Pokemon Stadium's dark floor could not be
  // read). The plate is the Controller overlay's look (Controllers.tsx):
  // dark and see-through with a thin outline in the port's color; on it the
  // stocks in the port's color, the percent in white and the name under it.
  // In the picture's own units: the viewBox is 730 wide, its bottom edge 300
  // below the middle.
  const cx = createMemo(() => (position().x / 100) * HUD_W);
  const shown = createMemo(() => {
    const n = name() ?? "";
    return n.length > NAME_MAX ? n.slice(0, NAME_MAX - 1) + "…" : n;
  });

  return (
    <>
      <Show when={renderData()}>
        <g data-hud={renderData()!.playerSettings.port}>
          <rect
            data-hud-plate=""
            x={cx() - PLATE_W / 2}
            y={-PLATE_BOTTOM}
            width={PLATE_W}
            height={PLATE_H}
            rx={8}
            fill="rgba(15, 23, 42, 0.8)"
            stroke={renderData()!.innerColor}
            stroke-width={2}
          />
          <For each={Array(renderData()!.playerState.stocksRemaining).fill(0)}>
            {(_, i) => (
              <circle
                cx={cx() - STOCK_GAP * (1.5 - i())}
                cy={-(PLATE_BOTTOM - PLATE_H + 13)}
                r={5}
                fill={renderData()!.innerColor}
                stroke="#f8fafc"
                stroke-width={1.5}
              />
            )}
          </For>
          <text
            data-hud-percent=""
            style={{ font: "bold 20px sans-serif", transform: "scaleY(-1)" }}
            x={cx()}
            y={PLATE_BOTTOM - PLATE_H + 41}
            text-anchor="middle"
            textContent={`${Math.floor(renderData()!.playerState.percent)}%`}
            fill="#f8fafc"
          />
          <text
            data-hud-name=""
            style={{ font: "bold 13px sans-serif", transform: "scaleY(-1)" }}
            x={cx()}
            y={PLATE_BOTTOM - 9}
            text-anchor="middle"
            textContent={shown()}
            fill="#cbd5e1"
          />
        </g>
        <Show when={replayStore.isDebug}>
          <Debug position={position()} renderData={renderData()!} />
        </Show>
      </Show>
    </>
  );
}

// the picture's width in its own units (Viewer.tsx's viewBox), and the plate
const HUD_W = 730;
const PLATE_W = 132;
const PLATE_H = 66;
// the plate's bottom edge below the middle (the picture's edge is 300)
const PLATE_BOTTOM = 292;
// between two stocks' centers
const STOCK_GAP = 14;
// a longer name is cut short with an ellipsis, so it stays on its plate
const NAME_MAX = 16;

function Debug(props: {
  position: { x: number; y: number };
  renderData: RenderData;
}) {
  return (
    <>
      <text
        style={{ font: "bold 15px sans-serif", transform: "scaleY(-1)" }}
        x={`${props.position.x}%`}
        y="-40%"
        text-anchor="middle"
        textContent={`State ID: ${props.renderData.playerState.actionStateId}`}
        fill={props.renderData.innerColor}
        stroke="black"
      />
      <text
        style={{ font: "bold 15px sans-serif", transform: "scaleY(-1)" }}
        x={`${props.position.x}%`}
        y="-37%"
        text-anchor="middle"
        textContent={`State Frame: ${parseFloat(
          props.renderData.playerState.actionStateFrameCounter.toFixed(4)
        )}`}
        fill={props.renderData.innerColor}
        stroke="black"
      />
      <text
        style={{ font: "bold 15px sans-serif", transform: "scaleY(-1)" }}
        x={`${props.position.x}%`}
        y="-34%"
        text-anchor="middle"
        textContent={`X: ${parseFloat(
          props.renderData.playerState.xPosition.toFixed(4)
        )}`}
        fill={props.renderData.innerColor}
        stroke="black"
      />
      <text
        style={{ font: "bold 15px sans-serif", transform: "scaleY(-1)" }}
        x={`${props.position.x}%`}
        y="-31%"
        text-anchor="middle"
        textContent={`Y: ${parseFloat(
          props.renderData.playerState.yPosition.toFixed(4)
        )}`}
        fill={props.renderData.innerColor}
        stroke="black"
      />
      <text
        style={{ font: "bold 15px sans-serif", transform: "scaleY(-1)" }}
        x={`${props.position.x}%`}
        y="-28%"
        text-anchor="middle"
        textContent={props.renderData.animationName}
        fill={props.renderData.innerColor}
        stroke="black"
      />
    </>
  );
}
