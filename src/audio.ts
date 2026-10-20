// Optional sound supplied by the embedding host. No engine or game assets are bundled.
// No rendering, server job, or generated audio asset. Destroying it restores the
// original lightweight viewer. The PCM clock owns picture timing while enabled.
import { createSignal } from 'solid-js';
const config = (globalThis as any).__MELEE_AUDIO_CONFIG__;
let Player: any, player: any, blob: Blob | undefined;
let desired = false, index = 0, speed = 1, generation = 0, seeking = false;
let music = true;
export const soundConfigured = !!config;
export const [soundState, setSoundState] = createSignal<'off' | 'loading' | 'on' | 'error'>('off');
export const [soundAvailable, setSoundAvailable] = createSignal(false);
export const [musicEnabled, setMusicEnabled] = createSignal(true);
// Load the controller ahead of the click, but create no worker or AudioContext.
if (config) void import(/* @vite-ignore */ config.module).then(m => { Player = m.ReplayPlayer; setSoundAvailable(true); }).catch(error => { console.warn('Experimental audio controller failed', error); setSoundState('error'); });
function fail(p: any) {
  if (p !== player) return;
  void p.destroy(); player = null; seeking = false;
  setSoundState('error');
}
function align() {
  if (!player?.ready) return;
  seeking = true;
  // Latest epoch wins in the worker; old sound is cleared synchronously.
  player.seek(index - 123, { resume: desired });
}
export const sound = {
  load(data?: Blob) { this.disable(); blob = data; },
  disable() {
    generation++; const old = player; player = null; seeking = false;
    if (old) void old.destroy(); setSoundState('off');
  },
  async enable() {
    if (!Player || !blob || !crossOriginIsolated) { setSoundState('error'); return; }
    const id = ++generation;
    const p = player = new Player({ audioOnly: true, assetsUrl: config.assetsUrl, music });
    setSoundState('loading');
    p.addEventListener('error', () => fail(p));
    p.addEventListener('audiointerrupted', () => fail(p));
    p.addEventListener('position', ({ detail }: any) => {
      if (p !== player || detail.videoEpoch !== p._videoEpoch) return;
      if (!detail.seeking) { seeking = false; }
    });
    try {
      // Called directly from the sound button, before the first await.
      const unlock = p.enableAudio();
      await Promise.all([unlock, p.open(blob)]);
      if (id !== generation || player !== p) return;
      p.setSpeed(speed); setSoundState('on'); align();
    } catch (error) { console.warn('Experimental audio startup failed', error); fail(p); }
  },
  transport(playing: boolean, frame: number, rate: number) {
    index = frame;
    const changed = desired !== playing || speed !== rate;
    desired = playing; speed = rate;
    if (changed && player?.ready) {
      if (player.speed !== rate) player.setSpeed(rate);
      align();
    }
  },
  seek(frame: number) { index = frame; if (player?.ready) align(); },
  frame(): number | null | undefined {
    if (!player) return undefined; // Original clock when sound is off.
    if (!player.ready || seeking) return null; // Hold while sound catches up.
    const frame = player.audioFrame;
    return frame == null ? null : Math.floor(frame + 123);
  },
  music(on: boolean) { music = on; setMusicEnabled(on); player?.setMusic(on); },

};
window.addEventListener('pagehide', () => sound.disable());
