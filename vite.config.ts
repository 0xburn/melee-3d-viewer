import { defineConfig, type Plugin } from "vite";
import solidPlugin from "vite-plugin-solid";
import wasmPlugin from "vite-plugin-wasm";
import viteTsconfigPaths from "vite-tsconfig-paths";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// The minifier drops the libraries' license comments, so their notices are
// written out next to the build instead: Slippi Lab's own LICENSE (this
// repository's), and the license of every npm package that ended up in the bundle.
function licenses(): Plugin {
  const packageOf = (id: string) => {
    const m = id.replace(/\\/g, "/").match(/.*node_modules\/((?:@[^/]+\/)?[^/]+)/);
    if (!m) return null;
    // plugin ids carry prefixes ("\0commonjs-...:"); fall back to the top level
    let dir = m[0].replace(/^.*?(?=[A-Za-z]:\/|\/)/, "");
    if (!existsSync(join(dir, "package.json"))) dir = join(here, "node_modules", m[1]);
    return { name: m[1], dir };
  };
  return {
    name: "third-party-licenses",
    apply: "build",
    generateBundle(_, bundle) {
      const used = new Map<string, string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const id of Object.keys(chunk.modules)) {
          const p = packageOf(id);
          if (p && !used.has(p.name)) used.set(p.name, p.dir);
        }
      }
      // a package pulled in by a stylesheet's @import (the icon fonts) is
      // inlined by postcss and never shows up as a module above
      for (const f of readdirSync(join(here, "src")).filter((f) => f.endsWith(".css"))) {
        const css = readFileSync(join(here, "src", f), "utf8");
        for (const m of css.matchAll(/@import\s+["']((?:@[^/"']+\/)?[^/"'.~][^/"']*)/g)) {
          if (!used.has(m[1])) used.set(m[1], join(here, "node_modules", m[1]));
        }
      }
      const parts = [
        "Third-party notices for the replay viewer: the npm packages below are",
        "bundled into assets/*.js. The viewer's own license is LICENSE.txt.",
        "",
      ];
      for (const [name, dir] of [...used].sort()) {
        let meta: { version?: string; license?: string } = {};
        try {
          meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        } catch { /* no package.json: still listed */ }
        const file = existsSync(dir)
          ? readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f))
          : undefined;
        parts.push("=".repeat(72));
        parts.push(`${name} ${meta.version ?? ""} - ${meta.license ?? "license not stated"}`);
        parts.push("");
        parts.push(file ? readFileSync(join(dir, file), "utf8").trim()
          : `(the package ships no license file; its package.json says: ${meta.license ?? "nothing"})`);
        parts.push("");
      }
      this.emitFile({ type: "asset", fileName: "THIRD_PARTY_LICENSES.txt", source: parts.join("\n") });
      this.emitFile({ type: "asset", fileName: "LICENSE.txt", source: readFileSync(join(here, "LICENSE"), "utf8") });
    },
  };
}

// Your game files (see README.md) are served from ./game at /game/ by the dev
// and preview servers only. They are never copied into a build.
function gameFolder(): Plugin {
  const dir: string = (globalThis as any).process?.env?.GAME_FILES_DIR ?? join(here, "game");
  const serve = (req: { url?: string }, res: any, next: () => void) => {
    const m = /^\/game\/([A-Za-z0-9_.-]+)(?:\?.*)?$/.exec(req.url ?? "");
    if (!m) return next();
    const p = join(dir, basename(m[1]));
    if (!existsSync(p) || !statSync(p).isFile()) { res.statusCode = 404; res.end("not found"); return; }
    const st = statSync(p);
    res.setHeader("Content-Type", "application/octet-stream");
    // (a size and a version stamp, so the viewer can tell a changed file without reading it: files.ts identity)
    res.setHeader("Content-Length", String(st.size));
    res.setHeader("Last-Modified", st.mtime.toUTCString());
    res.setHeader("ETag", `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`);
    if ((req as { method?: string }).method === "HEAD") { res.end(); return; }
    createReadStream(p).pipe(res);
  };
  return {
    name: "game-folder",
    configureServer(server) { server.middlewares.use(serve); },
    configurePreviewServer(server) { server.middlewares.use(serve); },
  };
}

export default defineConfig({
  assetsInclude: [/.*zip$/, /.*ttf$/],
  plugins: [solidPlugin(), wasmPlugin(), viteTsconfigPaths(), licenses(), gameFolder()],
  resolve: { conditions: ["browser"] },
  // relative, so a build works from any folder
  base: "./",
  server: { host: "127.0.0.1", port: 5173 },
  // (the simulator's worker imports the simulator's module: src/sim/sim.worker.ts)
  worker: { format: "es" },
  build: {
    target: "esnext",
    rollupOptions: { input: { embed: "embed.html", dev: "dev.html" } },
  },
});
