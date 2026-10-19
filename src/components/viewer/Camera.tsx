import { createEffect, createMemo, createSignal, on, onCleanup, ParentProps } from "solid-js";
import { replayStore } from "~/state/replayStore";
import { cameraTarget, CameraTarget, stageLimits, stepCamera } from "~/viewer/cameraFrame";

export function Camera(props: ParentProps) {
  const [cam, setCam] = createSignal<CameraTarget | undefined>();
  // what the camera aims for (viewer/cameraFrame.ts): the real
  // fighters as Slippi Lab framed them, or, with simulated ghosts on screen,
  // the real fighters and every ghost shown, as Melee frames several players
  let target: CameraTarget | undefined;

  createEffect(() => {
    const data = replayStore.replayData!;
    target = cameraTarget(
      data.frames,
      replayStore.frame,
      replayStore.ghosts.map((g) => ({ frames: g.replayData.frames, held: g.replayData.held })),
      stageLimits(data.settings.stageId),
    );
    setCam((old) => stepCamera(old, target!));
  });

  // ghosts turned on or off while paused: the camera eases over
  // there as it would playing, a step a frame, not one step and stuck
  let raf = 0;
  const ease = () => {
    raf = 0;
    if (replayStore.running || !target) return;
    const t = target, c = stepCamera(cam(), t);
    setCam(c);
    const done = Math.abs(c.x - t.x) < 0.05 && Math.abs(c.y - t.y) < 0.05 && Math.abs(c.scale - t.scale) < 0.001;
    if (!done) raf = requestAnimationFrame(ease);
  };
  createEffect(on(() => replayStore.ghosts, () => {
    if (!raf && !replayStore.running) raf = requestAnimationFrame(ease);
  }, { defer: true }));
  onCleanup(() => cancelAnimationFrame(raf));

  // the zoom is applied when drawing, not folded into the
  // smoothed scale - folded in, it multiplied itself every frame until any
  // ?zoom= other than 1 had zoomed the picture away
  const transforms = createMemo(() =>
    [
      `scale(${(cam()?.scale ?? 1) * replayStore.zoom})`,
      `translate(${(cam()?.x ?? 0) * -1}, ${(cam()?.y ?? 0) * -1})`,
    ].join(" ")
  );

  return <g transform={transforms()}>{props.children}</g>;
}
