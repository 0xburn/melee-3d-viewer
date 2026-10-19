import { createMemo, For, Match, Switch } from "solid-js";
import { itemNamesById } from "~/common/ids";
import { ItemUpdate, PlayerUpdate } from "~/common/types";
import { replayStore, ReplayStore } from "~/state/replayStore";

// TODO: characters projectiles

// Note: Most items coordinates and sizes are divided by 256 to convert them
// from hitboxspace to worldspace.
export function Item(props: { item: ItemUpdate }) {
  const itemName = createMemo(() => itemNamesById[props.item.typeId]);
  return (
    <Switch>
      <Match when={itemName() === "Needle(thrown)"}>
        <Needle item={props.item} />
      </Match>
      <Match when={itemName() === "Fox's Laser"}>
        <FoxLaser item={props.item} />
      </Match>
      <Match when={itemName() === "Falco's Laser"}>
        <FalcoLaser item={props.item} />
      </Match>
      <Match when={itemName() === "Turnip"}>
        <Turnip item={props.item} />
      </Match>
      <Match when={itemName() === "Yoshi's egg(thrown)"}>
        <YoshiEgg item={props.item} />
      </Match>
      <Match when={itemName() === "Luigi's fire"}>
        <LuigiFireball item={props.item} />
      </Match>
      <Match when={itemName() === "Mario's fire"}>
        <MarioFireball item={props.item} />
      </Match>
      <Match when={itemName() === "Missile"}>
        <Missile item={props.item} />
      </Match>
      <Match when={itemName() === "Samus's bomb"}>
        <SamusBomb item={props.item} />
      </Match>
      <Match when={itemName() === "Samus's chargeshot"}>
        <SamusChargeshot item={props.item} />
      </Match>
      <Match when={itemName() === "Shyguy (Heiho)"}>
        <FlyGuy item={props.item} />
      </Match>
    </Switch>
  );
}

function SamusChargeshot(props: { item: ItemUpdate }) {
  // charge levels go 0 to 7
  const hitboxesByChargeLevel = [300, 400, 500, 600, 700, 800, 900, 1200];
  return (
    <>
      <circle
        cx={props.item.xPosition}
        cy={props.item.yPosition}
        r={hitboxesByChargeLevel[props.item.chargeShotChargeLevel] / 256}
        fill="darkgray"
      />
    </>
  );
}

function SamusBomb(props: { item: ItemUpdate }) {
  // states: 1 = falling, 3 = exploding
  return (
    <>
      <circle
        cx={props.item.xPosition}
        cy={props.item.yPosition}
        r={(props.item.state === 3 ? 1536 : 500) / 256}
        fill="darkgray"
      />
    </>
  );
}

function Missile(props: { item: ItemUpdate }) {
  // samusMissileTypes: 0 = homing missile, 1 = smash missile
  return (
    <>
      <circle
        cx={props.item.xPosition}
        cy={props.item.yPosition}
        r={(props.item.samusMissileType === 0 ? 500 : 600) / 256}
        fill="darkgray"
      />
    </>
  );
}

function MarioFireball(props: { item: ItemUpdate }) {
  return (
    <>
      <circle
        cx={props.item.xPosition}
        cy={props.item.yPosition}
        r={600 / 256}
        fill="darkgray"
      />
    </>
  );
}

function LuigiFireball(props: { item: ItemUpdate }) {
  return (
    <>
      <circle
        cx={props.item.xPosition}
        cy={props.item.yPosition}
        r={500 / 256}
        fill="darkgray"
      />
    </>
  );
}

function YoshiEgg(props: { item: ItemUpdate }) {
  // states: 0 = held, 1 = thrown, 2 = exploded
  const ownerState = createMemo(() => getOwner(replayStore, props.item).state);
  return (
    <>
      <circle
        cx={
          props.item.state === 0 ? ownerState().xPosition : props.item.xPosition
        }
        cy={
          props.item.state === 0
            ? ownerState().yPosition + 8
            : props.item.yPosition
        }
        r={props.item.state === 2 ? 2500 / 256 : 1000 / 256}
        fill="darkgray"
        opacity={props.item.state === 1 ? 1 : 0.5}
      />
    </>
  );
}

function Turnip(props: { item: ItemUpdate }) {
  // states: 0 = held, 1 = bouncing?, 2 = thrown
  // face: props.item.peachTurnipFace
  const ownerState = createMemo(() => getOwner(replayStore, props.item).state);
  return (
    <>
      <circle
        cx={
          props.item.state === 0 ? ownerState().xPosition : props.item.xPosition
        }
        cy={
          props.item.state === 0
            ? ownerState().yPosition + 8
            : props.item.yPosition
        }
        r={600 / 256}
        fill="darkgray"
        opacity={props.item.state === 0 ? 0.5 : 1}
      />
    </>
  );
}

function Needle(props: { item: ItemUpdate }) {
  return (
    <>
      <circle
        cx={props.item.xPosition}
        cy={props.item.yPosition}
        r={500 / 256}
        fill="darkgray"
      />
    </>
  );
}

function FoxLaser(props: { item: ItemUpdate }) {
  // There is a 4th hitbox for the first frame only at -3600 (hitboxspace) with
  // size 400 / 256 that I am skipping.
  const hitboxOffsets = [-200, -933, -1666].map((x) => x / 256);
  const hitboxSize = 300 / 256;
  // Throws and deflected lasers are not straight horizontal
  const rotations = createMemo(() => {
    const direction = Math.atan2(props.item.yVelocity, props.item.xVelocity);
    return [Math.cos(direction), Math.sin(direction)];
  });
  return (
    <>
      <line
        x1={
          props.item.xPosition +
          hitboxOffsets[0] * props.item.facingDirection * rotations()[0]
        }
        y1={
          props.item.yPosition +
          hitboxOffsets[0] * props.item.facingDirection * rotations()[1]
        }
        x2={
          props.item.xPosition +
          hitboxOffsets[hitboxOffsets.length - 1] *
            props.item.facingDirection *
            rotations()[0]
        }
        y2={
          props.item.yPosition +
          hitboxOffsets[hitboxOffsets.length - 1] *
            props.item.facingDirection *
            rotations()[1]
        }
        stroke="red"
      />
      <For each={hitboxOffsets}>
        {(hitboxOffset) => (
          <circle
            cx={
              props.item.xPosition +
              hitboxOffset * props.item.facingDirection * rotations()[0]
            }
            cy={
              props.item.yPosition +
              hitboxOffset * props.item.facingDirection * rotations()[1]
            }
            r={hitboxSize}
            fill="red"
          />
        )}
      </For>
    </>
  );
}

function FalcoLaser(props: { item: ItemUpdate }) {
  const hitboxOffsets = [-200, -933, -1666, -2400].map((x) => x / 256);
  const hitboxSize = 300 / 256;
  // Throws and deflected lasers are not straight horizontal
  const rotations = createMemo(() => {
    const direction = Math.atan2(props.item.yVelocity, props.item.xVelocity);
    return [Math.cos(direction), Math.sin(direction)];
  });
  return (
    <>
      <line
        x1={props.item.xPosition + hitboxOffsets[0] * rotations()[0]}
        y1={props.item.yPosition + hitboxOffsets[0] * rotations()[1]}
        x2={
          props.item.xPosition +
          hitboxOffsets[hitboxOffsets.length - 1] * rotations()[0]
        }
        y2={
          props.item.yPosition +
          hitboxOffsets[hitboxOffsets.length - 1] * rotations()[1]
        }
        stroke="red"
      />
      <For each={hitboxOffsets}>
        {(hitboxOffset) => (
          <circle
            cx={props.item.xPosition + hitboxOffset * rotations()[0]}
            cy={props.item.yPosition + hitboxOffset * rotations()[1]}
            r={hitboxSize}
            fill="red"
          />
        )}
      </For>
    </>
  );
}

// Yoshi's Story's Shy Guys, drawn as the game draws them: a red
// hooded body seen from the side, the white mask on the front with its two
// eye holes and mouth, blue feet, and the propeller on its back that carries
// it - facing the way it flies, the propeller turning. The replay gives where
// each one is on its path, frame by frame.
function FlyGuy(props: { item: ItemUpdate }) {
  const face = () => (props.item.facingDirection < 0 ? -1 : 1);
  // the propeller's blades, foreshortened as they turn
  const blade = () => Math.abs(Math.cos(props.item.frameNumber * 0.9)) * 2.6 + 0.5;
  return (
    <g transform={`translate(${props.item.xPosition} ${props.item.yPosition}) scale(${face()} 1)`}>
      {/* propeller: shaft out of the back, hub and blades */}
      <line x1={-2.6} y1={1.2} x2={-4.8} y2={1.6} stroke="#57534e" stroke-width={0.55} />
      <ellipse cx={-5} cy={1.6} rx={0.5} ry={blade()} fill="#d9f99d" stroke="#65a30d" stroke-width={0.3} />
      <circle cx={-5} cy={1.6} r={0.45} fill="#65a30d" />
      {/* body and hood */}
      <path d="M -3.2 -3.4 C -3.9 -0.5 -3 3.6 0.4 4.1 C 3.6 4.3 4.2 0.5 3.4 -3.4 Z" fill="#dc2626" stroke="#7f1d1d" stroke-width={0.35} />
      {/* feet */}
      <ellipse cx={-1.2} cy={-3.9} rx={1.4} ry={0.75} fill="#1d4ed8" stroke="#1e3a8a" stroke-width={0.2} />
      <ellipse cx={1.8} cy={-3.9} rx={1.4} ry={0.75} fill="#1d4ed8" stroke="#1e3a8a" stroke-width={0.2} />
      {/* the mask, on the front */}
      <ellipse cx={2.1} cy={0.6} rx={2.1} ry={2.6} fill="#f8fafc" stroke="#475569" stroke-width={0.25} />
      <ellipse cx={1.6} cy={1.4} rx={0.4} ry={0.75} fill="#0f172a" />
      <ellipse cx={2.9} cy={1.4} rx={0.4} ry={0.75} fill="#0f172a" />
      <ellipse cx={2.3} cy={-0.7} rx={0.5} ry={0.38} fill="#0f172a" />
    </g>
  );
}

function getOwner(replayStore: ReplayStore, item: ItemUpdate): PlayerUpdate {
  return replayStore.replayData!.frames[item.frameNumber].players[item.owner];
}
