import type { JSX } from "solid-js";

/** The game's picture is 73:60 (its camera's shape, the TV's 4:3 with the
 *  console's pixels): 1.2167 across for 1 down. */
export const GAME_ASPECT = 73 / 60;

/**
 * The game's picture at the game's own shape, always.
 *
 * Whatever the box a page gives the player, the picture inside is the
 * largest 73:60 rectangle that fits, centered; the rest of the box is left to
 * the page behind it. Pages size their boxes 73:60, so there is usually
 * nothing left over - this only makes sure a box of another shape can never
 * widen the view or stretch it. The 3D view and the line art both sit in it.
 */
export function GameFrame(props: { children: JSX.Element; class?: string }) {
  return (
    <div class="relative min-h-0 w-full flex-1" style="container-type: size" data-game-frame>
      <div class={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden ${props.class ?? ""}`}
           style={{ width: "min(100cqw, calc(100cqh * 73 / 60))", height: "min(100cqh, calc(100cqw * 60 / 73))" }}>
        {props.children}
      </div>
    </div>
  );
}
