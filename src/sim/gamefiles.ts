/* Which of the game's files the simulator reads, and reading them (in the
 * worker). The simulator's build writes the exact list beside the module
 * (sim-files.json, BUILD.md "File list"); without it, a picked folder is
 * read the way melee-sim-light's extraction picks its files
 * (tools/data/extract.py: REQUIRED_FILES, and every fighter file).
 */
import type { GameFilesFrom } from "./protocol";

const REQUIRED = [
  "PlCo.dat", "PdPm.dat", "ItCo.dat", "ItCo.usd",
  "EfCoData.dat", "EfFxData.dat", "EfCaData.dat", "EfMsData.dat", "EfFeData.dat", "EfPeData.dat", "EfPrData.dat",
  "EfZdData.dat", "EfLgData.dat", "EfMrData.dat", "EfSsData.dat", "EfIcData.dat", "EfPkData.dat", "EfKbData.dat",
  "EfKbCa.dat", "EfKbDk.dat", "EfKbFe.dat", "EfKbFx.dat", "EfKbGn.dat", "EfKbIc.dat", "EfKbKp.dat", "EfKbLg.dat",
  "EfKbMr.dat", "EfKbMs.dat", "EfKbPk.dat", "EfKbSs.dat", "EfKbZd.dat", "EfDkData.dat", "EfGnData.dat",
  "EfYsData.dat", "EfKpData.dat", "EfMtData.dat", "EfNsData.dat", "EfLkData.dat",
  "GrNLa.dat", "GrNBa.dat", "GrIz.dat", "GrPs.dat", "GrSt.dat", "GrOp.dat",
];
// (the Stadium's transformation files, read when there)
const OPTIONAL = ["GrPs1.dat", "GrPs2.dat", "GrPs3.dat", "GrPs4.dat"];
const FIGHTER_PREFIXES = [
  "PlFx", "PlFc", "PlMs", "PlFe", "PlCa", "PlSk", "PlZd", "PlPr", "PlPe", "PlLg", "PlMr", "PlDr", "PlSs", "PlPp",
  "PlNn", "PlPk", "PlPc", "PlKb", "PlDk", "PlGn", "PlYs", "PlKp", "PlMt", "PlGw", "PlNs", "PlLk", "PlCl",
];

// (the graphics build's display pass loads these too: the HUD archive, the screen flash and refraction files, the name tags' font,
// Pokemon Stadium's English text; main.dol when it is there)
const GX_EXTRA = ["IfAll.usd", "LbBf.dat", "LbRf.dat", "SdIntro.dat", "GrPs.usd"];
const GX_OPTIONAL = ["main.dol", "IfAll.dat", "IfVsCam.dat", "IfVsCam.usd"];

/** the names the graphics build reads: the simulator's, and the display pass's files */
export function gxNames(have: string[]): string[] {
  const set = new Set(have);
  const missing = GX_EXTRA.filter((n) => !set.has(n));
  if (missing.length) throw new Error(`the game's draw path needs ${missing.join(", ")}`);
  return [...profileNames(have), ...GX_EXTRA, ...GX_OPTIONAL.filter((n) => set.has(n))].filter((n, i, a) => a.indexOf(n) === i);
}

/** the names to read from a folder's file names, the extraction's way; throws naming what is missing */
export function profileNames(have: string[]): string[] {
  const set = new Set(have);
  const missing = REQUIRED.filter((n) => !set.has(n));
  for (const p of FIGHTER_PREFIXES) if (!have.some((n) => n.startsWith(p) && n.endsWith(".dat"))) missing.push(`${p}*.dat`);
  if (missing.length) throw new Error(`the simulator needs ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? "…" : ""}`);
  const fighters = have.filter((n) => n.endsWith(".dat") && FIGHTER_PREFIXES.some((p) => n.startsWith(p)));
  return [...REQUIRED, ...OPTIONAL.filter((n) => set.has(n)), ...fighters];
}

/** the names the simulator reads: its build's list, else the extraction's way */
export async function namesToRead(from: GameFilesFrom, list: string | null): Promise<string[]> {
  if (list) {
    const r = await fetch(list);
    if (r.ok) {
      const names = await r.json();
      if (Array.isArray(names) && names.every((n) => typeof n === "string")) return names;
    }
  }
  if (from.kind === "files") return profileNames(from.list.map((f) => f.name));
  throw new Error("the simulator's file list (sim-files.json) could not be read");
}

/** the files' bytes, by name; throws naming the first one missing */
export async function readGameFiles(from: GameFilesFrom, names: string[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const byName = from.kind === "files" ? new Map(from.list.map((f) => [f.name, f])) : null;
  const one = async (name: string) => {
    if (byName) {
      const f = byName.get(name);
      if (!f) throw new Error(`${name}: not in the game files folder`);
      out.set(name, new Uint8Array(await f.arrayBuffer()));
      return;
    }
    const base = new URL((from as { base: string }).base.replace(/\/?$/, "/"));
    const r = await fetch(new URL(encodeURIComponent(name), base));
    if (!r.ok) throw new Error(`${name}: ${r.status === 404 ? "not in the game files folder" : "HTTP " + r.status}`);
    out.set(name, new Uint8Array(await r.arrayBuffer()));
  };
  // (a few at a time)
  for (let i = 0; i < names.length; i += 8) await Promise.all(names.slice(i, i + 8).map(one));
  return out;
}
