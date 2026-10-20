// Sound for the replay, from a player the embedding page supplies.
//
// Nothing here makes sound by itself: no audio engine and no game sound
// assets are in this repository. A host page that has a sound-only replay
// player sets globalThis.__MELEE_AUDIO_CONFIG__ before the viewer loads (see
// README.md, "Optional browser audio"); without it this module does nothing,
// the sound controls are not shown, and the viewer plays on its own clock as
// before. Turning sound off destroys the host's player, which gives the viewer
// back its own clock.
//
// While sound is on, the picture follows the sound: each tick the viewer shows
// the game frame the audio device is playing (PCM playback time, the host
// player's audioFrame), not the next frame of its own clock. Seeks, pause,
// play and speed changes go to the host player, which starts its sound again
// at the frame shown.

import { clearSimulationStage, receiveSimulationStage } from "./simulation-stage";
import { createSignal } from "solid-js";

/** what the host page sets before the viewer loads */
interface AudioConfig {
  /** URL of an ES module that exports ReplayPlayer */
  module: string;
  /** passed through to the host player */
  assetsUrl: string;
}

/** the host player's position event: which seek it is for, and whether that seek is done */
interface PositionDetail {
  videoEpoch: number;
  seeking: boolean;
}

/** the host's sound-only replay player (the contract in README.md) */
interface AudioPlayer extends EventTarget {
  /** the replay is open and seeks may be sent */
  readonly ready: boolean;
  readonly speed: number;
  /** the fractional game frame (from -123) at the audio device's playback time, null until known */
  readonly audioFrame: number | null | undefined;
  /** the number of the latest seek. Provisional: this is the existing host
   *  player's private field; a public way to acknowledge a seek should take
   *  its place before this contract is final */
  readonly _videoEpoch: number;
  enableAudio(): Promise<unknown>;
  open(replay: Blob): Promise<unknown>;
  seek(gameFrame: number, options: { resume: boolean }): void;
  play(): Promise<unknown>;
  pause(): void;
  setSpeed(rate: number): void;
  setMusic(on: boolean): void;
  destroy(): unknown;
}

type AudioPlayerClass = new (options: {
  audioOnly: true;
  assetsUrl: string;
  music: boolean;
}) => AudioPlayer;

/** the game's first frame: viewer frame indexes start at 0, the host player's game frames at -123 */
const FIRST_FRAME = -123;

const config = (globalThis as { __MELEE_AUDIO_CONFIG__?: AudioConfig })
  .__MELEE_AUDIO_CONFIG__;

/** whether the host page configured sound at all (the sound controls show only then) */
export const soundConfigured = !!config;
export const [soundState, setSoundState] = createSignal<
  "off" | "loading" | "on" | "error"
>("off");
/** the host's player module has loaded: sound can be turned on */
export const [soundAvailable, setSoundAvailable] = createSignal(false);
export const [musicEnabled, setMusicEnabled] = createSignal(true);

let Player: AudioPlayerClass | undefined;
// the host player while sound is on or starting, null while it is off
let player: AudioPlayer | null = null;
// the replay the host player opens
let blob: Blob | undefined;
// what the viewer asks for: playing or paused, the frame shown, the speed
let desired = false;
let index = 0;
let speed = 1;
// counts every start and stop of sound: a start that finishes after sound
// was turned off (or on again) sees the count has moved and does nothing
let generation = 0;
// a seek was sent and the host player has not said it is done
let seeking = false;

// the host's module is loaded ahead of the first click, so the click can
// start sound at once; loading it makes no worker or AudioContext
if (config) {
  void import(/* @vite-ignore */ config.module)
    .then((m: { ReplayPlayer: AudioPlayerClass }) => {
      Player = m.ReplayPlayer;
      setSoundAvailable(true);
    })
    .catch((error) => {
      console.warn("Experimental audio controller failed", error);
      setSoundState("error");
    });
}

/** sound off after the host player failed (if it is still the current one) */
function fail(p: AudioPlayer) {
  if (p !== player) return;
  void p.destroy();
  player = null;
  seeking = false;
  setSoundState("error");
}

/** start the host player's sound again at the frame shown, playing or paused */
function align() {
  if (!player?.ready) return;
  seeking = true;
  // each seek gets a new epoch in the host player and the latest one wins;
  // the old sound stops at once, before this returns
  player.seek(index + FIRST_FRAME, { resume: desired });
}

export const sound = {
  /** a new replay (or none): sound off, and the next start opens this one */
  load(data?: Blob): void {
    this.disable();
    clearSimulationStage();
    blob = data;
  },

  /** sound off: the host player is destroyed and the viewer's own clock is back */
  disable(): void {
    generation++;
    const old = player;
    player = null;
    seeking = false;
    if (old) void old.destroy();
    setSoundState("off");
  },

  /** sound on, from the sound button's click */
  async enable(): Promise<void> {
    if (!Player || !blob || !crossOriginIsolated) {
      setSoundState("error");
      return;
    }
    const id = ++generation;
    const p = new Player({
      audioOnly: true,
      assetsUrl: config!.assetsUrl,
      music: musicEnabled(),
    });
    player = p;
    setSoundState("loading");
    p.addEventListener("stage-frames", event => {
      if (p === player) receiveSimulationStage((event as CustomEvent<{frames: number[][]}>).detail.frames);
    });
    p.addEventListener("error", () => fail(p));
    p.addEventListener("audiointerrupted", () => fail(p));
    p.addEventListener("position", (event) => {
      const detail = (event as CustomEvent<PositionDetail>).detail;
      // (a seek is done only when the host player says so for the latest
      // seek: an older seek finishing while the slider moves on is not it)
      if (p !== player || detail.videoEpoch !== p._videoEpoch) return;
      if (!detail.seeking) seeking = false;
    });
    try {
      // enableAudio is called in the click itself, before the first await,
      // so the browser lets the host player start its AudioContext
      const unlock = p.enableAudio();
      await Promise.all([unlock, p.open(blob)]);
      // (sound was turned off, or the replay changed, while it started)
      if (id !== generation || player !== p) return;
      p.setSpeed(speed);
      setSoundState("on");
      align();
    } catch (error) {
      console.warn("Experimental audio startup failed", error);
      fail(p);
    }
  },

  /** the viewer's playing state, frame and speed (1 = the game's) */
  transport(playing: boolean, frame: number, rate: number): void {
    index = frame;
    const changed = desired !== playing || speed !== rate;
    desired = playing;
    speed = rate;
    if (changed && player?.ready) {
      if (player.speed !== rate) player.setSpeed(rate);
      if (seeking) align();
      else if (desired) { const p = player; void p.play().catch(() => fail(p)); }
      else player.pause();
    }
  },

  /** the viewer jumped to this frame */
  seek(frame: number): void {
    index = frame;
    if (player?.ready) align();
  },

  /** the frame to show now: undefined while sound is off (the viewer's own
   *  clock), null while the sound is not there yet (the picture holds), or
   *  the frame the audio device is playing */
  frame(): number | null | undefined {
    if (!player) return undefined;
    if (!player.ready || seeking) return null;
    const frame = player.audioFrame;
    return frame == null ? null : Math.floor(frame - FIRST_FRAME);
  },

  /** the game's music on or off (the rest of the sound stays) */
  music(on: boolean): void {
    setMusicEnabled(on);
    player?.setMusic(on);
  },
};

window.addEventListener("pagehide", () => sound.disable());
