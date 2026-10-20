/* A small cache in the browser for what is made from the game's files, so a
 * second open does not read and work out the same thing again. Every call is
 * guarded: where storage is missing, blocked or full (a private window,
 * cleared site data), each call answers as if the cache were empty and the
 * page works as it did without it.
 *
 * An entry is kept with a key made from the source's own identity for the file
 * it came from and a SHA-256 of a game file read anyway (files.ts), so another
 * disc, another folder or a changed file never finds an entry that is not its own.
 */
const DB_NAME = "viewer-cache";
const STORE = "kv";

let opened: Promise<IDBDatabase | null> | undefined;
function open(): Promise<IDBDatabase | null> {
  opened ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") { resolve(null); return; }
      const rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = () => { try { rq.result.createObjectStore(STORE); } catch { /* answered below */ } };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => resolve(null);
      rq.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opened;
}

/** the value kept under `key`, or undefined (nothing there, or no storage) */
export async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await open();
    if (!db) return undefined;
    return await new Promise<T | undefined>((resolve) => {
      try {
        const rq = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
        rq.onsuccess = () => resolve(rq.result as T | undefined);
        rq.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  } catch {
    return undefined;
  }
}

/** keep `value` under `key` (replacing what was there); false when it could not be kept */
export async function cachePut(key: string, value: unknown): Promise<boolean> {
  try {
    const db = await open();
    if (!db) return false;
    return await new Promise<boolean>((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  } catch {
    return false;
  }
}

/** the SHA-256 of some bytes as hex; null where the browser has no crypto.subtle (an insecure page) */
export async function sha256(buf: ArrayBuffer): Promise<string | null> {
  try {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}
