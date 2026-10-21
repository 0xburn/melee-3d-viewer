# melee-3d-viewer

A browser replay viewer for Super Smash Bros. Melee `.slp` replays (Slippi)
that draws the game with its own models, animations, stages, effects and HUD,
read at runtime from your own copy of the game. It is a fork of
[Slippi Lab](https://github.com/frankborden/slippilab)'s replay viewer: Slippi
Lab's line-art (SVG) viewer is still here as the "Simple" view, and the 3D
renderer is in `src/render3d/`.

Optionally it reads a viewer track: a list of events written by the
[melee-sim-light](https://github.com/kyhavlov/melee-sim-light) simulator as it
replays the game (color animations, stored charges, stage animations, item
turns, the game's animation frames). A replay does not record these; with a
track the viewer draws them as the game did, and without one it works them
out from the replay.

No game data is in this repository, and none is fetched from anywhere. Code
is written with Claude Code.

## Build and run

The repository uses [Deno](https://deno.com) to install and run Vite (npm
works too: `npm install`, then `npm run dev` / `npm run build`).

```
deno install --allow-scripts
deno run -A node_modules/vite/bin/vite.js            # dev server, http://127.0.0.1:5173/dev.html
deno run -A node_modules/vite/bin/vite.js build      # static build into dist/
deno test --no-check --sloppy-imports tests/         # tests
```

A few tests read your game files (see below). They run when `MELEE_ASSETS`
names that folder and may be read, and are skipped otherwise:

```
MELEE_ASSETS=<folder> deno test --no-check --sloppy-imports --allow-env --allow-read tests/
deno run --sloppy-imports --allow-read scripts/check-effect-assets.ts <folder>   # every effect's model or generator is in your files
```

`dist/` has `embed.html` (the player), `dev.html` (the dev page),
`LICENSE.txt` and `THIRD_PARTY_LICENSES.txt` (the bundled npm packages'
notices). The build uses relative paths, so it can be served from any folder.

## Your game files

The renderer needs files from your own Melee disc (NTSC 1.02, GALE01 rev 2).
Extract the disc's file system with any GameCube disc tool (for example
Dolphin: right-click the game, Properties, Filesystem, "Extract Entire Disc")
and give the viewer one flat folder holding:

- the disc's `.dat` and `.usd` files as they are named on the disc:
  `PlCo.dat`, `PlXx.dat` / `PlXxNr.dat` (and the other costume files) /
  `PlXxAJ.dat` for each character, `GrXx.dat` for each stage (Pokemon Stadium:
  `GrPs.dat`, `GrPs.usd` and its four transformation files), `EfCoData.dat`
  and the other `Ef*.dat` effect files, `ItCo.dat`, `IfAll.usd` (or
  `IfAll.dat`);
- the game's executable as `Start.dol` or `main.dol` (Dolphin puts it in
  `sys/main.dol`). The viewer reads two things from it at runtime
  (`src/render3d/dol.ts`): the action table (which animation each action
  state plays) and the text font Pokemon Stadium's screen uses.

Copying the whole extracted `files/` folder plus `main.dol` is simplest; the
viewer only reads the files it needs, by name.

How the viewer gets them (`src/render3d/files.ts`):

- the dev and preview servers serve a `game/` folder in the repository root at
  `/game/` (it is in `.gitignore`; `GAME_FILES_DIR=<folder>` points them
  elsewhere). `embed.html` reads from `game/` beside it by default, or from
  the folder URL given as `?files=<url>`;
- or pick the folder on the dev page ("Game files folder"): the files are
  handed to the player as `File` objects and never leave the browser.

The files are held in memory only. If they are missing the 3D view says which
file it could not read.

### The Simple (line-art) view

Slippi Lab's line-art view draws characters from animation zips
(`public/zips/<character>.zip`) that are not included here, since they are
derived from the game's animation data. Slippi Lab's repository has them in
its `public/zips/` folder; copy them to `public/zips/` (in `.gitignore`) if
you want the Simple view. The 3D views do not need them.

## Viewer tracks from the simulator

A track is made with the `viewer-track` branch of the melee-sim-light fork at
<https://github.com/briandle00/melee-sim-light/tree/viewer-track>. With the
simulator built (see that repository's README) and your game files in place,
from its checkout:

```
python -m tools.replay.replay_drive --viewer-track <replay.slp> <track.json>
```

This calls `export_viewer_track(path, out_json)` in
`tools/replay/replay_drive.py`. It replays the game through the simulator,
which writes its events to the file named by the `MSL_VIEWER_TRACK`
environment variable (the function sets it to a temporary file and collects
it). The result is JSON:

```
{"version": ..., "sim_build": ..., "exact": true|false, "diverged_at": <frame>|null,
 "events": [[frame, type, ...values], ...], ...}
```

Frames are numbered as the game numbers them (-123 is the first). When the
simulator does not reproduce the replay exactly, `diverged_at` is the first
frame that differs and the viewer uses the track only before it.

Load the replay and its track on the dev page, or pass `trackUrl` to the
embed page (below).

## Viewer tracks in the browser

The viewer can also make the track itself: melee-sim-light built as
WebAssembly plays the replay in a Web Worker while the viewer plays it
(`src/sim/`). This is optional and off unless the page asks for it, and a
track the page gives (`trackUrl`) always comes first.

- The replay plays at once without a track. When the simulator is 5 seconds
  ahead of the frame shown, the viewer takes its track; later it takes a
  longer one when the frame shown gets near the end of the one it has.
- Going back is free. A jump past where the simulator has got shows those
  frames without a track until it catches up.
- Each frame the simulator plays is checked against the replay. Where its
  game parts from the replay, the track stops there, as with a `diverged_at`
  track. It then plays the replay again with the next likely settings (UCF
  version, arithmetic), at most three times, and keeps the track that goes
  furthest.
- It reads the same game files as the renderer (the folder, or the files
  picked), in the worker. Nothing leaves the browser.
- Replays it does not play (other stages, items, PAL, Pokemon Stadium with its
  transformations on, Slippi before 3.0) play as before, without a track.

Turning it on: `?sim=1` on the embed page, a `{type: "sim", on: true}`
message, or "Simulate Track" on the dev page. The page is told how it stands
with `{type: "sim", state, until, last, rate, firstFrameMs, firstTrackMs, reason}`.

The simulator's build is not in this repository. Put it in a `sim/` folder
beside the page (in `.gitignore`), or say where it is before the embed entry
script loads:

```html
<script>
  globalThis.__MELEE_SIM_CONFIG__ = {
    module: "/sim/melee-sim.mjs",   // default: sim/melee-sim.mjs beside the page
    wasm: "/sim/melee-sim.wasm",    // default: beside the module
    files: "/sim/sim-files.json",   // the game files it reads; default: beside the module
    auto: false,                    // true: for every replay loaded without a track
  };
</script>
```

To build it, with [Emscripten](https://emscripten.org) 6.0.9 active
(`emcc` on `PATH`), from a checkout of the fork's viewer-track branches:

```
make -f Makefile -f <this repository>/scripts/sim/wasm-viewer.mk wasm-viewer \
  MSL_VISUAL_TRACK_BUILD=1 MSL_REPLAY_ARITHMETIC=1 -j8
cp build/melee_core/wasm/viewer/melee-sim.mjs build/melee_core/wasm/viewer/melee-sim.wasm <this repository>/sim/
```

`scripts/sim/wasm-viewer.mk` compiles the same objects as the simulator's own
`make wasm` and links them for the viewer: it exports the viewer API
(`msl_viewer_create`, `_step`, `_track`, `_output`, `_destroy`), packages no
game data, and has a file system the worker writes your files into.
`sim-files.json` (the game files it reads, a JSON list of names) goes beside
them; without it, a picked folder is read the simulator's extraction way and
a folder URL cannot be used.

`deno test --no-check --sloppy-imports tests/` checks the replay reading,
the drives and the hand-overs against a fake module (`tests/sim.test.ts`).

## The item animation table

An item's state number is not the index of the animation it plays: each item
kind has a table of its states in the game's code, and each entry names the
state's animation (or none: the item keeps the pose it had).
`src/render3d/item-animations.generated.ts` has that number for every state of
every item kind. It is made from the [Melee decompilation](https://github.com/doldecomp/melee)'s
item state tables (`src/melee/it/kinds/*.c`), not from the game's files, by
`scripts/generate-item-animations.py`:

```
git clone https://github.com/doldecomp/melee vendor/melee-native
python scripts/generate-item-animations.py            # writes the table
python scripts/generate-item-animations.py --check    # compares it with the repository's
```

`--native-root <folder>` reads a checkout somewhere else (`vendor/` is in
`.gitignore`). The table in the repository was made from doldecomp/melee
1f0499b.

## Embedding

`embed.html` is meant to sit in an iframe. URL parameters: `replayUrl`,
`name`, `frame`, `trackUrl`, `files`, `renderer` (`3d` or `svg`), `zoom`,
`look=480`, `crt` (`off`, `trinitron`, `pvm`), `controllers` (`both`, `left`,
`right`, `you`, `opponent`, `off`), `you` (port 1-4), `hudslots` (`outer`:
a two-player game's HUDs in slots 1 and 4 whatever the ports, the default;
`game`: each in their port's slot, as in the game), `mini=1`.

It is driven by `postMessage`: `load` (`url`, `name`, `frame`, `trackUrl`),
`gameFiles` (`files`: `File[]`), `seek`, `play`, `pause`, `toggle`, `range`,
`ghosts` (other replays drawn over this one, see-through), `renderer`, `view`
(`simple`, `3d`, `console`), `look`, `crt`, `controllers`, `hudslots`. It
posts `frame`, `loaded`, `renderer`, `track`, `warming`, `viewKey` and
`fullKey` (F, W or Esc pressed on the player: the page may make it Full
Screen or Full Window, as the dev page does; the 3D view draws at the size it
is given) back to the parent. The full list, with fields, is at the top of
`src/embed.tsx`.

### A page of your own around the renderer

A site that builds its own page with `src/render3d/` (its own `embed.tsx`, its
own server) sets these from `src/render3d/files.ts` before the player reads
anything, and leaves the renderer's files as they are:

- `setFileSource(source)`: where the game files come from. A source is a
  function from a file's name on the disc (`PlFxNr.dat`, `Start.dol`) to its
  bytes; `folderUrlSource(url)` and `fileListSource(files)` are the two kinds
  here. A source set before anything was read drops nothing, so several
  players on one page keep sharing what they read. A source may also have an
  `identity(name)`: a string that changes when that file does (a size and an
  ETag or modification time; `folderUrlSource` asks with a HEAD request, a
  picked folder uses the File's size and time), or null. With it the browser
  keeps the action table made from the executable (IndexedDB), so a later open
  does not read the 4 MB file again; without one, nothing is kept.
- `prefetchReplay(bytes)`: call it with the first 2 KB of a replay as soon as
  they are in, before the replay is read, to start fetching the stage's and
  fighters' files at once (the public `embed.tsx` does). `precompilePrograms()`
  (`renderer.ts`) compiles the shaders at page start the same way.
- `?timing=1` on the page records start-up marks and spans in `window.__startup`
  (`startup.ts`); off, nothing is kept.
- `setTrackUrl(replayUrl, trackUrl)`: the viewer track for a replay. The URL
  may answer with the track (JSON or the compact form, `trackcodec.ts`) or,
  while a server is still making it, with `{"state": "pending"}` (asked again
  every few seconds) or `{"state": "none", "reason": ...}`.
- `setWarmingHandler(fn)`: what is done every 2 s while a player that can be
  seen warms up, instead of the `warming` message.
- `status()` checks the files; a host with its own settings may answer the
  page's "3D or not" itself instead.

## Optional browser audio

The viewer makes no sound by itself. A page that embeds it can supply a
sound-only replay player; the viewer then shows a sound button, and while
sound is on the picture follows the sound's PCM playback clock. Without that
configuration nothing changes: no button, no extra simulation work, the
viewer's own clock. This repository has no audio engine, simulator, AudioWorklet
or game sound assets for it; the host page supplies the player and its assets.
This is a draft of the viewer's side (`src/audio.ts`).

The host sets its configuration before the embed entry script loads:

```html
<script>
  globalThis.__MELEE_AUDIO_CONFIG__ = {
    module: "/audio/player.mjs",
    assetsUrl: "/audio/assets/index.bin",
  };
</script>
```

The module exports `ReplayPlayer`:

- `new ReplayPlayer({ audioOnly: true, assetsUrl, music })`: sound only. It
  does no rendering and starts no renderer workers (hiding a second canvas is
  not enough).
- `enableAudio()` unlocks the audio context synchronously, inside the user's
  click, and returns a promise for when it is ready. `open(blob)` loads the
  same replay and resolves once `ready` is true. The two may run at the same
  time.
- `seek(gameFrame, { resume })` clears the old sound at once, increments
  `_videoEpoch` and cancels older seeks. `position` events carry
  `{ videoEpoch, seeking }` in `CustomEvent.detail`; a seek is done when one
  reports the current epoch. `_videoEpoch` is provisional: it is the existing
  player's private field, and a public seek acknowledgement should replace it
  before this contract is final.
- `audioFrame`: the fractional game frame at the audio device's current PCM
  playback time, or `null` until known. It must not run ahead of the
  simulation. Game frames start at -123; the viewer's frame indexes start at 0.
- `play()` (a promise) and `pause()`: go on or stop where the sound is,
  without a seek. A pause, a play or a change of speed is sent this way: a
  seek would make a backend that simulates the game rewind it.
- `speed`, `setSpeed(rate)`, `setMusic(on)`: playback speed and music.
  `destroy()` stops its workers and closes its audio context.
- `error` and `audiointerrupted` events turn sound off; the viewer keeps
  playing without it.
- `stage-frames` events (optional) carry Fountain of Dreams' platform heights
  for replays from before Slippi 3.18, which do not record them:
  `CustomEvent.detail.frames` is a list of `[gameFrame, left, right]`, the
  platforms' joint translations before the stage's scale. What a replay records
  comes first; the heights are forgotten when another replay is loaded. Without
  them the platforms keep their starting height (`src/simulation-stage.ts`).

The Lucky Stats host implements this feed, and bounded audio-only Wasm seek
checkpoints in its separate native audio backend. Neither that engine nor the
backend is bundled here.

A shared-memory Wasm backend needs the top-level page and the embedded
document served with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. Asset hosts must allow the
site's origin, and the module and worklet files must be reachable by the
browser. No server-side audio generation is needed.

While sound is on, a seek shows its frame at once and the picture holds until
the sound has caught up; the acknowledgement of an older seek is ignored.
A pause, a play or a change of speed goes to the host player as it is; a seek
under way is sent again with the new playing state. Music
is turned on and off separately. Turning sound off, or loading another replay,
destroys the host's player. The extra simulation still costs CPU and memory,
and can make backward seeks slower. A backend must report its simulation
failures rather than keep playing incorrect sound.

`deno test --no-check --sloppy-imports tests/` checks `src/audio.ts` against a fake player:
transport, rapid seeks, music, teardown, and turning sound off while it
starts. It does not cover browsers or devices, and supplies no engine. The
integration was also exercised in a host page with a Wasm simulator in the
browser and an AudioWorklet; that host's admin controls, telemetry and private
asset routes are not included here.

## Credits

- [Slippi Lab](https://github.com/frankborden/slippilab) by Frank Borden (MIT):
  the replay viewer this is forked from, its parser, line-art viewer and
  controls. Slippi Lab itself thanks:
  [Project Slippi](https://github.com/project-slippi) (Fizzi and the Project
  Slippi team), [slippi-visualiser](https://github.com/schmooblidon/slippi-visualiser)
  by schmooblidon, [react-slp-viewer](https://github.com/vinceau/react-slp-viewer)
  by vinceau, and [HSDraw/HSDLib](https://github.com/Ploaj/HSDlib) by Ploaj.
- Lucky Stats by petey (0xburn): the fighters' native effect callbacks, Fox
  and Falco's up-B fire, item animations and effect lifetimes, and the
  projectile joint fixes were ported from its viewer.
- [melee-sim-light](https://github.com/kyhavlov/melee-sim-light) by kyhavlov:
  the simulator that writes viewer tracks, and that the viewer can run in the
  browser as WebAssembly (`src/sim/`). `src/sim/tape.ts` follows its replay
  validator's input reading.
- [Emscripten](https://emscripten.org) (MIT / University of Illinois NCSA):
  builds the simulator for the browser; its runtime is part of that build.
- The [Melee decompilation](https://github.com/doldecomp/melee)
  (doldecomp/melee contributors): the game's code, which the renderer's
  behavior is written from (function names in the comments are its names).
- [noclip.website](https://github.com/magcius/noclip.website) by Jasper St.
  Pierre (magcius) (MIT): its SYSDOLPHIN loader was a reference for
  `src/render3d/hsd.ts`, and its keyframe decoding is adapted there. Its
  notice is `src/render3d/LICENSE-noclip.txt`.
- [M'Overlay](https://github.com/bkacjios/m-overlay) by Bkacjios (MIT): its
  default GameCube controller skin, traced to vector outlines, is the
  controller overlay (`src/assets/controllers/m-overlay/`, with its license
  and `SOURCE.txt`).
- The CRT look of the Console view follows techniques from crt-geom (cgwg),
  crt-royale (TroggleMonkey) and Timothy Lottes' CRT shader; none of their code
  is used.
- Icons in `src/components/common/icons.tsx` are from Bootstrap Icons,
  Heroicons and Phosphor Icons, as in Slippi Lab; the Material Icons fonts come
  from npm (`@fontsource/material-icons`).

## License

MIT, see `LICENSE`. Third-party notices: `src/render3d/LICENSE-noclip.txt`,
`src/assets/controllers/m-overlay/LICENSE`, and `THIRD_PARTY_LICENSES.txt` in
a build. Melee and its assets belong to Nintendo and HAL Laboratory; none are
included.
