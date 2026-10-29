// The GX player with sound (src/audio.ts and render3d/gxpath/playback.ts): a stub host player with a fake PCM clock, and a fake match.
// While sound is on the picture shows the frame being heard and never one past it; a seek holds it until the sound has caught up; pause,
// play and speed go to the sound as they are; the switch to Playback Original reaches the sound (setPlayback, and the next start's
// option); an error turns sound off and play goes on with the page's own clock.
//
//   deno test --no-check --sloppy-imports tests/

import test from "node:test";
import assert from "node:assert/strict";

// a host player whose sound is a clock: audioFrame moves at 60 game frames a second times the speed while it plays, from where its last
// seek put it once that seek is acknowledged (when the test says)
const stubPlayer = `export class ReplayPlayer extends EventTarget {
  constructor(options) {
    super();
    this.options = options;
    this.speed = 1;
    this.ready = false;
    this._videoEpoch = 0;
    this.seeks = [];
    this.playbacks = [];
    this.playing = false;
    this.at = -123;
    this.since = 0;
    globalThis.__players.push(this);
  }
  get audioFrame() { return this.playing ? this.at + (globalThis.__now - this.since) * 0.06 * this.speed : this.at; }
  async enableAudio() {}
  async open() { this.ready = true; }
  // (the sound of a seek starts when the seek is done: ack)
  seek(frame, options) { this._videoEpoch++; this.seeks.push({ frame, ...options }); this.at = frame; this.playing = false; this.resume = options.resume; }
  async play() { this.at = this.audioFrame; this.since = globalThis.__now; this.playing = true; this.plays = (this.plays ?? 0) + 1; }
  pause() { this.at = this.audioFrame; this.playing = false; this.pauses = (this.pauses ?? 0) + 1; }
  setSpeed(s) { this.at = this.audioFrame; this.since = globalThis.__now; this.speed = s; }
  setMusic(m) { this.music = m; }
  setPlayback(mode) { this.playbacks.push(mode); }
  destroy() { this.destroyed = true; this.ready = false; }
  ack() { this.since = globalThis.__now; this.playing = this.resume; this.dispatchEvent(new CustomEvent("position", { detail: { videoEpoch: this._videoEpoch, seeking: false } })); }
}`;

// a match of 6000 rows: every step draws a row (shown) and counts it
function fakeSession() {
  return {
    index: 0, shown: -1, frameCount: 6000, wantsRetry: false, drawn: 0, onPicture: null,
    step(draw) { if (this.index >= this.frameCount) return false; this.index++; this.shown = this.index - 1; if (draw) this.drawn++; return true; },
    seekStep(row) { while (this.index <= row) this.step(this.index > row - 2); return true; },
    needsRestart(row) { return row < this.index - 1; },
    async start() { this.index = 0; this.shown = -1; },
  };
}

test("the GX player follows the sound's clock: seek, pause, speed, Playback Original and an error", async () => {
  const hadWindow = "window" in globalThis;
  if (!hadWindow) globalThis.window = new EventTarget();
  globalThis.crossOriginIsolated = true;
  globalThis.__players = [];
  globalThis.__now = 0;
  globalThis.__MELEE_AUDIO_CONFIG__ = { module: "data:text/javascript," + encodeURIComponent(stubPlayer), assetsUrl: "/test-assets" };
  try {
    const { sound, soundAvailable, soundState } = await import("../src/audio.ts");
    const { GxPlayback } = await import("../src/render3d/gxpath/playback.ts");
    for (let i = 0; i < 20 && !soundAvailable(); i++) await new Promise((r) => setTimeout(r, 0));
    assert(soundAvailable());

    const s = fakeSession();
    const pb = new GxPlayback(s, { onPicture() {}, onState() {}, onError(e) { throw e; } }, () => globalThis.__now);
    pb.follow = () => sound.frame();
    const tick = (ms) => { globalThis.__now += ms; pb.tick(); };
    // (the page's own wiring, as gxpage.ts: every seek to the sound, the transport each state change)
    const transport = () => sound.transport(pb.playing, Math.max(0, s.shown), pb.speed);

    // sound on at row 600, playing, Playback Slippi
    sound.load(new Blob(["replay"]));
    sound.playback("slippi");
    const sk = pb.seek(600);
    pb.tick();
    await sk;
    sound.seek(600);
    pb.play();
    transport();
    await sound.enable();
    const p = globalThis.__players[0];
    assert.equal(soundState(), "on");
    assert.equal(p.options.playback, "slippi");
    assert.deepEqual(p.seeks.at(-1), { frame: 600 - 123, resume: true });

    // the picture holds until the seek is acknowledged
    tick(100);
    assert.equal(s.shown, 600);
    p.ack();
    // one second of sound: 60 rows, every one drawn, the picture on the row heard and never past it
    const drawn = s.drawn;
    for (let i = 0; i < 60; i++) {
      tick(1000 / 60);
      assert(s.shown <= Math.floor(p.audioFrame) + 123, `row ${s.shown} past the sound's ${p.audioFrame + 123}`);
    }
    assert.equal(s.shown, Math.floor(p.audioFrame) + 123);
    assert(s.shown >= 600 + 59 && s.shown <= 600 + 61, `${s.shown}`);
    assert.equal(s.drawn - drawn, s.shown - 600);

    // a seek: the sound starts again there, the picture holds until it has caught up, then follows
    const seeks = p.seeks.length;
    pb.seek(3000);
    sound.seek(3000);
    tick(16);
    assert.equal(p.seeks.length, seeks + 1);
    assert.equal(p.seeks.at(-1).frame, 3000 - 123);
    tick(16);
    const held = s.shown;
    tick(100);
    assert.equal(s.shown, held);
    p.ack();
    tick(500);
    assert.equal(s.shown, Math.floor(p.audioFrame) + 123);
    assert(s.shown > 3000);

    // pause: to the sound as it is (no seek); the sound's clock stops and so does the picture
    const seeksBeforePause = p.seeks.length;
    pb.pause();
    transport();
    assert.equal(p.pauses, 1);
    assert.equal(p.seeks.length, seeksBeforePause);
    const paused = s.shown;
    tick(1000);
    assert.equal(s.shown, paused);

    // play at double speed: setSpeed and play, still no seek; the sound and the picture go twice as fast
    pb.setSpeed(2);
    pb.play();
    transport();
    assert.equal(p.speed, 2);
    assert.equal(p.plays, 1);
    assert.equal(p.seeks.length, seeksBeforePause);
    const before = s.shown;
    for (let i = 0; i < 30; i++) tick(1000 / 60);
    assert(Math.abs(s.shown - before - 60) <= 2, `${s.shown - before} rows in half a second at 2x`);

    // the switch to Playback Original: told to the sound, which starts again at the frame shown
    const seeksBeforeMode = p.seeks.length;
    sound.playback("original", s.shown);
    assert.deepEqual(p.playbacks, ["original"]);
    assert.equal(p.seeks.length, seeksBeforeMode + 1);
    assert.equal(p.seeks.at(-1).frame, s.shown - 123);
    p.ack();

    // an error: sound off, and play goes on with the page's own clock
    p.dispatchEvent(new Event("error"));
    assert.equal(soundState(), "error");
    assert(p.destroyed);
    assert.equal(sound.frame(), undefined);
    pb.setSpeed(1);
    const at = s.shown;
    for (let i = 0; i < 30; i++) tick(1000 / 60);
    assert(s.shown - at >= 28, `the page's own clock did not go on: ${s.shown - at} rows`);

    // sound on again: the new player opens in Playback Original
    await sound.enable();
    assert.equal(globalThis.__players[1].options.playback, "original");
    sound.disable();
    assert(globalThis.__players[1].destroyed);
  } finally {
    delete globalThis.__MELEE_AUDIO_CONFIG__;
    delete globalThis.__players;
    delete globalThis.__now;
    delete globalThis.crossOriginIsolated;
    if (!hadWindow) delete globalThis.window;
  }
});
