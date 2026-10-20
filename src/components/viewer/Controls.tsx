import { createSignal, onCleanup, onMount, Show } from "solid-js";
import {
  musicEnabled,
  sound,
  soundAvailable,
  soundConfigured,
  soundState,
} from "~/audio";
import { MinusIcon, PlusIcon } from "~/components/common/icons";
import {
  replayStore,
  adjust,
  jump,
  jumpPercent,
  nextHighlight,
  pause,
  previousHighlight,
  speedFast,
  speedNormal,
  speedSlow,
  toggleDebug,
  toggleFullscreen,
  togglePause,
  zoomIn,
  zoomOut,
} from "~/state/replayStore";
import { currentSelectionStore } from "~/state/selectionStore";

export function Controls() {
  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  });

  function onKeyDown({ key }: KeyboardEvent): void {
    switch (key) {
      case "k":
      case "K":
      case " ":
        togglePause();
        break;
      case "ArrowRight":
      case "l":
      case "L":
        adjust(120);
        break;
      case "ArrowLeft":
      case "j":
      case "J":
        adjust(-120);
        break;
      case ".":
      case ">":
        pause();
        adjust(1);
        break;
      case ",":
      case "<":
        pause();
        adjust(-1);
        break;
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7":
      case "8":
      case "9":
        jumpPercent(Number(key) * 0.1); // convert 3 => 30%
        break;
      case "ArrowUp":
        speedSlow();
        break;
      case "ArrowDown":
        speedFast();
        break;
      case "-":
      case "_":
        zoomOut();
        break;
      case "=":
      case "+":
        zoomIn();
        break;
      case "]":
      case "}":
        void currentSelectionStore().nextFile();
        break;
      case "[":
      case "{":
        void currentSelectionStore().previousFile();
        break;
      case "'":
      case '"':
        nextHighlight();
        break;
      case ";":
      case ":":
        previousHighlight();
        break;
      case "d":
      case "D":
        toggleDebug();
        break;
      case "f":
      case "F":
        toggleFullscreen();
        break;
    }
  }

  function onKeyUp({ key }: KeyboardEvent): void {
    switch (key) {
      case "ArrowUp":
      case "ArrowDown":
        speedNormal();
        break;
    }
  }

  // sound from the host page's player (audio.ts), when it set one up: the
  // button turns it on at the frame shown, and off again (also while it is
  // still starting)
  function toggleSound(): void {
    if (soundState() === "on" || soundState() === "loading") {
      sound.disable();
    } else {
      sound.seek(replayStore.frame);
      void sound.enable();
    }
  }

  function soundLabel(): string {
    switch (soundState()) {
      case "loading":
        return "Cancel sound";
      case "on":
        return "Sound on";
      case "error":
        return "Retry sound";
      default:
        return "Enable sound";
    }
  }

  let seekbarInput!: HTMLInputElement;
  let bar!: HTMLDivElement;
  // while the bar is not shown (a host page may hide it: it has
  // its own controls) it does not follow the frame - nothing to update
  // sixty times a second that nobody sees
  const [shown, setShown] = createSignal(true);
  onMount(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setShown(bar.getClientRects().length > 0));
    ro.observe(bar);
    onCleanup(() => ro.disconnect());
  });

  return (
    <div ref={bar} class="flex flex-wrap items-center justify-evenly gap-4 rounded-b border border-t-0 py-1 px-2 text-slate-800">
      <Show
        when={replayStore.running}
        fallback={
          <div
            class="material-icons cursor-pointer text-[32px] leading-none"
            onClick={() => togglePause()}
            aria-label="Resume playback"
          >
            play_arrow
          </div>
        }
      >
        <div
          class="material-icons cursor-pointer text-[32px]"
          onClick={() => togglePause()}
          aria-label="pause playback"
        >
          pause
        </div>
      </Show>
      <div class="flex items-center gap-1">
        <div
          class="material-icons cursor-pointer text-[32px]"
          onClick={() => adjust(-120)}
          aria-label="Rewind 2 seconds"
        >
          history
        </div>
        <MinusIcon
          class="h-6 w-6"
          role="button"
          title="previous frame"
          onClick={() => {
            pause();
            adjust(-1);
          }}
        >
          -
        </MinusIcon>
        <label for="seekbar" class="font-mono text-sm">
          {shown() ? (replayStore.isDebug ? replayStore.frame - 123 : replayStore.frame) : ""}
        </label>
        <PlusIcon
          class="h-6 w-6"
          role="button"
          title="next frame"
          onClick={() => {
            pause();
            adjust(1);
          }}
        >
          +
        </PlusIcon>
        <div
          class="material-icons cursor-pointer text-[32px]"
          onClick={() => adjust(120)}
          aria-label="Skip ahead 2 seconds"
        >
          update
        </div>
      </div>
      <Show when={soundConfigured}>
        <button
          type="button"
          class="rounded px-2 py-1 hover:bg-slate-200 disabled:opacity-50"
          disabled={!soundAvailable()}
          aria-pressed={soundState() === "on"}
          onClick={() => toggleSound()}
        >
          {soundLabel()}
        </button>
        <Show when={soundState() === "on"}>
          <label class="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={musicEnabled()}
              onChange={(e) => sound.music(e.currentTarget.checked)}
            />
            Music
          </label>
        </Show>
      </Show>
      <input
        id="seekbar"
        class="flex-grow accent-slippi-500"
        type="range"
        ref={seekbarInput}
        value={shown() ? replayStore.frame : seekbarInput?.valueAsNumber ?? 0}
        // a moment's range is the whole bar
        min={replayStore.range ? replayStore.range[0] : 0}
        max={replayStore.range ? replayStore.range[1] : replayStore.replayData!.frames.length - 1}
        onInput={() => jump(seekbarInput.valueAsNumber)}
      />
      <div
        class="material-icons cursor-pointer text-[32px]"
        onClick={() => toggleFullscreen()}
        aria-label="Toggle fullscreen mode"
      >
        {replayStore.isFullscreen ? "fullscreen_exit" : "fullscreen"}
      </div>
    </div>
  );
}
