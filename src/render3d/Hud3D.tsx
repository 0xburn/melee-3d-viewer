/* 3D replay viewer: the HUD's words, held as the page's own text.
 *
 * Everything of the HUD is drawn with the picture (hud.ts), the words too:
 * the player names on Slippi's plates under the percentages, and a console
 * game's nametags over the fighters (hudtext.ts draws them, so they go
 * through the 480p look with the rest). But the words come from here: this
 * keeps each as text of the page, never shown, so the page's demo mode finds
 * and swaps them like every other name on the page (it rewrites the text it
 * can find, and cannot reach a picture), and hands the HUD whatever the text
 * now says - once when the replay's names are known, again whenever demo
 * mode changes one. Nothing here is laid out while the replay plays.
 */
import { createMemo, For, onCleanup, onMount } from "solid-js";
import { replayStore } from "~/state/replayStore";

export function Hud3D(props: { nametags: { player: number; tag: string }[];
                              onWords: (words: Map<string, string>) => void }) {
  let root!: HTMLDivElement;
  const plates = createMemo(() =>
    (replayStore.replayData?.settings.playerSettings ?? []).filter(Boolean)
      .map((s) => ({ player: s.playerIndex, name: s.displayName ?? "" })).filter((p) => p.name.length > 0)
  );
  const read = () => {
    const words = new Map<string, string>();
    root.querySelectorAll<HTMLElement>("[data-hud-word]").forEach((el) => {
      words.set(el.dataset.hudWord!, el.textContent ?? "");
    });
    props.onWords(words);
  };
  onMount(() => {
    read();
    const obs = new MutationObserver(read);
    obs.observe(root, { childList: true, subtree: true, characterData: true });
    onCleanup(() => obs.disconnect());
  });
  return (
    <div ref={root} class="hud3d-words" style={{ position: "absolute", width: "0", height: "0", overflow: "hidden",
                                                 visibility: "hidden" }} aria-hidden="true">
      <For each={plates()}>{(p) => <span data-hud-word={`plate:${p.player}`} data-hud-name={p.player}>{p.name}</span>}</For>
      <For each={props.nametags}>{(t) => <span data-hud-word={`tag:${t.player}`}>{t.tag}</span>}</For>
    </div>
  );
}
