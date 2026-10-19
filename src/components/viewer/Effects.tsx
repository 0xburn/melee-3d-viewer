/* the game's common effects in the line art - dust, hit sparks,
 * the vanish puffs, Fox's and Falco's reflector and the angel platform -
 * worked out from the replay (common/effects.ts), drawn in the line art's
 * own flat style. Coordinates are game units, y up (the viewer flips). */
import { createMemo, For, Show } from "solid-js";
import { effectsAt, Fx, fxAt, onAngelPlatform, shineAt } from "~/common/effects";
import type { PlayerState } from "~/common/types";
import { replayStore } from "~/state/replayStore";
import { actionMapByInternalId } from "~/viewer/characters";

const middle = (char: number) => actionMapByInternalId[char]?.shieldOffset[1] ?? 8;

interface Fighter { st: PlayerState; player: number; nana: boolean }

function fighters(): Fighter[] {
  const f = replayStore.replayData?.frames[replayStore.frame];
  const out: Fighter[] = [];
  for (const p of f?.players ?? []) {
    if (!p) continue;
    out.push({ st: p.state, player: p.playerIndex, nana: false });
    if (p.nanaState) out.push({ st: p.nanaState, player: p.playerIndex, nana: true });
  }
  return out;
}

/** under the fighters: the angel platform */
export function AngelPlatforms() {
  const on = createMemo(() => fighters().filter((f) => onAngelPlatform(f.st)));
  return <For each={on()}>{(f) => <AngelPlatform x={f.st.xPosition} y={f.st.yPosition} />}</For>;
}

/** over the fighters: dust, sparks, puffs, the reflector */
export function Effects() {
  const fx = createMemo(() => {
    const data = replayStore.replayData;
    return data ? effectsAt(data, replayStore.frame, middle) : [];
  });
  const shines = createMemo(() => {
    const data = replayStore.replayData;
    if (!data) return [];
    return fighters()
      .map((f) => ({ f, s: shineAt(data, replayStore.frame, f.player, f.nana) }))
      .filter((x) => x.s !== null);
  });
  return (
    <>
      <For each={fx().filter((e) => e.kind === "dust" || e.kind === "puff")}>{(e) => <Dust fx={e} />}</For>
      <For each={shines()}>
        {({ f, s }) => (
          <Reflector x={f.st.xPosition} y={f.st.yPosition + middle(f.st.internalCharacterId) * 0.75}
                     start={s!.start} loop={s!.loop} hit={s!.hit} />
        )}
      </For>
      <For each={fx().filter((e) => e.kind === "spark")}>{(e) => <Spark fx={e} />}</For>
    </>
  );
}

// A puff of dust: three soft round lobes that spread, rise a little and fade.
function Dust(props: { fx: Fx }) {
  const at = createMemo(() => fxAt(props.fx));
  const lobes = createMemo(() => {
    const s = props.fx.seed * Math.PI * 2;
    return [0, 1, 2].map((i) => ({
      dx: Math.cos(s + i * 2.1) * 0.45,
      dy: Math.abs(Math.sin(s + i * 2.1)) * 0.35,
      r: 0.62 + 0.18 * ((i + props.fx.seed * 3) % 1),
    }));
  });
  return (
    <g opacity={0.9 * (1 - at().t) ** 1.3}>
      <For each={lobes()}>
        {(l) => (
          <circle cx={at().x + l.dx * at().size} cy={at().y + l.dy * at().size} r={at().size * l.r}
                  class="fill-white stroke-slate-400" stroke-width={0.35} />
        )}
      </For>
    </g>
  );
}

// A hit spark: a sharp eight-pointed star that opens and fades in a few frames.
function Spark(props: { fx: Fx }) {
  const at = createMemo(() => fxAt(props.fx));
  const points = createMemo(() => {
    const { x, y, size } = at();
    const turn = props.fx.seed * Math.PI;
    const out: string[] = [];
    for (let i = 0; i < 16; i++) {
      const a = turn + (i * Math.PI) / 8;
      const r = i % 2 ? size * 0.38 : size * (i % 4 ? 0.8 : 1);
      out.push(`${x + Math.cos(a) * r},${y + Math.sin(a) * r}`);
    }
    return out.join(" ");
  });
  return (
    <polygon points={points()} fill="#fff7cc" stroke="#f59e0b" stroke-width={0.6} stroke-linejoin="round"
             opacity={1 - at().t ** 2} />
  );
}

const HEX = [0, 1, 2, 3, 4, 5].map((i) => [Math.sin((i * Math.PI) / 3), Math.cos((i * Math.PI) / 3)]);
const hexPoints = (x: number, y: number, r: number) => HEX.map(([dx, dy]) => `${x + dx * r},${y + dy * r}`).join(" ");

// Fox's and Falco's reflector: the flash as it comes out, then the hexagon -
// a pale blue plate with a bright rim and a hole in the middle - and a white
// burst each time it reflects something.
function Reflector(props: { x: number; y: number; start: number; loop: number; hit: number }) {
  const R = 7;
  return (
    <g>
      <Show when={props.start >= 0}>
        <polygon points={hexPoints(props.x, props.y, R * (0.5 + Math.min(1, props.start / 6) * 0.9))}
                 fill="none" stroke="#e0f2fe" stroke-width={1.2} opacity={Math.max(0, 1 - props.start / 12)} />
      </Show>
      <Show when={props.loop >= 0 || props.hit >= 0 || (props.start >= 0 && props.start < 4)}>
        <path d={`M${hexPoints(props.x, props.y, R).replace(/ /g, " L")} Z M${hexPoints(props.x, props.y, R * 0.55).replace(/ /g, " L")} Z`}
              fill="#7cc4f4" fill-opacity={0.5} fill-rule="evenodd" stroke="#e0f2fe" stroke-width={0.7} />
      </Show>
      <Show when={props.hit >= 0}>
        <polygon points={hexPoints(props.x, props.y, R * (1 + props.hit * 0.06))}
                 fill="white" opacity={0.85 * (1 - props.hit / 12)} />
      </Show>
    </g>
  );
}

// The platform a fighter comes back on: a flat, pale halo of a platform
// with a brighter rim, under the feet.
function AngelPlatform(props: { x: number; y: number }) {
  return (
    <g>
      <ellipse cx={props.x} cy={props.y - 1.2} rx={7.5} ry={1.3} fill="#bae6fd" opacity={0.8} />
      <ellipse cx={props.x} cy={props.y - 0.3} rx={7.5} ry={1.6} fill="#f0f9ff" stroke="#38bdf8" stroke-width={0.5} />
    </g>
  );
}
