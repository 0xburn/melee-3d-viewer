# melee-sim-light patches, round 3 (stage joints, fighter joints, the yo-yo's string)

Based on `visual-only/04-shake` at `f1eb1a73` (briandle00/melee-sim-light; this session cannot push there). Three commits, one change each. All of it is in the viewer track, so it compiles only with `MSL_VISUAL_TRACK_BUILD=1`.

To apply, from a clone of briandle00/melee-sim-light:

```
git checkout -b cloud/round3-track origin/visual-only/04-shake
git am /path/to/docs/cloud-patches/round3/*.patch
```

No patch contains game data.

**Checked for the whole series (no game data):**
- The production native build (`make native`) is byte-identical to the base: `cmp` of `melee-core-native` built at `f1eb1a73` and at the series head.
- The `MSL_VISUAL_TRACK_BUILD=1` native build compiles without warnings.
- `make source-check` passes.
- `pytest tests`: the same 63 failures and 51 skips as on the base. All of them need `data/` or the replays' LFS objects, which are not in this session.
- There are no synthetic C tests for the viewer track in the repo: it runs only inside a match, which needs game data. So the viewer side has the format tests instead (synthetic track text, in the viewer's `tests/`).

## 0001 Viewer track: stage joints ("sp")

`[frame,"sp",part,(joint,mask,values)...]`

Every stage part with a joint tree in the stage's file writes its joints as the frame's end left them. The nine values are those of `jp`: rot x, y, z, scale x, y, z, translate x, y, z, with mask bit k meaning value k follows. A joint is written once it leaves the file's rest pose, then whenever it changes, as `jp` does.

- **Part number.** The same number `gjoint` uses (`stage_joint`): the part's `map_id`, or `map_id + 1000 * k` for the k-th extra copy that is not the one in `stage_info.x180`.
- **Joint number.** The preorder index `stage_joint` counts. Index 0 is the part's scale root from `Ground_801C14D0`/`get_jobj_inline`, at rest rot 0, scale the stage's (`stage_info.param->x0`, else 1), translate 0. The file's tree (`grDatFiles_801C6330(map_id)->unk4->unk8[map_id].unk0`) starts at 1. An instance's children are not counted.
- **Not written:** quaternion joints, joints past 512, and parts with no tree in the file.
- The pose owners go from 64 to 128 and the line buffer from 48 KB to 256 KB, to fit a stage part's tree. Both are allocated once with the track.
- `sp` is added to `UNLOCKED_KINDS`, so the visual-state locks don't change.

**Needs game data:** check the lines against Dolphin's draws on Fountain of Dreams, Yoshi's Story and Pokemon Stadium. Also measure how much an animated background adds to a track's size. Every joint an animation moves is written on every frame it moves.

## 0002 Viewer track: fighter joints as the game left them ("fj")

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

## 0003 Viewer track: the yo-yo's string by the links' out bit

`lm` already writes each link's `x2C_b0` as its out. That was checked against itnessyoyo.c:
- set as the string pays out from the ball (`it_802BF28C`, `it_802BF4A0`), and for the ball itself (`it_802BE65C`, `it_802C0010`)
- cleared as it is drawn back (`it_802BF800`) and under the shortest length (`it_802BF28C`)

So the links that are out form one run from the ball, which is `lm`'s link 0.

The bug was in `hook`. It left a link out only when its place was still at the origin, which is how the hookshot and the grapple mark a link that isn't out yet. A yo-yo link that is not out keeps its spawn place or the hand's (nothing moves it), so the yo-yo's `hook` line drew the string through links the game does not draw. The yo-yo's links are now told by `x2C_b0`, which is what `it_802A24A0` draws by. The hookshot and the grapple are unchanged.

**Needs game data:** `hook` is locked. A visual-state recording with Ness's yo-yo out will change its `hook` digest. Check that only such recordings differ, then re-record them with `python -m tools.validation.visual_state --write`. The viewer itself no longer reads `hook`: it draws chains from `lm`.
