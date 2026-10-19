// what a replay's gecko code list (event 0x3D) says about the game
// it ran - for now, whether Final Destination's background was frozen.

/** whether a gecko code list puts a nop over Final Destination's background
 *  think (04 21AAE4 60000000: the 32-bit write at 0x8021AAE4, Slippi's
 *  "Frozen All" codes), given the list in the pieces the replay sent it in */
export function hasFrozenFD(pieces: Uint8Array[]): boolean {
  const n = pieces.reduce((s, p) => s + p.length, 0);
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of pieces) { all.set(p, o); o += p.length; }
  const want = [0x04, 0x21, 0xaa, 0xe4, 0x60, 0x00, 0x00, 0x00];
  for (let i = 0; i + 8 <= n; i += 4) {
    let k = 0;
    while (k < 8 && all[i + k] === want[k]) k++;
    if (k === 8) return true;
  }
  return false;
}
