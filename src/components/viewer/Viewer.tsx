import { createMemo, For, JSX, Show } from "solid-js";
import { GameFrame } from "~/components/viewer/GameFrame";
import { Camera } from "~/components/viewer/Camera";
import { HUD } from "~/components/viewer/HUD";
import { Players } from "~/components/viewer/Player";
import { Stage } from "~/components/viewer/Stage";
import { Item } from "~/components/viewer/Item";
import { replayStore } from "~/state/replayStore";
import { Controls } from "~/components/viewer/Controls";
import { AngelPlatforms, Effects } from "~/components/viewer/Effects";

export function Viewer(props: { corner?: JSX.Element; mini?: boolean } = {}) {
  const items = createMemo(
    () => replayStore.replayData?.frames[replayStore.frame]?.items ?? []
  );
  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Show when={replayStore.replayData}>
        {/* the picture at the game's own shape, whatever the box (GameFrame) */}
        <GameFrame>
        <svg class="absolute inset-0 h-full w-full border bg-slate-50" viewBox="-365 -300 730 600">
          {/* up = positive y axis */}
          <g class="-scale-y-100">
            <Camera>
              <Stage />
              <AngelPlatforms />
              <Players />
              <For each={items()}>{(item) => <Item item={item} />}</For>
              <Effects />
            </Camera>
            <HUD />
          </g>
        </svg>
        {props.corner}
        </GameFrame>
        <Show when={!props.mini}><Controls /></Show>
      </Show>
    </div>
  );
}
