/* The simulator's worker: plays one replay through melee-sim-light's Wasm
 * build ahead of the page's playback and sends the viewer track as it goes
 * (protocol.ts). It runs on its own thread, so the page keeps its 60 frames
 * a second; it stops when the page says so or the replay is over.
 *
 * Each drive gets a fresh instance of the module (the compiled code is
 * shared): a match's game data is loaded with the match (msl_viewer_create),
 * and a fresh instance starts from a clean memory and file system.
 */
import { decode } from "@shelacek/ubjson";
import { runDrives } from "./drive";
import { dropGameFiles, SimViewer, writeGameFiles, type SimFactory, type SimModule } from "./engine";
import { namesToRead, readGameFiles } from "./gamefiles";
import type { FromWorker, ToWorker } from "./protocol";
import { readTape, Unsupported } from "./tape";

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);
let stop = false;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === "stop") { stop = true; return; }
  if (m.type === "start") void start(m).catch((err) => post({ type: "error", reason: String(err?.message ?? err) }));
};

async function start(m: Extract<ToWorker, { type: "start" }>) {
  post({ type: "status", state: "loading" });
  const parsed = decode(m.replay, { useTypedArrays: true }) as { raw: Uint8Array; metadata?: { playedOn?: string } };
  let tape;
  try {
    tape = readTape(parsed.raw, parsed.metadata);
  } catch (err) {
    post({ type: "error", reason: err instanceof Unsupported ? `not played by the simulator: ${err.message}` : String(err) });
    return;
  }
  post({ type: "tape", frames: tape.count, firstFrame: tape.firstFrame });
  const [factory, compiled] = await Promise.all([
    import(/* @vite-ignore */ m.module).then((x: { default: SimFactory }) => x.default),
    // (a server that does not say application/wasm: compiled from the bytes)
    WebAssembly.compileStreaming(fetch(m.wasm))
      .catch(async () => WebAssembly.compile(await (await fetch(m.wasm)).arrayBuffer())),
  ]);
  if (stop) return;
  post({ type: "status", state: "reading files" });
  const files = await readGameFiles(m.files, await namesToRead(m.files, m.filesList));
  if (stop) return;
  const instance = (): Promise<SimModule> => factory({
    // (the code compiled once, an instance for each drive)
    instantiateWasm(imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, mod: WebAssembly.Module) => void) {
      void WebAssembly.instantiate(compiled, imports).then((i) => done(i, compiled));
      return {};
    },
    print: () => {},
    printErr: (s: string) => console.debug("simulator:", s),
  });
  await runDrives(tape, {
    async open(t, options) {
      const mod = await instance();
      const names = writeGameFiles(mod, files);
      try {
        return SimViewer.create(mod, t.config(options), t.previous());
      } finally {
        dropGameFiles(mod, names);
      }
    },
    post,
    stopped: () => stop,
    pause: () => new Promise((r) => setTimeout(r, 0)),
    now: () => performance.now(),
  }, m.maxDrives, m.chunkMs);
}
