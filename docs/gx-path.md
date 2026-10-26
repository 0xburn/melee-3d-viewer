# The game's own draw path (gx.html)

An option next to the default player. The simulator (melee-sim-light, built with its graphics layer for WebAssembly) plays the replay and
runs the game's own display pass each frame; what it hands back is the command stream the game sends to the GameCube's graphics processor
(the write-gather FIFO: BP, CP and XF register loads, draws with their vertex data) and the memory those commands read. The GX renderer
(`src/render3d/gxr/`) draws that stream. The default player is unchanged; this one is opened with `gx.html`, or `embed.html?renderer=gx`.

## Files

- `src/render3d/gxpath/tapebridge.ts`: the viewer's tape (`src/sim/tape.ts`) as the graphics build's replay driver takes it.
- `src/render3d/gxpath/core.ts`: the module's per-frame API (`msl_gxw_*`) as a class.
- `src/render3d/gxpath/session.ts`: one match: step a frame, hand its stream and new memory to the renderer, seek (restart and play forward),
  and the divergence check against the replay (`src/sim/compare.ts`).
- `src/render3d/gxpath/playback.ts`: play, pause, speed, frame step, seek.
- `gx.html`, `src/gxpage.ts`: the page.

## What the page needs

- The module `gx-core.js` and `gx-core.wasm` (the simulator's `tools/build/build_wasm_gx.sh` with no `DATA`, so no game data is packaged; the build
  also writes them next to nothing else the page needs). Default location `gx/gx-core.js` beside the page, or `?core=<url>`.
- Your game files, the way the default player gets them: `?files=<folder url>` (with `sim-files.json` beside the module, or the extraction's list) or
  the files handed over with `{type: "gameFiles", files}`. They are written into the module's file system and removed again when the match is open.
- WebGL 2 for the GL backend (`?backend=gl`, the default); `?backend=cpu` is the slow reference renderer.

## Parameters and messages

`replayUrl`, `frame` (game frame, -123 first), `files`, `core`, `backend`, `speed`, `paused=1`. In: `load`, `seek` (game frame), `play`, `pause`,
`toggle`, `gameFiles`, `speed`. Out: `loaded`, `frame`, `renderer`. The picture is the game's 640 x 480 copy to the screen, shown at 73:60.

## Camera

The game's own camera is in the stream; there is no other. Zoom and the viewer's own camera helpers do not apply.

## Limits today

- Pokemon Stadium with its transformations on is not played (the tape reader refuses it, as for the simulator feed).
- A replay the simulator's game parts from is flagged on the page (`diverged`), with the lane; the drive choices of `src/sim/drive.ts` are not retried here.
- Seeking behind the match starts it again; seeking ahead plays through the frames in between without drawing them.
