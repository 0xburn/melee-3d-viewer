/* the HUD Slots option (common/hudslots.ts) as a signal, for the
 * page's own components (the Simple view's HUD, the controller overlays): they
 * follow a change on the spot. */
import { createSignal } from "solid-js";
import { hudSlotsMode, onHudSlots } from "~/common/hudslots";

export const [hudSlotsNow, setHudSlotsNow] = createSignal(hudSlotsMode());
onHudSlots(setHudSlotsNow);
