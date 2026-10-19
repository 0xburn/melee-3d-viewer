/* 3D replay viewer: the viewer track's compact form (VTB1).
 *
 * The same events as the simulator's JSON, kept a column at a time: each
 * type's rows split into columns, a column of numbers kept as the steps from
 * one row to the next, the whole gzipped (a host may serve it in this form, and has
 * the layout). This reads it back into the events track.ts takes, in the
 * track's own order.
 */
import type { TrackData, TrackEvent } from "./track";

const MAGIC = "VTB1";

class Reader {
  o = 0;
  constructor(private b: Uint8Array) {}
  byte(): number { return this.b[this.o++]; }
  /** a varint, as a plain number (a column's values stay under 2^52) */
  varint(): number {
    let x = 0, scale = 1, c: number;
    do {
      c = this.b[this.o++];
      x += (c & 0x7f) * scale;
      scale *= 128;
    } while (c >= 0x80);
    return x;
  }
  zigzag(): number {
    const x = this.varint();
    return x % 2 === 0 ? x / 2 : -(x + 1) / 2;
  }
  text(): string {
    const n = this.varint();
    const s = new TextDecoder().decode(this.b.subarray(this.o, this.o + n));
    this.o += n;
    return s;
  }
}

function column(r: Reader, n: number): (number | string)[] {
  const kind = r.byte();
  const out: (number | string)[] = new Array(n);
  if (kind === 0 || kind === 1) {
    const k = kind === 1 ? r.byte() : 0, s = 10 ** k;
    let last = 0;
    for (let i = 0; i < n; i++) { last += r.zigzag(); out[i] = k ? last / s : last; }
    return out;
  }
  const count = r.varint();
  const table: (number | string)[] = [];
  for (let i = 0; i < count; i++) { const t = r.text(); table.push(kind === 3 ? JSON.parse(t) : t); }
  for (let i = 0; i < n; i++) out[i] = table[r.varint()];
  return out;
}

/** the events and the rest of a track from its compact form, once ungzipped */
export function readTrack(b: Uint8Array): TrackData {
  if (new TextDecoder().decode(b.subarray(0, 4)) !== MAGIC) throw new Error("not a VTB1 track");
  const r = new Reader(b);
  r.o = 4;
  const track = JSON.parse(r.text()) as TrackData;
  const names: string[] = [];
  for (let i = r.varint(); i > 0; i--) names.push(r.text());
  const total = r.varint();
  const order = new Uint16Array(total);
  const counts = new Array(names.length).fill(0);
  for (let i = 0; i < total; i++) { order[i] = r.varint(); counts[order[i]]++; }
  const rows: TrackEvent[][] = [];
  names.forEach((name, t) => {
    const n = counts[t];
    const same = r.byte() === 0;
    const lengths = new Array<number>(n);
    if (same) lengths.fill(r.varint());
    else for (let i = 0; i < n; i++) lengths[i] = r.varint();
    const events: TrackEvent[] = new Array(n);
    let last = 0;
    for (let i = 0; i < n; i++) { last += r.zigzag(); events[i] = [last, name]; }
    let most = 0;
    for (const m of lengths) if (m > most) most = m;
    for (let j = 0; j < most; j++) {
      const have: TrackEvent[] = [];
      for (let i = 0; i < n; i++) if (lengths[i] > j) have.push(events[i]);
      const v = column(r, have.length);
      for (let i = 0; i < have.length; i++) have[i].push(v[i]);
    }
    rows.push(events);
  });
  const at = new Array(names.length).fill(0);
  const events: TrackEvent[] = new Array(total);
  for (let i = 0; i < total; i++) events[i] = rows[order[i]][at[order[i]]++];
  track.events = events;
  return track;
}

/** a track's compact form as a host may send it (gzipped) */
export async function decodeTrack(buf: ArrayBuffer): Promise<TrackData> {
  // (the browser's own gunzip; the page's TypeScript library predates its type)
  const Gunzip = (globalThis as unknown as { DecompressionStream: new (f: string) => TransformStream<Uint8Array, Uint8Array> })
    .DecompressionStream;
  const plain = await new Response(new Blob([buf]).stream().pipeThrough(new Gunzip("gzip"))).arrayBuffer();
  return readTrack(new Uint8Array(plain));
}
