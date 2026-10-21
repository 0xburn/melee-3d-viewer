# melee-sim-light patches (jobs 3 and 4)

This cloud session could not push to briandle00/melee-sim-light. The git proxy refused it with a 403: "briandle00/melee-sim-light is not in this session's authorized repository set". kyhavlov/melee-sim-light is attached under the same name, and the two can't share one session. So both branches are here as `git format-patch` series. Both are based on `visual-only/04-shake` at `f1eb1a73`. This is the third round. The dynamics-counts series is unchanged from the second round. The stadium series adds two commits (0005, 0006) after the second check with game data.

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


## cloud/stadium (6 commits)

This is a **local combination of upstream's `feat/stadium-transformations` with our branch, not something to upstream.** It cherry-picks upstream b1192b5f, 77ffc009 and 52e04722 (Kyle Havlovitz's authorship kept), then adds three fix commits. Upstream's fcc46464 is **dropped**, because it changes match termination on every stage (see round two below).

### Third round: the setting is off unless a caller turns it on (0005, 0006)

With the setting at its default, the second series still changed production output on 15 of the 92 games. All 15 are Pokemon Stadium games whose frozen flag is false (Slippi 3.14–3.16), and the base replays them exactly. RNG events went from 302,500 to 294,000 and stage-generator events from 1,971 to 18,430. These things ran with the setting off:

1. **The replay path inferred the setting (the cause of the 15).**
   - **What ran.** `admission.stadium_transformations(start, codes)` returned true for every Stadium replay not recorded frozen. `validate_replay` and `prepare_replay_benchmark` passed that to the native config, so the 15 games ran with transformations on. Series 1 had also removed the base's `unfrozen-stadium` admission rule.
   - **Fix.** The helper now takes `requested=` and returns true only for `requested is True` on an unfrozen Stadium. Nothing is inferred from the frozen flag, the stage or the Slippi version.
   - The `unfrozen-stadium` rule is back in `capture_issues`, through `unfrozen_stadium_rejected`, with its entry in `replay_admission.json`. It is waived only when the caller passes `stadium_transformations=True`.
   - The suite and CLI wiring is described below. With the setting off, the native call gets no `stadium_transformations` argument at all, so it is the base's call. The result dict, the "Frozen Stadium" stage label and the benchmark cache keys (`CACHE_VERSION` back to 6) are also the base's.
   - `native.c` no longer reads a replay's `stadium_transformation` events unless the setting is on.
2. **The extra transforming GameData preload ran unconditionally.**
   - **What ran.** `preload_supported_game_data` ended with a Stadium preload that had the bit set. That changed the shared, sealed GameData (and its fingerprint) for every match.
   - **Fix.** It now runs only for GameData loaded with the new option `MSL_GAME_DATA_STADIUM_TRANSFORMATIONS`, through `msl_core_game_data_init_options`. The preload sequence and the sealed GameData are otherwise exactly the base's.
   - `msl_core_game_data_init` and `_init_visual` pass no option.
   - The stream runner (`main.c init_match`) sets the option from its own config's bit, since it runs one match.
   - The server runner and `msl_core_game_data_create` (the batch API, Python `EnvBatch`, `replay_bench`) set it only when `MSL_STADIUM_TRANSFORMATIONS=1` is in the environment, the exact string.
   - The flag sits at the end of `MslCoreGameData`, so no other member's offset (or savestate pointer map) moves.
   - A config with the bit on default GameData is refused at match construction, with an error. It is never run on the wrong data.
   - A config with the bit on any stage other than Pokemon Stadium is refused too. Without that, the pose hook could have turned on elsewhere.
3. **The Stadium controller's proc was replaced.**
   - **What ran.** With the setting off, series 2 installed a new `msl_stadium_frozen_update` proc in place of the source's `grStadium_801D1520`. It was meant to be equivalent, but it was a different function pointer in the proc list.
   - **Fix.** The source proc is restored. `grStadium_801D4548` gets back the base's hosted early return, which is now skipped only when the bit is set. With the setting off, the Stadium code path is the base's.
4. **GrPs1–4.dat were required for any data directory.**
   - **What ran.** `validate_raw_dir` and `EnvBatch` rejected data directories that lack them.
   - **Fix.** They are still extracted (`tools/data/extract.py`) but no longer required.
5. **Viewer trace export inferred the setting.**
   - **What ran.** `msltrace1.js replayDataToMslTrace` set `stadiumTransformations` from `isFrozenStadium === false`.
   - **Fix.** It now takes only an explicit `settings.stadiumTransformations === true`. `viewerSettings` sets that from the trace's own match, and the live viewer adapter sets it from the sim's state, which carries a Stadium type only when the config bit was on. `ReplaySettings` gains the optional `stadiumTransformations` field.

**Audited and already gated on the bit** (each only reads or writes when it is on):
- the `match_construct` archive and actor preload, and `msl_mp_island_reserve_dynamic`, its only caller;
- the headless schedule's priority-4 exception;
- `write_compare`'s `stadium_state` and `stadium_type`, which are otherwise 0 like the old padding;
- `viewer.c`'s Stadium fields;
- `msl_fighter_pose_srt_restored`. It returns before touching the flag when the bit is off. `set_root_position` tests bit 31 of the pose node's flags, which no AOBJ flag uses and which is set only by that hook.

**Unreachable with the setting off:**
- `grAnime_801C65B0`'s native archive-free exclusion and `grStadium_801D42B8`'s hosted `xD0` exclusion. Their only callers are `grStadium_801D4548`, which returns early when off, and the gated `match_construct` block.
- 801D4548's case 2 and case 3 edits, for the same reason.

**Still differs with the setting off, not in gameplay output:**
- `MslCoreViewerStage` and `MslCoreViewerState` grow to 4120 and 6432 bytes for the collision lines. The extra fields stay zero when off. Viewer and wasm callers use the regenerated `schema.generated.js`.
- Unknown `slippi_patches` bits are rejected (bits 2–7). Replay-derived configs only ever set bit 0.

### How to turn it on (explicit only)

- **Suites:** set `"stadium_transformations": true` on a replay entry. It must be a JSON bool and the entry's `stage_id` must be 3. The six entries in `replays/suites/stadium_transformations.json` now carry it.
- **`validate_replay`:** `--stadium-transformations` turns it on for every selected case. Those cases run in a one-shot runner whose GameData is loaded for their config. The pooled server runners keep the default GameData, and `native.validate_replay` refuses `stadium_transformations` with a pooled runner.
- **Benchmark:**
  ```
  python -m tools.validation.prepare_replay_benchmark --stadium-transformations
  MSL_STADIUM_TRANSFORMATIONS=1 <replay_bench ...>
  ```
  Without the flag, the transforming suite entries are skipped and a count is printed. With the variable set, all benchmark cases share the transforming GameData.
- **C API / Python:**
  - set `MslMatchConfig.stadium_transformations = 1` (C) or `MatchConfig(stage=3, stadium_transformations=True)` (Python);
  - start the process with `MSL_STADIUM_TRANSFORMATIONS=1` so the GameData preloads Stadium's forms.
- **Core:** `msl_core_game_data_init_options(&data, root, MSL_GAME_DATA_STADIUM_TRANSFORMATIONS)` and `MSL_PATCH_STADIUM_TRANSFORMATIONS` in `slippi_patches`.
- **Live viewer:** the "PS (unfrozen)" stage button. The wasm build has no preload and no GameData check.

### Tested here (no game data)

- `make native validator` builds, and so does `make native MSL_VISUAL_TRACK_BUILD=1` (`BUILD_ROOT=build/vis`). Both builds of `stadium-transformations-smoke` compile.
- PPC could not be built: the toolchain download was refused with a 403.
- `make source-check` passes.
- `tests/test_stadium_transformation_gating.py` passes all 20 tests. They check:
  - **Defaults:** the default `MatchConfig` and dtype row have the bit off, and `_write_match_config` sets it only from the config. On the C side, the API sets it only from the field, and the native replay config sets it only from the kwarg, which defaults to 0.
  - **GameData:** the transforming preload runs only under the GameData option, the default init passes 0, the variable must be exactly "1", and default GameData refuses a transforming config.
  - **Stadium source:** the source proc is kept, and 801D4548 returns early when off.
  - **Admission:** it returns false for every Stadium start (recorded frozen, legacy patch, flag false, no flag) unless `requested=True`, and false on every other stage. `unfrozen-stadium` is rejected unless explicitly asked.
  - **Replay path:** replay-derived configs never set it. A fake native shows the default call has no `stadium_transformations` argument and patch bit 1 is clear for all four starts. An explicit request does reach the config.
  - **Suites:** the bit is set only on the six written entries, and the field must be a literal bool on stage 3.
  - **Benchmark:** cache keys are the base's unless asked for.
  - **Viewer:** the trace export never reads `isFrozenStadium`.
- The full `pytest tests` run gives 76 passed, 105 failed and 6 errors. Every failure is missing game data or an LFS pointer replay.
- Both series apply with `git am` to `f1eb1a73`, and the result equals `cloud/stadium`.

### Verify with game data

1. **Production off is the base.** All 92 games must be byte-identical to the base build (no suite `stadium_transformations` entries, no variable). That includes the 15 unfrozen-flag Stadium games (RNG events 302,500, stage-generator events 1,971) and the `frozenps` lock.
2. **GameData off is the base.** `msl_core_game_data_init`'s fingerprint should equal the base's for the same data directory.
3. **The smoke.** `make native-smoke`, or run `stadium-transformations-smoke <data>/raw` directly. It runs all transformations with the option, then checks that default GameData has a different fingerprint, `stadium_transformations == 0`, refuses the bit, and still builds a frozen Stadium match.
4. **On, explicitly.** Run `python -m tools.validation.validate_replay --suite replays/suites/stadium_transformations.json --backend native`. The six entries should admit, run one-shot and match their output locks. These need the LFS objects: `git lfs fetch upstream feat/stadium-transformations`.
5. **Mixed run.** Run the aggregate suite (`melee_core_aggregate.json`). Its other cases must equal a run without the six, since they use the pooled default GameData.
6. **Benchmark.** Without `--stadium-transformations`, `prepare_replay_benchmark` should write the same tapes and keys as the base.
7. **The rest.** Run the Wasm and viewer smokes (there is no `emcc` here). Check upstream's lock entries against this branch.

### Earlier rounds (0001–0004)

The second round dropped fcc46464, made the frozen preloads run with no patch bits in base order, and gated the IK restore hook. Round three supersedes its claim that replay-derived configs transform unfrozen-flag Stadium replays: they no longer do, unless asked.
