# melee-sim-light patches (jobs 3 and 4)

This cloud session could not push to briandle00/melee-sim-light. The git proxy refused it with a 403: "briandle00/melee-sim-light is not in this session's authorized repository set". kyhavlov/melee-sim-light is attached under the same name, and the two can't share one session. So both branches are here as `git format-patch` series. Both are based on `visual-only/04-shake` at `f1eb1a73`. This is the second round: it follows the check with game data.

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

**Visual-state locks (second round).** With game data, production output was byte-identical on all 92 games, and 11 of the 14 visual-state locks matched. The other 3 differ in their fp-line digests, as expected now that the chains are driven correctly. The locks need game data and the Linux reference build to record, so they are not in the patch. To regenerate them on this branch:

```
make native MSL_REPLAY_ARITHMETIC=1 MSL_VISUAL_TRACK_BUILD=1
MSL_DATA_DIR=<game data> python -m tools.validation.visual_state            # check: 3 FAIL, fp digests
MSL_DATA_DIR=<game data> python -m tools.validation.visual_state --write    # record (only if every replay's gameplay passes)
git diff --stat replays/suites/visual_state_locks.json                      # expect exactly the 3 entries
git commit -m "Visual-state locks: the 3 recordings whose chains are now driven by their counts" replays/suites/visual_state_locks.json
```

`--write` rewrites every entry, so check that the diff touches only those 3 recordings before committing.


## cloud/stadium (4 commits)

This is a **local combination of upstream's `feat/stadium-transformations` with our branch, not something to upstream.** It cherry-picks upstream b1192b5f, 77ffc009 and 52e04722 (Kyle Havlovitz's authorship kept), plus one fix commit. Upstream's fcc46464 is **dropped**.

**Second round.** Checked with game data, the first series changed production output on all 15 Pokemon Stadium games of the 92, frozen ones included (lock `frozenps`: anim lines 9798 -> 7932). Commit 0004 fixes what ran with the setting off:

- **fcc46464 is dropped.** It changes match termination for every stage, whatever the setting: stepping stops once the match is decided, the outcome is checked after the whole frame, and the save format goes to v2. It cannot be made byte-identical, so it is not gated, it is removed. Replays carry frames after the final stock, and the old series stopped stepping there, which fits the shorter frozen trace.
- **The GameData preload ran with transformations forced on.** `preload_match_configuration` gave Stadium's preload `MSL_PATCH_STADIUM_TRANSFORMATIONS`. Every frozen preload now runs exactly as on the base, with no patch bits and in the same order. One transforming Stadium preload follows them all, so the four forms' archives and actors are still in GameData before it seals.
- **The IK restore hook (`msl_fighter_pose_srt_restored`, from ft_80089B08) now applies only with transformations on.** It had changed the pose schedule for every fighter on every stage.
- **Replay-derived configs use one helper, `tools.validation.admission.stadium_transformations`.** `validate_replay` and `prepare_replay_benchmark` both call it. It is true only on Pokemon Stadium, and never when the capture says frozen (`is_frozen_ps`, or the legacy FreezeStadium patch at 0x801D4578).

**What is now gated or default-off, checked by reading the code paths:**
- **Frozen controller.** Its update is `lb_800115F4` then `Ground_801C2FE0`, the same as the base's `grStadium_801D1520` with the hosted early return in `grStadium_801D4548`.
- **Gated on the bit:** the headless schedule, `write_compare`'s stadium fields (otherwise zero, the old padding), the viewer stage's Stadium fields, the dynamic island reserve and the actor preload.
- **Defaults:**
  - `MslMatchConfig.stadium_transformations` is 0.
  - melee_sim `MatchConfig.stadium_transformations` is `False`.
  - The live viewer's `stadiumTransformations` is `false`, which writes 0 to `slippiPatches`.
  - Unknown patch bits are rejected.

**How the setting is packed:**
- **The bit.** It follows #45, which reused an existing config byte for the arithmetic flags. The setting is bit 1 of `MslCoreMatchConfig.slippi_patches` (`MSL_PATCH_STADIUM_TRANSFORMATIONS`), read through `msl_core_config_stadium_transformations()`.
- **Sizes and versions.** The core config stays 64 bytes. The benchmark tape stays version 5 (`MSLRPB05`), and the export cache version goes to 7.
- **API.** The public `MslMatchConfig` (api.h, Python dtypes) keeps upstream's `stadium_transformations` byte, and api.c maps it to the bit.
- **Viewer.** The schema field `slippiPatches` carries the bit.
- **grpstadium.c.** Main's #60 jumbotron schedule is kept.

**Tested here (no game data):**
- `make native` and `make native MSL_VISUAL_TRACK_BUILD=1` build.
- The stadium smoke binary builds.
- `make source-check` passes.
- New `tests/test_stadium_transformation_gating.py` passes. It checks the API default, the bit and its known-bit mask, and that only unfrozen Stadium replays transform.
- Both series apply with `git am` to `f1eb1a73`.

**Left (needs game data and LFS):**
- **Byte-identity checks:** production on the 92 games should be byte-identical to the base for every frozen-Stadium game, and with the setting off. The `frozenps` lock should pass again.
- **Remaining smokes:** run `stadium-transformations-smoke`, and the Wasm and viewer smokes (there is no `emcc` here).
- **Possible cause outside this fix:** if a frozen game still differs, the remaining suspect is the extra transforming preload's effect on shared GameData. Run with that preload removed to tell.
- **LFS fixtures:** the six `.slpz` files are LFS pointers. Fetch them from upstream's LFS before pushing.
- **Upstream lock entries:** these were made at upstream's base, so check them against this branch.
