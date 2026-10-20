/* 3D replay viewer: where the game files come from.
 *
 * The game's own files (the .dat/.usd files on the disc, and its executable,
 * Start.dol or main.dol) are read at runtime from a source the page sets:
 *
 *  - by default, fetched from a folder beside the page: `game/`, or the URL
 *    given as ?files=<url> (a folder you fill with the files from your own
 *    copy of the game: see README.md);
 *  - or files the host page hands over ({type: "gameFiles", files: File[]},
 *    embed.tsx; the dev page's folder picker does this).
 *
 * Nothing from the game is bundled, and nothing is written anywhere: the
 * files are held in memory for as long as the page is open. Every failure is
 * an Error the viewer answers by saying why.
 */
import { type Article, Fighter, loadArticle, MotionTable, fighterFiles, sharedFiles } from "./fighter";
import { parseArchive, ptr } from "./hsd";
import { Stage, STADIUM_FORMS, STAGES } from "./stage";
import { type Lettering, parseSisCommon, parseSisFile, type SisCommon } from "./sistext";
import { EffectKit } from "./effects3d";
import { hatFiles, KirbyCopy, KirbyHat, loadHat } from "./kirby";
import { EFFECT_FILES, effectFilesOf } from "./fx/dispatch";
import { HudKit, stageMagnifierColors } from "./hud";
import { pageCache, sharedPromise, trim } from "../state/pageCache";
import { decodeTrack } from "./trackcodec";
import { motionTableFromDol, textFontFromDol } from "./dol";

export interface Status {
  available: boolean; // the files and the action table are there
  enabled: boolean; // 3D is wanted
  use3d: boolean; // both
  reason: string | null; // why not
  look480?: boolean; // the 480p look is on
  crt?: string; // the TV the Console view is shown on (crt.ts): off, trinitron or pvm
  curve?: number; // and its curve (0: flat)
  controller_overlay?: string; // the Controller overlay: "both", "left", "right", "you" or "off" (Controllers.tsx)
}

/** a game file's bytes by its name on the disc ("PlFxNr.dat") */
export type FileSource = (name: string) => Promise<ArrayBuffer>;

/** files fetched from a folder at this URL (relative to the page) */
export function folderUrlSource(base: string): FileSource {
  const dir = new URL(base.endsWith("/") ? base : base + "/", location.href);
  return async (name) => {
    const r = await fetch(new URL(encodeURIComponent(name), dir), { cache: "no-store" });
    if (!r.ok) throw new Error(`${name}: ${r.status === 404 ? "not in the game files folder" : "HTTP " + r.status}`);
    return r.arrayBuffer();
  };
}

/** files handed over as File objects (a folder picker's), found by their own name */
export function fileListSource(list: File[]): FileSource {
  const byName = new Map<string, File>();
  for (const f of list) byName.set(f.name, f);
  return async (name) => {
    const f = byName.get(name);
    if (!f) throw new Error(`${name}: not in the game files folder`);
    return f.arrayBuffer();
  };
}

// (made when first used: the module can be imported where there is no page, as the tests do)
let source: FileSource | undefined;
const currentSource = () => source ??= folderUrlSource(new URLSearchParams(location.search).get("files") ?? "game/");
// whether anything was read from the source yet (setFileSource)
let sourceUsed = false;
let statusPromise: Promise<Status> | undefined;

/** read the game files from here on (what was read before is dropped). A
 *  source set before anything was read, as a host page does when it starts,
 *  drops nothing: what the page's other players read stays shared */
export function setFileSource(s: FileSource) {
  source = s;
  statusPromise = undefined;
  if (!sourceUsed) return;
  sourceUsed = false;
  files.clear();
  pageCache<Promise<MotionTable>>("motion").clear();
  dol = undefined;
  fighters.clear(); kirbyHats.clear(); kirbyCopies.clear(); stages.clear(); fighterFx.clear();
  commonItemsP = undefined; effectKit = undefined; hudKit = undefined;
}

/** whether this page can draw in 3D: a file every game needs and the
 *  executable's action table can be read; asked once per file source */
export function status(): Promise<Status> {
  statusPromise ??= Promise.all([file("PlCo.dat"), motionTable()])
    .then((): Status => ({ available: true, enabled: true, use3d: true, reason: null }))
    .catch((e): Status => ({ available: false, enabled: true, use3d: false, reason: String(e?.message ?? e) }));
  return statusPromise;
}

// (the page's: every player on it fetches a file once - bytes nobody changes)
const files = pageCache<Promise<ArrayBuffer>>("gameFiles");

export function file(name: string): Promise<ArrayBuffer> {
  sourceUsed = true;
  const p = sharedPromise(files, name, () => {
    const made = currentSource()(name);
    // a failure is not kept, so a folder fixed while the page is open works next time
    made.catch(() => { if (files.get(name) === made) files.delete(name); });
    return made;
  });
  // (the page keeps the last few dozen)
  trim(files, 48);
  return p;
}

let dol: Promise<ArrayBuffer> | undefined;

/** the game's executable: Start.dol, else main.dol (whichever name the
 *  disc extraction gave it) */
function executable(): Promise<ArrayBuffer> {
  dol ??= file("Start.dol").catch(() => file("main.dol"));
  dol.catch(() => { dol = undefined; });
  return dol;
}

// replay URL -> its viewer track's URL (setTrackUrl)
const trackUrls = new Map<string, string>();

/** the viewer track (the JSON file the simulator wrote, or its compact form)
 *  for the replay loaded from `replayUrl`; null: none */
export function setTrackUrl(replayUrl: string, trackUrl: string | null) {
  if (trackUrl) trackUrls.set(replayUrl, trackUrl);
  else trackUrls.delete(replayUrl);
}

/** whether a viewer track was given for this replay */
export function hasTrack(replayUrl: string): boolean {
  return trackUrls.has(replayUrl);
}

/** the viewer track's answer for a replay (track.ts reads it): ready with the
 *  track, none with why, or null when it could not be read */
export async function trackAnswer(replayUrl: string): Promise<unknown | null> {
  const url = trackUrls.get(replayUrl);
  if (!url) return { state: "none", reason: "no viewer track given" };
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    const u = new Uint8Array(buf);
    // (the compact form, trackcodec.ts, is gzipped; the simulator's export is JSON)
    if (u[0] === 0x1f && u[1] === 0x8b) return { state: "ready", track: await decodeTrack(buf) };
    const t = JSON.parse(new TextDecoder().decode(u));
    if (t && Array.isArray(t.events)) return { state: "ready", track: t };
    return t?.state ? t : { state: "none", reason: "not a viewer track" };
  } catch {
    return null;
  }
}

/** the effects table (effect-table.json beside the page, optional); null when it is not there */
export async function effectTable(): Promise<{ table?: Record<string, unknown>; byGfx?: Record<string, unknown> } | null> {
  try {
    const r = await fetch(new URL("effect-table.json", location.href));
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** what a player that can be seen does while it warms up (every 2 s): by
 *  default the page that embeds it is told ({type: "warming"}), in case it
 *  wants to hold other work back for a moment */
let warming = () => {
  if (window.parent !== window) window.parent.postMessage({ type: "warming" }, "*");
};

/** tell the host of a player warming up some other way (a host serving the
 *  page itself may want a request instead of the message) */
export function setWarmingHandler(fn: () => void) {
  warming = fn;
}

/** a player that can be seen is warming up (setWarmingHandler says who is told) */
export function tellWarming() {
  warming();
}

export function motionTable(): Promise<MotionTable> {
  const shared = pageCache<Promise<MotionTable>>("motion");
  return sharedPromise(shared, "table", () => {
    const made = executable().then((b) => motionTableFromDol(b));
    made.catch(() => { if (shared.get("table") === made) shared.delete("table"); });
    return made;
  });
}

const fighters = new Map<string, Promise<Fighter>>();

/** one fighter in one costume, loaded once per page */
export function fighter(internalId: number, costume: number): Promise<Fighter> {
  const key = `${internalId}:${costume}`;
  let p = fighters.get(key);
  if (!p) {
    const names = fighterFiles(internalId, costume);
    if (!names) return Promise.reject(new Error(`no model for character ${internalId}`));
    // Nana plays Popo's animations for all but her own few: his files too
    // (the same fetch Popo's model makes, so read once)
    const shares = sharedFiles(internalId);
    const shared = shares
      ? Promise.all([file(shares[0]), file(shares[1])]).then(([pl, aj]) => ({ pl, aj }))
      : Promise.resolve(undefined);
    p = Promise.all([file(names[0]), file(names[1]), file(names[2]), motionTable(), shared])
      .then(([pl, aj, md, mt, sh]) => new Fighter(internalId, pl, aj, md, costume, mt, `f${key}`, sh));
    p.catch(() => fighters.delete(key));
    fighters.set(key, p);
  }
  return p;
}

const kirbyHats = new Map<string, Promise<KirbyHat | null>>();

/** Kirby's hat for a copy in one of his costumes (kirby.ts), loaded once per page */
export function kirbyHat(kind: number, costume: number): Promise<KirbyHat | null> {
  const key = `${kind}:${costume}`;
  let p = kirbyHats.get(key);
  if (!p) {
    const names = hatFiles(kind, costume);
    if (!names) return Promise.resolve(null);
    p = Promise.all([file(names[0]), names[1] ? file(names[1]) : Promise.resolve(null)])
      .then(([d, c]) => loadHat(kind, d, c, `kb${key}`, costume));
    p.catch(() => kirbyHats.delete(key));
    kirbyHats.set(key, p);
  }
  return p;
}

const kirbyCopies = new Map<number, Promise<KirbyCopy | null>>();

/** a copy's data file (kirby.ts: its projectiles), loaded once per page */
/** the common items' articles (ItCo.dat's itPublicData: its +4 a list by
 *  item kind, 0 to 0x2A - a Bob-omb, Mr. Saturn - as it_804D6D24 has it),
 *  once a page: each kind's model in a state, or null when it has none */
export interface CommonItems { article(kind: number, state: number): Article | null }
let commonItemsP: Promise<CommonItems | null> | undefined;
export function commonItems(): Promise<CommonItems | null> {
  commonItemsP ??= file("ItCo.dat").then((buf) => {
    const a = parseArchive(buf);
    const pub = a.publics.get("itPublicData");
    if (pub === undefined) return null;
    const list = ptr(a, pub + 4);
    const made = new Map<string, Article | null>();
    return {
      article(kind: number, state: number) {
        const key = `${kind}:${state}`;
        if (!made.has(key)) {
          const art = list === null || kind < 0 || kind > 0x2a ? null : ptr(a, list + kind * 4);
          made.set(key, art === null ? null : loadArticle(a, art, state, `item:${kind}:${state}`));
        }
        return made.get(key)!;
      },
    };
  }).catch(() => null);
  return commonItemsP;
}

export function kirbyCopy(kind: number): Promise<KirbyCopy | null> {
  let p = kirbyCopies.get(kind);
  if (!p) {
    const names = hatFiles(kind, 0);
    if (!names) return Promise.resolve(null);
    p = file(names[0]).then((d) => KirbyCopy.load(kind, d));
    p.catch(() => kirbyCopies.delete(kind));
    kirbyCopies.set(kind, p);
  }
  return p;
}

let effectKit: Promise<EffectKit> | undefined;

/** The effect art (effects3d.ts), loaded once per page. Each of its files is
 *  optional: one that cannot be read leaves its part out, never an error. */
export function effects(): Promise<EffectKit> {
  effectKit ??= (async () => {
    const kit = new EffectKit();
    const read = async (name: string, use: (b: ArrayBuffer) => void) => {
      try { use(await file(name)); } catch (e) { console.warn(`3D replay viewer: no ${name} effects:`, e); }
    };
    await Promise.all([
      read("EfCoData.dat", (b) => kit.common(b)),
      read("EfFxData.dat", (b) => kit.fox(b)),
      read("PlCo.dat", (b) => kit.shared(b)),
    ]);
    return kit;
  })();
  return effectKit;
}

const fighterFx = new Map<number, Promise<boolean>>();

/** A fighter's own effect files (EfFxData for Fox and Falco, Kirby's and
 *  his copies'...), into the kit, once per page: the ones read (none when
 *  it has none or they cannot be read: its special moves then just show no
 *  effects of their own). */
export async function fighterEffects(kit: EffectKit, internalId: number): Promise<number[]> {
  const got = await Promise.all(effectFilesOf(internalId).map((n) => effectFile(kit, n).then((ok) => (ok ? n : -1))));
  return got.filter((n) => n >= 0);
}

/** One of the game's effect files by its number (EFFECT_FILES), into the
 *  kit, once per page: whether it is in (a viewer track's pieces name the
 *  ones the game used, whoever's they are). */
export function effectFile(kit: EffectKit, n: number): Promise<boolean> {
  const f = EFFECT_FILES[n];
  if (!f) return Promise.resolve(false);
  if (kit.banks.has(n)) return Promise.resolve(true);
  let p = fighterFx.get(n);
  if (!p) {
    p = file(f.name).then((b) => { kit.fighter(n, f.table, b); return true; })
      .catch((e) => { console.warn(`3D replay viewer: no ${f.name} effects:`, e); fighterFx.delete(n); return false; });
    fighterFx.set(n, p);
  }
  return p;
}

let hudKit: Promise<HudKit> | undefined;

/** The HUD's art, loaded once per page: the English file an American disc
 *  plays (IfAll.usd: its tags read "P1", the Japanese file's "1P"), else the
 *  Japanese one; with the fighters' common numbers it times the player tags
 *  by (PlCo.dat, optional). */
export function hud(): Promise<HudKit> {
  hudKit ??= file("IfAll.usd").catch(() => file("IfAll.dat")).then(async (b) => {
    const kit = new HudKit(b);
    try { kit.common(await file("PlCo.dat")); } catch { /* the game's usual counts */ }
    return kit;
  });
  hudKit.catch(() => { hudKit = undefined; });
  return hudKit;
}

/** a stage's colors for the magnifier's background (its grGroundParam), or null */
export async function magnifierColors(stageId: number): Promise<[number, number, number][] | null> {
  const info = STAGES[stageId];
  if (!info) return null;
  try { return stageMagnifierColors(await file(`${info.file}.dat`)); } catch { return null; }
}

const stages = new Map<number, Promise<Stage>>();

export function stage(stageId: number): Promise<Stage> {
  let p = stages.get(stageId);
  if (!p) {
    const info = STAGES[stageId];
    if (!info) return Promise.reject(new Error(`no 3D model for this stage (${stageId})`));
    p = file(`${info.file}.dat`).then(async (b) => {
      const st = new Stage(b, stageId);
      // Pokemon Stadium: its four forms too, when the files can be read
      if (info.file === "GrPs") {
        for (const [type, name] of Object.entries(STADIUM_FORMS)) {
          try { st.addForm(Number(type), await file(`${name}.dat`)); } catch { /* the base stage stands */ }
        }
        // its big screen's text (sistext.ts)
        try { st.lettering = await stadiumLettering(b); } catch { /* the browser's lettering */ }
      }
      return st;
    });
    p.catch(() => stages.delete(stageId));
    stages.set(stageId, p);
  }
  return p;
}

/** Pokemon Stadium's screen's text: its pages and font from the English file an
 *  American disc plays (GrPs.usd), else the stage's own (the Japanese text), and
 *  the executable's font and tables (dol.ts) for what
 *  its code writes in; null when the file has no text table */
async function stadiumLettering(base: ArrayBuffer): Promise<Lettering | null> {
  let buf = base;
  try { buf = await file("GrPs.usd"); } catch { /* the stage's own */ }
  const a = parseArchive(buf), at = a.publics.get("SIS_GrPStadiumData");
  if (at === undefined) return null;
  const sis = parseSisFile(a.u8, at, (o) => ptr(a, o));
  if (!sis) return null;
  let common: SisCommon | null = null;
  try {
    common = parseSisCommon(textFontFromDol(await executable()));
  } catch { /* the stage's own pages alone */ }
  return { file: sis, common };
}
