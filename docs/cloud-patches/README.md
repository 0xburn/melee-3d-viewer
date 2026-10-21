# melee-sim-light patches (jobs 3 and 4)

This cloud session could not push to briandle00/melee-sim-light. The git proxy refused it with a 403: "briandle00/melee-sim-light is not in this session's authorized repository set". kyhavlov/melee-sim-light is attached under the same name, and the two can't share one session. So both branches are here as `git format-patch` series. Both are based on `visual-only/04-shake` at `f1eb1a73`.

To apply, from a clone of briandle00/melee-sim-light:

```
git checkout -b cloud/dynamics-counts origin/visual-only/04-shake
git am /path/to/cloud-patches/dynamics-counts/*.patch

git checkout -b cloud/stadium origin/visual-only/04-shake
git am /path/to/cloud-patches/stadium/*.patch
```

Neither series contains game data. The stadium series adds six `.slpz` files under `replays/validation/stadium_transformations/`. These are Git LFS pointer files from upstream, not the replays themselves. Fetch the objects from upstream's LFS (`git lfs fetch upstream feat/stadium-transformations`) before pushing, or the LFS check may fail.

## cloud/dynamics-counts (1 commit)

**The bug.** `ftDynamics.x10` is declared `FigaTree***`. In the file, each relocated slot of its table actually points at plain u32 counts. ftCo_8009CB40 reads these as `(s32) arg3`. The counts are not relocated, so the hosted translation (`native_dat.c translate_value`) turned them all into NULL. Every chain joint was then solved by physics.

**The fix.** It is a special case in `translate_value` (`ftDynamics`), next to the existing `DynamicsDesc` one. It keeps the declared host shape, with pointer-sized slots, and stores each count in its slot. A slot without a relocation stays NULL. This needed no gameplay-source change, no regenerated PPC layout, and no new native-DAT view type.

- Kirby hats are untouched: they use `MslDatKirbyHatDynamics`, which keeps x10 raw.
- PPC builds are unchanged.

**Other changes.**
- Ledger row `canonical:dynamics-animated-chain-counts`.
- New test `tests/melee_core/dynamics_counts_smoke.c`, run by `make dynamics-counts-smoke` and part of `native-smoke`. It builds a synthetic ftDataCaptain archive, translates it, and checks the counts and the NULL slot.

**Tested (no game data):**
- The new smoke passes, and fails without the change (`slot 0 count 0 is 0, want 3`).
- `make source-check` passes.
- `fnmsubs-smoke` passes.
- The native and `MSL_VISUAL_TRACK_BUILD=1` builds compile.

**Left: it changes hosted gameplay.** Any animation that drives part of a chain is affected: Peach, Zelda, DK, Marth, Roy, and wherever dynamics own hurt capsules. The production native build is therefore not byte-identical in behavior. Run the replay gate (`make validation-supported-domain`) and output locks with game data. Re-lock any replays that become exact, and investigate any that regress.

## cloud/stadium (4 commits)

This is a **local combination of upstream's `feat/stadium-transformations` with our branch, not something to upstream.** It cherry-picks upstream fcc46464, b1192b5f, 77ffc009 and 52e04722 (Kyle Havlovitz's authorship kept). Each commit message says what was resolved.

**How the conflicts were resolved:**
- **Packing the setting.** It follows #45, which reused an existing config byte for the arithmetic flags. Stadium transformations are bit 1 of `MslCoreMatchConfig.slippi_patches` (`MSL_PATCH_STADIUM_TRANSFORMATIONS`), read through `msl_core_config_stadium_transformations()`.
  - The core config stays 64 bytes.
  - The benchmark tape stays version 5 (`MSLRPB05`); the export cache version goes to 7.
  - Unknown patch bits are rejected in `validate_config`/`valid_config`.
  - The public `MslMatchConfig` (api.h, Python dtypes) keeps upstream's `stadium_transformations` byte, and api.c maps it to the bit.
  - The validation runner's Python keyword `stadium_transformations` is kept and sets the bit.
  - The viewer writes the bit through the new schema field `slippiPatches`.
- **grpstadium.c.** It keeps main's #60 jumbotron schedule: the display functions still run hosted with image/text work excluded. Upstream compiled the transition's display call out of grStadium_801D4548 case 2 hosted. Here it stays in, so the screen follows the transformations as in retail.
- **scalar.c.** It keeps this branch's arithmetic-flag checks. The match outcome is resolved before the viewer track records the frame.
- **api.c.** It keeps this branch's `release_game_data()`.
- **Counts and docs.** Suite counts become 530 replays and 79 filtered cases. BASELINE.md keeps both sections.

**Tested (no game data):**
- `make native`, the stadium-transformations smoke binary, and the `MSL_VISUAL_TRACK_BUILD=1` native build all compile.
- `make viewer-schema-check` passes.
- `node --check` passes on the viewer JS.
- The Python test suite has the same failures as the base branch: they all need extracted game data or LFS replays. The exceptions are three tests that are new or changed here and also need data or LFS: `test_frame_cutoff_and_restore`, `test_stockout_latches_after_all_ports_and_freezes`, `test_stadium_suite_covers_frozen_and_all_transformations`.

**Left:**
- Run with game data and LFS replays: native-smoke (including `stadium-transformations-smoke`), the full replay gate, output locks, and the Wasm and viewer smokes. No `emcc` was available here, so the Wasm build was not compiled.
- Upstream's fcc46464 changes match termination and the save format (`MSL_SAVE_VERSION` 2), so locks may move.
- Upstream's lock entries for its six fixtures were made at upstream's base. Check them against this branch.
