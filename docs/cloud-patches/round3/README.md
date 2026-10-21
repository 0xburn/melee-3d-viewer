# melee-sim-light patches, round 3 (stage joints, fighter joints, the yo-yo's string)

Based on `visual-only/04-shake` at `f1eb1a73` (briandle00/melee-sim-light). Eight commits, one change each, as one series:

- 0001 is the dynamics-counts fix (the same change as `docs/cloud-patches/dynamics-counts/`). It comes first so the swinging chains are solved with the file's driven-joint counts before `fj` records those joints (Peach's and Zelda's chains).
- 0002 to 0008 are in the viewer track, so they compile only with `MSL_VISUAL_TRACK_BUILD=1`.

To apply, from a clone of briandle00/melee-sim-light:

```
git checkout -b cloud/round3-track origin/visual-only/04-shake
git am /path/to/docs/cloud-patches/round3/*.patch
```

No patch contains game data.

**Checked for the whole series (no game data):**
- The production native build (`make native`) at the series head is byte-identical to the build after 0001 alone (`cmp` of `melee-core-native`, both built with the same `BUILD_ROOT`, which the binary embeds). So 0002 to 0004 change nothing in production. 0001 changes it as the dynamics-counts README says (its 3 visual-state locks need regenerating with game data).
- The `MSL_VISUAL_TRACK_BUILD=1` native build compiles without warnings.
- `make source-check` passes.
- `pytest tests`: the same 63 failures and 51 skips as on the base. All of them need `data/` or the replays' LFS objects, which are not in this session.
- There are no synthetic C tests for the viewer track in the repo: it runs only inside a match, which needs game data. So the viewer side has the format tests instead (synthetic track text, in the viewer's `tests/`).

## 0001 Dynamics: chain-joint counts

See `docs/cloud-patches/dynamics-counts/README.md`. Unchanged.

## 0002 Viewer track: stage joints ("sp")

`[frame,"sp",part,(joint,mask,values)...]`

Every stage part with a joint tree in the stage's file writes its joints as the frame's end left them. The nine values are those of `jp`: rot x, y, z, scale x, y, z, translate x, y, z, with mask bit k meaning value k follows. A joint is written once it leaves the file's rest pose, then whenever it changes, as `jp` does.

- **Part number.** The same number `gjoint` uses (`stage_joint`): the part's `map_id`, or `map_id + 1000 * k` for the k-th extra copy that is not the one in `stage_info.x180`.
- **Joint number.** The preorder index `stage_joint` counts. Index 0 is the part's scale root from `Ground_801C14D0`/`get_jobj_inline`, at rest rot 0, scale the stage's (`stage_info.param->x0`, else 1), translate 0. The file's tree (`grDatFiles_801C6330(map_id)->unk4->unk8[map_id].unk0`) starts at 1. An instance's children are not counted.
- **Not written:** quaternion joints, joints past 512, and parts with no tree in the file.
- The pose owners go from 64 to 128 and the line buffer from 48 KB to 256 KB, to fit a stage part's tree. Both are allocated once with the track.
- `sp` is added to `UNLOCKED_KINDS`, so the visual-state locks don't change.

**Needs game data:** check the lines against Dolphin's draws on Fountain of Dreams, Yoshi's Story and Pokemon Stadium. Also measure how much an animated background adds to a track's size. Every joint an animation moves is written on every frame it moves.

## 0003 Viewer track: fighter joints as the game left them ("fj")

`[frame,"fj",port,sub,character,(part,mask,values)...]`

A fighter's joints at the frame's end, by part, with the same nine values. This covers the animation, the blend into it (`ftAnim_8006FE9C`, `ftAnim_80070010`), and whatever the game's own code set afterwards (ftParts, the state's code, the swinging chains). The values are the exact rotate/scale/translate bits, so a viewer rebuilds `jobj->mtx` with `HSD_JObjMakeMatrix` and gets the game's matrix.

**Format chosen.** Every live part, with each value written only when it changes. The fighter's first line, and its first line as another character, has every value. It does not use a "differs from the file animation" baseline. In the hosted build, `ftAnim_8006EBA4` and the blends run more than once a frame in some states, so there is no single moment to snapshot "the file's animation". A baseline would also only help if the viewer's own animation matched bit for bit, which is the thing in question. So `fj` carries the final pose, and the viewer uses it in place of its own work for those parts.

**Not written:**
- part 0: the place and facing, which come from `pos` and the replay.
- quaternion joints.
- the presentation-only parts that the hosted build leaves cold (`JOBJ_MSL_GAMEPLAY_COLD`, from `ftParts_HeadlessGameplayMask`). Those include fingers and faces. They are not animated in the simulator at all, so the viewer keeps its own pose for them.

**Overlap with fp.** `fp` still writes its swinging chains. Where a part appears in both, the values are the same.

**Needs game data:**
- Measure the track size. Expect a few KB per fighter per frame before VTB1/gzip.
- Compare against Dolphin's joint matrices. The joints the user listed (Ganondorf, Marth) should agree to the bit wherever the part is live.
- Decide whether the cold parts are worth animating in the track build. That would mean loading the full tree there instead of `ftParts_HeadlessLoadCompact`, and it needs its own byte-identity check of gameplay.

`fj` is unlocked.

## 0004 Viewer track: the yo-yo's string by the links' out bit

`lm` already writes each link's `x2C_b0` as its out. That was checked against itnessyoyo.c:
- set as the string pays out from the ball (`it_802BF28C`, `it_802BF4A0`), and for the ball itself (`it_802BE65C`, `it_802C0010`)
- cleared as it is drawn back (`it_802BF800`) and under the shortest length (`it_802BF28C`)

So the links that are out form one run from the ball, which is `lm`'s link 0.

The bug was in `hook`. It left a link out only when its place was still at the origin, which is how the hookshot and the grapple mark a link that isn't out yet. A yo-yo link that is not out keeps its spawn place or the hand's (nothing moves it), so the yo-yo's `hook` line drew the string through links the game does not draw. The yo-yo's links are now told by `x2C_b0`, which is what `it_802A24A0` draws by. The hookshot and the grapple are unchanged.

**Needs game data:** `hook` is locked. A visual-state recording with Ness's yo-yo out will change its `hook` digest. Check that only such recordings differ, then re-record them with `python -m tools.validation.visual_state --write`. The viewer itself no longer reads `hook`: it draws chains from `lm`.

## 0005 Viewer track: Fountain of Dreams' water columns stretched to the recorded height

Fountain of Dreams' stage joints got worse with `sp` (stage2 draws from 1,021 to 7,884).

- **Cause.** Each side platform stands on a water column, a copy of part 4 (numbered 4 and 1004 in `sp`). The game stretches the column's root joint (`sp` joint 1) to its platform's height whenever the platform moves (`grIzumi_801CC358`'s `r29` block: scale x `0.5 f + 0.5`, scale y `f`, where `f` is the height over the column's own, clamped to 0.01). When the recording gives the platform's height, the hosted build takes it (`msl_grizumi_apply_replay_platform_height`) and returns before that block. So the column kept its first frame's stretch, `sp` wrote it, and that replaced the viewer's stretch, which follows the height correctly.
- **Fix.** In the track build only, and only with a track on, the replay branch now sets the same stretch from the recorded height, written as the source writes it. The game sets it whenever the platform moves, from the height it moved to, so it always matches the height. Setting it every frame from the recorded height gives the same values.
- **Production.** `.text`, `.rodata` and `.data` of `make native` are byte-identical to the build after 0004. The file still differs, because the inserted lines move later line numbers in `grizumi.c`'s debug info, and the build ID follows them.
- Also checked: the hosted build doesn't create part 2 (the platforms' shadows, `grIzumi_801CBCE8(2)`), so `sp` writes nothing for it and the viewer keeps its own. The column copies are numbered as the viewer names them (the left one 1004, the right one 4).

**Needs game data.** Check stage2 against the game's draws. A visual-state lock that digests the column's joints or the effects at its keys may change on Fountain recordings.

## 0006 Viewer track: sp leaves out joints that stand where a stopped animation left them

0005 did not move Fountain of Dreams (stage2 still 7,884). The pair (stage2:1:1:0, part 1, joint 3) has the game's translation but a 3x3 about 1/940 of the game's. That is a uniform scale, not the column's stretch.

- **Cause.** The hosted build plays a stage part's animation only if the part is in its stage's `runtime_animation_mask` (`configure_headless_ground_schedule`). Fountain's mask has only part 4, the columns. Every other part has its animation removed (`msl_ground_use_headless_epoch_proc`), so its joints stay where the animation was when it stopped. `sp` writes a joint once it leaves the file's rest pose, so it wrote such a joint once, at a scale its animation starts from near zero. That pose then stood over the viewer's own animation for the whole match.
- **Fix.** On a part whose animation the hosted build stopped (its proc is `msl_ground_headless_epoch_proc`), a joint's baseline is the pose it has when `sp` first sees it, not the file's rest. A joint that only the animation moves is never written, so the viewer animates it. A joint the game's code moves is still written when it moves (the platforms on part 3).
- **Other stages.** Yoshi's Story animates parts 2 and 3; Dream Land, Battlefield and the others have their own masks; Stadium animates none. Parts outside the masks change the same way.
- **Left as is.** For a joint written on a stopped part, the viewer reads a value that was never sent as the file's rest value, where its own animation would be closer. That only matters for a joint that code moves and the animation also moves. None is known.
- **Production.** `.text`, `.rodata` and `.data` are identical to the build after 0005.

**Needs game data.** stage2 should come back to about the 1,021 draws it had before `sp`. Yoshi's Story (stage8) should not get worse.

## 0007 Viewer track: fj leaves out the joints of chains the track build does not solve

Peach (f9: 3,362 to 10,959 draws with round 3) and Zelda (f19: 7,781 to 12,064) did not move with the dynamics-counts fix in front.

- **Cause.** The track build does not solve Peach's and Zelda's dress and hair chains, or Donkey Kong's tie. `msl_viewer_track_keep_dynamics` prunes their links as without a track (solved in the simulator they came out further from the game than the viewer's own solve). Their joints stay live, though, at the animation's pose, unsolved. `fj` writes every live part, so it wrote those unsolved joints over the viewer's own solve. That is also why the driven-joint counts changed nothing: those chains are not solved here at all.
- **Fix.** `fj` leaves out every joint of a chain whose links were pruned (its `dyn_desc.data` is `NULL`). The chain is found as `ftCo_8009CF84` links it: `lb_8000FD48` from the chain's bone down its first children, for the chain's count. The viewer keeps its own solve for those joints, as before `fj`. Chains the track build keeps (Fox's tail, Jigglypuff's body, every chain on the other fighters) are still written. The mask is a scratch array allocated once with the track.
- **Production.** `.text`, `.rodata` and `.data` are identical.

**Needs game data.** Peach and Zelda should come back to at least their numbers before `fj`, and the rest of the fighters should not change. Then regenerate the four visual-state locks.

## 0008 Viewer track: Peach's, Zelda's and Donkey Kong's chains solved too

With 0007, Zelda went to 5,559 draws (from 7,781 before `fj`), but Peach is still at 5,378 (from 3,362). What is left wrong is the viewer's own solve of their chains.

- **Change.** `msl_viewer_track_keep_dynamics` pruned these three fighters' chains, because solved in the track build they came out further from the game than the viewer's solve. That was without the dynamics-counts fix, which is now 0001. The exception is removed: their chains are copied and solved like every other fighter's, and `fp` writes them. 0007 skips nothing for them now, because their links are kept.
- **Also suspect, in 0009 next.** The chain joints are presentation-only, so the headless build marks them cold, and a cold joint gets no animation (`HSD_JObjAddAnim` and `JObjAnimAll` return early). A chain solved here therefore starts from the unanimated pose, while in the game the animation drives those joints and the physics works from that. If 0008 alone does not bring Peach and Zelda right, 0009 is the next step.
- **Production.** `.text`, `.rodata` and `.data` are identical.

**Check:** Peach (Jigglypuff vs Peach, Battlefield, fsmash, frame 319: f9:0:32:0, f9:0:50:0), Zelda (Sheik vs Zelda, Dream Land, KO, frame 4480: f19:1:31:0, f19:1:32:0) and Donkey Kong.
