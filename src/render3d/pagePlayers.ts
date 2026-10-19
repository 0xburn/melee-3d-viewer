/* 3D replay viewer: the 3D players on one page, and who goes first.
 *
 * A page can hold several players (a reel and one that takes its stills; a
 * main player and a preview). They share one main thread: two playing at full rate, or one
 * loading while another plays, make both stutter. So each says here whether
 * it can be seen and whether it is playing, and asks:
 *   - whether to draw at all: not while it cannot be seen (off the screen,
 *     in a part of the page that is hidden, or the tab in the background);
 *   - at what rate: the one playing that is seen biggest draws every frame,
 *     any other playing one every other frame;
 *   - whether to load now: a player that cannot be seen loads while none
 *     that can is playing, so its reading and decoding does not land in the
 *     middle of someone's playing.
 * The register is the page's (pageCache): the players are frames of one
 * origin and read each other's entries. */
import { pageCache } from "../state/pageCache";

interface Entry { seen: boolean; playing: boolean; area: number; at: number; beat: number }

// (a player that has not said anything for this long is gone: its frame went without a word)
const QUIET_MS = 2000;
const clock = () => performance.timeOrigin + performance.now();

let next = 0;

export class PagePlayer {
  private readonly id = `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}:${next++}`;
  private readonly all = pageCache<Entry>("players3d");
  private readonly me: Entry = { seen: false, playing: false, area: 0, at: clock(), beat: clock() };

  constructor() { this.all.set(this.id, this.me); }

  /** what it is now: seen (and how big, in pixels), playing */
  set(seen: boolean, area: number, playing: boolean) {
    this.me.seen = seen;
    this.me.area = seen ? area : 0;
    if (playing && !this.me.playing) this.me.at = clock();
    this.me.playing = playing;
    this.me.beat = clock();
  }

  /** whether another player that can be seen is playing */
  othersPlaying(): boolean {
    const now = clock();
    for (const [id, e] of this.all) if (id !== this.id && e.seen && e.playing && now - e.beat < QUIET_MS) return true;
    return false;
  }

  /** whether it draws every frame: it is the playing player seen biggest
   *  (the one started last, of two the same size), or none other is playing */
  first(): boolean {
    if (!this.me.playing) return true;
    const now = clock();
    for (const [id, e] of this.all) {
      if (id === this.id || !e.seen || !e.playing || now - e.beat >= QUIET_MS) continue;
      if (e.area > this.me.area || (e.area === this.me.area && e.at > this.me.at)) return false;
    }
    return true;
  }

  /** whether to load now: when it can be seen, or while no player that can be is playing */
  mayLoad(): boolean {
    return this.me.seen || !this.othersPlaying();
  }

  /** gone from the page */
  remove() { this.all.delete(this.id); }
}
