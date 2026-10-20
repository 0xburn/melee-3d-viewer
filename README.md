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

## Embedding

`embed.html` is meant to sit in an iframe. URL parameters: `replayUrl`,
`name`, `frame`, `trackUrl`, `files`, `renderer` (`3d` or `svg`), `zoom`,
`look=480`, `crt` (`off`, `trinitron`, `pvm`), `controllers` (`both`, `left`,
`right`, `you`, `opponent`, `off`), `you` (port 1-4), `mini=1`.

It is driven by `postMessage`: `load` (`url`, `name`, `frame`, `trackUrl`),
`gameFiles` (`files`: `File[]`), `seek`, `play`, `pause`, `toggle`, `range`,
`ghosts` (other replays drawn over this one, see-through), `renderer`, `view`
(`simple`, `3d`, `console`), `look`, `crt`, `controllers`. It posts `frame`,
`loaded`, `renderer`, `track`, `warming` and `viewKey` back to the parent. The
full list, with fields, is at the top of `src/embed.tsx`.

## Credits

- [Slippi Lab](https://github.com/frankborden/slippilab) by Frank Borden (MIT):
  the replay viewer this is forked from, its parser, line-art viewer and
  controls. Slippi Lab itself thanks:
  [Project Slippi](https://github.com/project-slippi) (Fizzi and the Project
  Slippi team), [slippi-visualiser](https://github.com/schmooblidon/slippi-visualiser)
  by schmooblidon, [react-slp-viewer](https://github.com/vinceau/react-slp-viewer)
  by vinceau, and [HSDraw/HSDLib](https://github.com/Ploaj/HSDlib) by Ploaj.
- [melee-sim-light](https://github.com/kyhavlov/melee-sim-light) by kyhavlov:
  the simulator that writes viewer tracks.
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

## Optional browser audio (draft integration)

An embedding host can supply a compatible sound-only playback controller. The
viewer does not bundle a simulator, an AudioWorklet, or game sound assets, and
stays silent with no extra simulation work unless the host configures audio and
the user enables it. This draft provides the viewer integration; choosing and
packaging a standalone audio engine remains a host requirement.

Set this trusted host configuration **before** loading the embed entry script:

```html
<script>
  globalThis.__MELEE_AUDIO_CONFIG__ = {
    module: '/audio/player.mjs',
    assetsUrl: '/audio/assets/index.bin'
  };
</script>
```

The module must export `ReplayPlayer`, implementing this adapter contract:

- Constructor accepts `{ audioOnly: true, assetsUrl, music }`. It must skip all
  rendering and renderer workers. Merely hiding a second canvas is insufficient.
- `enableAudio()` unlocks the audio context synchronously from the user's click
  and returns a readiness promise. `open(Blob)` loads the same game data and
  resolves when `ready` is true. These operations may run concurrently.
- `seek(gameFrame, { resume })` immediately clears old audio, increments
  `_videoEpoch`, and cancels older seeks. `position` events carry
  `{ videoEpoch, seeking }` in `CustomEvent.detail`; completion must acknowledge
  the current epoch. This draft uses the existing controller's epoch field;
  a public seek acknowledgement API would be preferable before stabilizing it.
- `audioFrame` returns the fractional game frame at the audio device's current
  PCM playback time (or `null` until anchored). It must not run ahead of the
  simulation. Game frames start at -123; viewer indexes start at zero.
- `setSpeed(rate)`, `setMusic(enabled)`, `speed`, and `destroy()` handle transport,
  music, and full worker/audio-context cleanup. `error` and `audiointerrupted`
  events disable sound while leaving the original visual-only player usable.

Serve the top-level page and embedded document with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` for a shared-memory Wasm backend.
Asset hosts must permit the site's origin. The module and worklet files must be
reachable by the browser; no backend audio-generation job is needed.

With audio enabled, the picture follows the PCM clock. Seeks display their
requested frame immediately, hold playback while sound catches up, and discard
stale seek acknowledgements. Pause/resume and speed changes re-anchor sound at
the visible frame. Music is independent; disabling sound releases the backend.
The additional simulation still costs CPU/memory and can make backward seeks
slower. A backend must surface its simulation failures instead of playing
incorrect sound indefinitely.

`node --test tests/audio.test.mjs` (Node 22+) checks transport with a fake backend,
including rapid seeks and cancellation during startup. `npm run build` builds
both embed and dev entries. These tests do not establish browser/device coverage
or supply a standalone engine. The integration was also exercised in a host
using a browser Wasm simulator and AudioWorklet; that host's admin controls,
telemetry and private asset routes are intentionally absent here.
