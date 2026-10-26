// Runs a TypeScript entry in headless Chrome (real GPU) and collects what it posts.
//   deno run -A tools/webrun.ts <entry.ts> <out dir> [key=value ...]
// The page gets the key=value pairs as its query string. The page posts files to /save/<name> (the body is written to <out dir>/<name>),
// log lines to /log, and ends with a POST to /done (the body is the exit message; "ok" is success). Static data: /spec/ is the spec's
// harness folder. Chrome is hidden (headless), killed when the run ends, its pid is recorded in pids.txt.
const [entry, outDir, ...kv] = Deno.args;
const CHROME = Deno.env.get("CHROME") ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
// where scratch files go, the folder of the spec harness (recordings, reference pictures) and of the spec vectors, and a file the
// browser's process id is written to
const ROOT = Deno.env.get("GX_OUT") ?? "out";
const SPEC = Deno.env.get("GX_SPEC_HARNESS") ?? "spec/harness";
const VEC = Deno.env.get("GX_SPEC_VECTORS") ?? "spec/vectors";
const PIDS = Deno.env.get("GX_PIDS");
const timeoutMs = Number(kv.find((a) => a.startsWith("timeout="))?.slice(8) ?? 600000);

Deno.mkdirSync(outDir, { recursive: true });
const bundle = `${ROOT}/web/${entry.replace(/[^\w]+/g, "_")}.js`;
Deno.mkdirSync(`${ROOT}/web`, { recursive: true });
const b = await new Deno.Command("deno", { args: ["bundle", "--sloppy-imports", "--no-lock", "-o", bundle, entry], stdout: "piped", stderr: "piped" }).output();
if (!b.success) { console.error(new TextDecoder().decode(b.stderr)); Deno.exit(2); }

const html = `<!doctype html><meta charset="utf-8"><title>run</title><body><script>
const post = (u, b) => fetch(u, { method: "POST", body: b });
window.addEventListener("error", (e) => post("/log", "page error: " + e.message + " at " + e.filename + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => post("/log", "page rejection: " + (e.reason && e.reason.stack || e.reason)));
const _log = console.log, _err = console.error, _warn = console.warn;
console.log = (...a) => { _log(...a); post("/log", a.join(" ")); }; console.error = (...a) => { _err(...a); post("/log", "console.error: " + a.join(" ")); }; console.warn = (...a) => { _warn(...a); post("/log", "console.warn: " + a.join(" ")); };
</script><script type="module" src="/bundle.js"></script></body>`;
let finish!: (m: string) => void;
let go!: () => void;
const goPromise = new Promise<void>((r) => (go = r));
const done = new Promise<string>((r) => (finish = r));
const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
  const u = new URL(req.url);
  if (req.method === "GET") {
    if (u.pathname === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    if (u.pathname === "/go") { await goPromise; return new Response("go"); }
    if (u.pathname === "/bundle.js") return new Response(Deno.readFileSync(bundle), { headers: { "content-type": "text/javascript", "cache-control": "no-store" } });
    if (u.pathname.startsWith("/spec/")) {
      try { return new Response(Deno.readFileSync(SPEC + "/" + decodeURIComponent(u.pathname.slice(6))), { headers: { "content-type": "application/octet-stream" } }); } catch { return new Response("no", { status: 404 }); }
    }
    if (u.pathname.startsWith("/vec/")) {
      try { return new Response(Deno.readFileSync(VEC + "/" + decodeURIComponent(u.pathname.slice(5))), { headers: { "content-type": "application/json" } }); } catch { return new Response("no", { status: 404 }); }
    }
    return new Response("no", { status: 404 });
  }
  if (u.pathname.startsWith("/save/")) {
    const p = `${outDir}/${decodeURIComponent(u.pathname.slice(6))}`;
    Deno.mkdirSync(p.replace(/[\\/][^\\/]*$/, ""), { recursive: true });
    Deno.writeFileSync(p, new Uint8Array(await req.arrayBuffer()));
    return new Response("ok");
  }
  if (u.pathname === "/log") { console.log(await req.text()); return new Response("ok"); }
  if (u.pathname === "/done") { finish(await req.text()); return new Response("ok"); }
  return new Response("no", { status: 404 });
});
const port = (server.addr as Deno.NetAddr).port;
const chrome = new Deno.Command(CHROME, {
  args: [...(kv.find((a) => a.startsWith("angle=")) ? ["--use-angle=" + kv.find((a) => a.startsWith("angle="))!.slice(6)] : []), "--headless=new", ...(kv.includes("profile=1") ? ["--remote-debugging-port=9333"] : []), "--enable-unsafe-swiftshader", "--user-data-dir=" + ROOT + "/chrome-profile", "--disable-gpu-sandbox", "--no-first-run", "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding", `http://127.0.0.1:${port}/?${kv.join("&")}`],
  stdout: "null", stderr: "null",
}).spawn();
if (PIDS) Deno.writeTextFileSync(PIDS, `pid ${chrome.pid} (chrome, ${entry})`+String.fromCharCode(10), { append: true });
// profile=1: a CPU profile of the page through the DevTools protocol, saved to <out dir>/profile.cpuprofile
let prof: { stop: () => Promise<void> } | null = null;
if (!kv.includes("profile=1")) go();
if (kv.includes("profile=1")) {
  await new Promise((r) => setTimeout(r, 2500));
  const tabs = await (await fetch("http://127.0.0.1:9333/json")).json();
  const ws = new WebSocket(tabs.find((t: any) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m.result); };
  const send = (method: string, params: any = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Profiler.enable");
  await send("Profiler.setSamplingInterval", { interval: 200 });
  await send("Profiler.start");
  go();
  prof = { stop: async () => { const r = await send("Profiler.stop"); Deno.writeTextFileSync(`${outDir}/profile.cpuprofile`, JSON.stringify(r.profile)); } };
}
const timer = setTimeout(() => finish("timeout"), timeoutMs);
const msg = await done;
clearTimeout(timer);
if (prof) await prof.stop();
try { await new Deno.Command("taskkill", { args: ["/T", "/F", "/PID", String(chrome.pid)], stdout: "null", stderr: "null" }).output(); } catch { /* gone */ }
await server.shutdown();
console.log("page says:", msg);
Deno.exit(msg === "ok" ? 0 : 1);
