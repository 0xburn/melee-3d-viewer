/* Start-up timing: where the time goes between opening a replay and its first
 * drawn 3D frame. A debug aid, off unless the page's URL has ?timing=1; off, each
 * call below is one boolean test and nothing is kept.
 *
 * On, the page's `__startup` holds the marks (ms since the page began), the
 * spans (a phase, what it was for, when it began and ended) and the game files
 * fetched (name, bytes, where they came from, when).
 */
export interface Span { phase: string; what: string; start: number; end: number }
export interface FileRead { name: string; bytes: number; from: string; start: number; end: number }
export interface Startup { marks: Record<string, number>; spans: Span[]; files: FileRead[] }

/** whether timing is on (?timing=1) */
export const timing = typeof location !== "undefined" && new URLSearchParams(location.search).has("timing");

const data: Startup | null = timing ? { marks: { module: performance.now() }, spans: [], files: [] } : null;
if (data) (globalThis as { __startup?: Startup }).__startup = data;

/** a named moment (the first call of a name wins) */
export function mark(name: string) {
  if (data && !(name in data.marks)) data.marks[name] = performance.now();
}

/** run `fn`, recording how long it took under `phase` */
export function timed<T>(phase: string, what: string, fn: () => T): T {
  if (!data) return fn();
  const start = performance.now();
  try { return fn(); } finally { data.spans.push({ phase, what, start, end: performance.now() }); }
}

/** a game file was read: `from` says where its bytes came from */
export function fileRead(name: string, bytes: number, from: string, start: number) {
  data?.files.push({ name, bytes, from, start, end: performance.now() });
}
