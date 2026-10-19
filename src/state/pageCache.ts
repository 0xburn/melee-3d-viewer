/* what every player on a page shares.
 *
 * A host page may show the player in several places at once (a reel and its
 * stills, a main player and a preview): each is a frame
 * of its own, on the same origin. What one has fetched or read - a replay
 * parsed, a game file's bytes - the others take from here instead of doing
 * it again. Only what nobody changes is kept: bytes and the parsed replay,
 * never a model a player poses. Without a page above it (the player opened
 * on its own) the cache is the player's own. */

type Shared = Record<string, Map<string, unknown>>;

function host(): { __viewerShared?: Shared } {
  const self = globalThis as unknown as { top?: { location: { origin: string } }; location?: { origin: string } };
  try {
    const top = self.top;
    // (the page above, when it is on this origin; asking a foreign one throws)
    if (top && top !== self && top.location.origin === self.location?.origin) return top as unknown as { __viewerShared?: Shared };
  } catch { /* another origin's page: this player's own */ }
  return self as unknown as { __viewerShared?: Shared };
}

/** the page's cache of this name (made on first use) */
export function pageCache<V>(name: string): Map<string, V> {
  const h = host();
  const all = (h.__viewerShared ??= {});
  return (all[name] ??= new Map()) as Map<string, V>;
}

/** the page's weak cache of this name: kept as long as its keys are (a game file's bytes, say) */
export function pageWeak<K extends object, V>(name: string): WeakMap<K, V> {
  const h = host() as { __viewerWeak?: Record<string, WeakMap<object, unknown>> };
  const all = (h.__viewerWeak ??= {});
  return (all[name] ??= new WeakMap()) as WeakMap<K, V>;
}

/** keep a cache to its last `n` entries (the oldest go) */
export function trim<V>(m: Map<string, V>, n: number) {
  while (m.size > n) m.delete(m.keys().next().value as string);
}

// (the frame a shared promise was started in, and the page it had then: see sharedPromise)
const OWNER = "__viewerOwner";
interface Owner { win: { closed: boolean; document?: unknown }; doc: unknown }
type Owned<V> = Promise<V> & { [OWNER]?: Owner };

/** whether the frame that started a promise is gone: removed, or moved on to
 *  another page (a frame given a new address keeps its window, not its page,
 *  and the old page's fetches never settle either) */
function gone(o: Owner): boolean {
  try {
    return o.win.closed || (o.doc !== undefined && o.win.document !== o.doc);
  } catch {
    return true; // (a frame now on another origin)
  }
}

/** one promise for `key` on the page, made by `make` when there is none.
 *  A fetch belongs to the frame that started it, and when that frame is
 *  removed (a reel, a preview closed) its fetch never settles: a player
 *  that took it would wait forever, its Loading cover up. So a promise from a
 *  frame that is gone is dropped and made again here, and one whose frame
 *  goes while we wait is too. */
export function sharedPromise<V>(m: Map<string, Promise<V>>, key: string, make: () => Promise<V>): Promise<V> {
  const self = globalThis as unknown as { closed: boolean; document?: unknown };
  const have = m.get(key) as Owned<V> | undefined;
  const owner = have?.[OWNER];
  if (have && !(owner && gone(owner))) {
    if (!owner || (owner.win === self && owner.doc === self.document)) return have;
    return new Promise<V>((resolve, reject) => {
      let settled = false;
      have.then((v) => { settled = true; resolve(v); }, (e) => { settled = true; reject(e); });
      const watch = () => {
        if (settled) return;
        if (!gone(owner)) { setTimeout(watch, 500); return; }
        if (m.get(key) === have) m.delete(key);
        sharedPromise(m, key, make).then(resolve, reject);
      };
      setTimeout(watch, 500);
    });
  }
  if (have) m.delete(key);
  const p = make() as Owned<V>;
  p[OWNER] = { win: self, doc: self.document };
  m.set(key, p);
  return p;
}
